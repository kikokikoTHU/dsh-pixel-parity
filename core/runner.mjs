/**
 * Case orchestration: capture both sides, judge G/S/P, write evidence.
 *
 * The runner is surface-agnostic. For v2 only `web` (Playwright/Chrome) and
 * `image` are wired; `electron` and `desktop` are reserved adapter ids that
 * fail with an explicit message instead of silently degrading.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { compareGeometry, comparePixels, compareStyles } from './compare.mjs'
import { hasBaseline, readBaseline, writeBaseline } from './baselines.mjs'
import { buildIr, flattenIr, validateIr } from './ir.mjs'
import { generateHtml } from './ir-web.mjs'
import { generateSemanticHtml } from './ir-html.mjs'
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

  const driver = await createWebDriver({ repoRoot: dependenciesRoot, headless: options.headless })
  const startedAt = new Date().toISOString()
  const repo = repoInfo(repoRoot)
  const exportIr = options.exportIr === true
  const caseResults = []

  try {
    for (const entry of cases) {
      const viewportResults = []
      for (const viewport of viewports) {
        if (options.signal?.aborted) throw new Error('run aborted')
        viewportResults.push(await runOne(entry, viewport, driver, runDir, config, { repoRoot, decision, repo, runId, exportIr }))
      }
      caseResults.push({
        id: entry.id,
        status: worstStatus(viewportResults.map(result => result.status)),
        viewports: viewportResults,
      })
    }
  } finally {
    await driver.dispose()
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

    const geometry = compareGeometry(reference.anchors ?? {}, implementation.anchors ?? {}, 1)
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
    if (context.exportIr === true && implementation.dom !== undefined) {
      const ir = buildIr({
        kind: 'web',
        url: entry.implementation.url,
        viewport: { width: viewport.width, height: viewport.height, dpr: viewport.dpr },
        capturedAt: new Date().toISOString(),
      }, implementation.dom)
      const violations = validateIr(ir)
      if (violations.length > 0) throw new Error(`IR validation failed: ${violations.join('; ')}`)
      const synthesis = await synthesizeLayout(ir, driver, viewport, caseDir)
      const irPath = join(caseDir, 'ir.json')
      writeFileSync(irPath, `${JSON.stringify(ir, null, 2)}\n`)
      const generatedPath = join(caseDir, 'generated.html')
      writeFileSync(generatedPath, generateHtml(ir))
      const semanticPath = join(caseDir, 'generated.semantic.html')
      writeFileSync(semanticPath, generateSemanticHtml(ir))
      irArtifacts = {
        path: irPath,
        generated: generatedPath,
        semantic: semanticPath,
        nodes: flattenIr(ir.root).length,
        truncated: ir.source.truncated === true,
        pins: synthesis.pins,
        iterations: synthesis.iterations,
        within1: synthesis.within1,
        within2: synthesis.within2,
        over2: synthesis.over2,
      }
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
async function synthesizeLayout(ir, driver, viewport, caseDir) {
  const nodes = flattenIr(ir.root)
  const flowPath = join(caseDir, 'generated.flow.html')
  const size = { width: viewport.width, height: viewport.height, dpr: viewport.dpr }
  let iterations = 0
  for (; iterations < 3; iterations += 1) {
    writeFileSync(flowPath, generateSemanticHtml(ir))
    const captured = await driver.capture({ url: pathToFileURL(flowPath).href, viewport: size, exportDom: true })
    const rendered = domMap(captured.dom)
    let added = 0
    for (const node of nodes) {
      node.layout = node.layout ?? { kind: 'block' }
      node.layout.pins = node.layout.pins ?? {}
      const pins = node.layout.pins
      const got = rendered.get(node.id)
      if (got === undefined) {
        if (pins.width !== true || pins.height !== true) {
          pins.width = true
          pins.height = true
          added += 1
        }
        continue
      }
      if (Math.abs(node.box.w - got.box.w) > 1 && pins.width !== true) {
        pins.width = true
        added += 1
      }
      if (Math.abs(node.box.h - got.box.h) > 1 && pins.height !== true) {
        pins.height = true
        added += 1
      }
    }
    if (added === 0) break
  }

  const semanticPath = join(caseDir, 'generated.semantic.html')
  writeFileSync(semanticPath, generateSemanticHtml(ir))
  const finalCapture = await driver.capture({ url: pathToFileURL(semanticPath).href, viewport: size, exportDom: true })
  const stats = measureBoxes(nodes, domMap(finalCapture.dom))
  return {
    iterations: iterations + 1,
    pins: nodes.filter(node => node.layout?.pins?.width === true || node.layout?.pins?.height === true).length,
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
  const stats = { boxes: nodes.length, within1: 0, within2: 0, over2: 0 }
  for (const node of nodes) {
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
