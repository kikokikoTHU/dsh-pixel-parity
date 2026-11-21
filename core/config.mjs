/**
 * Configuration loading and normalization for parity v2.
 *
 * A config is a JS module (default export) or a JSON file. JS wins for repos
 * that need computed values, JSON for generated configs. YAML is intentionally
 * not supported yet: it would add a parser dependency to a zero-dependency core.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SURFACES = new Set(['web', 'electron', 'desktop', 'image'])

/**
 * Load and normalize one config file.
 * @param {string} configPath - absolute or cwd-relative path.
 * @returns {Promise<object>} normalized config.
 */
export async function loadConfig(configPath) {
  const absolute = isAbsolute(configPath) ? configPath : resolve(configPath)
  const extension = extname(absolute).toLowerCase()
  let raw
  if (extension === '.json') {
    raw = JSON.parse(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, ''))
  } else if (extension === '.mjs' || extension === '.js') {
    const module = await import(`${pathToFileURL(absolute).href}?v=${Date.now()}`)
    raw = module.default ?? module.config
  } else {
    throw new Error(`unsupported config extension "${extension}": use .mjs, .js, or .json`)
  }
  return normalizeConfig(raw, absolute)
}

/**
 * Normalize a raw config object, resolving relative references against its directory.
 * @param {object} raw - parsed config.
 * @param {string} absolutePath - config file path, used as the base directory.
 * @returns {object} normalized config.
 */
export function normalizeConfig(raw, absolutePath) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config must be an object')
  }
  if (raw.version !== 2) throw new Error(`config version must be 2, got ${JSON.stringify(raw.version)}`)
  const directory = resolve(absolutePath, '..')

  const defaults = {
    surface: 'web',
    tolerance: 24,
    maxMismatch: 0.01,
    maxRegionMismatch: 0.4,
    geometryTolerance: 1,
    masks: [],
    freeze: { animations: true, caret: true, clock: null },
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    ...raw.defaults,
    freeze: { animations: true, caret: true, clock: null, ...raw.defaults?.freeze },
  }
  if (!SURFACES.has(defaults.surface)) {
    throw new Error(`defaults.surface must be one of ${[...SURFACES].join(', ')}`)
  }

  const viewports = (raw.viewports ?? [{ id: 'default', width: 1440, height: 900 }]).map((viewport, index) => {
    const normalized = {
      id: viewport.id ?? `viewport-${index + 1}`,
      width: integer(viewport.width, `viewports[${index}].width`, 1, 16384),
      height: integer(viewport.height, `viewports[${index}].height`, 1, 16384),
      dpr: viewport.dpr ?? 1,
    }
    if (typeof normalized.dpr !== 'number' || normalized.dpr < 0.5 || normalized.dpr > 8) {
      throw new Error(`viewports[${index}].dpr must be a number between 0.5 and 8`)
    }
    return normalized
  })
  const viewportIds = new Set()
  for (const viewport of viewports) {
    if (viewportIds.has(viewport.id)) throw new Error(`duplicate viewport id "${viewport.id}"`)
    viewportIds.add(viewport.id)
  }

  const targets = {
    reference: normalizeTarget(raw.targets?.reference ?? {}, directory, 'targets.reference'),
    implementation: normalizeTarget(raw.targets?.implementation ?? {}, directory, 'targets.implementation'),
  }

  const cases = (raw.cases ?? []).map((entry, index) => normalizeCase(entry, index, directory, defaults, targets))
  if (cases.length === 0) throw new Error('config needs at least one case')
  const caseIds = new Set()
  for (const entry of cases) {
    if (caseIds.has(entry.id)) throw new Error(`duplicate case id "${entry.id}"`)
    caseIds.add(entry.id)
  }

  return {
    version: 2,
    path: absolutePath,
    directory,
    sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    defaults,
    viewports,
    targets,
    cases,
  }
}

function normalizeTarget(raw, directory, label) {
  const kind = raw.kind ?? 'web'
  if (!['web', 'image', 'figma'].includes(kind)) {
    throw new Error(`${label}.kind must be "web", "image", or "figma"`)
  }
  if (kind === 'image') {
    if (typeof raw.path !== 'string' || raw.path.length === 0) throw new Error(`${label}.path is required for an image target`)
    return { ...raw, kind, path: resolve(directory, raw.path) }
  }
  if (kind === 'figma') {
    if (raw.document === undefined) {
      if (typeof raw.fileKey !== 'string' || raw.fileKey.length === 0) throw new Error(`${label}.fileKey is required for a Figma target`)
      if (typeof raw.nodeId !== 'string' || raw.nodeId.length === 0) throw new Error(`${label}.nodeId is required for a Figma target`)
    }
    return {
      kind,
      fileKey: raw.fileKey,
      nodeId: raw.nodeId,
      apiBase: raw.apiBase ?? 'https://api.figma.com',
      tokenEnv: raw.tokenEnv ?? 'FIGMA_TOKEN',
      document: raw.document,
    }
  }
  return {
    ...raw,
    kind,
    baseUrl: raw.baseUrl ?? '',
    start: typeof raw.start === 'string' && raw.start.trim().length > 0 ? raw.start : undefined,
    startTimeoutMs: raw.startTimeoutMs ?? 90000,
    readyUrl: raw.readyUrl,
    hide: raw.hide ?? [],
    waitFor: raw.waitFor ?? [],
    viewport: raw.viewport ?? null,
    fixtures: raw.fixtures === undefined ? undefined : resolve(directory, raw.fixtures),
  }
}

