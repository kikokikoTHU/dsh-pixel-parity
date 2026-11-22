/**
 * IR → semantic HTML (layout-preserving clone).
 *
 * Unlike the absolute renderer, this rebuilds the element tree with the captured
 * layout semantics (flex/block/table) and computed styles, letting the browser
 * re-run layout. It is the step that makes the IR portable: a QML generator can
 * map the same layout kinds instead of copying coordinates.
 */

import { expandStyle } from './ir.mjs'

const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'head'])
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'col', 'source'])
const CSS_KEYS = [
  'display',
  'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignSelf',
  'flexGrow', 'flexShrink', 'flexBasis', 'order', 'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
  'borderCollapse', 'borderSpacing', 'tableLayout', 'verticalAlign',
  'borderRadius', 'boxShadow',
  'backgroundColor', 'color',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'textOverflow', 'overflow', 'whiteSpace', 'opacity', 'zIndex',
  'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'backgroundOrigin', 'backgroundClip',
  'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset',
  'filter', 'backdropFilter', 'mixBlendMode',
  'transform', 'transformOrigin', 'justifyItems', 'placeItems', 'alignContent',
  'fill', 'fillOpacity', 'stroke', 'strokeOpacity', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray',
]

/**
 * Render an IR document as layout-preserving HTML.
 * @param {object} ir - IR document.
 * @returns {string} HTML source.
 */
export function generateSemanticHtml(ir) {
  const viewport = ir.source.viewport
  const fontFaces = (ir.assets?.fonts ?? []).map((font) => {
    const family = String(font.family).replaceAll("'", '')
    const src = String(font.src).replaceAll("'", '%27')
    const format = font.format ? ` format('${font.format}')` : ''
    return `@font-face{font-family:'${family}';font-style:${font.style};font-weight:${font.weight};src:url('${src}')${format}}`
  }).join('\n  ')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IR semantic render</title>
<style>
  ${fontFaces}
  html { height: 100%; }
  html, body { margin: 0; padding: 0; }
  body { width: ${viewport.width}px; height: ${viewport.height}px; }
</style>
</head>
${renderNode(ir.root, ir, true)}
</html>
`
}

function renderNode(node, ir, isRoot = false) {
  if (SKIP_TAGS.has(node.tag)) return ''
  const tag = node.tag === 'canvas' && node.attributes?.src !== undefined
    ? 'img'
    : node.tag === 'iframe' ? 'div' : node.tag
  const style = expandStyle(node.style, ir.tokens)
  const declarations = buildDeclarations(node, style)
  const spans = `${node.colSpan > 1 ? ` colspan="${node.colSpan}"` : ''}${node.rowSpan > 1 ? ` rowspan="${node.rowSpan}"` : ''}`
  const extra = node.attributes === undefined
    ? ''
    : Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')
  const attributes = `data-ir="${escapeHtml(node.id)}"${spans}${extra} style="${escapeHtml(declarations.join(';'))}"`
  const colgroup = node.tag === 'table' && Array.isArray(node.layout?.columnWidths)
    ? `<colgroup>${node.layout.columnWidths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`
    : ''
  const runs = node.textRuns ?? []
  const childHtml = (node.children ?? []).map(child => renderNode(child, ir))
  const runAfter = run => Math.min(
    Number.isInteger(run.afterChild) ? run.afterChild : 0,
    childHtml.length,
  )
  // Text runs keep their position between element children: a button whose icon
  // precedes its label must not render "label then icon".
  const parts = []
  for (let index = 0; index <= childHtml.length; index += 1) {
    const text = runs.filter(run => runAfter(run) === index).map(run => escapeHtml(run.text)).join(' ')
    if (text.length > 0) parts.push(text)
    if (index < childHtml.length) parts.push(childHtml[index])
  }
  const options = node.tag === 'select' && Array.isArray(node.options)
    ? node.options.map(option => `<option value="${escapeHtml(option.value)}"${option.selected ? ' selected' : ''}>${escapeHtml(option.text)}</option>`).join('')
    : ''
  const content = options.length > 0 ? options : `${colgroup}${parts.join('')}`
  if (isRoot) return `<body ${attributes}>${content}</body>`
  if (VOID_TAGS.has(tag)) return `<${tag} ${attributes} />`
  return `<${tag} ${attributes}>${content}</${tag}>`
}

function buildDeclarations(node, style) {
  const declarations = ['box-sizing:border-box']
  const display = style.display
  if (display !== undefined && display !== '') declarations.push(`display:${display}`)

  if (style.position !== undefined && style.position !== 'static') {
    declarations.push(`position:${style.position}`)
    for (const side of ['top', 'left', 'right', 'bottom']) {
      const value = style[side]
      if (value !== undefined && value !== 'auto' && value !== '') declarations.push(`${side}:${value}`)
    }
  }

  // Sizes are pins: a node keeps its measured width/height only when the
  // synthesizer proved the flow layout cannot reproduce it.
  const pinnedSizing = style.boxSizing === 'content-box'
  const borderX = (Number.parseFloat(style.borderLeftWidth ?? '0') || 0) + (Number.parseFloat(style.borderRightWidth ?? '0') || 0)
  const borderY = (Number.parseFloat(style.borderTopWidth ?? '0') || 0) + (Number.parseFloat(style.borderBottomWidth ?? '0') || 0)
  const pins = node.layout?.pins ?? {}
  if (pins.width === true) declarations.push(`width:${node.box.w - (pinnedSizing ? borderX : 0)}px`)
  if (pins.height === true) declarations.push(`height:${node.box.h - (pinnedSizing ? borderY : 0)}px`)

  if (pinnedSizing) declarations.push('box-sizing:content-box')

  // Authored sizes are design intent, not measured compensation: emit them after
  // pins so the source value wins when both exist.
  for (const [key, value] of Object.entries(node.authored ?? {})) {
    declarations.push(`${kebab(key)}:${value}`)
  }

  // Generated content (::before/::after) is sized by flow, but an explicit
  // pseudo width/height must survive.
  if (node.pseudo !== undefined) {
    for (const key of ['width', 'height']) {
      const value = style[key]
      if (typeof value === 'string' && value !== 'auto' && value !== '') declarations.push(`${key}:${value}`)
    }
  }

  // A transformed element's box is its bounding box; the layout size comes from
  // the capture so the transform replays at the same scale.
  if (style.transform !== undefined && node.transformedSize !== undefined) {
    for (const key of ['width', 'height']) {
      const value = node.transformedSize[key]
      if (typeof value === 'string' && value.endsWith('px')) declarations.push(`${key}:${value}`)
    }
  }

  for (const key of CSS_KEYS) {
    const value = style[key]
    if (value === undefined || value === '' || value === 'normal' || value === 'auto') continue
    if (key === 'display') continue
    declarations.push(`${kebab(key)}:${value}`)
  }
  return declarations
}

function kebab(property) {
  return property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
