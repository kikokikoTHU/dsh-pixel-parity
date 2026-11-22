/**
 * Web surface adapter.
 *
 * Primary driver: Playwright resolved from the target repo (no bundled copy).
 * It gives screenshots, anchor geometry, and computed styles from one render.
 * Fallback driver: the Chrome/Edge CLI from v1, which only yields pixels.
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodePng } from '../lib/png.js'
import { captureScreenshot, findBrowser } from '../lib/browser.js'

/** Computed-style properties compared by the S layer. */
export const STYLE_PROPS = [
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'borderTopWidth',
  'borderTopColor',
  'borderRadius',
  'boxShadow',
  'gap',
  'display',
  'position',
]

/** Extra properties serialized into an IR export. */
const IR_STYLE_PROPS = [
  ...STYLE_PROPS,
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'alignSelf',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'order',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridAutoFlow',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'boxSizing',
  'top',
  'left',
  'right',
  'bottom',
  'zIndex',
  'textAlign',
  'textOverflow',
  'overflow',
  'whiteSpace',
  'verticalAlign',
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundOrigin',
  'backgroundClip',
  'outlineWidth',
  'outlineStyle',
  'outlineColor',
  'outlineOffset',
  'filter',
  'backdropFilter',
  'mixBlendMode',
  'transform',
  'transformOrigin',
  'justifyItems',
  'placeItems',
  'alignContent',
  'borderCollapse',
  'borderSpacing',
  'tableLayout',
  'opacity',
  'fill',
  'fillOpacity',
  'stroke',
  'strokeOpacity',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'borderTopStyle',
  'borderRightWidth',
  'borderRightStyle',
  'borderRightColor',
  'borderBottomWidth',
  'borderBottomStyle',
  'borderBottomColor',
  'borderLeftWidth',
  'borderLeftStyle',
  'borderLeftColor',
]

/** Attributes that carry geometry or content for SVG/img elements. */
const ELEMENT_ATTRIBUTES = {
  svg: ['viewBox', 'preserveAspectRatio', 'width', 'height'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  path: ['d'],
  g: ['transform'],
  use: ['href', 'x', 'y', 'width', 'height'],
  img: ['src', 'alt'],
  input: ['type', 'value', 'placeholder', 'size', 'maxlength', 'checked', 'disabled', 'name', 'readonly'],
  textarea: ['rows', 'cols', 'placeholder', 'disabled', 'name'],
  select: ['multiple', 'size', 'disabled', 'name'],
  video: ['poster', 'src', 'autoplay', 'loop', 'muted', 'controls', 'playsinline'],
}

const CAPTURE_ARGS = { maxNodes: 2000, styleKeys: IR_STYLE_PROPS, elementAttributes: ELEMENT_ATTRIBUTES }

const FREEZE_CSS = `
*,*::before,*::after{
  animation-duration:0s!important;animation-delay:0s!important;
  transition-duration:0s!important;transition-delay:0s!important;
  scroll-behavior:auto!important;
}
html{scrollbar-width:none!important}
::-webkit-scrollbar{display:none!important}
`

/**
 * Resolve the `playwright` package from a repository's node_modules.
 * @param {string} repoRoot - repository root.
 * @returns {Promise<object | undefined>} the chromium facade, or undefined.
 */
export async function resolvePlaywright(repoRoot) {
  try {
    const require = createRequire(join(repoRoot, 'package.json'))
    const entry = require.resolve('playwright')
    const module = await import(pathToFileURL(entry).href)
    const chromium = module.chromium ?? module.default?.chromium
    if (chromium === undefined) return undefined
    const version = module.default?.version ?? module.version ?? 'unknown'
    return { chromium, version }
  } catch {
    return undefined
  }
}

/**
 * Create the web driver used by the runner.
 * @param {{repoRoot: string, headless?: boolean}} options - driver settings.
 * @returns {Promise<object>} driver with capture/dispose.
 */
export async function createWebDriver(options) {
  const playwright = await resolvePlaywright(options.repoRoot)
  if (playwright !== undefined) {
    return createPlaywrightDriver(playwright, options)
  }
  if (findBrowser() === undefined) {
    throw new Error('neither Playwright nor a Chromium-based browser was found; install playwright in the repo or set PIXEL_PARITY_BROWSER')
  }
  return createChromeDriver()
}

/**
 * Run configured interaction steps before capture. Steps are ordered and each
 * one awaits, so a click can reveal a panel that a later step fills.
 */
async function runSteps(page, steps) {
  for (const step of steps) {
    const timeout = step.timeoutMs ?? 15000
    if (step.action === 'click') await page.click(step.selector, { timeout })
    else if (step.action === 'fill') await page.fill(step.selector, step.value, { timeout })
    else if (step.action === 'press') await page.press(step.selector, step.value, { timeout })
    else if (step.action === 'hover') await page.hover(step.selector, { timeout })
    else if (step.action === 'wait') await page.waitForTimeout(step.ms)
    else if (step.action === 'waitFor') await page.waitForSelector(step.selector, { state: step.state ?? 'visible', timeout })
    else if (step.action === 'scroll') await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: step.x ?? 0, y: step.y ?? 0 })
    else throw new Error(`unknown step action "${step.action}"`)
  }
}