function normalizeCase(entry, index, directory, defaults, targets) {
  if (entry === null || typeof entry !== 'object') throw new Error(`cases[${index}] must be an object`)
  const id = entry.id ?? `case-${index + 1}`
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`cases[${index}].id must be a simple slug, got ${JSON.stringify(id)}`)
  }
  const surface = entry.surface ?? defaults.surface
  if (!SURFACES.has(surface)) throw new Error(`cases[${index}].surface must be one of ${[...SURFACES].join(', ')}`)

  const reference = resolveTargetSpec(entry.reference, targets.reference, directory, `cases[${index}].reference`)
  const implementation = resolveTargetSpec(entry.implementation, targets.implementation, directory, `cases[${index}].implementation`)

  const anchors = entry.anchors ?? {}
  if (typeof anchors !== 'object' || Array.isArray(anchors)) throw new Error(`cases[${index}].anchors must be an object`)
  for (const [key, value] of Object.entries(anchors)) {
    if (value === null || typeof value !== 'object') throw new Error(`cases[${index}].anchors.${key} must be { ref, impl }`)
    if (typeof value.ref !== 'string' || typeof value.impl !== 'string') {
      throw new Error(`cases[${index}].anchors.${key} needs string ref and impl selectors`)
    }
  }

  const masks = (entry.masks ?? defaults.masks).map((mask, maskIndex) => {
    if (typeof mask === 'string') return { ref: mask, impl: mask }
    if (mask === null || typeof mask !== 'object') throw new Error(`cases[${index}].masks[${maskIndex}] must be a selector or { ref, impl }`)
    return { ref: mask.ref, impl: mask.impl ?? mask.ref }
  })

  const thresholds = {
    tolerance: entry.thresholds?.tolerance ?? defaults.tolerance,
    maxMismatch: entry.thresholds?.maxMismatch ?? defaults.maxMismatch,
    maxRegionMismatch: entry.thresholds?.maxRegionMismatch ?? defaults.maxRegionMismatch,
    geometryTolerance: entry.thresholds?.geometryTolerance ?? defaults.geometryTolerance,
  }
  number(thresholds.geometryTolerance, `cases[${index}].thresholds.geometryTolerance`, 0, 64)
  number(thresholds.maxMismatch, `cases[${index}].thresholds.maxMismatch`, 0, 1)
  number(thresholds.maxRegionMismatch, `cases[${index}].thresholds.maxRegionMismatch`, 0, 1)

  return {
    id,
    surface,
    reference,
    implementation,
    anchors,
    masks,
    thresholds,
    hide: { ref: entry.hide?.ref ?? targets.reference.hide, impl: entry.hide?.impl ?? targets.implementation.hide },
    waitFor: { ref: entry.waitFor?.ref ?? targets.reference.waitFor, impl: entry.waitFor?.impl ?? targets.implementation.waitFor },
  }
}

function resolveTargetSpec(spec, target, directory, label) {
  if (spec === null || typeof spec !== 'object') throw new Error(`${label} must be an object`)
  const kind = spec.kind ?? target.kind
  if (kind === 'web') {
    const url = spec.url ?? spec.path
    if (typeof url !== 'string' || url.length === 0) throw new Error(`${label}.url (or .path) is required`)
    return {
      kind,
      url: resolveUrl(url, target.baseUrl, directory),
      fixtures: spec.fixtures === undefined ? target.fixtures : resolve(directory, spec.fixtures),
      start: spec.start ?? target.start,
      startTimeoutMs: spec.startTimeoutMs ?? target.startTimeoutMs ?? 90000,
      readyUrl: spec.readyUrl ?? target.readyUrl,
    }
  }
  if (kind === 'figma') {
    const document = spec.document ?? target.document
    const fileKey = spec.fileKey ?? target.fileKey
    const nodeId = spec.nodeId ?? target.nodeId
    if (document === undefined && (typeof fileKey !== 'string' || typeof nodeId !== 'string')) {
      throw new Error(`${label} needs fileKey and nodeId (or an inline document) for a Figma target`)
    }
    return {
      kind,
      fileKey,
      nodeId,
      apiBase: spec.apiBase ?? target.apiBase ?? 'https://api.figma.com',
      tokenEnv: spec.tokenEnv ?? target.tokenEnv ?? 'FIGMA_TOKEN',
      document,
    }
  }
  if (kind === 'image') {
    const path = spec.path ?? spec.url
    if (typeof path !== 'string' || path.length === 0) throw new Error(`${label}.path is required for an image target`)
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    return { kind, path: looksLikeUrl ? path : resolve(directory, path) }
  }
  throw new Error(`${label}.kind "${kind}" is not implemented yet (web, image, and figma only)`)
}

function resolveUrl(value, baseUrl, directory) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (typeof baseUrl === 'string' && baseUrl.length > 0) return new URL(value, baseUrl).href
  return resolve(directory, value)
}

function integer(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function number(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}`)
  }
  return value
}
