/**
 * G/S/P judgment for parity v2.
 *
 * G (geometry) and S (styles) need anchors captured from a DOM surface.
 * P (pixels) works on any two same-sized images and is available for every
 * surface, including a plain design image reference.
 */

import { compareImages } from '../lib/diff.js'

/** Round to a stable number of decimals for reporting. */
function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Compare anchor boxes between reference and implementation.
 * @param {Record<string, {rect: {x: number, y: number, w: number, h: number}} | null>} reference - anchors by id.
 * @param {Record<string, {rect: {x: number, y: number, w: number, h: number}} | null>} implementation - anchors by id.
 * @param {number} tolerancePx - allowed absolute delta per edge.
 * @returns {{pass: boolean, tolerance: number, anchors: object[]}} geometry result.
 */
export function compareGeometry(reference, implementation, tolerancePx = 1) {
  const anchors = []
  let pass = true
  for (const id of Object.keys(reference ?? {})) {
    const expected = reference[id]
    const actual = implementation?.[id]
    if (expected == null || actual == null) {
      pass = false
      anchors.push({
        id,
        pass: false,
        missing: expected == null ? 'reference' : 'implementation',
      })
      continue
    }
    const delta = {
      x: round(actual.rect.x - expected.rect.x),
      y: round(actual.rect.y - expected.rect.y),
      w: round(actual.rect.w - expected.rect.w),
      h: round(actual.rect.h - expected.rect.h),
    }
    const anchorPass = Math.abs(delta.x) <= tolerancePx
      && Math.abs(delta.y) <= tolerancePx
      && Math.abs(delta.w) <= tolerancePx
      && Math.abs(delta.h) <= tolerancePx
    if (!anchorPass) pass = false
    anchors.push({
      id,
      pass: anchorPass,
      expected: expected.rect,
      actual: actual.rect,
      delta,
    })
  }
  return { pass, tolerance: tolerancePx, anchors }
}

const COLOR_PROPERTIES = new Set(['color', 'backgroundColor', 'borderTopColor'])

/**
 * Normalize one computed-style value for comparison.
 * @param {string} property - CSS property name.
 * @param {string} value - computed value.
 * @returns {string | number} normalized value.
 */
export function normalizeStyleValue(property, value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (COLOR_PROPERTIES.has(property)) return normalizeColor(trimmed)
  if (property === 'fontFamily') return trimmed.split(',')[0].replace(/["']/g, '').trim().toLowerCase()
  if (/^-?\d*\.?\d+px$/.test(trimmed)) return round(Number.parseFloat(trimmed))
  if (property === 'boxShadow') return trimmed.replace(/\s+/g, ' ')
  return trimmed
}

function normalizeColor(value) {
  const match = /^rgba?\(([^)]+)\)$/.exec(value)
  if (match === null) return value.toLowerCase()
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  const [red, green, blue, alpha = 1] = parts
  if ([red, green, blue].some(part => !Number.isFinite(part))) return value.toLowerCase()
  const hex = `#${[red, green, blue].map(part => Math.round(part).toString(16).padStart(2, '0')).join('').toUpperCase()}`
  return alpha >= 0.995 ? hex : `${hex}@${round(alpha, 2)}`
}

/**
 * Compare normalized computed styles for shared anchors.
 * @param {Record<string, {styles: Record<string, string>} | null>} reference - anchors by id.
 * @param {Record<string, {styles: Record<string, string>} | null>} implementation - anchors by id.
 * @param {{ignore?: string[]}} [options] - properties excluded from the pass decision.
 * @returns {{pass: boolean, diffs: object[], warnings: object[]}} style result.
 */
export function compareStyles(reference, implementation, options = {}) {
  const ignore = new Set(options.ignore ?? ['fontFamily'])
  const diffs = []
  const warnings = []
  for (const id of Object.keys(reference ?? {})) {
    const expected = reference[id]
    const actual = implementation?.[id]
    if (expected == null || actual == null) continue
    for (const property of Object.keys(expected.styles)) {
      const expectedValue = normalizeStyleValue(property, expected.styles[property])
      const actualValue = normalizeStyleValue(property, actual.styles[property])
      if (String(expectedValue) === String(actualValue)) continue
      const entry = { id, property, expected: expectedValue, actual: actualValue }
      if (ignore.has(property)) warnings.push(entry)
      else diffs.push(entry)
    }
  }
  return { pass: diffs.length === 0, diffs, warnings }
}

/**
 * Compare pixels after masking dynamic regions on each side.
 * @param {{width: number, height: number, data: Uint8Array}} reference - reference image.
 * @param {{width: number, height: number, data: Uint8Array}} implementation - implementation image.
 * @param {{tolerance: number, maxMismatch: number, maxRegionMismatch: number, referenceMasks?: object[], implementationMasks?: object[], maskColor?: number[]}} options - thresholds and masks.
 * @returns {{pass: boolean, metrics: object, regions: object[], diff: Uint8Array, masks: object}} pixel result.
 */
export function comparePixels(reference, implementation, options) {
  if (reference.width !== implementation.width || reference.height !== implementation.height) {
    throw new Error(`size mismatch: reference is ${reference.width}x${reference.height}, implementation is ${implementation.width}x${implementation.height}`)
  }
  const referenceMasks = options.referenceMasks ?? []
  const implementationMasks = options.implementationMasks ?? []
  const maskedReference = maskImage(reference, referenceMasks, options.maskColor)
  const maskedImplementation = maskImage(implementation, implementationMasks, options.maskColor)
  const { metrics, regions, diff } = compareImages(maskedReference, maskedImplementation, { tolerance: options.tolerance })
  const worst = regions[0]
  const pass = metrics.mismatchRatio <= options.maxMismatch
    && (worst === undefined || worst.mismatchRatio <= options.maxRegionMismatch)
  return {
    pass,
    metrics,
    regions,
    diff,
    masks: {
      reference: referenceMasks.length,
      implementation: implementationMasks.length,
    },
  }
}

/**
 * Fill rectangles with a flat color so both sides ignore dynamic content.
 * @param {{width: number, height: number, data: Uint8Array}} image - source image.
 * @param {{x: number, y: number, w: number, h: number}[]} rects - pixel rectangles.
 * @param {number[]} [color] - RGB fill, white by default.
 * @returns {{width: number, height: number, data: Uint8Array}} masked copy.
 */
export function maskImage(image, rects, color = [255, 255, 255]) {
  if (rects.length === 0) return image
  const data = new Uint8Array(image.data)
  for (const rect of rects) {
    const startX = Math.max(0, Math.floor(rect.x))
    const startY = Math.max(0, Math.floor(rect.y))
    const endX = Math.min(image.width, Math.ceil(rect.x + rect.w))
    const endY = Math.min(image.height, Math.ceil(rect.y + rect.h))
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * image.width + x) * 4
        data[offset] = color[0]
        data[offset + 1] = color[1]
        data[offset + 2] = color[2]
        data[offset + 3] = 255
      }
    }
  }
  return { width: image.width, height: image.height, data }
}