/** Measure one anchor inside the document of a page or frame. */
function measureAnchorInDocument({ selector, props }) {
  const element = document.querySelector(selector)
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  const computed = getComputedStyle(element)
  const styles = {}
  for (const property of props) styles[property] = computed[property]
  return { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, styles }
}

/**
 * Measure anchors, including selectors scoped to an iframe. An iframe anchor is
 * `{ selector, frame }`, where `frame` selects the iframe in the parent page;
 * the reported rect is translated into page coordinates.
 */
async function measureAnchors(page, specs, props) {
  const result = {}
  for (const [id, raw] of Object.entries(specs)) {
    const spec = typeof raw === 'string' ? { selector: raw } : raw
    if (spec === null || typeof spec !== 'object' || typeof spec.selector !== 'string') {
      result[id] = null
      continue
    }
    if (spec.frame === undefined) {
      result[id] = await page.evaluate(measureAnchorInDocument, { selector: spec.selector, props })
      continue
    }
    const frameElement = await page.$(spec.frame)
    if (frameElement === null) {
      result[id] = null
      continue
    }
    const frame = await frameElement.contentFrame()
    if (frame === null) {
      result[id] = null
      continue
    }
    const origin = await frameElement.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.left + element.clientLeft, y: rect.top + element.clientTop }
    })
    const measured = await frame.evaluate(measureAnchorInDocument, { selector: spec.selector, props })
    result[id] = measured === null
      ? null
      : {
          rect: { x: measured.rect.x + origin.x, y: measured.rect.y + origin.y, w: measured.rect.w, h: measured.rect.h },
          styles: measured.styles,
        }
  }
  return result
}

