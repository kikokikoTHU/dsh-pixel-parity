/**
 * Repository detection and config scaffolding.
 *
 * The point is to make the first run cheap on an arbitrary repo: find the dev
 * command, the port it listens on, the Playwright availability, and any route
 * table, then write a config draft whose TODOs point at the one thing only a
 * human can supply — the reference URL.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const DEFAULT_PORTS = { vite: 5173, next: 3000, nuxt: 3000, astro: 4321, vue: 5173, react: 3000 }
const APP_HINTS = ['hub', 'web', 'frontend', 'app', 'client', 'ui']

/**
 * Detect the parts of a repository that a parity config needs.
 * @param {string} repoRoot - repository root.
 * @returns {object} detection result.
 */
export function detectRepo(repoRoot) {
  const root = resolve(repoRoot)
  const rootPackage = readJson(join(root, 'package.json'))
  const packageManager = detectPackageManager(root, rootPackage)
  const dependencies = { ...rootPackage?.dependencies, ...rootPackage?.devDependencies }
  const baseFramework = detectFramework(dependencies)
  const workspaceApps = detectWorkspaceApps(root, rootPackage)
  const apps = workspaceApps.length > 0 ? workspaceApps : [describeApp(root, rootPackage, baseFramework)]
  const selected = pickApp(apps, baseFramework)
  const framework = selected.framework ?? baseFramework
  const port = selected.port ?? DEFAULT_PORTS[framework] ?? 3000
  const routes = detectRoutes(root, selected.dir)
  const playwright = existsSync(join(root, 'node_modules', 'playwright', 'package.json'))
    || existsSync(join(root, 'node_modules', '@playwright', 'test', 'package.json'))
  const configPath = findExistingConfig(root)

  return {
    root,
    framework,
    packageManager,
    dependencies,
    apps,
    selected,
    devCommand: selected.devScript,
    port,
    portSource: selected.portSource,
    routes,
    playwright,
    configPath,
    surfaces: [...(dependencies.electron === undefined ? [] : ['electron']), 'web'],
  }
}

function detectPackageManager(root, pkg) {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined
  if (declared !== undefined) return declared
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  return 'npm'
}

function detectFramework(dependencies) {
  if (dependencies?.next !== undefined) return 'next'
  if (dependencies?.nuxt !== undefined) return 'nuxt'
  if (dependencies?.astro !== undefined) return 'astro'
  if (dependencies?.svelte !== undefined) return 'svelte'
  if (dependencies?.vue !== undefined) return 'vue'
  if (dependencies?.react !== undefined) return 'react'
  if (dependencies?.vite !== undefined) return 'vite'
  return 'unknown'
}

function detectWorkspaceApps(root, pkg) {
  const patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
  if (!Array.isArray(patterns) || patterns.length === 0) return []
  const apps = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    const directories = expandWorkspacePattern(root, pattern)
    for (const dir of directories) {
      const appPackage = readJson(join(dir, 'package.json'))
      if (appPackage === undefined) continue
      apps.push(describeApp(dir, appPackage, detectFramework({ ...appPackage.dependencies, ...appPackage.devDependencies })))
    }
  }
  return apps
}

function expandWorkspacePattern(root, pattern) {
  if (!pattern.includes('*')) {
    const direct = join(root, pattern)
    return isDirectory(direct) ? [direct] : []
  }
  const suffixIndex = pattern.indexOf('*')
  const base = join(root, pattern.slice(0, suffixIndex).replace(/[/\\]$/, ''))
  if (!isDirectory(base)) return []
  return readdirSync(base)
    .map(entry => join(base, entry))
    .filter(entry => isDirectory(entry))
}

function describeApp(dir, pkg, framework) {
  const devScript = pkg?.scripts?.dev ?? pkg?.scripts?.start ?? null
  const portInfo = devScript === null ? { port: undefined, source: undefined } : portFromScript(devScript, dir)
  return {
    name: pkg?.name ?? relative(process.cwd(), dir),
    dir,
    framework,
    devScript,
    port: portInfo.port,
    portSource: portInfo.source,
  }
}

function pickApp(apps, framework) {
  if (apps.length === 1) return apps[0]
  const hinted = apps.find(app => APP_HINTS.some(hint => app.name.toLowerCase().includes(hint)))
  return hinted ?? apps.find(app => app.port !== undefined) ?? apps[0]
}

function portFromScript(script, dir) {
  const direct = /(?:--port[=\s]+|-p\s+|PORT=)(\d{2,5})/.exec(script)
  if (direct !== null) return { port: Number(direct[1]), source: 'script' }
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const match = /server\s*:\s*\{[\s\S]{0,400}?port\s*:\s*(\d{2,5})/.exec(text)
    if (match !== null) return { port: Number(match[1]), source: 'vite-config' }
  }
  return { port: undefined, source: undefined }
}

