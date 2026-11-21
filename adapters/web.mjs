/**
 * Web surface adapter.
 *
 * Primary driver: Playwright resolved from the target repo (no bundled copy).
 * It gives screenshots, anchor geometry, and computed styles from one render.
 * Fallback driver: the Chrome/Edge CLI from v1, which only yields pixels.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
}

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
      for (const selector of input.hide ?? []) {
        await page.addStyleTag({ content: `${selector}{display:none!important}` })
      }
      for (const selector of input.waitFor ?? []) {
        await page.waitForSelector(selector, { state: 'visible', timeout: 15000 }).catch(() => {})
      }
      await page.evaluate(() => document.fonts?.ready ?? Promise.resolve())
      await page.waitForTimeout(120)

      const screenshot = await page.screenshot({ type: 'png' })
      const image = decodePng(screenshot)
      const expectedWidth = Math.round(width * dpr)
      const expectedHeight = Math.round(height * dpr)
      if (image.width !== expectedWidth || image.height !== expectedHeight) {
        throw new Error(`screenshot is ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight} (${width}x${height} at dpr ${dpr})`)
      }

      const anchors = await page.evaluate(({ selectors, props }) => {
        const result = {}
        for (const [id, selector] of Object.entries(selectors)) {
          const element = document.querySelector(selector)
          if (element === null) {
            result[id] = null
            continue
          }
          const rect = element.getBoundingClientRect()
          const computed = getComputedStyle(element)
          const styles = {}
          for (const property of props) styles[property] = computed[property]
          result[id] = {
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            styles,
          }
        }
        return result
      }, { selectors: input.anchors ?? {}, props: STYLE_PROPS })

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
        dom = await page.evaluate(({ maxNodes, styleKeys, elementAttributes }) => {
          const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'COLGROUP', 'COL'])
          const round = value => Math.round(value * 10) / 10
          const pick = (style) => {
            const out = {}
            for (const key of styleKeys) {
              const value = style[key]
              if (value !== undefined && value !== '') out[key] = value
            }
            return out
          }
          let count = 0
          let truncated = false
          const walk = (element, depth) => {
            if (depth > 14 || count >= maxNodes) {
              if (count >= maxNodes) truncated = true
              return null
            }
            if (SKIP.has(element.tagName)) return null
            const style = getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null
            const rect = element.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return null
            count += 1
            const textRuns = []
            for (const child of element.childNodes) {
              if (child.nodeType !== 3) continue
              const value = child.textContent.trim()
              if (value.length === 0) continue
              const range = document.createRange()
              range.selectNodeContents(child)
              const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
              if (rect === undefined || (rect.width === 0 && rect.height === 0)) continue
              textRuns.push({
                text: value.slice(0, 200),
                box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
              })
            }
            const localName = (element.localName ?? element.tagName).toLowerCase()
            const node = {
              tag: localName,
              box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
              style: pick(style),
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
            const children = [...element.children].map(child => walk(child, depth + 1)).filter(Boolean)
            if (children.length > 0) node.children = children
            return node
          }
          const root = walk(document.body, 0)
          return { root, truncated, count }
        }, { maxNodes: 2000, styleKeys: IR_STYLE_PROPS, elementAttributes: ELEMENT_ATTRIBUTES })
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
