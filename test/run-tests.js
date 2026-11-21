/**
 * End-to-end checks for the parity engine, run without a test framework:
 *   ELECTRON_RUN_AS_NODE=1 <electron> test/run-tests.js
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodePng, decodePng } from '../lib/png.js'
import { compareImages } from '../lib/diff.js'
import { dominantColors } from '../lib/palette.js'
import { runParityCheck } from '../lib/check.js'

const results = []
async function test(name, body) {
  try {
    await body()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}

await test('png encode/decode round-trip preserves pixels', () => {
  const width = 37
  const height = 19
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (i * 7) % 256
    rgba[i * 4 + 1] = (i * 13) % 256
    rgba[i * 4 + 2] = (i * 29) % 256
    rgba[i * 4 + 3] = 255
  }
  const decoded = decodePng(encodePng(width, height, rgba))
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual(Array.from(decoded.data), Array.from(rgba))
})

await test('identical images compare as a full match', () => {
  const width = 20
  const height = 10
  const data = new Uint8Array(width * height * 4).fill(200)
  const image = { width, height, data }
  const { metrics, regions } = compareImages(image, image, { tolerance: 24 })
  assert.equal(metrics.mismatchPixels, 0)
  assert.equal(metrics.mismatchRatio, 0)
  assert.equal(regions.length, 0)
})

await test('palette reports the dominant colors', () => {
  const width = 10
  const height = 10
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const color = i < 90 ? [255, 255, 255] : [30, 102, 255]
    data[i * 4] = color[0]
    data[i * 4 + 1] = color[1]
    data[i * 4 + 2] = color[2]
    data[i * 4 + 3] = 255
  }
  const palette = dominantColors({ width, height, data })
  assert.equal(palette.colors[0].hex, '#FFFFFF')
  assert.equal(palette.distinct, 2)
  assert.ok(palette.colors.some(color => color.hex === '#1E66FF'))
})

function makeDesign(width, height) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      let color = [255, 255, 255]
      if (x >= 30 && x < 130 && y >= 40 && y < 100) color = [30, 102, 255]
      if (x >= 150 && x < 270 && y >= 120 && y < 140) color = [17, 20, 27]
      data[offset] = color[0]
      data[offset + 1] = color[1]
      data[offset + 2] = color[2]
      data[offset + 3] = 255
    }
  }
  return data
}

function makeSparseDesign(width, height) {
  const data = new Uint8Array(width * height * 4).fill(255)
  for (let y = 10; y < 30; y += 1) {
    for (let x = 10; x < 30; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = 220
      data[offset + 1] = 38
      data[offset + 2] = 38
    }
  }
  return data
}

function writeFixture(dir, { data, html }) {
  const width = 320
  const height = 200
  const designPath = join(dir, 'design.png')
  writeFileSync(designPath, encodePng(width, height, data(width, height)))
  const pagePath = join(dir, 'page.html')
  writeFileSync(pagePath, html)
  return { designPath, pagePath, width, height }
}

const exactHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #fff; }
  .block { position: absolute; left: 30px; top: 40px; width: 100px; height: 60px; background: #1e66ff; }
  .bar { position: absolute; left: 150px; top: 120px; width: 120px; height: 20px; background: #11141b; }
</style></head>
<body><div class="block"></div><div class="bar"></div></body></html>`

const shiftedHtml = exactHtml.replace('left: 30px', 'left: 36px')

const blankHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #fff; }
</style></head><body></body></html>`

const baseDir = mkdtempSync(join(tmpdir(), 'pixel-parity-test-'))
const exact = writeFixture(baseDir, { data: makeDesign, html: exactHtml })
const shifted = writeFixture(mkdtempSync(join(tmpdir(), 'pixel-parity-shift-')), { data: makeDesign, html: shiftedHtml })
const blank = writeFixture(mkdtempSync(join(tmpdir(), 'pixel-parity-blank-')), { data: makeDesign, html: blankHtml })
const sparse = writeFixture(mkdtempSync(join(tmpdir(), 'pixel-parity-sparse-')), { data: makeSparseDesign, html: blankHtml })

function check(fixture, outputDir) {
  return runParityCheck({
    page: pathToFileURL(fixture.pagePath).href,
    design: fixture.designPath,
    width: fixture.width,
    height: fixture.height,
    dpr: 1,
    tolerance: 24,
    maxMismatch: 0.01,
    maxRegionMismatch: 0.4,
    outputDir: join(baseDir, outputDir),
  })
}

await test('a matching page passes with no mismatched pixels', async () => {
  const result = await check(exact, 'run-exact')
  assert.equal(result.pass, true, result.verdict)
  assert.equal(result.metrics.mismatchPixels, 0, result.verdict)
  assert.equal(result.screenshot.width, exact.width)
  assert.equal(result.screenshot.uniform, false)
  assert.ok(result.design.palette.some(color => color.hex === '#1E66FF'), JSON.stringify(result.design.palette))
})

await test('a 6px shift fails and names the shifted region', async () => {
  const result = await check(shifted, 'run-shift')
  assert.equal(result.pass, false, result.verdict)
  assert.ok(result.metrics.mismatchRatio > 0.01, `ratio ${result.metrics.mismatchRatio}`)
  const leftStrip = result.regions.some(region => region.x <= 40)
  const rightStrip = result.regions.some(region => region.x >= 120 && region.x <= 160)
  assert.ok(leftStrip && rightStrip, `regions ${JSON.stringify(result.regions.map(region => region.x))}`)
})

await test('a blank page fails as a uniform capture instead of passing', async () => {
  const result = await check(blank, 'run-blank')
  assert.equal(result.pass, false, result.verdict)
  assert.equal(result.screenshot.uniform, true)
  assert.match(result.verdict, /blank|single color/i)
})

await test('a small missing element fails the region budget even when the overall ratio passes', async () => {
  const result = await check(sparse, 'run-sparse')
  assert.ok(result.metrics.mismatchRatio <= 0.01, `ratio ${result.metrics.mismatchRatio}`)
  assert.equal(result.pass, false, result.verdict)
  assert.match(result.verdict, /region/)
})

await test('size mismatch is rejected with an explicit message', async () => {
  await assert.rejects(
    runParityCheck({
      page: pathToFileURL(exact.pagePath).href,
      design: exact.designPath,
      width: 160,
      height: 100,
      dpr: 1,
      tolerance: 24,
      maxMismatch: 0.01,
      maxRegionMismatch: 0.4,
      outputDir: join(baseDir, 'run-size'),
    }),
    /size mismatch/,
  )
})

await test('plugin registers the tool and skill, and the tool executes end to end', async () => {
  const { apply } = await import('../index.js')
  const registered = new Map()
  let skill
  const ctx = {
    effect(callback) { callback() },
    tools: { register(definition) { registered.set(definition.name, definition) } },
    skills: { register(definition) { skill = definition } },
  }
  apply(ctx)
  const tool = registered.get('parity_check')
  assert.ok(tool !== undefined, 'parity_check must be registered')
  assert.ok(registered.has('parity_run'), 'parity_run must be registered')
  assert.equal(skill.name, 'pixel-parity')
  assert.ok(skill.content.includes('parity_run'))
  const value = await tool.execute({
    page: pathToFileURL(exact.pagePath).href,
    design: exact.designPath,
    width: exact.width,
    height: exact.height,
    outputDir: join(baseDir, 'run-plugin'),
  }, {})
  assert.equal(value.pass, true, value.verdict)
  assert.equal(value.metrics.tolerance, 24)
  for (const key of ['pass', 'verdict', 'design', 'screenshot', 'viewport', 'metrics', 'regions', 'artifacts']) {
    assert.ok(key in value, `missing ${key}`)
  }
  const text = tool.output.render({}, value)
  assert.equal(text[0].type, 'text')
  assert.match(text[0].text, /PASS/)
  assert.match(text[0].text, /Design palette/)
})

await test('tool schemas pass the DSH schema validator and the output validates', async () => {
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir === undefined) {
    results.push('skip schema validation: DSH_INSTALL_DIR is not set')
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
  const tool = registered.get('parity_check')
  tools.assertSupportedJsonSchema(tool.parameters)
  tools.assertSupportedJsonSchema(tool.output.schema)
  const value = await tool.execute({
    page: pathToFileURL(exact.pagePath).href,
    design: exact.designPath,
    width: exact.width,
    height: exact.height,
    outputDir: join(baseDir, 'run-schema'),
  }, {})
  const violations = tools.validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [])
})

console.log(results.join('\n'))
console.log(`\n${results.filter(line => line.startsWith('ok')).length}/${results.length} passed`)
