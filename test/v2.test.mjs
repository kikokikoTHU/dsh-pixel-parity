/**
 * v2 core tests: config normalization, G/S comparisons, masking, and one
 * end-to-end run over the web fixtures.
 *
 * The end-to-end part needs a repo that provides Playwright:
 *   PARITY_REPO=C:\path\to\repo ELECTRON_RUN_AS_NODE=1 <electron> test/v2.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig, normalizeConfig } from '../core/config.mjs'
import { compareGeometry, compareStyles, maskImage, normalizeStyleValue } from '../core/compare.mjs'
import { approveRun } from '../core/baselines.mjs'
import { runConfig } from '../core/runner.mjs'
import { detectRepo, initRepo } from '../core/init.mjs'
import { buildIr, expandStyle, flattenIr, validateIr } from '../core/ir.mjs'
import { generateHtml } from '../core/ir-web.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
process.env.PIXEL_PARITY_TASK_DIR = join(tmpdir(), 'parity-task-store')
const fixtureConfig = join(here, 'fixtures', 'web', 'parity.config.mjs')
const interactionConfig = join(here, 'fixtures', 'interactions', 'parity.config.mjs')
const results = []
let failed = 0

async function test(name, body) {
  try {
    await body()
    results.push(`ok   ${name}`)
  } catch (error) {
    failed += 1
    results.push(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}

await test('config rejects an unknown version', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'parity-config-')), 'parity.config.json')
  writeFileSync(file, JSON.stringify({ version: 1, cases: [] }))
  await assert.rejects(loadConfig(file), /version must be 2/)
})

await test('config resolves a relative reference against the config directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'parity-config-'))
  const file = join(directory, 'parity.config.mjs')
  writeFileSync(file, `export default ${JSON.stringify({
    version: 2,
    viewports: [{ id: 'desktop', width: 800, height: 600 }],
    cases: [{ id: 'one', reference: { url: './ref.html' }, implementation: { url: './impl.html' } }],
  })}`)
  const config = await loadConfig(file)
  assert.equal(config.cases[0].reference.url, join(directory, 'ref.html'))
})

await test('config presets set tolerant thresholds and explicit values win', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'parity-preset-'))
  const file = join(directory, 'parity.config.mjs')
  writeFileSync(file, `export default ${JSON.stringify({
    version: 2,
    defaults: { preset: 'tolerant', maxMismatch: 0.03 },
    viewports: [{ id: 'v', width: 100, height: 100 }],
    cases: [{ id: 'case', reference: { url: './a.html' }, implementation: { url: './b.html' } }],
  })}`)
  const config = await loadConfig(file)
  const thresholds = config.cases[0].thresholds
  assert.equal(thresholds.geometryTolerance, 4)
  assert.equal(thresholds.maxMismatch, 0.03)
  assert.equal(thresholds.maxRegionMismatch, 0.6)
})

await test('plugin detail points at one local feature image', () => {
  const root = join(here, '..')
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.ok(typeof meta.detail === 'string', `${locale} declares meta.detail`)
    const documentPath = join(root, meta.detail)
    assert.ok(existsSync(documentPath), `${meta.detail} exists`)
    const lines = readFileSync(documentPath, 'utf8').trim().split(/\r?\n/)
    assert.equal(lines.length, 1, 'detail document is one image line')
    const image = /^!\[[^\]]+\]\(([^)]+)\)$/.exec(lines[0])
    assert.ok(image !== null, 'detail line is a markdown image')
    const imagePath = join(root, 'docs', image[1])
    assert.ok(existsSync(imagePath), `${image[1]} exists`)
    assert.ok(statSync(imagePath).size < 1024 * 1024, 'feature image under 1 MiB')
    assert.doesNotMatch(readFileSync(imagePath, 'utf8'), /<text[\s>]/, 'feature image has no text elements')
  }
})

await test('component generator emits classes and token variables', async () => {
  const { generateComponent } = await import('../core/ir-component.mjs')
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 200, height: 100, dpr: 1 }, canvas: { width: 200, height: 100 }, truncated: false },
    tokens: {
      colors: { 'color.1': 'rgb(51, 65, 85)' },
      typography: { 'type.1': { fontFamily: 'Arial', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal' } },
      radius: { 'radius.1': '6px' },
    },
    assets: { fonts: [{ family: 'Inter', weight: '400', style: 'normal', src: 'assets/fonts/x.woff2', format: 'woff2' }] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 200, h: 100 }, style: { backgroundColor: 'color.1' },
      children: [{
        id: 'n2', tag: 'div', role: 'container', layout: { kind: 'block' },
        box: { x: 10, y: 10, w: 80, h: 40 },
        style: {
          backgroundColor: 'color.1',
          typography: 'type.1',
          borderRadius: 'radius.1',
          paddingTop: '4px', paddingRight: '4px', paddingBottom: '4px', paddingLeft: '4px',
          borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'color.1',
          borderRightWidth: '1px', borderRightStyle: 'solid', borderRightColor: 'color.1',
          borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: 'color.1',
          borderLeftWidth: '1px', borderLeftStyle: 'solid', borderLeftColor: 'color.1',
          gap: '8px', rowGap: '8px', columnGap: '8px',
        },
        textRuns: [{ text: 'Hello', box: { x: 12, y: 14, w: 40, h: 18 } }],
      }],
    },
  }
  const { html, css } = generateComponent(ir)
  assert.match(html, /<body class="body-container">/)
  assert.match(html, /Hello/)
  assert.doesNotMatch(html, / style="/, 'no inline styles on nodes')
  assert.match(css, /:root \{/)
  assert.match(css, /--color-1: rgb\(51, 65, 85\)/)
  assert.match(css, /--type-1-font-size: 14px/)
  assert.match(css, /var\(--color-1\)/)
  assert.match(css, /var\(--type-1-font-size\)/)
  assert.match(css, /var\(--radius-1\)/)
  assert.doesNotMatch(css, /padding-top: 0px/)
  assert.doesNotMatch(css, /border-top-width: 0px/)
  assert.doesNotMatch(css, /opacity: 1/)
  assert.match(css, /padding: 4px;/)
  assert.match(css, /border: 1px solid var\(--color-1\);/)
  assert.doesNotMatch(css, /padding-top:/)
  assert.doesNotMatch(css, /border-top-width:/)
  assert.doesNotMatch(css, /row-gap:/)
  assert.match(css, /@font-face \{/)
  assert.match(css, /assets\/fonts\/x\.woff2/)
})

await test('diagnose explains region-local pixel failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'parity-region-'))
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    version: 2,
    runId: 'synthetic',
    iteration: 1,
    cases: [{
      id: 'region',
      status: 'failed',
      viewports: [{
        viewportId: 'desktop',
        status: 'failed',
        thresholds: { tolerance: 24, maxMismatch: 0.01, maxRegionMismatch: 0.4, geometryTolerance: 1 },
        geometry: { available: true, pass: true, tolerance: 1, anchors: [] },
        styles: { available: true, pass: true, diffs: [], warnings: [] },
        pixels: {
          pass: false,
          metrics: { mismatchRatio: 0.00435 },
          regions: [{ x: 50, y: 26, w: 25, h: 13, mismatchRatio: 0.5046 }],
        },
      }],
    }],
  }, null, 2))
  const { diagnoseRun } = await import('../core/diagnose.mjs')
  const diagnosis = diagnoseRun(directory)
  const finding = diagnosis.viewports[0].findings.find(entry => entry.layer === 'pixels' && entry.severity === 3000)
  assert.ok(finding !== undefined, 'region-cap finding present')
  assert.match(finding.summary, /maxRegionMismatch/)
  assert.match(finding.suggestion, /region-local/)
})

await test('panel overview and artifact guard work on run directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parity-panel-'))
  const runsDir = join(root, '.parity', 'runs')
  mkdirSync(join(runsDir, 'run-1', 'cases', 'case', 'desktop'), { recursive: true })
  mkdirSync(join(runsDir, 'run-2'), { recursive: true })
  const manifest = (runId, finishedAt, iteration) => JSON.stringify({
    version: 2,
    runId,
    iteration,
    startedAt: finishedAt,
    finishedAt,
    decision: { mode: 'ephemeral' },
    summary: { cases: 1, viewports: 1, verified: 1, 'image-verified': 0, failed: 0, incomplete: 0 },
    cases: [{
      id: 'case',
      status: 'verified',
      viewports: [{
        viewportId: 'desktop',
        status: 'verified',
        pixels: { metrics: { mismatchRatio: 0 } },
        geometry: { available: true, pass: true },
        styles: { diffs: [] },
        artifacts: { diff: join(runsDir, 'run-1', 'cases', 'case', 'desktop', 'diff.png') },
      }],
    }],
  })
  writeFileSync(join(runsDir, 'run-1', 'manifest.json'), manifest('run-1', '2026-01-01T00:00:00.000Z', 1))
  writeFileSync(join(runsDir, 'run-2', 'manifest.json'), manifest('run-2', '2026-01-02T00:00:00.000Z', 2))
  writeFileSync(join(runsDir, 'run-1', 'cases', 'case', 'desktop', 'diff.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(root, 'secret.png'), Buffer.from([137, 80, 78, 71]))

  const { overview, resolveArtifact } = await import('../core/panel.mjs')
  const data = overview([root])
  assert.equal(data.roots.length, 1)
  assert.deepEqual(data.roots[0].runs.map(run => run.runId), ['run-2', 'run-1'])
  assert.equal(data.roots[0].runs[0].iteration, 2)

  const allowed = resolveArtifact([root], join(runsDir, 'run-1', 'cases', 'case', 'desktop', 'diff.png'))
  assert.ok(allowed !== undefined, 'artifact inside a run is served')
  assert.equal(allowed.type, 'image/png')
  assert.equal(resolveArtifact([root], join(root, 'secret.png')), undefined)
  assert.equal(resolveArtifact([root], join(runsDir, 'run-1', 'manifest.json')), undefined)
})

await test('panel routes register on the web server', async () => {
  const { apply } = await import('../index.js')
  const registered = []
  const stub = {
    register(route) {
      registered.push(route)
      return () => {}
    },
  }
  apply({
    effect(callback) { callback() },
    tools: { register() {} },
    skills: { register() {} },
    get(name) { return name === 'webServer' ? stub : undefined },
  })
  const paths = registered.map(route => route.path).sort()
  assert.deepEqual(paths, [
    '/pixel-parity/approve',
    '/pixel-parity/artifact',
    '/pixel-parity/diagnose',
    '/pixel-parity/job',
    '/pixel-parity/overview',
    '/pixel-parity/run',
    '/pixel-parity/task/delete',
    '/pixel-parity/task/job',
    '/pixel-parity/task/report',
    '/pixel-parity/task/report-file',
    '/pixel-parity/task/step',
    '/pixel-parity/tasks',
  ])
  const overviewRoute = registered.find(route => route.path === '/pixel-parity/overview')
  const response = await overviewRoute.resource(new Request('http://local/pixel-parity/overview'), {})
  const body = await response.json()
  assert.ok(Array.isArray(body.roots))

  const panelRepo = mkdtempSync(join(tmpdir(), 'parity-panel-repo-'))
  mkdirSync(join(panelRepo, '.parity', 'runs'), { recursive: true })
  const scoped = await overviewRoute.resource(new Request(`http://local/pixel-parity/overview?repo=${encodeURIComponent(panelRepo)}`), {})
  assert.equal(scoped.status, 200)
  const scopedBody = await scoped.json()
  assert.equal(scopedBody.roots[0].root, panelRepo)
  const rejected = await overviewRoute.resource(new Request('http://local/pixel-parity/overview?repo=C%3A%5CWindows'), {})
  assert.equal(rejected.status, 400)

  const diagnoseRoute = registered.find(route => route.path === '/pixel-parity/diagnose')
  const runDir = join(panelRepo, '.parity', 'runs', 'r1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    version: 2,
    runId: 'r1',
    iteration: 1,
    cases: [{ id: 'one', status: 'verified', viewports: [{ viewportId: 'v', status: 'verified', geometry: { available: true, pass: true, tolerance: 1, anchors: [] }, styles: { available: true, pass: true, diffs: [] }, pixels: { pass: true, metrics: { mismatchRatio: 0 } } }] }],
  }))
  const diagnosed = await diagnoseRoute.resource(new Request(`http://local/pixel-parity/diagnose?runDir=${encodeURIComponent(runDir)}`), {})
  assert.equal(diagnosed.status, 200)
  const outside = await diagnoseRoute.resource(new Request('http://local/pixel-parity/diagnose?runDir=C%3A%5CWindows'), {})
  assert.equal(outside.status, 400)
  const jobRoute = registered.find(route => route.path === '/pixel-parity/job')
  const job = await jobRoute.resource(new Request('http://local/pixel-parity/job'), {})
  assert.ok((await job.json()) === null)
})

await test('QML generator maps 2D skew matrices to Matrix4x4', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 200, height: 100, dpr: 1 }, canvas: { width: 200, height: 100 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 200, h: 100 }, style: {},
      children: [{
        id: 'n2', tag: 'div', role: 'container', layout: { kind: 'block' },
        box: { x: 20, y: 10, w: 100, h: 40 },
        transformedSize: { width: '100px', height: '40px' },
        style: { backgroundColor: '#3366cc', transform: 'matrix(1, 0, 0.2, 1, 0, 0)' },
      }],
    },
  }
  const qml = generateQml(ir)
  assert.match(qml, /Matrix4x4/)
  assert.match(qml, /Qt\.matrix4x4\(1, 0, 0, 0, 0\.2, 1,/)
})

await test('alignment plan orders layers and includes mock guidance', async () => {
  const { buildAlignmentPlan } = await import('../core/plan.mjs')
  const manifest = {
    cases: [{
      id: 'c',
      viewports: [{
        viewportId: 'v',
        thresholds: { maxMismatch: 0.01 },
        geometry: { pass: true },
        styles: { pass: true },
        pixels: { pass: false, metrics: { mismatchRatio: 0.2 } },
      }],
    }],
  }
  const plan = buildAlignmentPlan({ viewports: [{ case: 'c', viewport: 'v', findings: [] }] }, manifest)
  assert.deepEqual(plan.steps.map(step => step.kind), ['structure', 'mock'])
  assert.match(plan.autonomy, /Do not ask the user/)
  assert.match(plan.steps[1].action, /fixtures or local mock data/)
})

await test('alignment plan puts geometry and styles before pixels', async () => {
  const { buildAlignmentPlan } = await import('../core/plan.mjs')
  const manifest = {
    cases: [{
      id: 'c',
      viewports: [{
        viewportId: 'v',
        thresholds: { maxMismatch: 0.01 },
        geometry: { pass: false },
        styles: { pass: false },
        pixels: { pass: false, metrics: { mismatchRatio: 0.2 } },
      }],
    }],
  }
  const findings = [
    { layer: 'geometry', anchor: 'sidebar', suggestion: 'fix width' },
    { layer: 'styles', anchor: 'sidebar', property: 'color', suggestion: 'fix color' },
  ]
  const plan = buildAlignmentPlan({ viewports: [{ case: 'c', viewport: 'v', findings }] }, manifest)
  assert.deepEqual(plan.steps.map(step => step.kind), ['geometry', 'style', 'pixels'])
})

await test('package and locale JSON files have no BOM', async () => {
  const root = join(here, '..')
  for (const file of ['package.json', 'locale/en.json', 'locale/zh.json']) {
    const bytes = readFileSync(join(root, file))
    assert.notEqual(bytes[0], 0xef, `${file} starts with a UTF-8 BOM`)
    assert.equal(bytes[0], 0x7b, `${file} must start with "{"`)
  }
})

await test('config rejects duplicate case ids', async () => {
  assert.throws(() => normalizeConfig({
    version: 2,
    viewports: [{ id: 'v', width: 100, height: 100 }],
    cases: [
      { id: 'dup', reference: { url: 'a.html' }, implementation: { url: 'b.html' } },
      { id: 'dup', reference: { url: 'a.html' }, implementation: { url: 'b.html' } },
    ],
  }, 'D:/tmp/parity.config.mjs'), /duplicate case id/)
})

await test('geometry flags a 4px offset and accepts equality', () => {
  const reference = { button: { rect: { x: 10, y: 20, w: 80, h: 30 } } }
  const same = { button: { rect: { x: 10, y: 20, w: 80, h: 30 } } }
  const shifted = { button: { rect: { x: 14, y: 20, w: 80, h: 30 } } }
  assert.equal(compareGeometry(reference, same).pass, true)
  const result = compareGeometry(reference, shifted)
  assert.equal(result.pass, false)
  assert.equal(result.anchors[0].delta.x, 4)
})

await test('geometry treats a missing anchor as a hard failure', () => {
  const reference = { button: { rect: { x: 0, y: 0, w: 10, h: 10 } } }
  const result = compareGeometry(reference, {})
  assert.equal(result.pass, false)
  assert.equal(result.anchors[0].missing, 'implementation')
})

await test('style values normalize colors, lengths, and font families', () => {
  assert.equal(normalizeStyleValue('color', 'rgb(17, 20, 27)'), '#11141B')
  assert.equal(normalizeStyleValue('color', 'rgba(17, 20, 27, 0.5)'), '#11141B@0.5')
  assert.equal(normalizeStyleValue('paddingTop', '12px'), 12)
  assert.equal(normalizeStyleValue('fontFamily', 'Inter, "Helvetica Neue", sans-serif'), 'inter')
})

await test('styles ignore the font family by default but report it as a warning', () => {
  const ref = { a: { styles: { color: 'rgb(0,0,0)', fontFamily: 'Inter, sans-serif' } } }
  const impl = { a: { styles: { color: '#000000', fontFamily: 'Arial, sans-serif' } } }
  const result = compareStyles(ref, impl)
  assert.equal(result.pass, true)
  assert.equal(result.warnings.length, 1)
})

await test('maskImage fills the requested rectangle on a copy', () => {
  const image = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(10) }
  image.data.fill(255)
  const masked = maskImage(image, [{ x: 1, y: 0, w: 2, h: 1 }], [0, 0, 0])
  assert.equal(masked.data[0], 255)
  assert.equal(masked.data[(0 * 4 + 1) * 4], 0)
  assert.equal(image.data[(0 * 4 + 1) * 4], 255, 'source image must stay untouched')
})

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'parity-init-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'demo-app',
    private: true,
    scripts: { dev: 'vite --port 4321' },
    dependencies: { vue: '^3.5.0' },
    devDependencies: { vite: '^6.0.0' },
  }))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'pages.js'), `export const pages = [
    { path: '/alpha', title: 'Alpha' },
    { path: '/beta', title: 'Beta' },
  ]`)
  return root
}

await test('generated HTML escapes quotes in font families', () => {
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 100, height: 50, dpr: 1 }, canvas: { width: 100, height: 50 }, truncated: false },
    tokens: {
      colors: {},
      radius: {},
      typography: { 'type.1': { fontFamily: 'Inter, "Microsoft YaHei", sans-serif', fontSize: '14px', fontWeight: '400', lineHeight: 'normal', letterSpacing: 'normal' } },
    },
    root: {
      id: 'n1',
      tag: 'body',
      role: 'container',
      layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 100, h: 50 },
      style: { typography: 'type.1' },
      textRuns: [{ text: 'hello', box: { x: 1, y: 1, w: 40, h: 16 } }],
    },
  }
  assert.deepEqual(validateIr(ir), [])
  const html = generateHtml(ir)
  assert.match(html, /&quot;Microsoft YaHei&quot;/)
  assert.doesNotMatch(html, /style="[^"]*Inter, "Microsoft/)
})

await test('QML generator emits a positioned snapshot', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 200, height: 100, dpr: 1 }, canvas: { width: 200, height: 100 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 200, h: 100 },
      style: { backgroundColor: '#ffffff' },
      children: [{
        id: 'n2', tag: 'div', role: 'container', layout: { kind: 'flex' },
        box: { x: 10, y: 10, w: 80, h: 40 },
        style: { backgroundColor: '#3366cc', borderRadius: '4px' },
        textRuns: [{ text: 'hi "qml"', box: { x: 16, y: 18, w: 30, h: 16 } }],
      }],
    },
  }
  const qml = generateQml(ir)
  assert.match(qml, /import QtQuick/)
  assert.match(qml, /Rectangle \{/)
  assert.match(qml, /x: 10/)
  assert.match(qml, /y: 10/)
  assert.match(qml, /width: 80/)
  assert.match(qml, /height: 40/)
  assert.match(qml, /Text \{/)
  assert.match(qml, /hi \\"qml\\"/)
  assert.match(qml, /color: "#ffffff"/)
})

await test('QML semantic mode maps sequential children to Column', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const child = (id, y) => ({
    id, tag: 'div', role: 'container', layout: { kind: 'block' },
    box: { x: 0, y, w: 100, h: 40 },
    style: { backgroundColor: '#eeeeee' },
  })
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 100, height: 100, dpr: 1 }, canvas: { width: 100, height: 100 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 100, h: 100 }, style: {},
      children: [child('n2', 0), child('n3', 50)],
    },
  }
  const qml = generateQml(ir, { semantic: true })
  assert.match(qml, /Column \{/)
  assert.match(qml, /spacing: 10/)
})

await test('QML semantic mode maps tables to Column/Row with column widths', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const cell = (id, x, w, text) => ({
    id, tag: 'td', role: 'text', layout: { kind: 'table' },
    box: { x, y: 0, w, h: 40 },
    style: {},
    textRuns: [{ text, box: { x: x + 4, y: 10, w: 30, h: 18 } }],
  })
  const row = (id, y, left, right) => ({
    id, tag: 'tr', role: 'container', layout: { kind: 'table' },
    box: { x: 0, y, w: 400, h: 40 },
    style: {},
    children: [cell(`${id}-a`, 0, 100, left), cell(`${id}-b`, 100, 300, right)],
  })
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 400, height: 200, dpr: 1 }, canvas: { width: 400, height: 200 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 400, h: 200 }, style: {},
      children: [{
        id: 'table', tag: 'table', role: 'table', layout: { kind: 'table', columnWidths: [100, 300] },
        box: { x: 0, y: 0, w: 400, h: 80 },
        style: {},
        children: [{
          id: 'tbody', tag: 'tbody', role: 'container', layout: { kind: 'table' },
          box: { x: 0, y: 0, w: 400, h: 80 }, style: {},
          children: [row('r1', 0, 'a', 'b'), row('r2', 40, 'c', 'd')],
        }],
      }],
    },
  }
  const qml = generateQml(ir, { semantic: true })
  assert.match(qml, /Column \{/)
  assert.match(qml, /Row \{/)
  assert.match(qml, /width: 400/)
})

await test('figmaToIr maps frames, auto-layout and text', async () => {
  const { figmaToIr } = await import('../core/figma.mjs')
  const document = {
    id: '0:1', type: 'FRAME', name: 'Root',
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [{
      id: '0:2', type: 'FRAME', name: 'Header',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 60 },
      layoutMode: 'HORIZONTAL', itemSpacing: 8,
      paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
      fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }],
      children: [{
        id: '0:3', type: 'TEXT', characters: 'Figma hello',
        absoluteBoundingBox: { x: 16, y: 20, width: 120, height: 20 },
        style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400, lineHeightPx: 20, letterSpacing: 0 },
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      }],
    }],
  }
  const ir = figmaToIr({ document })
  assert.equal(ir.source.viewport.width, 400)
  assert.equal(ir.source.viewport.height, 200)
  const nodes = flattenIr(ir.root)
  const header = nodes.find(node => node.layout.kind === 'flex')
  assert.ok(header !== undefined)
  assert.equal(header.layout.direction, 'row')
  assert.equal(header.layout.gap, '8px')
  const text = nodes.find(node => node.textRuns !== undefined)
  assert.equal(text.textRuns[0].text, 'Figma hello')
  assert.ok(Object.keys(ir.tokens.colors).length > 0)
  assert.deepEqual(validateIr(ir), [])
})

await test('QML semantic mode maps centered rows to anchors', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const child = (id, x) => ({
    id, tag: 'div', role: 'container', layout: { kind: 'block' },
    box: { x, y: 10, w: 40, h: 20 }, style: {},
  })
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 200, height: 100, dpr: 1 }, canvas: { width: 200, height: 100 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 200, h: 100 }, style: {},
      children: [{
        id: 'n2', tag: 'div', role: 'container',
        layout: { kind: 'flex', direction: 'row', justify: 'center', align: 'center' },
        box: { x: 0, y: 0, w: 200, h: 40 },
        style: { display: 'flex', flexDirection: 'row', justifyContent: 'center' },
        children: [child('n3', 60), child('n4', 100)],
      }],
    },
  }
  const qml = generateQml(ir, { semantic: true })
  assert.match(qml, /anchors\.horizontalCenter: parent\.horizontalCenter/)
})

await test('QML semantic mode treats space-between as start with uniform gaps', async () => {
  const { generateQml } = await import('../core/ir-qml.mjs')
  const child = (id, x) => ({
    id, tag: 'div', role: 'container', layout: { kind: 'block' },
    box: { x, y: 10, w: 40, h: 20 }, style: {},
  })
  const ir = {
    ir: '1.0',
    source: { kind: 'web', url: 'x', viewport: { width: 200, height: 100, dpr: 1 }, canvas: { width: 200, height: 100 }, truncated: false },
    tokens: { colors: {}, radius: {}, typography: {} },
    assets: { fonts: [] },
    root: {
      id: 'n1', tag: 'body', role: 'container', layout: { kind: 'block' },
      box: { x: 0, y: 0, w: 200, h: 100 }, style: {},
      children: [{
        id: 'n2', tag: 'div', role: 'container',
        layout: { kind: 'flex', direction: 'row', justify: 'space-between' },
        box: { x: 0, y: 0, w: 200, h: 40 },
        style: { display: 'flex', flexDirection: 'row', justifyContent: 'space-between' },
        children: [child('n3', 0), child('n4', 120)],
      }],
    },
  }
  const qml = generateQml(ir, { semantic: true })
  assert.match(qml, /Row \{/)
  assert.match(qml, /spacing: 80/)
})

await test('init detects framework, port, routes, and Playwright', () => {
  const repoRoot = createFixtureRepo()
  const detection = detectRepo(repoRoot)
  assert.equal(detection.framework, 'vue')
  assert.equal(detection.port, 4321)
  assert.equal(detection.portSource, 'script')
  assert.equal(detection.playwright, false)
  assert.deepEqual(detection.routes.map(route => route.path), ['/alpha', '/beta'])
})

await test('init tolerates a UTF-8 BOM in package.json', () => {
  const repoRoot = createFixtureRepo()
  const pkgPath = join(repoRoot, 'package.json')
  const text = readFileSync(pkgPath, 'utf8')
  writeFileSync(pkgPath, `\uFEFF${text}`, 'utf8')
  const detection = detectRepo(repoRoot)
  assert.equal(detection.framework, 'vue')
  assert.equal(detection.port, 4321)
})

await test('init writes a config draft that loads and points at the first route', async () => {
  const repoRoot = createFixtureRepo()
  const result = initRepo({ repoRoot })
  assert.equal(result.created, true)
  const config = await loadConfig(result.configPath)
  assert.equal(config.cases[0].implementation.url, 'http://127.0.0.1:4321/alpha')
  const source = readFileSync(result.configPath, 'utf8')
  assert.match(source, /REPLACE_WITH_REFERENCE_URL/)
  assert.match(source, /\/beta/)
})

await test('init refuses to overwrite without force', () => {
  const repoRoot = createFixtureRepo()
  assert.equal(initRepo({ repoRoot }).created, true)
  const second = initRepo({ repoRoot })
  assert.equal(second.created, false)
  assert.match(second.warnings[0], /already exists/)
  assert.equal(initRepo({ repoRoot, force: true }).created, true)
})

await test('init works through the parity_init tool and validates output', async () => {
  const installDir = process.env.DSH_INSTALL_DIR
  const { apply } = await import('../index.js')
  const registered = new Map()
  apply({
    effect(callback) { callback() },
    tools: { register(definition) { registered.set(definition.name, definition) } },
    skills: { register() {} },
  })
  const tool = registered.get('parity_init')
  assert.ok(tool !== undefined)
  const repoRoot = createFixtureRepo()
  const value = await tool.execute({ repo: repoRoot }, {})
  assert.equal(value.created, true)
  assert.equal(value.detected.port, 4321)
  assert.ok(value.detected.routes.includes('/alpha'))
  if (installDir !== undefined) {
    const require = createRequire(join(installDir, 'package.json'))
    const tools = require('@deepseek-ai/dsh-tools')
    tools.assertSupportedJsonSchema(tool.parameters)
    tools.assertSupportedJsonSchema(tool.output.schema)
    assert.deepEqual(tools.validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
  }
})

const repo = process.env.PARITY_REPO
if (repo === undefined) {
  results.push('skip end-to-end run: set PARITY_REPO to a repo that provides playwright')
} else {
  await test('fixtures make a data-driven page deterministic', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-fixtures-'))
    const withFixtures = await runConfig({
      configPath: join(here, 'fixtures', 'web', 'fixtures.config.mjs'),
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir: join(repoRoot, '.parity', 'runs', 'fixtures'),
    })
    assert.equal(withFixtures.manifest.cases[0].status, 'verified', JSON.stringify(withFixtures.manifest.cases[0].viewports[0].error))

    const noFixturesConfig = join(repoRoot, 'no-fixtures.config.mjs')
    writeFileSync(noFixturesConfig, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 300 }],
      cases: [{
        id: 'fixture',
        reference: { url: pathToFileURL(join(here, 'fixtures', 'web', 'fixture-ref.html')).href },
        implementation: { url: pathToFileURL(join(here, 'fixtures', 'web', 'fixture-impl.html')).href },
      }],
    })}`)
    const withoutFixtures = await runConfig({
      configPath: noFixturesConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir: join(repoRoot, '.parity', 'runs', 'no-fixtures'),
    })
    assert.equal(withoutFixtures.manifest.cases[0].status, 'failed')
    assert.ok(withoutFixtures.manifest.cases[0].viewports[0].pixels.metrics.mismatchRatio > 0.9)
  })

  await test('export-ir writes a valid IR and a generated page', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-ir-'))
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'ir'),
    })
    const viewport = result.manifest.cases.find(entry => entry.id === 'exact').viewports[0]
    assert.ok(viewport.ir !== undefined, JSON.stringify(viewport.error))
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    assert.deepEqual(validateIr(ir), [])
    assert.ok(viewport.ir.nodes > 5, `nodes ${viewport.ir.nodes}`)
    assert.equal(viewport.ir.truncated, false)
    const html = readFileSync(viewport.ir.generated, 'utf8')
    assert.match(html, /data-ir="/)
    assert.match(html, /AOI SPC/)
    assert.ok(viewport.ir.pins >= 0, `pins ${viewport.ir.pins}`)
    assert.ok(existsSync(viewport.ir.semantic), 'semantic render must exist')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /data-ir="/)
    const tableNode = flattenIr(ir.root).find(node => node.tag === 'table')
    assert.ok(tableNode !== undefined, 'fixture has a table')
    assert.ok(Array.isArray(tableNode.layout.columnWidths), 'table layout captures column widths')
    assert.equal(tableNode.layout.columnWidths.length, 3)
    assert.match(semantic, /<colgroup>/)
    const authoredNodes = flattenIr(ir.root).filter(node => node.authored !== undefined)
    assert.ok(authoredNodes.length > 0, 'authored sizes are captured')
    assert.ok(authoredNodes.some(node => node.authored.width === '80px' || node.authored.height !== undefined))
    assert.ok(Object.keys(ir.tokens.typography).length > 0, 'typography tokens must exist')
    const nodes = flattenIr(ir.root)
    assert.ok(nodes.some(node => typeof node.style.typography === 'string'), 'at least one node must reference a typography token')
    for (const node of nodes) {
      if (typeof node.style.typography === 'string') {
        assert.ok(ir.tokens.typography[node.style.typography] !== undefined, `unknown typography token ${node.style.typography}`)
      }
    }
    assert.match(html, /font-family:/)
  })

  await test('IR → HTML round-trip keeps boxes and text', async () => {
    const { createWebDriver } = await import('../adapters/web.mjs')
    const driver = await createWebDriver({ repoRoot: repo })
    const viewport = { width: 800, height: 600, dpr: 1 }
    const referenceUrl = pathToFileURL(join(here, 'fixtures', 'web', 'reference.html')).href
    const original = await driver.capture({ url: referenceUrl, viewport, exportDom: true })
    const ir = buildIr({ kind: 'web', url: referenceUrl, viewport, capturedAt: new Date().toISOString() }, original.dom)
    assert.deepEqual(validateIr(ir), [])
    const generated = join(mkdtempSync(join(tmpdir(), 'parity-ir-render-')), 'generated.html')
    writeFileSync(generated, generateHtml(ir))
    const rendered = await driver.capture({ url: pathToFileURL(generated).href, viewport, exportDom: true })
    await driver.dispose()

    const flattenDom = (node, out = []) => {
      out.push(node)
      for (const child of node.children ?? []) flattenDom(child, out)
      return out
    }
    const expectedNodes = new Map(flattenIr(ir.root).map(node => [node.id, node]))
    const generatedNodes = flattenDom(rendered.dom.root)
    const renderedBoxes = generatedNodes.filter(node => node.ir !== undefined)
    assert.equal(renderedBoxes.length, expectedNodes.size, 'every IR node must render one box')
    for (const box of renderedBoxes) {
      const node = expectedNodes.get(box.ir)
      assert.ok(node !== undefined, `unknown rendered node ${box.ir}`)
      for (const key of ['x', 'y', 'w', 'h']) {
        assert.ok(Math.abs(node.box[key] - box.box[key]) <= 1, `node ${node.id} (${node.tag}) ${key}: ${node.box[key]} vs ${box.box[key]}`)
      }
    }

    const expectedRuns = []
    for (const node of expectedNodes.values()) {
      for (const run of node.textRuns ?? []) expectedRuns.push({ id: node.id, run })
    }
    const renderedRuns = generatedNodes.filter(node => node.irRun !== undefined)
    assert.equal(renderedRuns.length, expectedRuns.length, 'every text run must render once')
    for (const [index, expected] of expectedRuns.entries()) {
      const actual = renderedRuns[index]
      assert.equal(actual.irRun, expected.id)
      const text = actual.textRuns?.[0]?.text ?? ''
      assert.equal(text, expected.run.text, `run ${index} text`)
      for (const key of ['x', 'y', 'w', 'h']) {
        assert.ok(Math.abs(expected.run.box[key] - actual.box[key]) <= 1, `run ${index} ${key}: ${expected.run.box[key]} vs ${actual.box[key]}`)
      }
      const node = expectedNodes.get(expected.id)
      const expectedStyle = expandStyle(node.style, ir.tokens)
      if (expectedStyle.fontFamily !== undefined) {
        assert.equal(actual.style.fontFamily, expectedStyle.fontFamily, `run ${index} font family`)
      }
    }
  })

  await test('semantic IR render preserves node boxes after size synthesis', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-ir-semantic-'))
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'semantic'),
    })
    const viewport = result.manifest.cases.find(entry => entry.id === 'exact').viewports[0]
    assert.ok(viewport.ir !== undefined, JSON.stringify(viewport.error))
    assert.equal(viewport.ir.over2, 0, `boxes over 2px: ${viewport.ir.over2} (pins ${viewport.ir.pins}, iterations ${viewport.ir.iterations})`)
    assert.ok(viewport.ir.within1 >= Math.floor(viewport.ir.nodes * 0.8), `within1 ${viewport.ir.within1} of ${viewport.ir.nodes}`)
    assert.ok(existsSync(viewport.ir.semantic))
  })

  await test('SVG geometry and paint survive the IR', async () => {
    const { createWebDriver } = await import('../adapters/web.mjs')
    const { generateSemanticHtml } = await import('../core/ir-html.mjs')
    const driver = await createWebDriver({ repoRoot: repo })
    const viewport = { width: 400, height: 200, dpr: 1 }
    const url = pathToFileURL(join(here, 'fixtures', 'web', 'svg-icon.html')).href
    const captured = await driver.capture({ url, viewport, exportDom: true })
    const ir = buildIr({ kind: 'web', url, viewport, capturedAt: new Date().toISOString() }, captured.dom)
    const circle = flattenIr(ir.root).find(node => node.tag === 'circle')
    assert.ok(circle !== undefined, 'circle node captured')
    assert.equal(circle.attributes?.cx, '20')
    assert.equal(circle.attributes?.r, '16')
    assert.ok(String(circle.style.fill ?? '').includes('77, 107, 254') || circle.style.fill === '#4D6BFE')

    const html = generateSemanticHtml(ir)
    assert.match(html, /<circle[^>]*cx="20"[^>]*r="16"/)
    assert.match(html, /fill:/)

    const renderedPath = join(mkdtempSync(join(tmpdir(), 'parity-svg-')), 'semantic.html')
    writeFileSync(renderedPath, html)
    const rendered = await driver.capture({ url: pathToFileURL(renderedPath).href, viewport, exportDom: true })
    await driver.dispose()
    const map = new Map()
    const walkDom = (node) => { if (node.ir) map.set(node.ir, node); for (const child of node.children ?? []) walkDom(child) }
    walkDom(rendered.dom.root)
    const got = map.get(circle.id)
    assert.ok(got !== undefined, 'circle rendered')
    assert.equal(got.box.w, circle.box.w)
    assert.equal(got.box.h, circle.box.h)
  })

  await test('font faces are captured and materialized next to the render', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-font-'))
    const configPath = join(repoRoot, 'font.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'font-face.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 200 }],
      cases: [{ id: 'font', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'font'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    assert.equal(ir.assets.fonts.length, 1)
    assert.equal(ir.assets.fonts[0].family, 'FixtureFont')
    assert.ok(ir.assets.fonts[0].src.startsWith('assets/fonts/'), ir.assets.fonts[0].src)
    assert.ok(existsSync(join(dirname(viewport.ir.path), ir.assets.fonts[0].src)), 'font file materialized')
    const html = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(html, /@font-face/)
    assert.match(html, /assets\/fonts\//)
  })

  await test('QML snapshot renders through qmlscene', async () => {
    const { findQmlScene } = await import('../adapters/qml.mjs')
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-qml-'))
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportQml: true,
      outDir: join(repoRoot, '.parity', 'runs', 'qml'),
    })
    const viewport = result.manifest.cases.find(entry => entry.id === 'exact').viewports[0]
    assert.ok(viewport.ir?.qml !== undefined, viewport.error)
    assert.ok(existsSync(viewport.ir.qml.path), 'generated.qml written')
    if (findQmlScene() === undefined) {
      assert.match(viewport.ir.qml.error ?? '', /qmlscene/)
      return
    }
    if (viewport.ir.qml.error !== undefined) {
      throw new Error(`QML render failed: ${viewport.ir.qml.error}`)
    }
    assert.ok(existsSync(viewport.ir.qml.screenshot), 'qml screenshot written')
    assert.equal(typeof viewport.ir.qml.mismatchRatio, 'number')
    assert.ok(viewport.ir.qml.mismatchRatio < 0.5, `QML mismatch ${viewport.ir.qml.mismatchRatio}`)
    assert.ok(viewport.ir.qml.semantic !== undefined, 'semantic QML artifact')
    assert.ok(existsSync(viewport.ir.qml.semantic.path))
    assert.match(readFileSync(viewport.ir.qml.semantic.path, 'utf8'), /Row|Column/)
    assert.ok(viewport.ir.qml.semantic.mismatchRatio < 0.5, `semantic QML mismatch ${viewport.ir.qml.semantic.mismatchRatio}`)
  })

  await test('Figma reference renders through the same pipeline', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-figma-'))
    const configPath = join(repoRoot, 'figma.config.mjs')
    const document = {
      id: '0:1', type: 'FRAME', name: 'Root',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      children: [{
        id: '0:2', type: 'TEXT', characters: 'Figma reference',
        absoluteBoundingBox: { x: 20, y: 20, width: 200, height: 24 },
        style: { fontFamily: 'Arial', fontSize: 16, fontWeight: 400, lineHeightPx: 24, letterSpacing: 0 },
        fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }],
      }],
    }
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'svg-icon.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 200 }],
      cases: [{ id: 'figma-case', reference: { kind: 'figma', document }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir: join(repoRoot, '.parity', 'runs', 'figma'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.notEqual(viewport.status, 'incomplete', viewport.error)
    assert.equal(viewport.driver.reference, 'figma')
    assert.ok(existsSync(join(repoRoot, '.parity', 'runs', 'figma', 'cases', 'figma-case', 'desktop', 'reference.ir.json')))
  })

  await test('images and background images are materialized', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-assets-'))
    const configPath = join(repoRoot, 'assets.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'assets.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 200, height: 100 }],
      cases: [{ id: 'assets', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'assets'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const caseDir = dirname(viewport.ir.path)
    const image = flattenIr(ir.root).find(node => node.tag === 'img')
    assert.ok(image.attributes.src.startsWith('assets/images/'), image.attributes.src)
    assert.ok(existsSync(join(caseDir, image.attributes.src)), 'image file materialized')
    const background = flattenIr(ir.root).find(node => node.style?.backgroundImage?.includes('assets/images/'))
    assert.ok(background !== undefined, 'background image rewritten')
    assert.match(readFileSync(viewport.ir.semantic, 'utf8'), /assets\/images\//)
  })

  await test('report summarizes a run without re-capturing', async () => {
    const { buildReport, renderReport, resolveRunDir } = await import('../core/report.mjs')
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-report-'))
    const outDir = join(repoRoot, '.parity', 'runs', 'report')
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir,
    })
    const report = buildReport(result.runDir)
    assert.equal(report.runDir, result.runDir)
    assert.equal(resolveRunDir(repoRoot), outDir)
    assert.equal(report.cases.length, result.manifest.cases.length)
    assert.equal(report.cases[0].id, 'exact')
    assert.equal(report.cases[0].viewports[0].status, result.manifest.cases[0].viewports[0].status)
    const text = renderReport(report)
    assert.match(text, /PixelParity report/)
    assert.match(text, /exact/)
    assert.match(text, /image-verified|verified/)
  })

  await test('start command launches and stops the dev server', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-start-'))
    const port = 4400 + Math.floor(Math.random() * 400)
    writeFileSync(join(repoRoot, 'reference.html'), readFileSync(join(here, 'fixtures', 'web', 'reference.html')))
    writeFileSync(join(repoRoot, 'server.js'), `const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const port = Number(process.argv[2])
const html = fs.readFileSync(path.join(__dirname, 'reference.html'))
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}).listen(port, '127.0.0.1')
`)
    const configPath = join(repoRoot, 'start.config.mjs')
    const page = pathToFileURL(join(repoRoot, 'reference.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 800, height: 600 }],
      targets: {
        implementation: {
          baseUrl: `http://127.0.0.1:${port}`,
          start: `node server.js ${port}`,
          startTimeoutMs: 20000,
        },
      },
      cases: [{ id: 'start', reference: { url: page }, implementation: { path: '/' } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir: join(repoRoot, 'run'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(['verified', 'image-verified'].includes(viewport.status), viewport.error)
    let alive = true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/`)
        await new Promise(resolve => setTimeout(resolve, 150))
      } catch {
        alive = false
        break
      }
    }
    assert.equal(alive, false, 'dev server should be stopped after the run')
  })

  await test('wrapped text is captured as one run per visual line', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-wrap-'))
    const configPath = join(repoRoot, 'wrap.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'wrapped.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 200 }],
      cases: [{ id: 'wrap', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'wrap'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const runs = flattenIr(ir.root).filter(node => (node.textRuns ?? []).length > 0).flatMap(node => node.textRuns)
    assert.ok(runs.length >= 2, `expected multiple line runs, got ${runs.length}`)
    const tops = new Set(runs.map(run => Math.round(run.box.y)))
    assert.ok(tops.size >= 2, 'lines have distinct y positions')
    assert.deepEqual(validateIr(ir), [])
    const { generateQml } = await import('../core/ir-qml.mjs')
    const qml = generateQml(ir)
    assert.ok((qml.match(/Text \{/g) ?? []).length >= 2, 'QML emits one Text per line')
  })

  await test('outline, filter and blend mode survive the IR', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-effects-'))
    const configPath = join(repoRoot, 'effects.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'effects.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 200 }],
      cases: [{ id: 'effects', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'effects'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const card = flattenIr(ir.root).find(node => Number.parseFloat(node.style?.outlineWidth ?? '0') >= 2)
    assert.ok(card !== undefined, 'outline captured')
    assert.match(card.style.outlineColor, /255, 0, 0|#ff0000/i)
    assert.match(card.style.filter, /blur/)
    assert.equal(card.style.mixBlendMode, 'multiply')
    assert.match(readFileSync(viewport.ir.semantic, 'utf8'), /outline/)
  })

  await test('pseudo elements are captured as generated children', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-pseudo-'))
    const configPath = join(repoRoot, 'pseudo.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'pseudo.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 200 }],
      cases: [{ id: 'pseudo', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'pseudo'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const nodes = flattenIr(ir.root)
    const before = nodes.find(node => node.pseudo === '::before')
    assert.ok(before !== undefined, '::before captured')
    assert.equal(before.style.width, '8px')
    const color = before.style.backgroundColor
    const resolved = color.startsWith('color.') ? ir.tokens.colors[color] : color
    assert.match(resolved, /34, ?197, ?94|22c55e/i)
    const after = nodes.find(node => node.pseudo === '::after')
    assert.ok(after !== undefined, '::after captured')
    assert.equal(after.textRuns[0].text, '★')
    const imagePseudo = nodes.find(node => node.pseudo === '::before' && node.style?.backgroundImage?.includes('assets/images/'))
    assert.ok(imagePseudo !== undefined, 'url() pseudo captured as a background image')
    const caseDir = dirname(viewport.ir.path)
    const imageUrl = /url\(['"]?([^'")]+)['"]?\)/.exec(imagePseudo.style.backgroundImage)[1]
    assert.ok(existsSync(join(caseDir, imageUrl)), 'pseudo image materialized')
    assert.deepEqual(validateIr(ir), [])
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /border-radius/)
    assert.match(semantic, /★/)
  })

  await test('canvas pixels are captured as an image asset', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-canvas-'))
    const configPath = join(repoRoot, 'canvas.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'canvas.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 200, height: 100 }],
      cases: [{ id: 'canvas', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'canvas'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const canvas = flattenIr(ir.root).find(node => node.tag === 'canvas')
    assert.ok(canvas !== undefined, 'canvas node captured')
    assert.ok(canvas.attributes.src.startsWith('assets/images/'), canvas.attributes.src)
    assert.ok(existsSync(join(dirname(viewport.ir.path), canvas.attributes.src)), 'canvas snapshot materialized')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /<img/)
    assert.match(semantic, /assets\/images\//)
  })

  await test('zero-size flex children are kept so their gap survives', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-zero-'))
    const configPath = join(repoRoot, 'zero.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'zero-spacer.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 200, height: 100 }],
      cases: [{ id: 'zero', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'zero'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const spacer = flattenIr(ir.root).find(node => node.box.w === 0 && node.box.h === 0)
    assert.ok(spacer !== undefined, 'zero-size spacer captured')
    assert.equal(viewport.ir.pins, 0, 'no pins needed once the spacer is present')
    assert.equal(viewport.ir.over2, 0, 'every box within 2px')
  })

  await test('transforms and grid item alignment survive the IR', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-transform-'))
    const configPath = join(repoRoot, 'transform.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'transform-grid.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 200, height: 100 }],
      cases: [{ id: 'transform', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportQml: true,
      outDir: join(repoRoot, '.parity', 'runs', 'transform'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const nodes = flattenIr(ir.root)
    const arrow = nodes.find(node => node.style?.transform !== undefined)
    assert.ok(arrow !== undefined, 'transform captured')
    assert.match(arrow.style.transform, /matrix/)
    const button = nodes.find(node => node.style?.justifyItems === 'center')
    assert.ok(button !== undefined, 'grid justify-items captured')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /transform:matrix/)
    assert.match(semantic, /justify-items:center/)
    assert.match(semantic, /width:7px/)
    assert.equal(viewport.ir.pins, 0, 'no pins needed')
    assert.equal(viewport.ir.over2, 0, 'every box within 2px')
    const qml = readFileSync(viewport.ir.qml.path, 'utf8')
    assert.match(qml, /rotation: 45/)
    assert.match(qml, /transformOrigin: Item\.Center/)
    const { findQmlScene } = await import('../adapters/qml.mjs')
    if (findQmlScene() !== undefined) {
      assert.equal(viewport.ir.qml.error, undefined, viewport.ir.qml.error)
    }
  })

  await test('video posters are materialized and rendered', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-video-'))
    const configPath = join(repoRoot, 'video.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'video.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 200, height: 100 }],
      cases: [{ id: 'video', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportQml: true,
      outDir: join(repoRoot, '.parity', 'runs', 'video'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const video = flattenIr(ir.root).find(node => node.tag === 'video')
    assert.ok(video !== undefined, 'video captured')
    assert.ok(video.attributes.poster.startsWith('assets/images/'), video.attributes.poster)
    assert.ok(existsSync(join(dirname(viewport.ir.path), video.attributes.poster)), 'poster materialized')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /<video/)
    assert.match(semantic, /poster="assets\/images\//)
    const qml = readFileSync(viewport.ir.qml.path, 'utf8')
    assert.match(qml, /assets\/images\//)
  })

  await test('shadow DOM content is captured through slots', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-shadow-'))
    const configPath = join(repoRoot, 'shadow.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'shadow.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 300, height: 150 }],
      cases: [{ id: 'shadow', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'shadow'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const nodes = flattenIr(ir.root)
    assert.ok(nodes.every(node => node.tag !== 'slot'), 'slot nodes are resolved away')
    const title = nodes.find(node => (node.textRuns ?? []).some(run => run.text.includes('Shadow title')))
    assert.ok(title !== undefined, 'slotted light-DOM text captured')
    const box = nodes.find(node => node.style?.backgroundColor !== undefined && node.box.w === 160)
    assert.ok(box !== undefined, 'shadow-root styled box captured')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    assert.match(semantic, /Shadow title/)
  })

  await test('text runs keep their position between element children', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-interleave-'))
    const configPath = join(repoRoot, 'interleave.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'interleave.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 300, height: 100 }],
      cases: [{ id: 'interleave', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'interleave'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir !== undefined, viewport.error)
    const ir = JSON.parse(readFileSync(viewport.ir.path, 'utf8'))
    const button = flattenIr(ir.root).find(node => (node.textRuns ?? []).some(run => run.text === 'Retry'))
    assert.ok(button !== undefined, 'button text captured')
    assert.equal(button.textRuns[0].afterChild, 1, 'text follows the icon child')
    const icon = flattenIr(ir.root).find(node => node.tag === 'i')
    assert.ok(icon !== undefined, 'icon child captured')
    const semantic = readFileSync(viewport.ir.semantic, 'utf8')
    const iconIndex = semantic.indexOf(`data-ir="${icon.id}"`)
    const retryIndex = semantic.indexOf('Retry')
    assert.ok(iconIndex >= 0 && retryIndex >= 0)
    assert.ok(iconIndex < retryIndex, 'icon renders before the label')
  })

  await test('QML maps background gradients and images', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-qmlbg-'))
    const configPath = join(repoRoot, 'qmlbg.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'qml-background.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 300, height: 200 }],
      cases: [{ id: 'qmlbg', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportQml: true,
      outDir: join(repoRoot, '.parity', 'runs', 'qmlbg'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir?.qml !== undefined, viewport.error)
    const qml = readFileSync(viewport.ir.qml.path, 'utf8')
    assert.match(qml, /gradient: Gradient \{/)
    assert.match(qml, /orientation: Gradient\.Horizontal/)
    assert.match(qml, /assets\/images\//)
    const { findQmlScene } = await import('../adapters/qml.mjs')
    if (findQmlScene() !== undefined) {
      assert.equal(viewport.ir.qml.error, undefined, viewport.ir.qml.error)
    }
  })

  await test('component export renders and records its pixel difference', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-component-'))
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['exact'],
      exportComponent: true,
      outDir: join(repoRoot, '.parity', 'runs', 'component'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir?.component !== undefined, viewport.error)
    const component = viewport.ir.component
    assert.ok(existsSync(component.html), 'component html written')
    assert.ok(existsSync(component.css), 'component css written')
    const html = readFileSync(component.html, 'utf8')
    const css = readFileSync(component.css, 'utf8')
    assert.match(html, /<body class="body-container">/)
    assert.doesNotMatch(html.replace(/<colgroup>[\s\S]*?<\/colgroup>/g, ''), /style="/, 'no inline node styles')
    assert.match(css, /:root \{/)
    assert.match(css, /var\(--/)
    assert.equal(typeof component.mismatchRatio, 'number', component.error)
    assert.ok(component.mismatchRatio < 0.05, `component mismatch ${component.mismatchRatio}`)
  })

  await test('component export extracts repeated subtrees into slots', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-repeat-'))
    const configPath = join(repoRoot, 'repeat.config.mjs')
    const page = pathToFileURL(join(here, 'fixtures', 'web', 'repeat.html')).href
    writeFileSync(configPath, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 400, height: 400 }],
      cases: [{ id: 'repeat', reference: { url: page }, implementation: { url: page } }],
    })}`)
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportComponent: true,
      outDir: join(repoRoot, '.parity', 'runs', 'repeat'),
    })
    const viewport = result.manifest.cases[0].viewports[0]
    assert.ok(viewport.ir?.component !== undefined, viewport.error)
    const component = viewport.ir.component
    assert.ok(existsSync(component.componentsJson), 'component inventory written')
    const inventory = JSON.parse(readFileSync(component.componentsJson, 'utf8'))
    assert.ok(inventory.components.length >= 1, 'at least one repeated component')
    const repeated = inventory.components.find(entry => entry.count >= 4)
    assert.ok(repeated !== undefined, 'cluster of four instances')
    assert.ok(repeated.slots.length >= 1, 'varying text becomes a slot')
    assert.ok(repeated.slots[0].samples.includes('Alpha'), JSON.stringify(repeated.slots[0]))
    assert.ok(Array.isArray(component.partials) && component.partials.length >= 1, 'partial written')
    const partial = readFileSync(component.partials[0], 'utf8')
    assert.match(partial, /\{\{text\d\}\}/)
  })

  await test('runs record iteration history and pixel deltas', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-history-'))
    const first = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['exact'],
      outDir: join(repoRoot, '.parity', 'runs', 'iteration-1'),
    })
    const second = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['exact'],
      outDir: join(repoRoot, '.parity', 'runs', 'iteration-2'),
    })
    assert.equal(first.manifest.iteration, 1)
    assert.equal(second.manifest.iteration, 2)
    assert.equal(second.manifest.parentRun.runId, first.manifest.runId)
    const delta = second.manifest.delta
    assert.ok(delta !== null && delta !== undefined, 'delta recorded')
    assert.equal(delta.viewports.length, 1)
    assert.equal(delta.viewports[0].previous, first.manifest.cases[0].viewports[0].pixels.metrics.mismatchRatio)

    const { diagnoseRun } = await import('../core/diagnose.mjs')
    const diagnosis = diagnoseRun(second.runDir)
    assert.equal(diagnosis.iteration, 2)
    assert.equal(diagnosis.viewports[0].case, 'exact')
    assert.equal(diagnosis.viewports[0].findings.filter(finding => finding.layer === 'geometry').length, 0)
  })

  await test('diagnose ranks geometry failures for the shifted case', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-diagnose-'))
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['shifted'],
      outDir: join(repoRoot, '.parity', 'runs', 'diagnose'),
    })
    const { diagnoseRun } = await import('../core/diagnose.mjs')
    const diagnosis = diagnoseRun(result.runDir)
    const viewport = diagnosis.viewports[0]
    assert.equal(viewport.status, 'failed')
    const geometry = viewport.findings.filter(finding => finding.layer === 'geometry')
    assert.ok(geometry.length >= 1, 'geometry finding present')
    assert.equal(geometry[0].anchor, 'query')
    assert.ok(Math.abs(geometry[0].delta.x) >= 4)
    assert.ok(viewport.next.length >= 1)
  })

  await test('interaction steps and iframe anchors are measured', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-interactions-'))
    const result = await runConfig({
      configPath: interactionConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      exportIr: true,
      outDir: join(repoRoot, '.parity', 'runs', 'interactions'),
    })
    const byId = id => result.manifest.cases.find(entry => entry.id === id)
    assert.equal(byId('steps').status, 'verified', 'steps reveal the panel before capture')
    assert.equal(byId('iframe').status, 'verified', 'iframe anchors are measured')
    const anchor = byId('iframe').viewports[0].geometry.anchors.find(entry => entry.id === 'inner')
    assert.ok(anchor.pass)
    assert.equal(anchor.actual.x, 50)
    assert.equal(anchor.actual.y, 70)

    const irPath = byId('iframe').viewports[0].ir.path
    const ir = JSON.parse(readFileSync(irPath, 'utf8'))
    const { flattenIr } = await import('../core/ir.mjs')
    const flat = flattenIr(ir.root)
    const frame = flat.find(node => node.tag === 'iframe')
    assert.ok(frame !== undefined, 'iframe node kept in the IR')
    assert.ok((frame.children ?? []).length > 0, 'iframe content captured')
    assert.ok(flat.some(node => (node.textRuns ?? []).some(run => run.text === 'inner')), 'iframe text captured')
  })

  await test('config normalizes interaction steps, storageState, and frame anchors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'parity-config-steps-'))
    const configPath = join(directory, 'parity.config.mjs')
    writeFileSync(configPath, `
      export default {
        version: 2,
        viewports: [{ id: 'desktop', width: 400, height: 200 }],
        targets: {
          implementation: {
            steps: [{ action: 'click', selector: '#go' }],
            storageState: './state.json',
            settle: { networkIdle: true, selector: '#ready', timeoutMs: 5000 },
          },
        },
        cases: [{
          id: 'one',
          reference: { url: './a.html' },
          implementation: { url: './b.html' },
          anchors: {
            inner: { ref: 'iframe >>> .box', impl: { selector: '.box', frame: 'iframe#f' } },
          },
        }],
      }
    `)
    const { loadConfig } = await import('../core/config.mjs')
    const config = await loadConfig(configPath)
    assert.deepEqual(config.cases[0].steps.ref, [])
    assert.equal(config.cases[0].steps.impl.length, 1)
    assert.equal(config.cases[0].steps.impl[0].action, 'click')
    assert.equal(config.cases[0].storageState.impl, join(directory, 'state.json'))
    assert.equal(config.cases[0].settle.impl.networkIdle, true)
    assert.equal(config.cases[0].settle.impl.selector, '#ready')
    assert.equal(config.cases[0].settle.impl.timeoutMs, 5000)
    assert.deepEqual(config.cases[0].anchors.inner.ref, { selector: '.box', frame: 'iframe' })
    assert.deepEqual(config.cases[0].anchors.inner.impl, { selector: '.box', frame: 'iframe#f' })
  })

  await test('login capture saves storageState after a URL condition', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((request, response) => {
      if (request.url === '/done') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html><body>done</body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=abc123; Path=/' })
      response.end('<html><body><script>setTimeout(() => { location.href = "/done" }, 150)</script></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const directory = mkdtempSync(join(tmpdir(), 'parity-login-'))
    const statePath = join(directory, 'state.json')
    try {
      const { captureLoginState } = await import('../adapters/web.mjs')
      const result = await captureLoginState({
        repoRoot: repo,
        url: `http://127.0.0.1:${port}/`,
        waitForUrl: '/done',
        headless: true,
        storageState: statePath,
      })
      assert.equal(result.url.endsWith('/done'), true)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.ok(state.cookies.some(cookie => cookie.name === 'session' && cookie.value === 'abc123'))
    } finally {
      server.close()
    }
  })

  await test('task creates, steps, and writes a report', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-task-'))
    const { createTask, stepTask, reportTask, listTasks, deleteTask } = await import('../core/task.mjs')
    const task = createTask({ repo: repoRoot, config: fixtureConfig, cases: ['exact'] })
    assert.equal(task.status, 'draft')
    const result = await stepTask({ id: task.id, dependenciesRoot: repo })
    assert.equal(result.task.iteration, 1)
    assert.equal(result.task.status, 'converged')
    const reportPath = reportTask(task.id)
    const checkpoint = JSON.parse(readFileSync(join(process.env.PIXEL_PARITY_TASK_DIR, task.id, 'checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.iteration, result.task.iteration)
    assert.ok(readFileSync(reportPath, 'utf8').includes('PixelParity task'))
    assert.equal(listTasks(repoRoot).length, 1)
    deleteTask(task.id)
    assert.equal(listTasks(repoRoot).length, 0)
  })

  await test('init detects the real repo workspace app and routes', () => {
    const detection = detectRepo(repo)
    assert.equal(detection.framework, 'vue')
    assert.equal(detection.port, 7620)
    assert.ok(detection.routes.some(route => route.path === '/projects'), JSON.stringify(detection.routes.slice(0, 5)))
    assert.equal(detection.playwright, true)
  })

  await test('end-to-end: exact passes, 4px shift fails geometry, masked data passes', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'parity-e2e-'))
    const result = await runConfig({ configPath: fixtureConfig, repoRoot: repo, outDir })
    const statuses = Object.fromEntries(result.manifest.cases.map(entry => [entry.id, entry.status]))
    assert.equal(statuses.exact, 'verified', JSON.stringify(statuses))
    assert.equal(statuses.masked, 'verified', JSON.stringify(statuses))
    assert.equal(statuses.shifted, 'failed', JSON.stringify(statuses))
    const shifted = result.manifest.cases.find(entry => entry.id === 'shifted').viewports[0]
    assert.equal(shifted.geometry.pass, false)
    const query = shifted.geometry.anchors.find(anchor => anchor.id === 'query')
    assert.equal(query.delta.x, 4)
    assert.ok(shifted.pixels.metrics.mismatchRatio < 0.01, 'pixels alone would not have caught the shift')
  })

  await test('run thresholds tolerate a shift and can tighten pixel tolerance', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-tolerance-'))
    const tolerant = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['shifted'],
      outDir: join(repoRoot, '.parity', 'runs', 'tolerant'),
      thresholds: { geometryTolerance: 4 },
    })
    const tolerantViewport = tolerant.manifest.cases[0].viewports[0]
    assert.equal(tolerantViewport.status, 'verified', tolerantViewport.error)
    assert.equal(tolerantViewport.geometry.tolerance, 4)

    const strict = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      caseIds: ['shifted'],
      outDir: join(repoRoot, '.parity', 'runs', 'strict'),
      thresholds: { geometryTolerance: 4, maxMismatch: 0.0005 },
    })
    const strictViewport = strict.manifest.cases[0].viewports[0]
    assert.equal(strictViewport.status, 'failed')
    assert.equal(strictViewport.pixels.pass, false)
  })

  await test('end-to-end: pin writes a baseline and baseline mode rejects a 4px regression', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-baseline-'))
    const pinned = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'pin',
      outDir: join(repoRoot, '.parity', 'runs', 'pin'),
    })
    assert.equal(pinned.manifest.decision.mode, 'pin')
    const pinnedStatuses = Object.fromEntries(pinned.manifest.cases.map(entry => [entry.id, entry.status]))
    assert.equal(pinnedStatuses.exact, 'verified')

    const baselineFile = join(repoRoot, '.parity', 'baselines', 'exact@desktop', 'baseline.json')
    assert.ok(existsSync(baselineFile), 'pin must write a baseline for the exact case')

    const regressionConfig = join(repoRoot, 'regression.config.mjs')
    writeFileSync(regressionConfig, `export default ${JSON.stringify({
      version: 2,
      viewports: [{ id: 'desktop', width: 800, height: 600 }],
      cases: [{
        id: 'exact',
        reference: { url: pathToFileURL(join(here, 'fixtures', 'web', 'reference.html')).href },
        implementation: { url: pathToFileURL(join(here, 'fixtures', 'web', 'implementation.html')).href },
        anchors: {
          header: { ref: '[data-parity="header"]', impl: '[data-parity="header"]' },
          query: { ref: '[data-parity="query"]', impl: '[data-parity="query"]' },
          table: { ref: '[data-parity="table"]', impl: '[data-parity="table"]' },
        },
      }],
    })}`)
    const regression = await runConfig({
      configPath: regressionConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'baseline',
      outDir: join(repoRoot, '.parity', 'runs', 'regression'),
    })
    const viewport = regression.manifest.cases[0].viewports[0]
    assert.equal(viewport.status, 'failed')
    const query = viewport.geometry.anchors.find(anchor => anchor.id === 'query')
    assert.equal(query.delta.x, 4)
  })

  await test('end-to-end: auto mode asks once and applies the answer', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-ask-'))
    let asked = 0
    const asked_with = []
    const result = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'auto',
      outDir: join(repoRoot, '.parity', 'runs', 'asked'),
      ask: async (context) => {
        asked += 1
        asked_with.push(...context.cases.map(entry => entry.id))
        return 'pin'
      },
    })
    assert.equal(asked, 1, 'the question must be asked once per run')
    assert.deepEqual(asked_with.sort(), ['exact', 'masked', 'shifted'])
    assert.equal(result.manifest.decision.mode, 'pin')
    assert.equal(result.manifest.decision.source, 'user')
    assert.ok(existsSync(join(repoRoot, '.parity', 'baselines', 'exact@desktop', 'baseline.json')))
  })

  await test('approve promotes verified viewports to baselines', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-approve-'))
    const run = await runConfig({
      configPath: fixtureConfig,
      repoRoot,
      dependenciesRoot: repo,
      baselineMode: 'ephemeral',
      outDir: join(repoRoot, '.parity', 'runs', 'approved'),
    })
    const result = approveRun({ repoRoot, runDir: run.runDir, note: 'initial approval' })
    assert.ok(result.approved.some(entry => entry.case === 'exact'))
    assert.ok(result.skipped.some(entry => entry.case === 'shifted'))
    const meta = JSON.parse(readFileSync(join(repoRoot, '.parity', 'baselines', 'exact@desktop', 'baseline.json'), 'utf8'))
    assert.equal(meta.source, undefined)
    assert.equal(meta.note, 'initial approval')
    assert.ok(meta.anchors.query !== undefined, 'baseline keeps the anchor snapshot')
  })

  await test('parity_run asks through userQuestions and applies the selected label', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'parity-uq-'))
    const { apply } = await import('../index.js')
    const registered = new Map()
    let request
    const ctx = {
      effect(callback) { callback() },
      tools: { register(definition) { registered.set(definition.name, definition) } },
      skills: { register() {} },
      get(name) {
        if (name !== 'userQuestions') return undefined
        return {
          async ask(input) {
            request = input
            return { answers: [{ id: 'baseline-mode', selected: ['对齐在线原型并固化基线'] }] }
          },
        }
      },
    }
    apply(ctx)
    const value = await registered.get('parity_run').execute({
      repo: repoRoot,
      dependencies: repo,
      config: fixtureConfig,
      cases: ['exact'],
      outputDir: join(repoRoot, 'out'),
    }, {})
    assert.equal(value.decision.mode, 'pin')
    assert.equal(value.decision.source, 'user')
    assert.equal(request.questions.length, 1)
    assert.equal(request.questions[0].options.length, 3)
    assert.match(request.questions[0].detail, /exact: .*reference\.html/)
    assert.ok(existsSync(join(repoRoot, '.parity', 'baselines', 'exact@desktop', 'baseline.json')))
  })

  await test('end-to-end: the parity_run tool schema and value pass the DSH validator', async () => {
    const installDir = process.env.DSH_INSTALL_DIR
    if (installDir === undefined) {
      results.push('skip tool schema validation: DSH_INSTALL_DIR is not set')
      return
    }
    const require = createRequire(join(installDir, 'package.json'))
    const tools = require('@deepseek-ai/dsh-tools')
    const { apply } = await import('../index.js')
    const registered = new Map()
    apply({
      effect(callback) { callback() },
      tools: { register(definition) { registered.set(definition.name, definition) } },
      skills: { register() {} },
    })
    const definition = registered.get('parity_run')
    assert.ok(definition !== undefined)
    assert.ok(registered.has('parity_approve'))
    tools.assertSupportedJsonSchema(definition.parameters)
    tools.assertSupportedJsonSchema(definition.output.schema)
    const approveTool = registered.get('parity_approve')
    tools.assertSupportedJsonSchema(approveTool.parameters)
    tools.assertSupportedJsonSchema(approveTool.output.schema)
    const outDir = mkdtempSync(join(tmpdir(), 'parity-tool-'))
    const value = await definition.execute({ repo, config: fixtureConfig, cases: ['exact'], outputDir: outDir }, {})
    const violations = tools.validateJsonSchemaValue(definition.output.schema, value, 'value')
    assert.deepEqual(violations, [])
    assert.equal(value.passed, true)
    assert.equal(value.decision.mode, 'ephemeral')

    const irValue = await definition.execute({
      repo,
      config: fixtureConfig,
      cases: ['exact'],
      outputDir: mkdtempSync(join(tmpdir(), 'parity-tool-ir-')),
      exportIr: true,
    }, {})
    assert.deepEqual(tools.validateJsonSchemaValue(definition.output.schema, irValue, 'value'), [])
    assert.ok(irValue.cases[0].viewports[0].ir !== undefined)

    const reportTool = registered.get('parity_report')
    assert.ok(reportTool !== undefined)
    tools.assertSupportedJsonSchema(reportTool.parameters)
    tools.assertSupportedJsonSchema(reportTool.output.schema)
    const reportValue = await reportTool.execute({ repo, runDir: value.runDir }, {})
    assert.deepEqual(tools.validateJsonSchemaValue(reportTool.output.schema, reportValue, 'value'), [])
    assert.equal(reportValue.cases[0].id, 'exact')

    const diagnoseTool = registered.get('parity_diagnose')
    assert.ok(diagnoseTool !== undefined)
    tools.assertSupportedJsonSchema(diagnoseTool.parameters)
    tools.assertSupportedJsonSchema(diagnoseTool.output.schema)
    const loginTool = registered.get('parity_login')
    assert.ok(loginTool !== undefined)
    tools.assertSupportedJsonSchema(loginTool.parameters)
    tools.assertSupportedJsonSchema(loginTool.output.schema)

    const alignTool = registered.get('parity_align')
    assert.ok(alignTool !== undefined)
    tools.assertSupportedJsonSchema(alignTool.parameters)
    tools.assertSupportedJsonSchema(alignTool.output.schema)
    const planValue = await alignTool.execute({ repo, runDir: value.runDir }, {})
    assert.deepEqual(tools.validateJsonSchemaValue(alignTool.output.schema, planValue, 'value'), [])
    assert.ok(Array.isArray(planValue.steps))

    const taskTool = registered.get('parity_task')
    assert.ok(taskTool !== undefined)
    tools.assertSupportedJsonSchema(taskTool.parameters)
    tools.assertSupportedJsonSchema(taskTool.output.schema)
    const taskRepo = mkdtempSync(join(tmpdir(), 'parity-task-tool-'))
    const createdTask = await taskTool.execute({ action: 'create', repo: taskRepo, config: fixtureConfig }, {})
    assert.deepEqual(tools.validateJsonSchemaValue(taskTool.output.schema, createdTask, 'value'), [])
    const diagnosisValue = await diagnoseTool.execute({ repo, runDir: value.runDir }, {})
    assert.deepEqual(tools.validateJsonSchemaValue(diagnoseTool.output.schema, diagnosisValue, 'value'), [])
  })
}

console.log(results.join('\n'))
console.log(`\n${results.filter(line => line.startsWith('ok')).length}/${results.length} passed`)
process.exitCode = failed > 0 ? 1 : 0



