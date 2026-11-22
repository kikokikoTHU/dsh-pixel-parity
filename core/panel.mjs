/**
 * Read-only data for the Pixel Parity panel.
 *
 * The Host exposes two same-origin endpoints (see index.js):
 *   /pixel-parity/overview  → runs per root
 *   /pixel-parity/artifact  → a PNG/JSON file inside a run directory
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const ARTIFACT_TYPES = {
  '.png': 'image/png',
}

/**
 * Summarize recent runs under `<root>/.parity/runs`.
 * @param {string[]} roots - repository roots to scan.
 * @param {{limit?: number}} [options] - per-root run limit.
 * @returns {{roots: object[]}} overview value.
 */
export function overview(roots, options = {}) {
  const limit = options.limit ?? 20
  const seen = new Set()
  const summaries = []
  for (const rawRoot of roots) {
    if (typeof rawRoot !== 'string' || rawRoot.length === 0) continue
    const root = resolve(rawRoot)
    if (seen.has(root)) continue
    seen.add(root)
    const runsDir = join(root, '.parity', 'runs')
    if (!existsSync(runsDir)) continue
    const runs = []
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(runsDir, entry.name)
      const manifestPath = join(dir, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      try {
        runs.push(summarize(JSON.parse(readFileSync(manifestPath, 'utf8')), dir))
      } catch {
        // A half-written run is skipped rather than failing the panel.
      }
    }
    runs.sort((left, right) => String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')))
    summaries.push({ root, runs: runs.slice(0, limit) })
  }
  return { roots: summaries }
}

function summarize(manifest, dir) {
  return {
    runId: manifest.runId ?? dir.split(/[\\/]/).pop(),
    dir,
    iteration: manifest.iteration ?? 1,
    parentRun: manifest.parentRun?.runId ?? null,
    startedAt: manifest.startedAt ?? null,
    finishedAt: manifest.finishedAt ?? null,
    decision: manifest.decision?.mode ?? null,
    summary: manifest.summary ?? null,
    delta: manifest.delta ?? null,
    cases: (manifest.cases ?? []).map(entry => ({
      id: entry.id,
      status: entry.status,
      viewports: (entry.viewports ?? []).map(viewport => ({
        id: viewport.viewportId,
        status: viewport.status,
        pixels: viewport.pixels?.metrics?.mismatchRatio ?? null,
        geometry: viewport.geometry?.available === true ? (viewport.geometry.pass === true ? 'pass' : 'fail') : 'unavailable',
        styleDiffs: Array.isArray(viewport.styles?.diffs) ? viewport.styles.diffs.length : 0,
        diff: viewport.artifacts?.diff ?? null,
        reference: viewport.artifacts?.reference ?? null,
        implementation: viewport.artifacts?.implementation ?? null,
      })),
    })),
  }
}

/**
 * Resolve a requested artifact path, refusing anything outside a run directory.
 * @param {string[]} roots - repository roots that own the runs.
 * @param {string} requested - absolute path from the query string.
 * @returns {{path: string, type: string} | undefined} artifact to serve.
 */
export function resolveArtifact(roots, requested) {
  if (typeof requested !== 'string' || requested.length === 0) return undefined
  const target = resolve(requested)
  const type = ARTIFACT_TYPES[target.slice(target.lastIndexOf('.')).toLowerCase()]
  if (type === undefined) return undefined
  for (const rawRoot of roots) {
    if (typeof rawRoot !== 'string' || rawRoot.length === 0) continue
    const runsDir = join(resolve(rawRoot), '.parity', 'runs')
    if (!target.startsWith(`${runsDir}${sep}`)) continue
    if (!existsSync(target)) continue
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue
    return { path: target, type }
  }
  return undefined
}
