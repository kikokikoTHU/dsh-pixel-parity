/**
 * v2 core tests: config normalization, G/S comparisons, masking, and one
 * end-to-end run over the web fixtures.
 *
 * The end-to-end part needs a repo that provides Playwright:
 *   PARITY_REPO=C:\path\to\repo ELECTRON_RUN_AS_NODE=1 <electron> test/v2.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const fixtureConfig = join(here, 'fixtures', 'web', 'parity.config.mjs')
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
      exportIr: true,
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
  })
}

console.log(results.join('\n'))
console.log(`\n${results.filter(line => line.startsWith('ok')).length}/${results.length} passed`)
process.exitCode = failed > 0 ? 1 : 0
