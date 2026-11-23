/**
 * Turn a diagnosis into an executable alignment plan.
 *
 * The plan is the plugin's way of directing the agent: each step names the
 * layer, the target, the edit, and the verification. The accompanying tool and
 * skill tell the agent to execute the plan immediately instead of asking the
 * user for permission or for mock data.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build an ordered plan from a diagnose value and its manifest.
 * @param {object} diagnosis - value from diagnoseRun.
 * @param {object} manifest - the run manifest.
 * @returns {{autonomy: string, stopWhen: string, steps: object[]}} plan.
 */
export function buildAlignmentPlan(diagnosis, manifest) {
  const steps = []
  for (const viewport of diagnosis.viewports ?? []) {
    const entry = (manifest.cases ?? []).find(entry => entry.id === viewport.case)
    const observed = (entry?.viewports ?? []).find(item => item.viewportId === viewport.viewport)
    const thresholds = observed?.thresholds ?? {}
    const geometryFindings = (viewport.findings ?? []).filter(finding => finding.layer === 'geometry')
    const styleFindings = (viewport.findings ?? []).filter(finding => finding.layer === 'styles')

    for (const finding of geometryFindings) {
      steps.push({
        kind: 'geometry',
        priority: 1,
        case: viewport.case,
        viewport: viewport.viewport,
        target: finding.anchor,
        action: finding.suggestion,
        verify: 're-run and confirm the anchor delta is 0',
      })
    }
    for (const finding of styleFindings) {
      steps.push({
        kind: 'style',
        priority: 2,
        case: viewport.case,
        viewport: viewport.viewport,
        target: finding.anchor,
        action: finding.suggestion,
        verify: 're-run and confirm the style diffs are 0',
      })
    }

    const ratio = observed?.pixels?.metrics?.mismatchRatio
    const geometryPass = observed?.geometry?.pass !== false
    const stylesPass = observed?.styles?.pass !== false
    const pixelPass = observed?.pixels?.pass !== false
    if (!pixelPass && geometryPass && stylesPass) {
      steps.push({
        kind: 'structure',
        priority: 3,
        case: viewport.case,
        viewport: viewport.viewport,
        target: 'page composition',
        action: `Geometry and styles pass but ${(Number(ratio ?? 0) * 100).toFixed(2)}% of pixels differ. Compare the reference and implementation section by section (cards, charts, table, empty states) and implement the missing or misplaced blocks in the target repo.`,
        verify: 're-run and confirm the pixel ratio drops',
      })
      steps.push({
        kind: 'mock',
        priority: 4,
        case: viewport.case,
        viewport: viewport.viewport,
        target: 'data layer',
        action: 'If the difference comes from missing data or a backend dependency, add fixtures or local mock data in the target repo (the plugin `fixtures` option can serve API responses), then re-run. Do not ask the user to provide data for a layout check.',
        verify: 're-run with the mock active; the data area should render deterministically',
      })
    }
    if (!pixelPass && (!geometryPass || !stylesPass)) {
      steps.push({
        kind: 'pixels',
        priority: 5,
        case: viewport.case,
        viewport: viewport.viewport,
        target: 'largest regions',
        action: 'After geometry and styles are fixed, inspect diff.png and fix the largest remaining regions.',
        verify: 're-run and confirm the pixel ratio drops',
      })
    }
  }

  steps.sort((left, right) => left.priority - right.priority)
  return {
    autonomy: 'Execute these steps immediately in the target repository. Do not ask the user for permission, structure work, or mock data; only stop for missing credentials, unavailable assets, or a product decision.',
    stopWhen: 'Every case is verified, or the remaining differences are covered by an explicitly chosen tolerance and named in the report.',
    steps: steps.slice(0, 8),
  }
}

/**
 * Read a manifest next to a diagnosis run directory.
 * @param {string} runDir - run directory.
 * @returns {object} manifest.
 */
export function readManifest(runDir) {
  const path = join(runDir, 'manifest.json')
  if (!existsSync(path)) throw new Error(`no manifest.json in ${runDir}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
