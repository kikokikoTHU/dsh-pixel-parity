/**
 * Baselines: the approved implementation state of one case + viewport.
 *
 * A baseline stores the implementation screenshot plus the anchor snapshot
 * (boxes and computed styles) from the run that was approved. Regression runs
 * compare against both, so they keep geometry and style evidence even offline.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../lib/png.js'
import { loadImage } from '../lib/image.js'

/**
 * Directory holding one baseline.
 * @param {string} repoRoot - repository root.
 * @param {string} caseId - case id.
 * @param {string} viewportId - viewport id.
 * @returns {string} absolute baseline directory.
 */
export function baselineDir(repoRoot, caseId, viewportId) {
  return join(repoRoot, '.parity', 'baselines', `${caseId}@${viewportId}`)
}

/**
 * Whether a usable baseline exists.
 * @param {string} repoRoot - repository root.
 * @param {string} caseId - case id.
 * @param {string} viewportId - viewport id.
 * @returns {boolean} true when the meta file exists.
 */
export function hasBaseline(repoRoot, caseId, viewportId) {
  return existsSync(join(baselineDir(repoRoot, caseId, viewportId), 'baseline.json'))
}

/**
 * Read one baseline.
 * @param {string} repoRoot - repository root.
 * @param {string} caseId - case id.
 * @param {string} viewportId - viewport id.
 * @returns {{image: object, anchors: object, meta: object} | undefined} baseline, or undefined.
 */
export function readBaseline(repoRoot, caseId, viewportId) {
  const directory = baselineDir(repoRoot, caseId, viewportId)
  const metaPath = join(directory, 'baseline.json')
  if (!existsSync(metaPath)) return undefined
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const image = loadImage(join(directory, 'implementation.png'))
  return { image, anchors: meta.anchors ?? {}, masks: meta.masks ?? [], meta }
}

/**
 * Write one baseline from a passing run.
 * @param {string} repoRoot - repository root.
 * @param {string} caseId - case id.
 * @param {string} viewportId - viewport id.
 * @param {{image: object, anchors: object, meta: object}} input - screenshot, anchors, metadata.
 * @returns {string} baseline directory.
 */
export function writeBaseline(repoRoot, caseId, viewportId, input) {
  const directory = baselineDir(repoRoot, caseId, viewportId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'implementation.png'), encodePng(input.image.width, input.image.height, input.image.data))
  writeFileSync(join(directory, 'baseline.json'), `${JSON.stringify({ ...input.meta, anchors: input.anchors }, null, 2)}\n`)
  return directory
}

/**
 * Approve a run: promote every verified viewport to a baseline.
 * @param {{repoRoot: string, runDir?: string, cases?: string[], note?: string}} input - approval request.
 * @returns {{runDir: string, approved: object[], skipped: object[]}} approval result.
 */
export function approveRun(input) {
  const runDir = input.runDir ?? latestRunDir(input.repoRoot)
  if (runDir === undefined) throw new Error(`no run found under ${join(input.repoRoot, '.parity', 'runs')}`)
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'))
  const approved = []
  const skipped = []
  for (const entry of manifest.cases ?? []) {
    if (input.cases !== undefined && input.cases.length > 0 && !input.cases.includes(entry.id)) continue
    for (const viewport of entry.viewports ?? []) {
      if (viewport.status !== 'verified' && viewport.status !== 'image-verified') {
        skipped.push({ case: entry.id, viewport: viewport.viewportId, reason: `status ${viewport.status}` })
        continue
      }
      if (viewport.artifacts?.implementation === undefined) {
        skipped.push({ case: entry.id, viewport: viewport.viewportId, reason: 'no implementation.png' })
        continue
      }
      const image = loadImage(viewport.artifacts.implementation)
      const anchors = viewport.anchors?.implementation ?? {}
      writeBaseline(input.repoRoot, entry.id, viewport.viewportId, {
        image,
        anchors,
        meta: {
          caseId: entry.id,
          viewportId: viewport.viewportId,
          approvedAt: new Date().toISOString(),
          runId: manifest.runId,
          status: viewport.status,
          note: input.note ?? null,
          repo: manifest.repo ?? null,
          config: manifest.config ?? null,
          masks: viewport.maskRects ?? [],
          thresholds: viewport.pixels?.metrics ? { maxMismatch: viewport.thresholds?.maxMismatch ?? null } : null,
        },
      })
      approved.push({ case: entry.id, viewport: viewport.viewportId, path: baselineDir(input.repoRoot, entry.id, viewport.viewportId) })
    }
  }
  return { runDir, approved, skipped }
}

/**
 * Find the newest run directory.
 * @param {string} repoRoot - repository root.
 * @returns {string | undefined} absolute path.
 */
export function latestRunDir(repoRoot) {
  const root = join(repoRoot, '.parity', 'runs')
  if (!existsSync(root)) return undefined
  const entries = readdirSync(root)
    .map(name => ({ name, path: join(root, name), mtime: statSync(join(root, name)).mtimeMs }))
    .filter(entry => existsSync(join(entry.path, 'manifest.json')))
    .sort((left, right) => right.mtime - left.mtime)
  return entries[0]?.path
}
