/**
 * IR v1: a renderer-neutral description of one static screen.
 *
 * Built from a captured DOM (best fidelity source) so the same artifacts can
 * later feed other generators (QML, WPF, ...). Layout stays in page coordinates
 * for v1; the layout model is deliberately literal until a generator proves it
 * can map constraints across renderers.
 */

const COLOR_KEYS = ['color', 'backgroundColor', 'borderTopColor']
const TYPE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']
const RADIUS_KEYS = ['borderRadius']
const STYLE_KEYS = [
  'display', 'position', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignSelf',
  'flexGrow', 'flexShrink', 'flexBasis', 'order', 'gap', 'rowGap', 'columnGap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'boxSizing',
  'top', 'left', 'right', 'bottom', 'zIndex',
  'borderTopWidth', 'borderTopStyle', 'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
  'borderCollapse', 'borderSpacing', 'tableLayout', 'verticalAlign',
  'boxShadow', 'textAlign', 'textOverflow', 'overflow', 'whiteSpace', 'opacity',
  'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'backgroundOrigin', 'backgroundClip',
  'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset',
  'filter', 'backdropFilter', 'mixBlendMode',
  'fill', 'fillOpacity', 'stroke', 'strokeOpacity', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray',
]

/**
 * Build an IR document from a captured DOM tree.
 * @param {{kind: string, url: string, viewport: {width: number, height: number, dpr: number}, capturedAt: string}} source - capture identity.
 * @param {{root: object, truncated?: boolean}} dom - DOM capture.
 * @returns {object} IR document.
 */
export function buildIr(source, dom) {
  if (dom === null || dom.root === null || dom.root === undefined) {
    throw new Error('cannot build IR: the capture contains no DOM tree')
  }
  const flat = []
  assign(dom.root, flat)
  const tokens = extractTokens(flat)
  const root = convert(dom.root, tokens)
  const ir = {
    ir: '1.0',
    source: {
      ...source,
      canvas: { width: Math.round(source.viewport.width * source.viewport.dpr), height: Math.round(source.viewport.height * source.viewport.dpr) },
      truncated: dom.truncated === true,
    },
    tokens: tokens.tables,
    root,
  }
  if (Array.isArray(dom.fonts) && dom.fonts.length > 0) {
    ir.assets = { fonts: dom.fonts.map(font => ({ ...font })) }
  }
  return ir
}

function assign(node, flat) {
  node.__id = `n${flat.length + 1}`
  flat.push(node)
  for (const child of node.children ?? []) assign(child, flat)
}

function extractTokens(flat) {
  const colors = new Map()
  const types = new Map()
  const radii = new Map()
  for (const node of flat) {
    const style = node.style ?? {}
    for (const key of COLOR_KEYS) {
      const value = style[key]
      if (typeof value === 'string' && value !== '' && value !== 'transparent') colors.set(value, (colors.get(value) ?? 0) + 1)
    }
    const typeKey = TYPE_KEYS.map(key => style[key] ?? '').join('|')
    if (typeKey.replaceAll('|', '').length > 0) types.set(typeKey, (types.get(typeKey) ?? 0) + 1)
    for (const key of RADIUS_KEYS) {
      const value = style[key]
      if (typeof value === 'string' && value !== '' && value !== '0px') radii.set(value, (radii.get(value) ?? 0) + 1)
    }
  }
  const tables = {
    colors: nameValues(colors, 'color'),
    typography: nameTypography(types),
    radius: nameValues(radii, 'radius'),
  }
  const typeIndex = new Map()
  for (const [name, value] of Object.entries(tables.typography)) {
    typeIndex.set(TYPE_KEYS.map(key => value[key] ?? '').join('|'), name)
  }
  return { tables, colorIndex: reverse(tables.colors), typeIndex, radiusIndex: reverse(tables.radius) }
}

