/**
 * Image loading: PNG through the built-in codec, every other format through
 * Electron's nativeImage (the DSH host runs inside Electron's main process).
 * Both paths return straight-alpha RGBA composited onto white, so comparisons
 * never depend on a transparent background.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { decodePng, isPng } from './png.js'

let nativeImageCache
let nativeImageChecked = false

function electronNativeImage() {
  if (nativeImageChecked) return nativeImageCache
  nativeImageChecked = true
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron')
    if (electron !== null && typeof electron === 'object' && typeof electron.nativeImage?.createFromPath === 'function') {
      nativeImageCache = electron.nativeImage
    } else {
      nativeImageCache = undefined
    }
  } catch {
    nativeImageCache = undefined
  }
  return nativeImageCache
}

/**
 * Load an image file as opaque RGBA on a white background.
 * @param {string} filePath - absolute path to a PNG, JPEG, or WebP image.
 * @returns {{width: number, height: number, data: Uint8Array, format: string}} decoded image.
 */
export function loadImage(filePath) {
  const buffer = readFileSync(filePath)
  if (isPng(buffer)) {
    try {
      const decoded = decodePng(buffer)
      return { ...compositeOnWhite(decoded), format: 'png' }
    } catch (error) {
      const viaElectron = loadWithElectron(filePath)
      if (viaElectron !== undefined) return viaElectron
      throw new Error(`cannot decode ${filePath}: ${error.message}`)
    }
  }
  const viaElectron = loadWithElectron(filePath)
  if (viaElectron !== undefined) return viaElectron
  throw new Error(`unsupported image format for ${filePath}: PNG is decoded natively, JPEG/WebP need Electron's nativeImage`)
}

function loadWithElectron(filePath) {
  const nativeImage = electronNativeImage()
  if (nativeImage === undefined) return undefined
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const expected = size.width * size.height * 4
  if (bitmap.length < expected) throw new Error(`nativeImage returned ${bitmap.length} bytes, expected ${expected}`)
  const rgba = new Uint8Array(size.width * size.height * 4)
  for (let i = 0; i < size.width * size.height; i += 1) {
    const source = i * 4
    // Electron bitmaps are BGRA and premultiplied.
    const alpha = bitmap[source + 3]
    const unpremultiply = alpha === 0 ? 0 : 255 / alpha
    rgba[source] = clampByte(bitmap[source + 2] * unpremultiply)
    rgba[source + 1] = clampByte(bitmap[source + 1] * unpremultiply)
    rgba[source + 2] = clampByte(bitmap[source] * unpremultiply)
    rgba[source + 3] = alpha
  }
  return { ...compositeOnWhite({ width: size.width, height: size.height, data: rgba }), format: 'nativeImage' }
}

function clampByte(value) {
  const rounded = Math.round(value)
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded
}

/**
 * Flatten an RGBA image onto white and drop the alpha channel.
 * @param {{width: number, height: number, data: Uint8Array}} image - source image.
 * @returns {{width: number, height: number, data: Uint8Array}} opaque RGBA image.
 */
export function compositeOnWhite(image) {
  const { width, height, data } = image
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4
    const alpha = data[offset + 3]
    if (alpha === 255) {
      out[offset] = data[offset]
      out[offset + 1] = data[offset + 1]
      out[offset + 2] = data[offset + 2]
    } else {
      const weight = alpha / 255
      out[offset] = Math.round(data[offset] * weight + 255 * (1 - weight))
      out[offset + 1] = Math.round(data[offset + 1] * weight + 255 * (1 - weight))
      out[offset + 2] = Math.round(data[offset + 2] * weight + 255 * (1 - weight))
    }
    out[offset + 3] = 255
  }
  return { width, height, data: out }
}
