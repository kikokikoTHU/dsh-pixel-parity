/**
 * Orchestration for one parity check: render, decode, compare, report.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureScreenshot } from './browser.js'
import { loadImage } from './image.js'
import { compareImages } from './diff.js'
import { dominantColors } from './palette.js'
import { encodePng } from './png.js'

/**
 * Run a full parity check.
 * @param {{page: string, design: string, width: number, height: number, dpr: number, tolerance: number, maxMismatch: number, maxRegionMismatch: number, outputDir?: string}} args - validated arguments.
 * @param {{signal?: AbortSignal}} [exec] - tool execution context.
 * @returns {Promise<object>} canonical result matching the tool output schema.
 */
export async function runParityCheck(args, exec = {}) {
  const designPath = resolvePath(args.design)
  if (!existsSync(designPath)) throw new Error(`design image not found: ${args.design}`)
  const pageUrl = toPageUrl(args.page)

  const runDir = args.outputDir === undefined
    ? join(tmpdir(), 'pixel-parity', `run-${timestamp()}`)
    : resolvePath(args.outputDir)
  mkdirSync(runDir, { recursive: true })

  const screenshotPath = join(runDir, 'screenshot.png')
  const capture = await captureScreenshot({
    url: pageUrl,
    width: args.width,
    height: args.height,
    dpr: args.dpr,
    outPath: screenshotPath,
    signal: exec.signal,
  })

  const design = loadImage(designPath)
  const implementation = loadImage(screenshotPath)
  if (design.width !== implementation.width || design.height !== implementation.height) {
    throw new Error(describeSizeMismatch(design, implementation, args))
  }

  const { metrics, regions, diff } = compareImages(design, implementation, { tolerance: args.tolerance })
  const designPalette = dominantColors(design)
  const screenshotPalette = dominantColors(implementation)

  // A page that failed to load is usually one flat color while the design is not.
  const blank = screenshotPalette.dominantShare >= 0.995 && designPalette.dominantShare < 0.98
  const worstRegion = regions[0]
  const pass = !blank
    && metrics.mismatchRatio <= args.maxMismatch
    && (worstRegion === undefined || worstRegion.mismatchRatio <= args.maxRegionMismatch)

  const diffPath = join(runDir, 'diff.png')
  writeFileSync(diffPath, encodePng(metrics.width, metrics.height, diff))

  const reportPath = join(runDir, 'report.json')
  const report = {
    page: args.page,
    design: designPath,
    screenshot: screenshotPath,
    viewport: { width: args.width, height: args.height, dpr: args.dpr },
    metrics,
    regions,
    palette: designPalette,
    blank,
    pass,
    thresholds: { maxMismatch: args.maxMismatch, maxRegionMismatch: args.maxRegionMismatch },
    browser: capture.browser,
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  return {
    pass,
    verdict: buildVerdict({
      pass,
      blank,
      metrics,
      worstRegion,
      screenshotPalette,
      maxMismatch: args.maxMismatch,
      maxRegionMismatch: args.maxRegionMismatch,
    }),
    design: {
      path: designPath,
      width: design.width,
      height: design.height,
      palette: designPalette.colors,
    },
    screenshot: {
      path: screenshotPath,
      width: implementation.width,
      height: implementation.height,
      browser: capture.browser,
      uniform: screenshotPalette.dominantShare >= 0.995,
    },
    viewport: { width: args.width, height: args.height, dpr: args.dpr },
    metrics: {
      width: metrics.width,
      height: metrics.height,
      totalPixels: metrics.totalPixels,
      mismatchPixels: metrics.mismatchPixels,
      mismatchRatio: round(metrics.mismatchRatio, 6),
      meanDelta: round(metrics.meanDelta, 3),
      maxDelta: metrics.maxDelta,
      tolerance: metrics.tolerance,
      bounds: metrics.diffBounds ?? { x: 0, y: 0, w: 0, h: 0 },
    },
    regions: regions.map(region => ({
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      mismatchRatio: round(region.mismatchRatio, 6),
      meanDelta: round(region.meanDelta, 3),
    })),
    artifacts: { screenshot: screenshotPath, diff: diffPath, report: reportPath },
  }
}

function buildVerdict(input) {
  const { pass, blank, metrics, worstRegion, screenshotPalette, maxMismatch, maxRegionMismatch } = input
  const ratio = percent(metrics.mismatchRatio)
  const limit = percent(maxMismatch)
  if (blank) {
    return `FAIL: the screenshot is ${percent(screenshotPalette.dominantShare)} a single color and the design is not, so the page is blank or failed to load. ${ratio} of pixels differ (limit ${limit}).`
  }
  if (metrics.mismatchRatio > maxMismatch) {
    return `FAIL: ${ratio} of pixels differ from the design (limit ${limit}).`
  }
  if (worstRegion !== undefined && worstRegion.mismatchRatio > maxRegionMismatch) {
    return `FAIL: region (${worstRegion.x},${worstRegion.y}) ${worstRegion.w}x${worstRegion.h} is ${percent(worstRegion.mismatchRatio)} mismatched (limit ${percent(maxRegionMismatch)}), so the difference is concentrated rather than anti-aliasing noise.`
  }
  const worst = worstRegion === undefined ? 'none' : percent(worstRegion.mismatchRatio)
  return `PASS: ${ratio} of pixels differ (limit ${limit}); worst region ${worst} (limit ${percent(maxRegionMismatch)}).`
}

function resolvePath(input) {
  if (input.startsWith('file://')) return fileURLToPath(input)
  return isAbsolute(input) ? input : resolve(input)
}

function toPageUrl(input) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input
  const absolute = isAbsolute(input) ? input : resolve(input)
  if (!existsSync(absolute)) throw new Error(`page not found: ${input}`)
  return pathToFileURL(absolute).href
}

function describeSizeMismatch(design, implementation, args) {
  const expectedWidth = args.width * args.dpr
  const expectedHeight = args.height * args.dpr
  return [
    `size mismatch: design is ${design.width}x${design.height}px but the screenshot is ${implementation.width}x${implementation.height}px.`,
    `width x dpr must equal the design width: ${args.width} x ${args.dpr} = ${expectedWidth} (design ${design.width}); height x dpr = ${expectedHeight} (design ${design.height}).`,
    'Adjust width, height, or dpr to match the design; do not edit the design image.',
  ].join(' ')
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`
}
