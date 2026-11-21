/**
 * IR → maintainable HTML + CSS.
 *
 * The fidelity renders inline every declaration. This generator extracts shared
 * classes, keeps design tokens as CSS custom properties, turns generated content
 * back into ::before/::after rules, and writes a real stylesheet instead of a
 * coordinate dump.
 */

import { expandStyle } from './ir.mjs'

const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'head'])
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'col', 'source'])
const CSS_KEYS = [
  'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignSelf',
  'flexGrow', 'flexShrink', 'flexBasis', 'order', 'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow',
  'justifyItems', 'placeItems', 'alignContent',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
  'borderCollapse', 'borderSpacing', 'tableLayout', 'verticalAlign',
  'borderRadius', 'boxShadow', 'backgroundColor', 'color',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'textOverflow', 'overflow', 'whiteSpace', 'opacity', 'zIndex',
  'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'backgroundOrigin', 'backgroundClip',
  'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset',
  'filter', 'backdropFilter', 'mixBlendMode',
  'transform', 'transformOrigin',
  'fill', 'fillOpacity', 'stroke', 'strokeOpacity', 'strokeWidth',
  'strokeLinecap', 'strokeLinejoin', 'strokeDasharray',
]
const COLOR_KEYS = ['color', 'backgroundColor', 'borderTopColor']

/**
 * Render an IR document as HTML plus a separate stylesheet.
 * @param {object} ir - IR document.
 * @returns {{html: string, css: string}} component sources.
 */