function nameValues(map, prefix) {
  const entries = [...map.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
  const table = {}
  for (const [index, [value]] of entries.entries()) table[`${prefix}.${index + 1}`] = value
  return table
}

function nameTypography(map) {
  const entries = [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const table = {}
  for (const [index, [key]] of entries.entries()) {
    const [fontFamily, fontSize, fontWeight, lineHeight, letterSpacing] = key.split('|')
    table[`type.${index + 1}`] = { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing }
  }
  return table
}

function reverse(table) {
  const map = new Map()
  for (const [name, value] of Object.entries(table)) map.set(typeof value === 'string' ? value : JSON.stringify(value), name)
  return map
}

function convert(node, tokens) {
  const style = node.style ?? {}
  const irStyle = {}
  for (const key of STYLE_KEYS) {
    if (style[key] !== undefined && style[key] !== '') irStyle[key] = style[key]
  }
  for (const key of COLOR_KEYS) {
    const name = tokens.colorIndex.get(style[key])
    if (name !== undefined) irStyle[key] = name
  }
  const typeKey = TYPE_KEYS.map(key => style[key] ?? '').join('|')
  const typeName = tokens.typeIndex.get(typeKey)
  if (typeName !== undefined) irStyle.typography = typeName
  const radiusName = tokens.radiusIndex.get(style.borderRadius)
  if (radiusName !== undefined) irStyle.borderRadius = radiusName

  const result = {
    id: node.__id,
    tag: node.tag,
    role: roleOf(node),
    layout: layoutOf(node),
    box: node.box,
    style: irStyle,
  }
  if (node.pseudo !== undefined) {
    result.pseudo = node.pseudo
    // Pseudo boxes carry their explicit size; flow sizes text-only ones.
    if (style.width !== undefined && style.width !== 'auto') result.style.width = style.width
    if (style.height !== undefined && style.height !== 'auto') result.style.height = style.height
  }
  if (node.textRuns !== undefined && node.textRuns.length > 0) {
    result.textRuns = node.textRuns.map(run => ({ text: run.text, box: run.box }))
  }
  if (node.colSpan !== undefined) result.colSpan = node.colSpan
  if (node.rowSpan !== undefined) result.rowSpan = node.rowSpan
  if (node.attributes !== undefined) result.attributes = node.attributes
  if (Array.isArray(node.options) && node.options.length > 0) {
    result.options = node.options.map(option => ({
      text: String(option.text ?? ''),
      value: String(option.value ?? ''),
      selected: option.selected === true,
    }))
  }
  if (node.authored !== undefined) {
    // Keep fixed pixel sizes that explain the measured box, and percentage sizes
    // (they are source truth; the parent supplies the reference size).
    const authored = {}
    for (const [key, value] of Object.entries(node.authored)) {
      if (key !== 'width' && key !== 'height') continue
      if (!/^\d+(?:\.\d+)?(?:px|%)$/.test(value)) continue
      if (value.endsWith('px')) {
        const measured = key === 'width' ? node.box.w : node.box.h
        if (Math.abs(Number.parseFloat(value) - measured) > 1) continue
      }
      authored[key] = value
    }
    if (Object.keys(authored).length > 0) result.authored = authored
  }
  if (node.children !== undefined && node.children.length > 0) result.children = node.children.map(child => convert(child, tokens))
  return result
}

function layoutOf(node) {
  const display = node.style?.display ?? 'block'
  const kind = display.includes('flex')
    ? 'flex'
    : display.includes('grid')
      ? 'grid'
      : display === 'inline-table' || display.startsWith('table')
        ? 'table'
        : display.startsWith('inline')
          ? 'inline'
          : 'block'
  const layout = { kind }
  if (kind === 'flex') {
    layout.direction = node.style.flexDirection ?? 'row'
    layout.justify = node.style.justifyContent ?? 'normal'
    layout.align = node.style.alignItems ?? 'normal'
    layout.wrap = node.style.flexWrap ?? 'nowrap'
    if (typeof node.style.gap === 'string' && node.style.gap !== 'normal') layout.gap = node.style.gap
  } else if (kind === 'grid') {
    layout.columns = node.style.gridTemplateColumns ?? ''
    layout.rows = node.style.gridTemplateRows ?? ''
    layout.gap = node.style.gap ?? 'normal'
  } else if (kind === 'table') {
    const columns = tableColumns(node)
    if (columns.length > 0) layout.columnWidths = columns
  }
  return layout
}

/** Derive column widths from the first row of a table node. */
function tableColumns(node) {
  const row = firstRow(node)
  if (row === undefined) return []
  const columns = []
  for (const cell of row.children ?? []) {
    if (cell.tag !== 'td' && cell.tag !== 'th') continue
    const span = Math.max(1, cell.colSpan ?? 1)
    const width = Math.round(((cell.box?.w ?? 0) / span) * 100) / 100
    for (let index = 0; index < span; index += 1) columns.push(width)
  }
  return columns
}

function firstRow(node) {
  for (const child of node.children ?? []) {
    if (child.tag === 'tr') return child
    if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
      const nested = firstRow(child)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function roleOf(node) {
  const tag = node.tag
  if (tag === 'header') return 'header'
  if (tag === 'nav') return 'nav'
  if (tag === 'aside') return 'sidebar'
  if (tag === 'main') return 'main'
  if (tag === 'footer') return 'footer'
  if (tag === 'table') return 'table'
  if (tag === 'button') return 'button'
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'field'
  if (tag === 'img') return 'image'
  if (tag === 'a') return 'link'
  if (node.textRuns !== undefined && node.textRuns.length > 0) {
    if (['span', 'p', 'h1', 'h2', 'h3', 'td', 'th', 'label', 'strong', 'b'].includes(tag)) return 'text'
  }
  return 'container'
}

/**
 * Validate an IR document's structure and token references.
 * @param {object} ir - IR document.
 * @returns {string[]} violations; empty means valid.
 */
export function validateIr(ir) {
  const violations = []
  if (ir === null || typeof ir !== 'object') return ['IR must be an object']
  if (ir.ir !== '1.0') violations.push(`ir version must be "1.0", got ${JSON.stringify(ir.ir)}`)
  if (ir.source === undefined || typeof ir.source !== 'object') violations.push('source is required')
  else if (ir.source.canvas === undefined || typeof ir.source.canvas.width !== 'number' || typeof ir.source.canvas.height !== 'number') {
    violations.push('source.canvas needs numeric width and height')
  }
  const tokens = ir.tokens ?? {}
  const colorNames = new Set(Object.keys(tokens.colors ?? {}))
  const typeNames = new Set(Object.keys(tokens.typography ?? {}))
  const radiusNames = new Set(Object.keys(tokens.radius ?? {}))
  if (ir.assets !== undefined) {
    if (ir.assets === null || typeof ir.assets !== 'object') violations.push('assets must be an object')
    else if (ir.assets.fonts !== undefined) {
      if (!Array.isArray(ir.assets.fonts)) violations.push('assets.fonts must be an array')
      else {
        for (const [index, font] of ir.assets.fonts.entries()) {
          for (const key of ['family', 'weight', 'style', 'src', 'format']) {
            if (typeof font?.[key] !== 'string') violations.push(`assets.fonts[${index}].${key} must be a string`)
          }
        }
      }
    }
  }
  const ids = new Set()
  if (ir.root === undefined) violations.push('root is required')
  else walk(ir.root, (node, path) => {
    if (typeof node.id !== 'string' || node.id.length === 0) violations.push(`${path}.id must be a non-empty string`)
    else if (ids.has(node.id)) violations.push(`${path}.id "${node.id}" is duplicated`)
    else ids.add(node.id)
    if (typeof node.tag !== 'string') violations.push(`${path}.tag must be a string`)
    if (node.box === undefined || ['x', 'y', 'w', 'h'].some(key => typeof node.box[key] !== 'number')) {
      violations.push(`${path}.box needs numeric x/y/w/h`)
    }
    if (node.layout === undefined || typeof node.layout.kind !== 'string') {
      violations.push(`${path}.layout.kind is required`)
    }
    if (node.layout?.pins !== undefined) {
      for (const key of ['width', 'height']) {
        if (node.layout.pins[key] !== undefined && typeof node.layout.pins[key] !== 'boolean') {
          violations.push(`${path}.layout.pins.${key} must be a boolean`)
        }
      }
    }
    if (node.layout?.columnWidths !== undefined) {
      const columns = node.layout.columnWidths
      if (!Array.isArray(columns) || columns.some(width => typeof width !== 'number' || width < 0)) {
        violations.push(`${path}.layout.columnWidths must be an array of non-negative numbers`)
      }
    }
    if (node.colSpan !== undefined && (!Number.isInteger(node.colSpan) || node.colSpan < 1)) {
      violations.push(`${path}.colSpan must be a positive integer`)
    }
    if (node.attributes !== undefined) {
      if (node.attributes === null || typeof node.attributes !== 'object' || Array.isArray(node.attributes)) {
        violations.push(`${path}.attributes must be an object`)
      } else {
        for (const [name, value] of Object.entries(node.attributes)) {
          if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) violations.push(`${path}.attributes has an unsafe name ${JSON.stringify(name)}`)
          if (typeof value !== 'string') violations.push(`${path}.attributes.${name} must be a string`)
        }
      }
    }
    if (node.options !== undefined) {
      if (!Array.isArray(node.options)) {
        violations.push(`${path}.options must be an array`)
      } else {
        for (const [index, option] of node.options.entries()) {
          if (typeof option?.text !== 'string' || typeof option?.value !== 'string' || typeof option?.selected !== 'boolean') {
            violations.push(`${path}.options[${index}] needs string text/value and boolean selected`)
          }
        }
      }
    }
    if (node.authored !== undefined) {
      if (node.authored === null || typeof node.authored !== 'object' || Array.isArray(node.authored)) {
        violations.push(`${path}.authored must be an object`)
      } else {
        for (const [name, value] of Object.entries(node.authored)) {
          if (typeof value !== 'string') violations.push(`${path}.authored.${name} must be a string`)
        }
      }
    }
    for (const [index, run] of (node.textRuns ?? []).entries()) {
      if (typeof run.text !== 'string' || run.text.length === 0) violations.push(`${path}.textRuns[${index}].text must be a non-empty string`)
      if (run.box === undefined || ['x', 'y', 'w', 'h'].some(key => typeof run.box[key] !== 'number')) {
        violations.push(`${path}.textRuns[${index}].box needs numeric x/y/w/h`)
      }
    }
    for (const key of COLOR_KEYS) {
      const value = node.style?.[key]
      if (typeof value === 'string' && value.startsWith('color.') && !colorNames.has(value)) {
        violations.push(`${path}.style.${key} references unknown token ${value}`)
      }
    }
    if (typeof node.style?.typography === 'string' && !typeNames.has(node.style.typography)) {
      violations.push(`${path}.style.typography references unknown token ${node.style.typography}`)
    }
    if (typeof node.style?.borderRadius === 'string' && node.style.borderRadius.startsWith('radius.') && !radiusNames.has(node.style.borderRadius)) {
      violations.push(`${path}.style.borderRadius references unknown token ${node.style.borderRadius}`)
    }
  })
  return violations
}

/** Walk every node of an IR tree in document order. */
export function walk(node, visit, path = 'root') {
  visit(node, path)
  for (const [index, child] of (node.children ?? []).entries()) walk(child, visit, `${path}.children[${index}]`)
}

/**
 * Flatten an IR tree in document order.
 * @param {object} root - IR root node.
 * @returns {object[]} nodes.
 */
export function flattenIr(root) {
  const nodes = []
  walk(root, node => nodes.push(node))
  return nodes
}

/**
 * Expand one IR style object into literal CSS values.
 * @param {object} style - IR style.
 * @param {object} tokens - IR tokens.
 * @returns {Record<string, string>} literal styles.
 */
export function expandStyle(style, tokens) {
  const result = {}
  for (const [key, value] of Object.entries(style ?? {})) {
    if (key === 'typography') {
      const type = tokens.typography?.[value]
      if (type !== undefined) {
        result.fontFamily = type.fontFamily
        result.fontSize = type.fontSize
        result.fontWeight = type.fontWeight
        result.lineHeight = type.lineHeight
        result.letterSpacing = type.letterSpacing
      }
      continue
    }
    if ((key === 'color' || key === 'backgroundColor' || key === 'borderTopColor') && typeof value === 'string' && value.startsWith('color.')) {
      result[key] = tokens.colors?.[value] ?? value
      continue
    }
    if (key === 'borderRadius' && typeof value === 'string' && value.startsWith('radius.')) {
      result[key] = tokens.radius?.[value] ?? value
      continue
    }
    result[key] = value
  }
  return result
}
