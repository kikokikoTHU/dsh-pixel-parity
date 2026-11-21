/**
 * Dominant-color extraction for a design image.
 *
 * Models are bad at sampling exact hex values from a picture. Returning the most
 * common colors (with their share) gives the spec a measurable starting point and
 * also detects a screenshot that is one flat color because the page failed to load.
 */

/**
 * Count the most frequent colors of an opaque RGBA image.
 * @param {{width: number, height: number, data: Uint8Array}} image - decoded image.
 * @param {{limit?: number, minShare?: number}} [options] - how many colors and the minimum share.
 * @returns {{colors: {hex: string, share: number}[], dominantShare: number, distinct: number}} palette summary.
 */
export function dominantColors(image, options = {}) {
  const limit = options.limit ?? 8
  const minShare = options.minShare ?? 0.005
  const total = image.width * image.height
  const counts = new Map()
  const data = image.data
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1])
  const colors = sorted
    .slice(0, limit)
    .filter(([, count]) => count / total >= minShare)
    .map(([key, count]) => ({
      hex: `#${key.toString(16).padStart(6, '0').toUpperCase()}`,
      share: Math.round((count / total) * 10000) / 10000,
    }))
  return {
    colors,
    dominantShare: sorted.length === 0 ? 1 : sorted[0][1] / total,
    distinct: sorted.length,
  }
}
