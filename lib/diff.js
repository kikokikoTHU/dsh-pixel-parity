/**
 * Pixel comparison of a design image and an implementation screenshot.
 *
 * A pixel is mismatched when any RGB channel differs by more than `tolerance`
 * (0-255). The report keeps a coarse grid so the caller can point at the
 * regions that are actually wrong instead of re-reading the whole image.
 */

const GRID_COLUMNS = 16
const GRID_ROWS = 16

/**
 * Compare two opaque RGBA images of identical size.
 * @param {{width: number, height: number, data: Uint8Array}} design - reference image.
 * @param {{width: number, height: number, data: Uint8Array}} implementation - rendered screenshot.
 * @param {{tolerance?: number}} [options] - per-channel threshold, 0-255.
 * @returns {{metrics: object, regions: object[], diff: Uint8Array}} metrics, worst regions, diff pixels.
 */
export function compareImages(design, implementation, options = {}) {
  const tolerance = options.tolerance ?? 24
  const { width, height } = design
  if (implementation.width !== width || implementation.height !== height) {
    throw new Error(`size mismatch: design is ${width}x${height}, screenshot is ${implementation.width}x${implementation.height}`)
  }

  const total = width * height
  const mask = new Uint8Array(total)
  let mismatched = 0
  let deltaSum = 0
  let maxDelta = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    const dr = Math.abs(design.data[offset] - implementation.data[offset])
    const dg = Math.abs(design.data[offset + 1] - implementation.data[offset + 1])
    const db = Math.abs(design.data[offset + 2] - implementation.data[offset + 2])
    const delta = Math.max(dr, dg, db)
    deltaSum += delta
    if (delta > maxDelta) maxDelta = delta
    if (delta > tolerance) {
      mismatched += 1
      mask[index] = 1
      const x = index % width
      const y = (index - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const cellWidth = Math.max(1, Math.ceil(width / GRID_COLUMNS))
  const cellHeight = Math.max(1, Math.ceil(height / GRID_ROWS))
  const regions = []
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const y = row * cellHeight
    if (y >= height) break
    const h = Math.min(cellHeight, height - y)
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x = column * cellWidth
      if (x >= width) break
      const w = Math.min(cellWidth, width - x)
      let count = 0
      let sum = 0
      for (let yy = y; yy < y + h; yy += 1) {
        const line = yy * width
        for (let xx = x; xx < x + w; xx += 1) {
          if (mask[line + xx] === 1) count += 1
          const offset = (line + xx) * 4
          const delta = Math.max(
            Math.abs(design.data[offset] - implementation.data[offset]),
            Math.abs(design.data[offset + 1] - implementation.data[offset + 1]),
            Math.abs(design.data[offset + 2] - implementation.data[offset + 2]),
          )
          sum += delta
        }
      }
      const area = w * h
      regions.push({
        x,
        y,
        w,
        h,
        mismatchRatio: count / area,
        meanDelta: sum / area,
        mismatchPixels: count,
      })
    }
  }

  const worst = regions
    .filter(region => region.mismatchPixels > 0)
    .sort((left, right) => right.mismatchRatio - left.mismatchRatio
      || right.meanDelta - left.meanDelta)
    .slice(0, 5)

  return {
    metrics: {
      width,
      height,
      tolerance,
      totalPixels: total,
      mismatchPixels: mismatched,
      mismatchRatio: mismatched / total,
      meanDelta: deltaSum / total,
      maxDelta,
      diffBounds: mismatched === 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    },
    regions: worst,
    diff: buildDiffImage(design, implementation, mask),
  }
}

function buildDiffImage(design, implementation, mask) {
  const { width, height } = design
  const out = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    if (mask[index] === 1) {
      out[offset] = 220
      out[offset + 1] = 38
      out[offset + 2] = 38
    } else {
      // Dim the design so the red mismatch marks stay the brightest thing on the page.
      out[offset] = Math.round(design.data[offset] * 0.35)
      out[offset + 1] = Math.round(design.data[offset + 1] * 0.35)
      out[offset + 2] = Math.round(design.data[offset + 2] * 0.35)
    }
    out[offset + 3] = 255
  }
  return out
}