function captureDocumentFrame({ maxNodes, styleKeys, elementAttributes }) {
          const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'COLGROUP', 'COL'])
          const round = value => Math.round(value * 10) / 10
          const pick = (style) => {
            const out = {}
            for (const key of styleKeys) {
              const value = style[key]
              if (value !== undefined && value !== '') out[key] = value
            }
            // Drop defaults that would otherwise bloat every node.
            if (Number.parseFloat(out.outlineWidth ?? '0') === 0) {
              for (const key of ['outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset']) delete out[key]
            }
            if (out.filter === 'none') delete out.filter
            if (out.backdropFilter === 'none') delete out.backdropFilter
            if (out.mixBlendMode === 'normal') delete out.mixBlendMode
            if (out.backgroundImage === 'none') delete out.backgroundImage
            if (out.boxShadow === 'none') delete out.boxShadow
            if (out.transform === 'none' || out.transform === '') {
              delete out.transform
              delete out.transformOrigin
            }
            return out
          }
          let count = 0
          let iframeCount = 0
          let truncated = false
          const num = value => Number.parseFloat(value) || 0
          const measureCanvas = document.createElement('canvas')
          const measureContext = measureCanvas.getContext('2d')

          // Authored sizing declarations (width/height/min/max/flex-basis) from
          // same-origin CSS. Flow layout cannot derive an explicit height from
          // content, so the IR keeps the authored value instead of a measured pin.
          const sizingRules = []
          for (const sheet of document.styleSheets) {
            let rules
            try {
              rules = sheet.cssRules
            } catch {
              continue
            }
            for (const rule of rules ?? []) {
              if (rule.type !== 1) continue
              const values = {}
              for (const property of ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'flex-basis']) {
                const value = rule.style.getPropertyValue(property)
                if (value !== '' && value !== 'auto' && value !== 'none' && value !== 'normal') {
                  const key = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
                  values[key] = value
                }
              }
              if (Object.keys(values).length > 0) sizingRules.push({ selector: rule.selectorText, values })
            }
          }

          const walk = (element, depth, keepEmpty = false) => {
            if (depth > 14 || count >= maxNodes) {
              if (count >= maxNodes) truncated = true
              return null
            }
            if (SKIP.has(element.tagName)) return null
            const style = getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null
            const rect = element.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0 && !keepEmpty) return null
            count += 1
            const textRuns = []
            let elementIndex = 0
            for (const child of element.childNodes) {
              if (child.nodeType === 1) {
                elementIndex += 1
                continue
              }
              if (child.nodeType !== 3) continue
              const value = child.textContent
              if (value.trim().length === 0) continue
              const range = document.createRange()
              range.selectNodeContents(child)
              const lineRects = [...range.getClientRects()].filter(item => item.width > 0 || item.height > 0)
              if (lineRects.length <= 1 || value.length > 500) {
                const rect = lineRects[0] ?? range.getBoundingClientRect()
                if (rect.width === 0 && rect.height === 0) continue
                textRuns.push({
                  text: value.trim().slice(0, 200),
                  box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
                  afterChild: elementIndex,
                })
                continue
              }
              // One run per visual line: walk characters and bucket them by the
              // line box they land in, so wrapped text keeps its line geometry.
              const groups = []
              for (const line of lineRects) {
                const existing = groups.find(group => Math.abs(group.top - line.top) < 1.5)
                if (existing === undefined) groups.push({ top: line.top, bottom: line.bottom, rect: line })
                else if (line.width > existing.rect.width) existing.rect = line
              }
              const buckets = groups.map(() => [])
              const charRange = document.createRange()
              for (let index = 0; index < value.length; index += 1) {
                charRange.setStart(child, index)
                charRange.setEnd(child, index + 1)
                const box = charRange.getBoundingClientRect()
                if (box.width === 0 && box.height === 0) {
                  if (buckets.length > 0) buckets[buckets.length - 1].push(index)
                  continue
                }
                const center = box.top + box.height / 2
                let bucket = 0
                while (bucket < groups.length - 1 && center > groups[bucket].bottom) bucket += 1
                buckets[bucket].push(index)
              }
              for (let index = 0; index < groups.length; index += 1) {
                const chars = buckets[index]
                if (chars.length === 0) continue
                const text = value.slice(chars[0], chars[chars.length - 1] + 1).trim()
                if (text.length === 0) continue
                const rect = groups[index].rect
                textRuns.push({
                  text: text.slice(0, 200),
                  box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
                  afterChild: elementIndex,
                })
              }
            }
            const localName = (element.localName ?? element.tagName).toLowerCase()
            const node = {
              tag: localName,
              box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
              style: pick(style),
            }
            if (localName === 'iframe') node.frameIndex = iframeCount++
            // A transformed element's box is its bounding box, not its layout box;
            // keep the computed layout size so the transform can be replayed.
            if (style.transform !== 'none') {
              node.transformedSize = { width: style.width, height: style.height }
            }
            if (textRuns.length > 0) node.textRuns = textRuns
            if (element.dataset?.ir !== undefined) node.ir = element.dataset.ir
            if (element.dataset?.irRun !== undefined) node.irRun = element.dataset.irRun
            if (element.colSpan > 1) node.colSpan = element.colSpan
            if (element.rowSpan > 1) node.rowSpan = element.rowSpan
            const attributeNames = elementAttributes[localName]
            if (attributeNames !== undefined) {
              const attributes = {}
              for (const name of attributeNames) {
                if (name === 'src') {
                  const source = element.currentSrc || element.src
                  if (source) attributes.src = source
                  continue
                }
                const value = element.getAttribute(name)
                if (value !== null && value !== '') attributes[name] = value
              }
              if (Object.keys(attributes).length > 0) node.attributes = attributes
            }
            if (localName === 'select' && element.options !== undefined && element.options.length > 0) {
              node.options = [...element.options].map(option => ({
                text: option.textContent.trim().slice(0, 80),
                value: option.value,
                selected: option.selected,
              }))
            }
            if (localName === 'canvas' && typeof element.toDataURL === 'function') {              try {
                const snapshot = element.toDataURL('image/png')
                if (typeof snapshot === 'string' && snapshot.startsWith('data:image/')) {
                  node.attributes = { ...(node.attributes ?? {}), src: snapshot }
                }
              } catch {
                // Tainted canvas: keep the box, no pixels.
              }
            }
            const authored = {}
            for (const rule of sizingRules) {
              try {
                if (!element.matches(rule.selector)) continue
              } catch {
                continue
              }
              Object.assign(authored, rule.values)
            }
            for (const key of ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'flexBasis']) {
              const value = element.style?.[key]
              if (typeof value === 'string' && value !== '') authored[key] = value
            }
            if (Object.keys(authored).length > 0) node.authored = authored
            const pseudoNodes = []
            for (const which of ['::before', '::after']) {
              const pseudo = getComputedStyle(element, which)
              const content = pseudo.content
              if (content === 'none' || content === 'normal' || content === '') continue
              if (pseudo.display === 'none' || pseudo.visibility === 'hidden') continue
              if (content.startsWith('url(')) {
                const urlMatch = /^url\((['"]?)([^'")]+)\1\)/.exec(content)
                const widthPx = pseudo.width !== 'auto' ? Number.parseFloat(pseudo.width) : 0
                const heightPx = pseudo.height !== 'auto' ? Number.parseFloat(pseudo.height) : 0
                if (urlMatch !== null && widthPx > 0 && heightPx > 0) {
                  let absolute = urlMatch[2]
                  try { absolute = new URL(absolute, location.href).href } catch {}
                  const pseudoStyle = pick(pseudo)
                  pseudoStyle.backgroundImage = `url("${absolute}")`
                  pseudoStyle.width = `${widthPx}px`
                  pseudoStyle.height = `${heightPx}px`
                  if (pseudoStyle.display === 'inline') pseudoStyle.display = 'inline-block'
                  const x = which === '::before'
                    ? rect.x + num(style.paddingLeft) + num(pseudo.marginLeft)
                    : rect.x + rect.width - num(style.paddingRight) - widthPx
                  const y = rect.y + num(style.paddingTop) + Math.max(0, (rect.height - heightPx) / 2)
                  pseudoNodes.push({
                    tag: 'span',
                    pseudo: which,
                    box: { x: round(x), y: round(y), w: round(widthPx), h: round(heightPx) },
                    style: pseudoStyle,
                  })
                }
                continue
              }
              if (!content.startsWith('"')) continue
              let text = ''
              try { text = JSON.parse(content) } catch { text = content.slice(1, -1) }
              if (text.length > 100) continue
              const widthPx = pseudo.width !== 'auto' ? Number.parseFloat(pseudo.width) : undefined
              const heightPx = pseudo.height !== 'auto' ? Number.parseFloat(pseudo.height) : undefined
              const background = pseudo.backgroundColor
              const hasBox = widthPx !== undefined || heightPx !== undefined
                || (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent')
                || Number.parseFloat(pseudo.borderTopWidth) > 0
              // An empty ::before/::after still becomes a zero-width flex item and
              // consumes a gap, so flex/grid containers must keep it.
              const parentFlow = style.display.includes('flex') || style.display.includes('grid')
              if (text.length === 0 && !hasBox && !parentFlow) continue
              const padX = num(pseudo.paddingLeft) + num(pseudo.paddingRight) + num(pseudo.borderLeftWidth) + num(pseudo.borderRightWidth)
              const padY = num(pseudo.paddingTop) + num(pseudo.paddingBottom) + num(pseudo.borderTopWidth) + num(pseudo.borderBottomWidth)
              measureContext.font = `${pseudo.fontStyle} ${pseudo.fontWeight} ${pseudo.fontSize} ${pseudo.fontFamily}`
              const textWidth = text.length > 0 ? measureContext.measureText(text).width : 0
              const width = widthPx ?? Math.max(0, textWidth + padX)
              const height = heightPx
                ?? (Number.parseFloat(pseudo.lineHeight) || Number.parseFloat(pseudo.fontSize) * 1.2) + padY
              const pseudoStyle = pick(pseudo)
              if (widthPx !== undefined) pseudoStyle.width = `${widthPx}px`
              if (heightPx !== undefined) pseudoStyle.height = `${heightPx}px`
              if (pseudoStyle.display === 'inline') pseudoStyle.display = 'inline-block'
              const contentHeight = rect.height - num(style.paddingTop) - num(style.paddingBottom)
              const y = rect.y + num(style.paddingTop) + Math.max(0, (contentHeight - height) / 2)
              const x = which === '::before'
                ? rect.x + num(style.paddingLeft) + num(pseudo.marginLeft)
                : rect.x + rect.width - num(style.paddingRight) - width
              const pseudoNode = {
                tag: 'span',
                pseudo: which,
                box: { x: round(x), y: round(y), w: round(width), h: round(height) },
                style: pseudoStyle,
              }
              if (text.length > 0) {
                pseudoNode.textRuns = [{ text, box: { x: round(x), y: round(y), w: round(width), h: round(height) } }]
              }
              pseudoNodes.push(pseudoNode)
            }
            const parentFlow = style.display.includes('flex') || style.display.includes('grid')
            const collectChildren = () => {
              const shadow = element.shadowRoot
              const source = shadow === null || shadow === undefined
                ? [...element.children]
                : [...shadow.children]
              // Composed tree: each <slot> is replaced by its assigned light-DOM
              // elements (fallback children when nothing is assigned).
              const composed = []
              for (const child of source) {
                if (child.tagName === 'SLOT') {
                  const assigned = typeof child.assignedElements === 'function'
                    ? child.assignedElements({ flatten: true })
                    : []
                  composed.push(...(assigned.length > 0 ? assigned : [...child.children]))
                  continue
                }
                composed.push(child)
              }
              return composed
            }
            const children = collectChildren()
              .map(child => walk(child, depth + 1, parentFlow))
              .filter(Boolean)
            if (pseudoNodes.length > 0) {
              const before = pseudoNodes.filter(item => item.pseudo === '::before')
              const after = pseudoNodes.filter(item => item.pseudo === '::after')
              node.children = [...before, ...children, ...after]
            } else if (children.length > 0) {
              node.children = children
            }
            return node
          }
          const root = walk(document.body, 0)
          const fonts = []
          const seen = new Set()
          for (const sheet of document.styleSheets) {
            let rules
            try {
              rules = sheet.cssRules
            } catch {
              continue
            }
            for (const rule of rules ?? []) {
              if (rule.type !== 5) continue
              const family = (rule.style.getPropertyValue('font-family') ?? '').replace(/['"]/g, '').trim()
              if (family.length === 0) continue
              const weight = (rule.style.getPropertyValue('font-weight') ?? '').trim() || '400'
              const styleValue = (rule.style.getPropertyValue('font-style') ?? '').trim() || 'normal'
              const srcValue = rule.style.getPropertyValue('src') ?? ''
              const url = /url\((['"]?)([^'")]+)\1\)/.exec(srcValue)?.[2]
              if (url === undefined) continue
              let absolute = url
              try {
                absolute = new URL(url, sheet.href || location.href).href
              } catch {}
              const format = /format\((['"]?)([^'")]+)\1\)/.exec(srcValue)?.[2] ?? ''
              const key = `${family}|${weight}|${styleValue}|${absolute}`
              if (seen.has(key)) continue
              seen.add(key)
              fonts.push({ family, weight, style: styleValue, src: absolute, format })
            }
          }
          return { root, truncated, count, fonts, iframes: iframeCount }
        }

/**
 * Capture same-browser iframe content into the parent IR. Coordinates are
 * translated into page space, so the absolute renderer draws the content at the
 * right place. Only one iframe level is attached; a nested iframe stays a plain
 * box and is reported as such in docs/IR.md.
 */
async function attachIframeContent(hostFrame, dom) {
  const handles = await hostFrame.$$('iframe')
  if (handles.length === 0) return
  const nodes = []
  const visit = node => {
    if (node === null || typeof node !== 'object') return
    if (node.frameIndex !== undefined) nodes.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  if (dom.root !== null) visit(dom.root)
  for (const node of nodes) {
    const handle = handles[node.frameIndex]
    if (handle === undefined) continue
    const frame = await handle.contentFrame()
    if (frame === null) continue
    const origin = await handle.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.left + element.clientLeft, y: rect.top + element.clientTop }
    })
    let sub
    try {
      sub = await frame.evaluate(captureDocumentFrame, CAPTURE_ARGS)
    } catch {
      continue
    }
    if (sub.root === null) continue
    translateIr(sub.root, origin.x, origin.y)
    node.children = sub.root.children ?? []
    node.iframe = { url: frame.url() }
  }
}

function translateIr(node, dx, dy) {
  node.box.x += dx
  node.box.y += dy
  for (const run of node.textRuns ?? []) {
    run.box.x += dx
    run.box.y += dy
  }
  for (const child of node.children ?? []) translateIr(child, dx, dy)
}

/**
 * Wait for the page to become capture-ready. Defaults keep the old behaviour
 * (fonts, image decode, 120 ms) and `networkIdle` / `selector` are opt-in.
 */
async function settlePage(page, settle = {}) {
  const timeout = settle.timeoutMs ?? 15000
  if (settle.networkIdle === true) {
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
  }
  if (settle.selector !== undefined) {
    await page.waitForSelector(settle.selector, { timeout }).catch(() => {})
  }
  if (settle.fonts !== false) {
    await page.evaluate(() => document.fonts?.ready ?? Promise.resolve()).catch(() => {})
  }
  if (settle.images !== false) {
    await page.evaluate(async () => {
      const pending = [...document.images].filter(image => !image.complete)
      await Promise.all(pending.map(image => image.decode().catch(() => {})))
    }).catch(() => {})
  }
  await page.waitForTimeout(settle.delayMs ?? 120)
}

/**
 * Read `@font-face` rules through CDP so cross-origin stylesheets (whose
 * `cssRules` the page cannot read) still materialize their fonts.
 */
async function collectCrossOriginFonts(page, fonts) {
  const seen = new Set(fonts.map(font => `${font.family}|${font.weight}|${font.style}|${font.src}`))
  let client
  try {
    client = await page.context().newCDPSession(page)
  } catch {
    return
  }
  const sheets = []
  client.on('CSS.styleSheetAdded', event => {
    if (event?.header !== undefined) sheets.push(event.header)
  })
  try {
    await client.send('DOM.enable')
    await client.send('CSS.enable')
    await page.waitForTimeout(250)
    for (const header of sheets) {
      if (typeof header.sourceURL !== 'string' || header.sourceURL.length === 0) continue
      let text
      try {
        ({ text } = await client.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId }))
      } catch {
        continue
      }
      for (const match of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
        const body = match[1]
        const family = /font-family\s*:\s*['"]?([^'";]+)/.exec(body)?.[1]?.trim()
        const source = /src\s*:\s*([^;]+)/.exec(body)?.[1]
        if (family === undefined || source === undefined) continue
        const url = /url\((['"]?)([^'")]+)\1\)/.exec(source)?.[2]
        if (url === undefined) continue
        let absolute
        try {
          absolute = new URL(url, header.sourceURL).href
        } catch {
          continue
        }
        const weight = /font-weight\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() || '400'
        const style = /font-style\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() || 'normal'
        const format = /format\((['"]?)([^'")]+)\1\)/.exec(source)?.[2] ?? ''
        const key = `${family}|${weight}|${style}|${absolute}`
        if (seen.has(key)) continue
        seen.add(key)
        fonts.push({ family, weight, style, src: absolute, format })
      }
    }
  } finally {
    await client.detach().catch(() => {})
  }
}

/**
 * Open a headed browser so the user can log in, wait for a URL or selector
 * condition, then write a Playwright storageState file.
 * @returns {Promise<{path: string, url: string, cookies: number, origins: number}>}
 */
export async function captureLoginState(options) {
  const playwright = await resolvePlaywright(options.dependenciesRoot ?? options.repoRoot)
  if (playwright === undefined) {
    throw new Error('login capture needs Playwright: install it in the repository (npm i -D playwright)')
  }
  if (options.waitForUrl === undefined && options.waitForSelector === undefined) {
    throw new Error('login capture needs waitForUrl or waitForSelector so it knows when the login is done')
  }
  const timeoutMs = options.timeoutMs ?? 300000
  const browser = await playwright.chromium.launch({ headless: options.headless === true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
    const page = await context.newPage()
    await page.goto(toTargetUrl(options.url), { waitUntil: 'load', timeout: 60000 })
    const deadline = Date.now() + timeoutMs
    const done = async () => {
      if (options.waitForUrl !== undefined) {
        const current = page.url()
        const matched = options.waitForUrl.startsWith('re:')
          ? new RegExp(options.waitForUrl.slice(3)).test(current)
          : current.includes(options.waitForUrl)
        if (matched) return true
      }
      if (options.waitForSelector !== undefined && await page.$(options.waitForSelector) !== null) return true
      return false
    }
    while (Date.now() < deadline) {
      if (await done()) break
      await page.waitForTimeout(500)
    }
    if (!(await done())) {
      throw new Error(`login did not reach the wait condition within ${Math.round(timeoutMs / 1000)}s`)
    }
    const state = await context.storageState()
    const target = options.storageState ?? join(options.repoRoot, '.parity', 'state.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(state, null, 2))
    return { path: target, url: page.url(), cookies: state.cookies.length, origins: state.origins.length }
  } finally {
    await browser.close()
  }
}

function createPlaywrightDriver(playwright, options) {
  let browser

  async function capture(input) {
    if (browser === undefined) {
      browser = await playwright.chromium.launch({
        headless: options.headless !== false,
        // Match the Chrome CLI fallback's text rendering so captures from the
        // two drivers remain comparable.
        args: ['--disable-lcd-text', '--font-render-hinting=none', '--hide-scrollbars'],
      })
    }
    const { width, height, dpr } = input.viewport
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      locale: input.locale ?? 'zh-CN',
      timezoneId: input.timezone ?? 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      bypassCSP: true,
      ...(input.storageState === undefined ? {} : { storageState: input.storageState }),
    })
    try {
      const page = await context.newPage()
      if (input.fixtures !== undefined) {
        await applyFixtures(page, input.fixtures, input)
      }
      await page.goto(toTargetUrl(input.url), { waitUntil: 'load', timeout: 45000 })
      await page.addStyleTag({ content: FREEZE_CSS })
      if (input.freeze?.animations !== false) {
        await page.emulateMedia({ reducedMotion: 'reduce' })
      }
      if (input.freeze?.clock !== undefined && input.freeze?.clock !== null) {
        try {
          await page.clock.install({ time: new Date(input.freeze.clock) })
        } catch {
          // Older Playwright builds may not expose the clock API; the screenshot still runs.
        }
      }
      if (Array.isArray(input.steps) && input.steps.length > 0) {
        await runSteps(page, input.steps)
      }
      for (const selector of input.hide ?? []) {
        await page.addStyleTag({ content: `${selector}{display:none!important}` })
      }
      for (const selector of input.waitFor ?? []) {
        await page.waitForSelector(selector, { state: 'visible', timeout: 15000 }).catch(() => {})
      }
      await settlePage(page, input.settle)

      const screenshot = await page.screenshot({ type: 'png' })
      const image = decodePng(screenshot)
      const expectedWidth = Math.round(width * dpr)
      const expectedHeight = Math.round(height * dpr)
      if (image.width !== expectedWidth || image.height !== expectedHeight) {
        throw new Error(`screenshot is ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight} (${width}x${height} at dpr ${dpr})`)
      }

      const anchors = await measureAnchors(page, input.anchors ?? {}, STYLE_PROPS)

      const masks = await page.evaluate((selectors) => {
        const rects = []
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) rects.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
          }
        }
        return rects
      }, input.masks ?? [])

      let dom
      if (input.exportDom === true) {
        dom = await page.evaluate(captureDocumentFrame, CAPTURE_ARGS)
        await attachIframeContent(page, dom)
        if (input.settle?.fonts !== false) await collectCrossOriginFonts(page, dom.fonts)
      }

      return {
        image: { width: image.width, height: image.height, data: image.data },
        anchors,
        masks: masks.map(rect => scaleRect(rect, dpr)),
        dom,
        driver: `playwright ${playwright.version}`,
      }
    } finally {
      await context.close()
    }
  }

  async function dispose() {
    if (browser !== undefined) await browser.close()
    browser = undefined
  }

  return { id: 'playwright', capture, dispose }
}

function createChromeDriver() {
  return {
    id: 'chrome-cli',
    async capture(input) {
      const { width, height, dpr } = input.viewport
      const outPath = input.screenshotPath
      if (input.fixtures !== undefined) {
        throw new Error('fixtures need Playwright: the Chrome CLI driver cannot intercept requests. Install playwright in the repo.')
      }
      if (input.exportDom === true) {
        throw new Error('IR export needs Playwright: the Chrome CLI driver cannot read the DOM. Install playwright in the repo.')
      }
      if (Array.isArray(input.steps) && input.steps.length > 0) {
        throw new Error('interaction steps need Playwright: the Chrome CLI driver cannot click or fill. Install playwright in the repo.')
      }
      if (input.storageState !== undefined) {
        throw new Error('storageState needs Playwright: the Chrome CLI driver cannot load a browser state. Install playwright in the repo.')
      }
      const result = await captureScreenshot({ url: toTargetUrl(input.url), width, height, dpr, outPath, signal: input.signal })
      const decoded = decodePng(readFileSync(outPath))
      return {
        image: { width: decoded.width, height: decoded.height, data: decoded.data },
        anchors: {},
        masks: [],
        driver: `chrome-cli (${result.browser})`,
      }
    },
    async dispose() {},
  }
}

function scaleRect(rect, dpr) {
  return {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    w: Math.round(rect.w * dpr),
    h: Math.round(rect.h * dpr),
  }
}

/** Turn a local file path into a file:// URL; leave real URLs untouched. */
export function toTargetUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : pathToFileURL(value).href
}

/**
 * Install request interception for one capture by importing a repo module.
 * The module must default-export `(page, context) => Promise<void>`.
 * @param {object} page - Playwright page.
 * @param {string} file - absolute fixtures module path.
 * @param {object} input - capture input, passed as context.
 */
async function applyFixtures(page, file, input) {
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    throw new Error(`cannot load fixtures "${file}": ${error instanceof Error ? error.message : String(error)}`)
  }
  const setup = module.default ?? module.setup
  if (typeof setup !== 'function') {
    throw new Error(`fixtures "${file}" must default-export a function (page, context)`)
  }
  await setup(page, { url: input.url, viewport: input.viewport })
}
