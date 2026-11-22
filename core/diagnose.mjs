/**
 * Turn a finished run into ranked, fix-oriented findings.
 *
 * The raw manifest is evidence; this module turns it into "what to change next"
 * so an agent can iterate: geometry deltas first (hard failures), then style
 * diffs, then the largest pixel regions with the IR nodes that overlap them.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flattenIr } from './ir.mjs'

/**
 * Diagnose one run (or selected cases/viewports).
 * @param {string} runDir - run directory with manifest.json.
 * @param {{cases?: string[], viewports?: string[]}} [options] - filters.
 * @returns {object} diagnosis value.
 */
export function diagnoseRun(runDir, options = {}) {
  const manifestPath = join(runDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${runDir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const cases = (manifest.cases ?? []).filter(entry => options.cases === undefined || options.cases.length === 0 || options.cases.includes(entry.id))
  const viewports = []
  for (const entry of cases) {
    for (const viewport of entry.viewports ?? []) {
      if (options.viewports !== undefined && options.viewports.length > 0 && !options.viewports.includes(viewport.viewportId)) continue
      viewports.push(diagnoseViewport(runDir, entry.id, viewport))
    }
  }
  return {
    runDir,
    iteration: manifest.iteration ?? 1,
    parentRun: manifest.parentRun ?? null,
    delta: manifest.delta ?? null,
    viewports,
  }
}

function diagnoseViewport(runDir, caseId, viewport) {
  const findings = []

  const anchors = Array.isArray(viewport.geometry?.anchors) ? viewport.geometry.anchors : []
  for (const anchor of anchors) {
    if (anchor.pass !== false) continue
    if (anchor.missing !== undefined) {
      findings.push({
        layer: 'geometry',
        severity: 20000,
        anchor: anchor.id,
        summary: `anchor "${anchor.id}" is missing in the ${anchor.missing}`,
        suggestion: `Anchor "${anchor.id}" could not be measured on the ${anchor.missing} side: check the selector, visibility, and that the element exists at this viewport.`,
      })
      continue
    }
    const delta = anchor.delta ?? { x: 0, y: 0, w: 0, h: 0 }
    const deltaPx = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.w), Math.abs(delta.h))
    findings.push({
      layer: 'geometry',
      severity: 10000 + deltaPx,
      anchor: anchor.id,
      delta,
      summary: `anchor "${anchor.id}" moved dx=${delta.x} dy=${delta.y} dw=${delta.w} dh=${delta.h}`,
      suggestion: `Anchor "${anchor.id}" is off by up to ${deltaPx}px (tolerance ${viewport.geometry.tolerance}px). Fix geometry first: check its container's flex/grid distribution, gap, padding, and fixed sizes before touching colors or text.`,
    })
  }

  for (const diff of viewport.styles?.diffs ?? []) {
    findings.push({
      layer: 'styles',
      severity: 5000,
      anchor: diff.id,
      property: diff.property,
      expected: String(diff.expected),
      actual: String(diff.actual),
      summary: `style "${diff.property}" on anchor "${diff.id}": expected ${diff.expected}, got ${diff.actual}`,
      suggestion: `Fix the rule or token that sets "${diff.property}" on "${diff.id}"; do not hardcode a one-off value if a design token exists.`,
    })
  }

  const regions = [...(viewport.pixels?.regions ?? [])]
    .sort((left, right) => (right.mismatchRatio ?? 0) - (left.mismatchRatio ?? 0))
    .slice(0, 5)
  const ir = readIr(runDir, caseId, viewport.viewportId)
  for (const region of regions) {
    const targets = ir === undefined ? [] : overlappingNodes(ir, region)
    findings.push({
      layer: 'pixels',
      severity: Math.round((region.mismatchRatio ?? 0) * 1000),
      region: { x: region.x, y: region.y, w: region.w, h: region.h, mismatchRatio: region.mismatchRatio },
      summary: `pixel region ${region.w}x${region.h} at (${region.x},${region.y}) mismatches ${(Number(region.mismatchRatio ?? 0) * 100).toFixed(1)}%`,
      targets,
      suggestion: `Largest remaining difference is at (${region.x},${region.y}) ${region.w}x${region.h}${targets.length > 0 ? `; overlapping IR nodes: ${targets.map(node => `${node.tag}#${node.id}`).join(', ')}` : ''}. Open diff.png, compare that area, then check position/spacing/text of those nodes.`,
    })
  }

  findings.sort((left, right) => right.severity - left.severity)
  return {
    case: caseId,
    viewport: viewport.viewportId,
    status: viewport.status,
    findings,
    next: findings.slice(0, 3).map(finding => finding.suggestion),
  }
}

function readIr(runDir, caseId, viewportId) {
  const path = join(runDir, 'cases', caseId, viewportId, 'ir.json')
  if (!existsSync(path)) return undefined
  try {
    return flattenIr(JSON.parse(readFileSync(path, 'utf8')).root).filter(node => node.pseudo === undefined)
  } catch {
    return undefined
  }
}

function overlappingNodes(nodes, region) {
  const regionArea = region.w * region.h
  if (regionArea <= 0) return []
  const scored = []
  for (const node of nodes) {
    const area = intersectionArea(node.box, region)
    if (area <= 0) continue
    const coverage = area / regionArea
    if (coverage < 0.25) continue
    scored.push({ node, coverage, area: node.box.w * node.box.h })
  }
  scored.sort((left, right) => right.coverage - left.coverage || left.area - right.area)
  return scored.slice(0, 4).map(({ node, coverage }) => ({
    id: node.id,
    tag: node.tag,
    role: node.role,
    box: node.box,
    coverage: Math.round(coverage * 100) / 100,
  }))
}

function intersectionArea(left, right) {
  const width = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}