export function generateComponent(ir) {
  const classMap = new Map()
  const rules = []
  const pseudoRules = []
  let counter = 0
  const classOf = (declarations) => {
    const key = declarations.join(';')
    const found = classMap.get(key)
    if (found !== undefined) return found
    const name = `c${++counter}`
    const entry = { name, declarations }
    classMap.set(key, entry)
    rules.push(entry)
    return entry
  }

  const body = renderNode(ir.root, ir, classOf, pseudoRules, true)
  const css = buildStylesheet(ir, rules, pseudoRules)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PixelParity component</title>
<link rel="stylesheet" href="generated.component.css">
</head>
${body}
</html>
`
  return { html, css }
}

function renderNode(node, ir, classOf, pseudoRules, isRoot = false) {
  if (SKIP_TAGS.has(node.tag)) return ''
  const style = expandStyle(node.style, ir.tokens)
  const declarations = buildDeclarations(node, style, ir)
  const classEntry = classOf(declarations)

  const children = (node.children ?? []).filter(child => child.pseudo === undefined)
  for (const pseudo of (node.children ?? []).filter(child => child.pseudo !== undefined)) {
    pushPseudoRule(pseudo, classEntry, ir, pseudoRules)
  }

  const attributes = Object.entries(node.attributes ?? {})
    .filter(([name]) => !name.startsWith('data-'))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('')
  const classAttribute = ` class="${classEntry.name}"`

  const runs = node.textRuns ?? []
  const childHtml = children.map(child => renderNode(child, ir, classOf, pseudoRules))
  const runAfter = run => Math.min(Number.isInteger(run.afterChild) ? run.afterChild : 0, childHtml.length)
  const parts = []
  for (let index = 0; index <= childHtml.length; index += 1) {
    const text = runs.filter(run => runAfter(run) === index).map(run => escapeHtml(run.text)).join(' ')
    if (text.length > 0) parts.push(text)
    if (index < childHtml.length) parts.push(childHtml[index])
  }

  const options = node.tag === 'select' && Array.isArray(node.options)
    ? node.options.map(option => `<option value="${escapeHtml(option.value)}"${option.selected ? ' selected' : ''}>${escapeHtml(option.text)}</option>`).join('')
    : ''
  const colgroup = node.tag === 'table' && Array.isArray(node.layout?.columnWidths)
    ? `<colgroup>${node.layout.columnWidths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`
    : ''

  if (isRoot) return `<body${classAttribute}>${colgroup}${options}${parts.join('')}</body>`
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${classAttribute}${attributes}>`
  return `<${node.tag}${classAttribute}${attributes}>${colgroup}${options}${parts.join('')}</${node.tag}>`
}

function pushPseudoRule(pseudo, parentClass, ir, pseudoRules) {
  const style = expandStyle(pseudo.style, ir.tokens)
  const declarations = buildDeclarations(pseudo, style, ir)
  const content = (pseudo.textRuns ?? [])[0]?.text ?? ''
  const header = [`content: "${escapeCssString(content)}"`]
  if (content === '' && !declarations.includes('display:inline-block') && !declarations.some(item => item.startsWith('display:'))) {
    header.push('display: inline-block')
  }
  pseudoRules.push({
    selector: `.${parentClass.name}${pseudo.pseudo}`,
    declarations: [...header, ...declarations],
  })
}

function buildDeclarations(node, style, ir) {
  const declarations = []
  const display = style.display
  if (display !== undefined && display !== '') declarations.push(`display:${display}`)

  if (style.position !== undefined && style.position !== 'static') {
    declarations.push(`position:${style.position}`)
    for (const side of ['top', 'left', 'right', 'bottom']) {
      const value = style[side]
      if (value !== undefined && value !== 'auto' && value !== '') declarations.push(`${side}:${value}`)
    }
  }

  const contentBox = style.boxSizing === 'content-box'
  const borderX = (Number.parseFloat(style.borderLeftWidth ?? '0') || 0) + (Number.parseFloat(style.borderRightWidth ?? '0') || 0)
  const borderY = (Number.parseFloat(style.borderTopWidth ?? '0') || 0) + (Number.parseFloat(style.borderBottomWidth ?? '0') || 0)
  if (contentBox) declarations.push('box-sizing:content-box')

  const pins = node.layout?.pins ?? {}
  if (pins.width === true) declarations.push(`width:${node.box.w - (contentBox ? borderX : 0)}px`)
  if (pins.height === true) declarations.push(`height:${node.box.h - (contentBox ? borderY : 0)}px`)
  for (const [key, value] of Object.entries(node.authored ?? {})) {
    declarations.push(`${kebab(key)}:${value}`)
  }
  if (node.pseudo !== undefined) {
    for (const key of ['width', 'height']) {
      const value = style[key]
      if (typeof value === 'string' && value !== 'auto' && value !== '') declarations.push(`${key}:${value}`)
    }
  }
  if (style.transform !== undefined && node.transformedSize !== undefined) {
    for (const key of ['width', 'height']) {
      const value = node.transformedSize[key]
      if (typeof value === 'string' && value.endsWith('px')) declarations.push(`${key}:${value}`)
    }
  }

  const tokenTypography = ir.tokens.typography?.[node.style?.typography]
  if (tokenTypography !== undefined) {
    const prefix = `--${String(node.style.typography).replace('.', '-')}`
    if (tokenTypography.fontFamily !== undefined) declarations.push(`font-family:var(${prefix}-font-family)`)
    if (tokenTypography.fontSize !== undefined) declarations.push(`font-size:var(${prefix}-font-size)`)
    if (tokenTypography.fontWeight !== undefined) declarations.push(`font-weight:var(${prefix}-font-weight)`)
    if (tokenTypography.lineHeight !== undefined && tokenTypography.lineHeight !== 'normal') {
      declarations.push(`line-height:var(${prefix}-line-height)`)
    }
    if (tokenTypography.letterSpacing !== undefined && tokenTypography.letterSpacing !== 'normal') {
      declarations.push(`letter-spacing:var(${prefix}-letter-spacing)`)
    }
  }

  for (const key of CSS_KEYS) {
    const value = style[key]
    if (value === undefined || value === '' || value === 'normal' || value === 'auto' || value === 'none') continue
    if (key === 'fontFamily' || key === 'fontSize' || key === 'fontWeight' || key === 'lineHeight' || key === 'letterSpacing') continue
    if (key === 'borderRadius' && node.style?.borderRadius?.startsWith('radius.')) {
      declarations.push(`border-radius:var(--${String(node.style.borderRadius).replace('.', '-')})`)
      continue
    }
    if (COLOR_KEYS.includes(key) && typeof node.style?.[key] === 'string' && node.style[key].startsWith('color.')) {
      declarations.push(`${kebab(key)}:var(--${String(node.style[key]).replace('.', '-')})`)
      continue
    }
    if (key === 'transform' || key === 'transformOrigin') {
      declarations.push(`${kebab(key)}:${value}`)
      continue
    }
    declarations.push(`${kebab(key)}:${value}`)
  }
  return [...new Set(declarations)]
}

function buildStylesheet(ir, rules, pseudoRules) {
  const viewport = ir.source.viewport
  const lines = ['/* Generated by dsh-pixel-parity from IR v1. */', ':root {']
  for (const [name, value] of Object.entries(ir.tokens.colors ?? {})) {
    lines.push(`  --${name.replace('.', '-')}: ${value};`)
  }
  for (const [name, value] of Object.entries(ir.tokens.typography ?? {})) {
    const prefix = `--${name.replace('.', '-')}`
    if (value.fontFamily !== undefined) lines.push(`  ${prefix}-font-family: ${value.fontFamily};`)
    if (value.fontSize !== undefined) lines.push(`  ${prefix}-font-size: ${value.fontSize};`)
    if (value.fontWeight !== undefined) lines.push(`  ${prefix}-font-weight: ${value.fontWeight};`)
    if (value.lineHeight !== undefined && value.lineHeight !== 'normal') lines.push(`  ${prefix}-line-height: ${value.lineHeight};`)
    if (value.letterSpacing !== undefined && value.letterSpacing !== 'normal') lines.push(`  ${prefix}-letter-spacing: ${value.letterSpacing};`)
  }
  for (const [name, value] of Object.entries(ir.tokens.radius ?? {})) {
    lines.push(`  --${name.replace('.', '-')}: ${value};`)
  }
  lines.push('}')
  lines.push('')
  for (const font of ir.assets?.fonts ?? []) {
    const family = String(font.family).replaceAll("'", '')
    const format = font.format ? ` format('${font.format}')` : ''
    lines.push(`@font-face { font-family: '${family}'; font-style: ${font.style}; font-weight: ${font.weight}; src: url('${font.src}')${format}; }`)
  }
  if ((ir.assets?.fonts ?? []).length > 0) lines.push('')
  lines.push('*, *::before, *::after { box-sizing: border-box; }')
  lines.push(`html, body { margin: 0; padding: 0; }`)
  lines.push(`body { width: ${viewport.width}px; height: ${viewport.height}px; }`)
  lines.push('')
  for (const rule of rules) {
    lines.push(`.${rule.name} {`)
    for (const declaration of rule.declarations) lines.push(`  ${declaration};`)
    lines.push('}')
    lines.push('')
  }
  for (const rule of pseudoRules) {
    lines.push(`${rule.selector} {`)
    for (const declaration of rule.declarations) lines.push(`  ${declaration};`)
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
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

function escapeCssString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
