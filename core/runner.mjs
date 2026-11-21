/**
 * Case orchestration: capture both sides, judge G/S/P, write evidence.
 *
 * The runner is surface-agnostic. For v2 only `web` (Playwright/Chrome) and
 * `image` are wired; `electron` and `desktop` are reserved adapter ids that
 * fail with an explicit message instead of silently degrading.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { compareGeometry, comparePixels, compareStyles } from './compare.mjs'
import { hasBaseline, readBaseline, writeBaseline } from './baselines.mjs'
import { buildIr, flattenIr, validateIr } from './ir.mjs'
import { generateHtml } from './ir-web.mjs'
import { generateSemanticHtml } from './ir-html.mjs'
import { generateQml } from './ir-qml.mjs'
import { generateComponent } from './ir-component.mjs'
import { figmaToIr } from './figma.mjs'
import { captureQml, findQmlScene } from '../adapters/qml.mjs'
import { createWebDriver } from '../adapters/web.mjs'
import { loadImage } from '../lib/image.js'
import { encodePng } from '../lib/png.js'

/**
 * Run a parity config.
 * @param {{configPath: string, repoRoot: string, dependenciesRoot?: string, caseIds?: string[], viewportIds?: string[], outDir?: string, headless?: boolean, baselineMode?: 'auto'|'pin'|'ephemeral'|'baseline', ask?: Function, signal?: AbortSignal}} options - run options.
 * @returns {Promise<{runDir: string, manifest: object, summary: object}>} run result.
 */
export async function runConfig(options) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd())
  const dependenciesRoot = resolve(options.dependenciesRoot ?? repoRoot)
  const config = await loadConfig(options.configPath)
  const cases = select(config.cases, options.caseIds, 'case')
  if (options.thresholds !== undefined) {
    const geometryTolerance = options.thresholds.geometryTolerance
    if (geometryTolerance !== undefined && (!Number.isFinite(geometryTolerance) || geometryTolerance < 0)) {
      throw new Error('geometryTolerance must be a non-negative number')
    }
    const maxMismatch = options.thresholds.maxMismatch
    if (maxMismatch !== undefined && (!Number.isFinite(maxMismatch) || maxMismatch < 0 || maxMismatch > 1)) {
      throw new Error('maxMismatch must be a number between 0 and 1')
    }
    for (const entry of cases) entry.thresholds = { ...entry.thresholds, ...options.thresholds }
  }
  const viewports = select(config.viewports, options.viewportIds, 'viewport')

  for (const surface of new Set(cases.map(entry => entry.surface))) {
    if (surface !== 'web') {
      throw new Error(`surface "${surface}" is reserved for a later phase; only "web" and image references are implemented`)
    }
  }

  const decision = await resolveBaselineDecision(config, repoRoot, cases, viewports, options)
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const runDir = resolve(options.outDir ?? join(repoRoot, '.parity', 'runs', runId))
  mkdirSync(join(runDir, 'tmp'), { recursive: true })

  const startedAt = new Date().toISOString()
  const repo = repoInfo(repoRoot)
  const exportIr = options.exportIr === true || options.exportQml === true || options.exportComponent === true
  const exportQml = options.exportQml === true
  const exportComponent = options.exportComponent === true
  const caseResults = []
  let driver
  let devServer

  try {
    devServer = await ensureDevServer(config, repoRoot, options)
    driver = await createWebDriver({ repoRoot: dependenciesRoot, headless: options.headless })
    for (const entry of cases) {
      const viewportResults = []
      for (const viewport of viewports) {
        if (options.signal?.aborted) throw new Error('run aborted')
        viewportResults.push(await runOne(entry, viewport, driver, runDir, config, { repoRoot, decision, repo, runId, exportIr, exportQml, exportComponent }))
      }
      caseResults.push({
        id: entry.id,
        status: worstStatus(viewportResults.map(result => result.status)),
        viewports: viewportResults,
      })
    }
  } finally {
    if (driver !== undefined) await driver.dispose()
    await stopDevServer(devServer)
  }

  const manifest = {
    version: 2,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: config.path, sha256: config.sha256 },
    repo,
    driver: driver.id,
    decision,
    cases: caseResults,
    summary: summarize(caseResults),
  }
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { runDir, manifest, summary: manifest.summary }
}

