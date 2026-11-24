/**
 * Design-site discovery and implementation route discovery.
 *
 * The prototype site is a set of static HTML pages linked from one entry page.
 * We only follow same-origin links inside the entry directory, and only .html
 * pages; this keeps the crawl scoped and avoids turning into a general crawler.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createRequire } from 'node:module'

const MAX_PAGES = 40

function decodeEntities(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function meta(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  return { title: stripTags(title ?? ''), heading: stripTags(h1 ?? '') }
}

async function fetchText(url, timeoutMs = 15000) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw lastError
}

/** Pure parser, exported for tests. */
export function parseDesignLinks(html, entryUrl, { max = MAX_PAGES } = {}) {
  const entry = new URL(entryUrl)
  const directory = entry.pathname.slice(0, entry.pathname.lastIndexOf('/') + 1)
  const found = new Map()
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let url
    try {
      url = new URL(decodeEntities(match[1]), entry)
    } catch {
      continue
    }
    if (url.origin !== entry.origin) continue
    if (!url.pathname.startsWith(directory)) continue
    if (!/\.html?$/i.test(url.pathname)) continue
    if (url.pathname === entry.pathname) continue
    if (url.pathname.length > 300) continue
    if (!found.has(url.pathname)) found.set(url.pathname, url.href)
    if (found.size >= max) break
  }
  return [...found.values()]
}

/**
 * Discover all same-origin .html pages linked from one prototype entry page.
 * Returns [{url,title,heading}] with the entry page first.
 */
async function discoverDesignPagesWithBrowser(entryUrl, dependenciesRoot, options = {}) {
  const require = createRequire(join(dependenciesRoot, 'package.json'))
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(entryUrl, { waitUntil: 'networkidle', timeout: options.timeoutMs ?? 60000 })
    await page.waitForTimeout(500)
    const entry = new URL(entryUrl)
    const directory = entry.pathname.slice(0, entry.pathname.lastIndexOf('/') + 1)
    const raw = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.href, text: (a.textContent || '').trim() })))
    const urls = []
    for (const item of raw) {
      let url
      try { url = new URL(item.href) } catch { continue }
      if (url.origin !== entry.origin) continue
      if (!url.pathname.startsWith(directory)) continue
      if (!/\.html?$/i.test(url.pathname)) continue
      if (url.pathname === entry.pathname) continue
      if (!urls.includes(url.href)) urls.push(url.href)
      if (urls.length >= (options.max ?? MAX_PAGES)) break
    }
    const info = async () => ({
      title: await page.title(),
      heading: (await page.locator('h1').first().textContent().catch(() => ''))?.trim() ?? '',
    })
    const entryInfo = await info()
    const pages = [{ url: entry.href, title: entryInfo.title, heading: entryInfo.heading }]
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30000 })
        await page.waitForTimeout(200)
        pages.push({ url, ...(await info()) })
      } catch {
        pages.push({ url, title: '', heading: '' })
      }
    }
    return pages
  } finally {
    await browser.close()
  }
}
export async function discoverDesignPages(entryUrl, options = {}) {
  if (typeof options.dependenciesRoot === 'string' && options.dependenciesRoot.length > 0) {
    try {
      return await discoverDesignPagesWithBrowser(entryUrl, options.dependenciesRoot, options)
    } catch {}
  }
  const entry = new URL(entryUrl)
  const html = await fetchText(entryUrl, options.timeoutMs)
  const entryMeta = meta(html)
  const links = parseDesignLinks(html, entryUrl, { max: options.max ?? MAX_PAGES })
  const pages = [{ url: entry.href, title: entryMeta.title, heading: entryMeta.heading }]
  const queue = [...links]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      try {
        const pageHtml = await fetchText(url, options.timeoutMs)
        const info = meta(pageHtml)
        pages.push({ url, title: info.title, heading: info.heading })
      } catch {
        pages.push({ url, title: '', heading: '' })
      }
    }
  })
  await Promise.all(workers)
  return pages
}

/** Strip the site-name suffix/prefix so headings can be matched to route titles. */
export function normalizePageTitle(value) {
  return String(value ?? '')
    .replace(/^SPC集中管理平台\s*[-–—]\s*/i, '')
    .replace(/\s*[-–—]\s*SPC集中管理平台$/i, '')
    .replace(/^[\s·•\-–—|]+/, '')
    .replace(/[\s·•\-–—|]+$/, '')
    .replace(/\s+/g, '')
    .trim()
}

/** Scan common routing files and return [{path,title,file}]. */
export function discoverRoutes(repoRoot, { maxFiles = 500 } = {}) {
  const roots = ['src', 'app', 'pages', 'routes', 'apps', 'packages'].map(name => join(repoRoot, name)).filter(existsSync)
  const files = []
  const walk = directory => {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(js|mjs|ts|tsx|vue)$/i.test(entry.name)) {
        try {
          if (statSync(full).size < 2_000_000) files.push(full)
        } catch {}
      }
    }
  }
  for (const root of roots) walk(root)

  const routes = new Map()
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const pattern = /path\s*:\s*['"]([^'"]+)['"][\s\S]{0,240}?title\s*:\s*['"]([^'"]+)['"]/g
    for (const match of text.matchAll(pattern)) {
      const path = match[1]
      const title = match[2]
      if (!path.startsWith('/')) continue
      if (path.includes(':') || path.includes('*')) continue
      if (routes.has(path)) continue
      routes.set(path, { path, title, file: relative(repoRoot, file) })
    }
  }
  return [...routes.values()]
}

export function matchPageToRoute(page, routes) {
  const candidates = [normalizePageTitle(page.heading), normalizePageTitle(page.title)]
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const exact = routes.find(route => normalizePageTitle(route.title) === candidate)
    if (exact !== undefined) return { route: exact, confidence: 1, reason: 'title exact' }
  }
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const partial = routes.find(route => {
      const title = normalizePageTitle(route.title)
      return title.includes(candidate) || candidate.includes(title)
    })
    if (partial !== undefined) return { route: partial, confidence: 0.7, reason: 'title partial' }
  }
  return null
}

export function buildImplementationUrl(templateUrl, routePath) {
  const url = new URL(templateUrl)
  if (url.hash.startsWith('#/')) {
    return `${url.origin}${url.pathname}#${routePath.startsWith('/') ? routePath : `/${routePath}`}`
  }
  return `${url.origin}${routePath.startsWith('/') ? routePath : `/${routePath}`}`
}

export function routeCaseId(routePath) {
  const slug = routePath.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
  return slug.length === 0 ? 'home' : slug
}