function detectRoutes(root, appDir) {
  const candidates = [
    join(appDir, 'src', 'pages.js'),
    join(appDir, 'src', 'pages.ts'),
    join(appDir, 'src', 'router.js'),
    join(appDir, 'src', 'router.ts'),
    join(appDir, 'src', 'router', 'index.js'),
    join(appDir, 'src', 'router', 'index.ts'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const routes = extractRoutePaths(readFileSync(file, 'utf8'))
    if (routes.length > 0) return routes.slice(0, 50).map(path => ({ path, source: relative(root, file) }))
  }
  const pages = scanPageFiles(root, appDir)
  return pages.slice(0, 50).map(path => ({ path, source: 'file-scan' }))
}

function extractRoutePaths(text) {
  const routes = []
  const seen = new Set()
  const pattern = /path\s*:\s*['"]([^'"]+)['"]/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const path = match[1]
    if (!path.startsWith('/') || seen.has(path)) continue
    seen.add(path)
    routes.push(path)
  }
  return routes
}

function scanPageFiles(root, appDir) {
  const roots = [join(appDir, 'src', 'views'), join(appDir, 'pages'), join(appDir, 'src', 'pages'), join(appDir, 'app')]
  const routes = []
  for (const directory of roots) {
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry)
      if (!statSync(file).isFile()) continue
      if (!/\.(vue|tsx|jsx|js|ts)$/.test(entry)) continue
      const name = entry.replace(/\.[^.]+$/, '').replace(/(Page|View)$/, '')
      routes.push(`/${kebab(name)}`)
    }
  }
  return [...new Set(routes)]
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function findExistingConfig(root) {
  for (const name of ['parity.config.mjs', 'parity.config.js', 'parity.config.json']) {
    if (existsSync(join(root, name))) return join(root, name)
  }
  return undefined
}

function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Render a config draft for a detected repository.
 * @param {object} detection - result of {@link detectRepo}.
 * @param {{routes?: string[]}} [options] - route overrides.
 * @returns {string} config source.
 */
export function renderConfigDraft(detection, options = {}) {
  const routes = options.routes ?? detection.routes.map(route => route.path)
  const firstRoute = routes[0] ?? '/'
  const baseUrl = `http://127.0.0.1:${detection.port}`
  const routeList = routes.length === 0
    ? '    // no route table detected; set implementation.path to the page you are aligning'
    : routes.map(route => `    // ${route}`).join('\n')
  return `// Generated by parity_init. Fill in the reference URL, then map cases below.
// Detected: framework=${detection.framework}, packageManager=${detection.packageManager}, port=${detection.port} (${detection.portSource ?? 'default'}).
// Dev command: ${detection.devCommand ?? '(none found)'}
// Playwright: ${detection.playwright ? 'available' : 'not installed — runs will fall back to the Chrome CLI (pixels only)'}
//
// Routes detected in this repo:
${routeList}

export default {
  version: 2,
  viewports: [
    { id: 'desktop', width: 1440, height: 900, dpr: 1 },
  ],
  targets: {
    implementation: { baseUrl: '${baseUrl}' },
  },
  cases: [
    {
      id: 'first-page',
      // TODO: point this at the reference for '${firstRoute}' (URL or local image path).
      reference: { url: 'REPLACE_WITH_REFERENCE_URL' },
      implementation: { path: '${firstRoute}' },
      anchors: {},
    },
  ],
}
`
}

/**
 * Write a config draft unless one already exists.
 * @param {{repoRoot: string, output?: string, force?: boolean}} input - scaffold request.
 * @returns {object} init result.
 */
export function initRepo(input) {
  const detection = detectRepo(input.repoRoot)
  const configPath = resolve(input.repoRoot, input.output ?? 'parity.config.mjs')
  if (existsSync(configPath) && input.force !== true) {
    return {
      configPath,
      created: false,
      detection,
      warnings: [`config already exists at ${configPath}; pass force to overwrite`],
    }
  }
  const source = renderConfigDraft(detection)
  writeFileSync(configPath, source)
  return {
    configPath,
    created: true,
    detection,
    warnings: buildWarnings(detection),
  }
}

function buildWarnings(detection) {
  const warnings = []
  if (!detection.playwright) warnings.push('Playwright is not installed in this repo: geometry and style layers will be unavailable (image-verified only).')
  if (detection.routes.length === 0) warnings.push('No route table detected: set implementation.path manually.')
  if (detection.surfaces.includes('electron')) warnings.push('Electron detected: desktop surfaces are reserved for a later phase; this config checks the web build.')
  if (detection.selected.portSource === undefined) warnings.push(`Port ${detection.port} is a framework default, not read from the repo; confirm the dev server port.`)
  return warnings
}
