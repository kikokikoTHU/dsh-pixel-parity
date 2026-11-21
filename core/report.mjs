/**
 * Read a finished run and summarize it without re-capturing anything.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { latestRunDir } from './baselines.mjs'

/**
 * Build a compact report from a run directory.
 * @param {string} runDir - run directory containing manifest.json.
 * @returns {object} report value.
 */
export function buildReport(runDir) {
  const manifestPath = join(runDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${runDir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const cases = (manifest.cases ?? []).map(entry => ({
    id: entry.id,
    status: entry.status,
    viewports: (entry.viewports ?? []).map(viewport => {
      const anchors = Array.isArray(viewport.geometry?.anchors) ? viewport.geometry.anchors : []
      const result = {
        id: viewport.viewportId,
        status: viewport.status,
        geometryFailures: anchors.filter(anchor => anchor.pass === false).length,
        styleDiffs: Array.isArray(viewport.styles?.diffs) ? viewport.styles.diffs.length : 0,
        styleWarnings: Array.isArray(viewport.styles?.warnings) ? viewport.styles.warnings.length : 0,
        regions: (viewport.pixels?.regions ?? []).slice(0, 5).map(region => ({
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
        })),
      }
      const ratio = viewport.pixels?.metrics?.mismatchRatio
      if (typeof ratio === 'number') result.pixels = ratio
      const mean = viewport.pixels?.metrics?.meanDelta
      if (typeof mean === 'number') result.meanDelta = mean
      if (typeof viewport.geometry?.pass === 'boolean') result.geometry = viewport.geometry.pass
      if (typeof viewport.error === 'string') result.error = viewport.error
      return result
    }),
  }))
  const repo = typeof manifest.repo === 'string'
    ? { root: manifest.repo }
    : { root: manifest.repo?.root, commit: manifest.repo?.commit }
  const cleanedRepo = {}
  if (typeof repo.root === 'string') cleanedRepo.root = repo.root
  if (typeof repo.commit === 'string') cleanedRepo.commit = repo.commit
  const baseline = {
    mode: manifest.decision?.mode,
    source: manifest.decision?.source,
  }
  const cleanedBaseline = {}
  if (typeof baseline.mode === 'string') cleanedBaseline.mode = baseline.mode
  if (typeof baseline.source === 'string') cleanedBaseline.source = baseline.source
  return {
    runDir,
    runId: manifest.runId,
    config: manifest.config?.path ?? manifest.config,
    repo: cleanedRepo,
    baseline: cleanedBaseline,
    summary: manifest.summary,
    cases,
  }
}

/**
 * Resolve the run directory: explicit path or the newest run under the repo.
 * @param {string} repoRoot - repository root.
 * @param {string} [runDir] - explicit run directory.
 * @returns {string} absolute run directory.
 */
export function resolveRunDir(repoRoot, runDir) {
  if (typeof runDir === 'string' && runDir.length > 0) return runDir
  const latest = latestRunDir(repoRoot)
  if (latest === undefined) throw new Error(`no runs under ${join(repoRoot, '.parity', 'runs')}; run parity_run first`)
  return latest
}

/**
 * Render a report as plain text.
 * @param {object} report - value from buildReport.
 * @returns {string} text report.
 */
export function renderReport(report) {
  const lines = [
    `PixelParity report ${report.runId ?? ''}`.trim(),
    `run:    ${report.runDir}`,
    `config: ${report.config ?? ''}`,
    `repo:   ${report.repo?.root ?? ''} @ ${report.repo?.commit ?? ''}`,
    `baseline: ${report.baseline?.mode ?? '?'} (${report.baseline?.source ?? '?'})`,
    '',
  ]
  const header = ['case', 'viewport', 'status', 'pixels', 'geometry', 'styles', 'regions']
  const rows = []
  for (const entry of report.cases) {
    for (const viewport of entry.viewports) {
      const pixels = viewport.pixels === undefined ? '-' : `${(viewport.pixels * 100).toFixed(2)}%`
      const geometry = viewport.geometry === undefined
        ? '-'
        : viewport.geometry ? 'pass' : `fail(${viewport.geometryFailures})`
      const styles = viewport.styleDiffs === 0 && viewport.styleWarnings === 0
        ? 'clean'
        : `${viewport.styleDiffs}d/${viewport.styleWarnings}w`
      const regions = viewport.regions.map(region => `${region.w}x${region.h}@${region.x},${region.y}`).join(' ')
      rows.push([entry.id, viewport.id, viewport.status, pixels, geometry, styles, regions])
    }
  }
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => row[index].length)))
  const format = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()
  lines.push(format(header))
  lines.push(format(widths.map(width => '-'.repeat(width))))
  for (const row of rows) lines.push(format(row))
  const summary = report.summary ?? {}
  lines.push('')
  lines.push(`${summary.verified ?? 0} verified, ${summary['image-verified'] ?? 0} image-verified, ${summary.failed ?? 0} failed, ${summary.incomplete ?? 0} incomplete`)
  return lines.join('\n')
}