/**
 * Start the configured dev server when the implementation URL is not reachable.
 *
 * The command comes from `targets.implementation.start`; an already running
 * server is reused and never killed.
 * @param {object} config - normalized config.
 * @param {string} repoRoot - repository root (working directory for the command).
 * @param {object} options - run options.
 * @returns {Promise<{spawned: boolean, child?: object} | undefined>} server handle.
 */
async function ensureDevServer(config, repoRoot, options) {
  const target = config.targets.implementation
  const command = target.start
  if (typeof command !== 'string' || command.length === 0) return undefined
  if (options.startServer === false) return undefined
  if (typeof target.baseUrl !== 'string' || target.baseUrl.length === 0) {
    throw new Error('targets.implementation.start requires baseUrl so readiness can be probed')
  }
  const readyUrl = typeof target.readyUrl === 'string' && target.readyUrl.length > 0 ? target.readyUrl : target.baseUrl
  if (await isReachable(readyUrl)) return { spawned: false }

  const timeout = target.startTimeoutMs ?? 90000
  const child = spawn(command, { cwd: repoRoot, shell: true, stdio: 'ignore' })
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await isReachable(readyUrl)) return { spawned: true, child }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  await stopDevServer({ spawned: true, child })
  throw new Error(`dev server did not become ready at ${readyUrl} within ${timeout}ms (command: ${command})`)
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
    return response.status < 500
  } catch {
    return false
  }
}

async function stopDevServer(server) {
  if (server === undefined || server.spawned !== true || server.child === undefined) return
  const child = server.child
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('close', () => resolve())
      killer.on('error', () => resolve())
    })
  } else {
    child.kill('SIGTERM')
  }
}

/**
 * Decide how this run treats baselines.
 * @param {object} config - normalized config.
 * @param {string} repoRoot - repository root.
 * @param {object[]} cases - selected cases.
 * @param {object[]} viewports - selected viewports.
 * @param {object} options - run options.
 * @returns {Promise<{mode: string, source: string, cases?: object[]}>} decision.
 */
async function resolveBaselineDecision(config, repoRoot, cases, viewports, options) {
  const requested = options.baselineMode ?? 'auto'
  if (requested !== 'auto') return { mode: requested, source: 'explicit' }

  const webCases = cases.filter(entry => entry.reference.kind === 'web')
  const missing = webCases.filter(entry => !viewports.every(viewport => hasBaseline(repoRoot, entry.id, viewport.id)))
  if (webCases.length > 0 && missing.length === 0) return { mode: 'baseline', source: 'auto' }

  if (missing.length > 0 && typeof options.ask === 'function') {
    const answer = await options.ask({
      cases: missing.map(entry => ({ id: entry.id, reference: entry.reference.url ?? entry.reference.path })),
      viewports: viewports.map(viewport => viewport.id),
    })
    if (answer === 'pin' || answer === 'ephemeral' || answer === 'baseline') {
      return { mode: answer, source: 'user', cases: missing.map(entry => entry.id) }
    }
    return { mode: 'ephemeral', source: 'fallback', cases: missing.map(entry => entry.id) }
  }
  return { mode: 'ephemeral', source: 'auto' }
}

