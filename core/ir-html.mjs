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
]

/**
 * Render an IR document as layout-preserving HTML.
 * @param {object} ir - IR document.
 * @returns {string} HTML source.
 */
export function generateSemanticHtml(ir) {
  const viewport = ir.source.viewport
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IR semantic render</title>
<style>
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
  const style = expandStyle(node.style, ir.tokens)
  const declarations = buildDeclarations(node, style)
  const attributes = `data-ir="${escapeHtml(node.id)}" style="${escapeHtml(declarations.join(';'))}"`
  const text = (node.textRuns ?? []).map(run => run.text).join(' ')
  const children = (node.children ?? []).map(child => renderNode(child, ir)).join('')
  if (isRoot) return `<body ${attributes}>${escapeHtml(text)}${children}</body>`
  if (VOID_TAGS.has(node.tag)) return `<${node.tag} ${attributes} />`
  return `<${node.tag} ${attributes}>${escapeHtml(text)}${children}</${node.tag}>`
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
  const pins = node.layout?.pins ?? {}
  if (pins.width === true) declarations.push(`width:${node.box.w}px`)
  if (pins.height === true) declarations.push(`height:${node.box.h}px`)

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
