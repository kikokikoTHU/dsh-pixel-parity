/**
 * Figma → IR.
 *
 * Accepts either a full `GET /v1/files/:key/nodes` payload or a bare document
 * node, and produces the same IR the web capture produces. Text, frames, fills,
 * auto-layout (horizontal/vertical), padding, gaps and corner radius are mapped;
 * vectors and image fills are left as plain boxes for now.
 */

import { buildIr } from './ir.mjs'

/**
 * Convert a Figma node payload into an IR document.
 * @param {object} payload - API payload (`{ nodes: { [id]: { document } } }`) or a document.
 * @param {{nodeId?: string, fileKey?: string}} options - which node to extract.
 * @returns {object} IR document.
 */
export function figmaToIr(payload, options = {}) {
  const document = extractDocument(payload, options.nodeId)
  const bounds = document.absoluteBoundingBox ?? { x: 0, y: 0, width: 1440, height: 900 }
  const root = convertNode(document, bounds, true)
  const viewport = { width: Math.round(bounds.width), height: Math.round(bounds.height), dpr: 1 }
  return buildIr({
    kind: 'figma',
    url: options.fileKey === undefined ? 'figma' : `figma://${options.fileKey}/${document.id}`,
    viewport,
    capturedAt: new Date().toISOString(),
  }, { root, fonts: [], truncated: false })
}

function extractDocument(payload, nodeId) {
  if (payload?.nodes !== undefined) {
    const entry = nodeId === undefined ? Object.values(payload.nodes)[0] : payload.nodes[nodeId]
    if (entry?.document === undefined) throw new Error(`Figma payload has no node ${JSON.stringify(nodeId)}`)
    return entry.document
  }
  if (payload?.document !== undefined) return payload.document
  if (payload?.type !== undefined) return payload
  throw new Error('unsupported Figma payload: expected a document or a nodes map')
}

function convertNode(node, rootBounds, isRoot = false) {
  const box = node.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const style = buildStyle(node)
  const result = {
    tag: tagOf(node),
    box: {
      x: round(box.x - rootBounds.x),
      y: round(box.y - rootBounds.y),
      w: round(box.width),
      h: round(box.height),
    },
    style,
  }
  if (node.type === 'TEXT' && typeof node.characters === 'string' && node.characters.length > 0) {
    result.textRuns = [{
      text: node.characters.slice(0, 200),
      box: {
        x: 0,
        y: 0,
        w: round(box.width),
        h: round(box.height),
      },
    }]
  }
  if (Array.isArray(node.fills) && node.fills.length > 0) {
    const fill = node.fills[0]
    if (fill.type === 'SOLID' && fill.color !== undefined) {
      result.style.backgroundColor = figmaColor(fill.color)
    }
  }
  if (Array.isArray(node.strokes) && node.strokes.length > 0 && node.strokeWeight > 0) {
    const stroke = node.strokes[0]
    if (stroke.type === 'SOLID' && stroke.color !== undefined) {
      result.style.borderTopWidth = `${node.strokeWeight}px`
      result.style.borderTopColor = figmaColor(stroke.color)
    }
  }
  const children = (node.children ?? []).map(child => convertNode(child, rootBounds))
  if (children.length > 0) result.children = children
  if (isRoot) result.style.position = 'static'
  return result
}

function buildStyle(node) {
  const style = { display: 'block' }
  if (node.type === 'TEXT') style.display = 'inline'
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    style.display = 'flex'
    style.flexDirection = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'
    style.gap = `${node.itemSpacing ?? 0}px`
    style.justifyContent = alignOf(node.primaryAxisAlignItems)
    style.alignItems = alignOf(node.secondaryAxisAlignItems)
  }
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const value = node[`padding${side}`]
    if (typeof value === 'number') style[`padding${side}`] = `${value}px`
  }
  if (typeof node.cornerRadius === 'number') style.borderRadius = `${node.cornerRadius}px`
  const text = node.style
  if (text !== undefined) {
    if (text.fontFamily !== undefined) style.fontFamily = text.fontFamily
    if (text.fontSize !== undefined) style.fontSize = `${text.fontSize}px`
    if (text.fontWeight !== undefined) style.fontWeight = String(text.fontWeight)
    if (text.lineHeightPx !== undefined) style.lineHeight = `${text.lineHeightPx}px`
    if (text.letterSpacing !== undefined) style.letterSpacing = `${text.letterSpacing}px`
    if (text.fills?.[0]?.type === 'SOLID' && text.fills[0].color !== undefined) {
      style.color = figmaColor(text.fills[0].color)
    }
  }
  return style
}

function alignOf(value) {
  if (value === 'CENTER') return 'center'
  if (value === 'MAX') return 'flex-end'
  if (value === 'SPACE_BETWEEN') return 'space-between'
  return 'flex-start'
}

function tagOf(node) {
  if (node.type === 'TEXT') return 'span'
  return 'div'
}

function figmaColor(color) {
  const scale = value => Math.round(Math.min(1, Math.max(0, value ?? 0)) * 255)
  return `rgba(${scale(color.r)}, ${scale(color.g)}, ${scale(color.b)}, ${color.a ?? 1})`
}

function round(value) {
  return Math.round(value * 10) / 10
}