async function runOne(entry, viewport, driver, runDir, config, context) {
  const caseDir = join(runDir, 'cases', entry.id, viewport.id)
  mkdirSync(caseDir, { recursive: true })
  const base = { caseId: entry.id, viewportId: viewport.id }

  try {
    let reference
    let baselineUsed = false
    if (context.decision.mode === 'baseline') {
      const stored = readBaseline(context.repoRoot, entry.id, viewport.id)
      if (stored === undefined) throw new Error(`no baseline for ${entry.id}@${viewport.id}; run with baselineMode "pin" first`)
      reference = { image: stored.image, anchors: stored.anchors, masks: stored.masks, driver: 'baseline' }
      baselineUsed = true
    } else {
      reference = await captureSide('reference', entry, entry.reference, viewport, driver, caseDir, config)
    }
    const implementation = await captureSide('implementation', entry, entry.implementation, viewport, driver, caseDir, config, {
      exportDom: context.exportIr === true,
    })

    if (reference.image.width !== implementation.image.width || reference.image.height !== implementation.image.height) {
      throw new Error(
        `size mismatch for ${entry.id}@${viewport.id}: reference ${reference.image.width}x${reference.image.height}, `
        + `implementation ${implementation.image.width}x${implementation.image.height}. `
        + `A web viewport renders width*dpr = ${viewport.width * viewport.dpr}x${viewport.height * viewport.dpr}.`,
      )
    }

    writePng(join(caseDir, 'reference.png'), reference.image)
    writePng(join(caseDir, 'implementation.png'), implementation.image)

    const geometry = compareGeometry(reference.anchors ?? {}, implementation.anchors ?? {}, entry.thresholds.geometryTolerance)
    const styles = compareStyles(reference.anchors ?? {}, implementation.anchors ?? {})
    const pixels = comparePixels(reference.image, implementation.image, {
      tolerance: entry.thresholds.tolerance,
      maxMismatch: entry.thresholds.maxMismatch,
      maxRegionMismatch: entry.thresholds.maxRegionMismatch,
      referenceMasks: reference.masks,
      implementationMasks: implementation.masks,
    })
    writeFileSync(join(caseDir, 'diff.png'), encodePng(pixels.metrics.width, pixels.metrics.height, pixels.diff))

    const geometryAvailable = Object.keys(reference.anchors ?? {}).length > 0
    const failed = !pixels.pass || (geometryAvailable && !geometry.pass) || (geometryAvailable && !styles.pass)
    const status = failed ? 'failed' : geometryAvailable ? 'verified' : 'image-verified'

    const allPass = geometry.pass && styles.pass && pixels.pass

    let irArtifacts
    let irDocument
    if (context.exportIr === true && implementation.dom !== undefined) {
      const ir = buildIr({
        kind: 'web',
        url: entry.implementation.url,
        viewport: { width: viewport.width, height: viewport.height, dpr: viewport.dpr },
        capturedAt: new Date().toISOString(),
      }, implementation.dom)
      await materializeAssets(ir, caseDir)
      const violations = validateIr(ir)
      if (violations.length > 0) throw new Error(`IR validation failed: ${violations.join('; ')}`)
      const synthesis = await synthesizeLayout(ir, driver, viewport, caseDir)
      const irPath = join(caseDir, 'ir.json')
      writeFileSync(irPath, `${JSON.stringify(ir, null, 2)}\n`)
      const generatedPath = join(caseDir, 'generated.html')
      writeFileSync(generatedPath, generateHtml(ir))
      const semanticPath = join(caseDir, 'generated.semantic.html')
      writeFileSync(semanticPath, generateSemanticHtml(ir))
      irDocument = ir
      irArtifacts = {
        path: irPath,
        generated: generatedPath,
        semantic: semanticPath,
        nodes: flattenIr(ir.root).length,
        truncated: ir.source.truncated === true,
        pins: synthesis.pins,
        pruned: synthesis.pruned,
        iterations: synthesis.iterations,
        within1: synthesis.within1,
        within2: synthesis.within2,
        over2: synthesis.over2,
      }
    }

    if (irArtifacts !== undefined && context.exportQml === true && irDocument !== undefined) {
      const qmlPath = join(caseDir, 'generated.qml')
      writeFileSync(qmlPath, generateQml(irDocument))
      const semanticQmlPath = join(caseDir, 'generated.semantic.qml')
      writeFileSync(semanticQmlPath, generateQml(irDocument, { semantic: true }))
      const qml = { path: qmlPath }
      if (findQmlScene() === undefined) {
        qml.error = 'qmlscene not available'
      } else {
        try {
          const captured = await captureQml(qmlPath, {
            width: viewport.width,
            height: viewport.height,
            outPath: join(caseDir, 'qml.png'),
          })
          const diff = comparePixels(implementation.image, captured, {
            tolerance: entry.thresholds.tolerance,
            maxMismatch: entry.thresholds.maxMismatch,
            maxRegionMismatch: entry.thresholds.maxRegionMismatch,
          })
          qml.screenshot = join(caseDir, 'qml.png')
          qml.mismatchRatio = round(diff.metrics.mismatchRatio, 6)

          const semanticImage = await captureQml(semanticQmlPath, {
            width: viewport.width,
            height: viewport.height,
            outPath: join(caseDir, 'qml.semantic.png'),
          })
          const semanticDiff = comparePixels(implementation.image, semanticImage, {
            tolerance: entry.thresholds.tolerance,
            maxMismatch: entry.thresholds.maxMismatch,
            maxRegionMismatch: entry.thresholds.maxRegionMismatch,
          })
          qml.semantic = {
            path: semanticQmlPath,
            screenshot: join(caseDir, 'qml.semantic.png'),
            mismatchRatio: round(semanticDiff.metrics.mismatchRatio, 6),
          }
        } catch (error) {
          qml.error = error instanceof Error ? error.message : String(error)
        }
      }
      irArtifacts.qml = qml
    }

    if (irArtifacts !== undefined && context.exportComponent === true && irDocument !== undefined) {
      const component = generateComponent(irDocument)
      const htmlPath = join(caseDir, 'generated.component.html')
      writeFileSync(htmlPath, component.html)
      const cssPath = join(caseDir, 'generated.component.css')
      writeFileSync(cssPath, component.css)
      const artifact = { html: htmlPath, css: cssPath }
      try {
        const captured = await driver.capture({
          url: pathToFileURL(htmlPath).href,
          viewport: { width: viewport.width, height: viewport.height, dpr: viewport.dpr },
          screenshotPath: join(caseDir, 'component.png'),
        })
        const diff = comparePixels(implementation.image, captured.image, {
          tolerance: entry.thresholds.tolerance,
          maxMismatch: entry.thresholds.maxMismatch,
          maxRegionMismatch: entry.thresholds.maxRegionMismatch,
        })
        artifact.screenshot = join(caseDir, 'component.png')
        artifact.mismatchRatio = round(diff.metrics.mismatchRatio, 6)
      } catch (error) {
        artifact.error = error instanceof Error ? error.message : String(error)
      }
      irArtifacts.component = artifact
    }

    let baselineWritten = false
    if (allPass && context.decision.mode === 'pin' && !baselineUsed) {
      writeBaseline(context.repoRoot, entry.id, viewport.id, {
        image: implementation.image,
        anchors: implementation.anchors ?? {},
        meta: {
          caseId: entry.id,
          viewportId: viewport.id,
          approvedAt: new Date().toISOString(),
          runId: context.runId,
          source: 'pin',
          repo: context.repo,
          config: { path: config.path, sha256: config.sha256 },
          reference: entry.reference,
          thresholds: entry.thresholds,
          masks: implementation.masks,
        },
      })
      baselineWritten = true
    }

    const result = {
      ...base,
      status,
      driver: { reference: reference.driver, implementation: implementation.driver },
      baseline: { used: baselineUsed, written: baselineWritten },
      ...(irArtifacts === undefined ? {} : { ir: irArtifacts }),
      maskRects: implementation.masks,
      anchors: {
        reference: reference.anchors ?? null,
        implementation: implementation.anchors ?? null,
      },
      geometry: { available: geometryAvailable, ...geometry },
      styles: { available: geometryAvailable, pass: styles.pass, diffs: styles.diffs, warnings: styles.warnings },
      pixels: {
        pass: pixels.pass,
        metrics: {
          ...pixels.metrics,
          mismatchRatio: round(pixels.metrics.mismatchRatio, 6),
          meanDelta: round(pixels.metrics.meanDelta, 3),
        },
        regions: pixels.regions.map(region => ({
          ...region,
          mismatchRatio: round(region.mismatchRatio, 6),
          meanDelta: round(region.meanDelta, 3),
        })),
        masks: pixels.masks,
      },
      artifacts: {
        reference: join(caseDir, 'reference.png'),
        implementation: join(caseDir, 'implementation.png'),
        diff: join(caseDir, 'diff.png'),
      },
    }
    writeFileSync(join(caseDir, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    const result = {
      ...base,
      status: 'incomplete',
      error: error instanceof Error ? error.message : String(error),
    }
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(join(caseDir, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
}

async function captureSide(side, entry, spec, viewport, driver, caseDir, config, extra = {}) {
  if (spec.kind === 'figma') {
    const ir = await loadFigmaIr(spec)
    if (ir.source.viewport.width !== Math.round(viewport.width) || ir.source.viewport.height !== Math.round(viewport.height)) {
      throw new Error(
        `Figma frame is ${ir.source.viewport.width}x${ir.source.viewport.height}; `
        + `set the viewport to ${ir.source.viewport.width}x${ir.source.viewport.height}`,
      )
    }
    writeFileSync(join(caseDir, 'reference.ir.json'), `${JSON.stringify(ir, null, 2)}\n`)
    const htmlPath = join(caseDir, 'reference.semantic.html')
    writeFileSync(htmlPath, generateSemanticHtml(ir))
    const captured = await driver.capture({ url: pathToFileURL(htmlPath).href, viewport })
    return { image: captured.image, anchors: null, masks: [], driver: 'figma' }
  }
  if (spec.kind === 'image') {
    const image = loadImage(spec.path)
    const expectedWidth = Math.round(viewport.width * viewport.dpr)
    const expectedHeight = Math.round(viewport.height * viewport.dpr)
    if (image.width !== expectedWidth || image.height !== expectedHeight) {
      throw new Error(
        `reference image ${spec.path} is ${image.width}x${image.height}; viewport ${viewport.id} expects `
        + `${expectedWidth}x${expectedHeight} (${viewport.width}x${viewport.height} at dpr ${viewport.dpr})`,
      )
    }
    return { image, anchors: null, masks: [], driver: 'image' }
  }

  const anchors = side === 'reference'
    ? mapSelectors(entry.anchors, 'ref')
    : mapSelectors(entry.anchors, 'impl')
  const masks = entry.masks
    .map(mask => (side === 'reference' ? mask.ref : mask.impl))
    .filter(selector => typeof selector === 'string')

  const result = await driver.capture({
    url: spec.url,
    viewport,
    anchors,
    masks,
    fixtures: spec.fixtures,
    hide: entry.hide[side === 'reference' ? 'ref' : 'impl'],
    waitFor: entry.waitFor[side === 'reference' ? 'ref' : 'impl'],
    freeze: config.defaults.freeze,
    locale: config.defaults.locale,
    timezone: config.defaults.timezone,
    screenshotPath: join(caseDir, `tmp-${side}.png`),
    ...extra,
  })
  return result
}

function mapSelectors(anchors, key) {
  const result = {}
  for (const [id, value] of Object.entries(anchors ?? {})) {
    if (typeof value[key] === 'string') result[id] = value[key]
  }
  return result
}

function writePng(path, image) {
  writeFileSync(path, encodePng(image.width, image.height, image.data))
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function select(entries, ids, label) {
  if (ids === undefined || ids.length === 0) return entries
  const selected = entries.filter(entry => ids.includes(entry.id))
  if (selected.length !== ids.length) {
    const known = entries.map(entry => entry.id).join(', ')
    throw new Error(`unknown ${label} id(s): ${ids.filter(id => !entries.some(entry => entry.id === id)).join(', ')}; known: ${known}`)
  }
  return selected
}

const STATUS_ORDER = ['incomplete', 'failed', 'image-verified', 'verified']

function worstStatus(statuses) {
  return statuses.reduce((worst, status) => {
    return STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf(worst) ? status : worst
  }, 'verified')
}

function summarize(cases) {
  const summary = { cases: cases.length, viewports: 0, verified: 0, 'image-verified': 0, failed: 0, incomplete: 0 }
  for (const entry of cases) {
    summary.viewports += entry.viewports.length
    for (const viewport of entry.viewports) summary[viewport.status] += 1
  }
  return summary
}

/**
 * Add size pins only where flow layout cannot reproduce the captured box.
 *
 * The semantic renderer starts with no explicit sizes; each render is compared
 * back to the captured boxes and a node gets a width and/or height pin when it
 * drifts. The resulting IR records exactly which sizes are load-bearing, which
 * is the information a QML generator needs.
 * @param {object} ir - IR document, mutated with pins.
 * @param {object} driver - capture driver.
 * @param {{width: number, height: number, dpr: number}} viewport - viewport.
 * @param {string} caseDir - directory for intermediate renders.
 * @returns {Promise<{iterations: number, pins: number, boxes: number, within1: number, within2: number, over2: number}>} synthesis stats.
 */
/**
 * Load a Figma document from the configured payload or the REST API.
 * @param {object} spec - Figma reference target.
 * @returns {Promise<object>} IR document.
 */
async function loadFigmaIr(spec) {
  let payload = spec.document
  if (payload === undefined) {
    const token = process.env[spec.tokenEnv]
    if (typeof token !== 'string' || token.length === 0) throw new Error(`Figma token missing: set ${spec.tokenEnv}`)
    const url = `${spec.apiBase}/v1/files/${encodeURIComponent(spec.fileKey)}/nodes?ids=${encodeURIComponent(spec.nodeId)}`
    const response = await fetch(url, { headers: { 'X-Figma-Token': token } })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw new Error(`Figma API ${response.status}: ${detail}`)
    }
    payload = await response.json()
  }
  return figmaToIr(payload, { nodeId: spec.nodeId, fileKey: spec.fileKey })
}

/**
 * Download font files referenced by the IR into the case directory.
 *
 * A generated page has no origin for remote @font-face rules, so fonts are
 * materialized next to the render and the IR keeps relative paths.
 * @param {object} ir - IR document, mutated.
 * @param {string} caseDir - case artifact directory.
 * @returns {Promise<void>} when every reachable font is materialized.
 */
async function materializeFonts(ir, caseDir) {
  const fonts = ir.assets?.fonts ?? []
  if (fonts.length === 0) return
  const directory = join(caseDir, 'assets', 'fonts')
  mkdirSync(directory, { recursive: true })
  for (const font of fonts) {
    try {
      let buffer
      if (font.src.startsWith('data:')) {
        const match = /^data:[^;]*;base64,(.*)$/s.exec(font.src)
        if (match === null) continue
        buffer = Buffer.from(match[1], 'base64')
      } else if (/^https?:/i.test(font.src)) {
        const response = await fetch(font.src)
        if (!response.ok) continue
        buffer = Buffer.from(await response.arrayBuffer())
      } else {
        continue
      }
      const rawExtension = font.format !== '' ? font.format : extname(new URL(font.src, 'file:///').pathname)
      const extension = rawExtension.replace(/^\./, '') || 'woff2'
      const name = `${createHash('sha256').update(font.src).digest('hex').slice(0, 12)}.${extension}`
      writeFileSync(join(directory, name), buffer)
      font.src = `assets/fonts/${name}`
    } catch {
      // Keep the absolute URL when the asset cannot be materialized.
    }
  }
}

/**
 * Materialize fonts and images referenced by the IR into the case directory.
 *
 * A generated page has no origin for remote resources, so assets are written
 * next to the render and the IR keeps relative paths.
 * @param {object} ir - IR document, mutated.
 * @param {string} caseDir - case artifact directory.
 * @returns {Promise<void>} when every reachable asset is materialized.
 */
async function materializeAssets(ir, caseDir) {
  await materializeFonts(ir, caseDir)

  const images = new Map()
  const directory = join(caseDir, 'assets', 'images')
  let created = false
  const localize = async (source) => {
    if (!/^(data:|https?:)/i.test(source)) return source
    if (images.has(source)) return images.get(source)
    try {
      let buffer
      let type = ''
      if (source.startsWith('data:')) {
        const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(source)
        if (match === null) return source
        type = match[1] ?? ''
        buffer = match[2] === ';base64'
          ? Buffer.from(match[3], 'base64')
          : Buffer.from(decodeURIComponent(match[3]), 'binary')
      } else {
        const response = await fetch(source)
        if (!response.ok) return source
        type = response.headers.get('content-type') ?? ''
        buffer = Buffer.from(await response.arrayBuffer())
      }
      const name = `${createHash('sha256').update(source).digest('hex').slice(0, 12)}.${imageExtension(source, type)}`
      if (!created) {
        mkdirSync(directory, { recursive: true })
        created = true
      }
      writeFileSync(join(directory, name), buffer)
      const relative = `assets/images/${name}`
      images.set(source, relative)
      return relative
    } catch {
      return source
    }
  }

  for (const node of flattenIr(ir.root)) {
    if (typeof node.attributes?.src === 'string') {
      node.attributes.src = await localize(node.attributes.src)
    }
    if (typeof node.attributes?.poster === 'string') {
      node.attributes.poster = await localize(node.attributes.poster)
    }
    const background = node.style?.backgroundImage
    if (typeof background === 'string' && background.includes('url(')) {
      node.style.backgroundImage = await replaceCssUrls(background, localize)
    }
  }
}

async function replaceCssUrls(value, localize) {
  const parts = []
  let last = 0
  const pattern = /url\((['"]?)([^'")]+)\1\)/g
  let match
  while ((match = pattern.exec(value)) !== null) {
    parts.push(value.slice(last, match.index))
    parts.push(`url('${await localize(match[2])}')`)
    last = pattern.lastIndex
  }
  parts.push(value.slice(last))
  return parts.join('')
}

function imageExtension(source, type) {
  const mime = (/^data:([^;,]+)/.exec(source)?.[1] ?? type).toLowerCase()
  const byMime = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
  }
  if (byMime[mime] !== undefined) return byMime[mime]
  try {
    const extension = extname(new URL(source, 'file:///').pathname).replace(/^\./, '').toLowerCase()
    if (/^(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/.test(extension)) return extension
  } catch {}
  return 'bin'
}

async function synthesizeLayout(ir, driver, viewport, caseDir) {
  const nodes = flattenIr(ir.root)
  const flowPath = join(caseDir, 'generated.flow.html')
  const size = { width: viewport.width, height: viewport.height, dpr: viewport.dpr }

  const captureCurrent = async () => {
    writeFileSync(flowPath, generateSemanticHtml(ir))
    const captured = await driver.capture({ url: pathToFileURL(flowPath).href, viewport: size, exportDom: true })
    return domMap(captured.dom)
  }

  let iterations = 0
  for (; iterations < 3; iterations += 1) {
    const rendered = await captureCurrent()
    let added = 0
    for (const node of nodes) {
      // Table cells derive their size from the table model (columns, row heights);
      // pinning them individually is redundant once rows/columns are pinned.
      if (node.tag === 'td' || node.tag === 'th') continue
      // Pseudo-elements are generated content: let flow size them.
      if (node.pseudo !== undefined) continue
      const got = rendered.get(node.id)
      const needWidth = got === undefined || Math.abs(node.box.w - got.box.w) > 1
      const needHeight = got === undefined || Math.abs(node.box.h - got.box.h) > 1
      if (needWidth && node.layout?.pins?.width !== true) {
        node.layout = node.layout ?? { kind: 'block' }
        node.layout.pins = node.layout.pins ?? {}
        node.layout.pins.width = true
        added += 1
      }
      if (needHeight && node.layout?.pins?.height !== true) {
        node.layout = node.layout ?? { kind: 'block' }
        node.layout.pins = node.layout.pins ?? {}
        node.layout.pins.height = true
        added += 1
      }
    }
    if (added === 0) break
  }

  let stats = measureBoxes(nodes, await captureCurrent())

  // Prune pins that turn out not to be load-bearing: remove one, re-render, keep
  // the removal only when box accuracy does not regress.
  let pruned = 0
  const budget = 30
  const candidates = nodes
    .filter(node => node.layout?.kind === 'block' && (node.layout.pins?.width === true || node.layout.pins?.height === true))
    .reverse()
  for (const node of candidates.slice(0, budget)) {
    const saved = { ...node.layout.pins }
    delete node.layout.pins
    const trial = measureBoxes(nodes, await captureCurrent())
    if (trial.over2 <= stats.over2 && trial.within2 >= stats.within2) {
      stats = trial
      pruned += 1
    } else {
      node.layout.pins = saved
    }
  }

  for (const node of nodes) {
    if (node.layout?.pins !== undefined && Object.keys(node.layout.pins).length === 0) delete node.layout.pins
  }
  const semanticPath = join(caseDir, 'generated.semantic.html')
  writeFileSync(semanticPath, generateSemanticHtml(ir))
  return {
    iterations: iterations + 1,
    pins: nodes.filter(node => node.layout?.pins?.width === true || node.layout?.pins?.height === true).length,
    pruned,
    ...stats,
  }
}

function domMap(dom) {
  const map = new Map()
  const walk = (node) => {
    if (node.ir !== undefined) map.set(node.ir, node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(dom.root)
  return map
}

function measureBoxes(nodes, rendered) {
  const measured = nodes.filter(node => node.pseudo === undefined)
  const stats = { boxes: measured.length, within1: 0, within2: 0, over2: 0 }
  for (const node of measured) {
    const got = rendered.get(node.id)
    if (got === undefined) {
      stats.over2 += 1
      continue
    }
    const delta = Math.max(...['x', 'y', 'w', 'h'].map(key => Math.abs(node.box[key] - got.box[key])))
    if (delta <= 1) stats.within1 += 1
    else if (delta <= 2) stats.within2 += 1
    else stats.over2 += 1
  }
  return stats
}

function repoInfo(repoRoot) {  const info = { root: repoRoot, commit: null, dirty: null }
  try {
    info.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    info.dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch {
    // Not every target is a git checkout.
  }
  return info
}
