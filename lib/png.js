/**
 * Minimal, dependency-free PNG codec for 8-bit, non-interlaced images.
 *
 * Chrome screenshots are always 8-bit PNGs, so the decoder is the hot path.
 * The encoder writes the diff image. Anything outside this subset (interlaced,
 * 16-bit) throws and the caller falls back to Electron's nativeImage.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Whether a buffer starts with the PNG signature. */
export function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(SIGNATURE)
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * Decode an 8-bit, non-interlaced PNG into straight-alpha RGBA.
 * @param {Buffer} buffer - PNG bytes.
 * @returns {{width: number, height: number, data: Uint8Array}} decoded image.
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG file')
  let offset = 8
  let header
  const idat = []
  let palette = null
  let transparency = null
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (header === undefined) throw new Error('PNG has no IHDR')
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported')
  if (header.bitDepth !== 8) throw new Error(`PNG bit depth ${header.bitDepth} is not supported`)
  const channels = CHANNELS[header.colorType]
  if (channels === undefined) throw new Error(`PNG color type ${header.colorType} is not supported`)
  if (idat.length === 0) throw new Error('PNG has no image data')

  const { width, height, colorType } = header
  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels)
  const data = new Uint8Array(width * height * 4)

  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels
    const target = i * 4
    if (colorType === 0) {
      const gray = raw[source]
      data[target] = gray
      data[target + 1] = gray
      data[target + 2] = gray
      data[target + 3] = 255
    } else if (colorType === 2) {
      data[target] = raw[source]
      data[target + 1] = raw[source + 1]
      data[target + 2] = raw[source + 2]
      data[target + 3] = 255
    } else if (colorType === 3) {
      if (palette === null) throw new Error('palette PNG has no PLTE chunk')
      const index = raw[source]
      data[target] = palette[index * 3]
      data[target + 1] = palette[index * 3 + 1]
      data[target + 2] = palette[index * 3 + 2]
      data[target + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255
    } else if (colorType === 4) {
      const gray = raw[source]
      data[target] = gray
      data[target + 1] = gray
      data[target + 2] = gray
      data[target + 3] = raw[source + 1]
    } else {
      data[target] = raw[source]
      data[target + 1] = raw[source + 1]
      data[target + 2] = raw[source + 2]
      data[target + 3] = raw[source + 3]
    }
  }
  return { width, height, data }
}

function unfilter(inflated, width, height, channels) {
  const stride = width * channels
  if (inflated.length < (stride + 1) * height) throw new Error('PNG image data is truncated')
  const out = Buffer.alloc(stride * height)
  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[position]
    position += 1
    const rowStart = y * stride
    const previousStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[position]
      position += 1
      const left = x >= channels ? out[rowStart + x - channels] : 0
      const up = y > 0 ? out[previousStart + x] : 0
      const upLeft = x >= channels && y > 0 ? out[previousStart + x - channels] : 0
      let restored
      if (filter === 0) restored = value
      else if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      else throw new Error(`PNG filter ${filter} is not supported`)
      out[rowStart + x] = restored & 0xff
    }
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Encode straight-alpha RGBA as an 8-bit RGBA PNG.
 * @param {number} width - image width.
 * @param {number} height - image height.
 * @param {Uint8Array} rgba - width * height * 4 bytes.
 * @returns {Buffer} PNG bytes.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    const row = y * stride
    for (let x = 0; x < stride; x += 1) raw[y * (stride + 1) + 1 + x] = rgba[row + x]
  }
  const compressed = deflateSync(raw, { level: 9 })
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
