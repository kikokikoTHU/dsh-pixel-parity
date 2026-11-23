/**
 * Project-style alignment: repo + base commit + design sources → matched
 * subtasks → manually triggered rounds → per-round reports.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { runConfig } from './runner.mjs'
import { logEvent } from './log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export function projectsDirectory() {
  return process.env.PIXEL_PARITY_PROJECT_DIR === undefined
    ? resolve(HERE, '..', 'data', 'projects')
    : resolve(process.env.PIXEL_PARITY_PROJECT_DIR)
}

export function projectPath(id) {
  return join(projectsDirectory(), id, 'project.json')
}

function newProjectId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `proj-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

function writeProject(project) {
  project.updatedAt = new Date().toISOString()
  const directory = join(projectsDirectory(), project.id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'project.json'), `${JSON.stringify(project, null, 2)}\n`)
}

export function readProject(id) {
  const path = projectPath(id)
  if (!existsSync(path)) throw new Error(`project not found: ${id}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function listProjects() {
  const directory = projectsDirectory()
  if (!existsSync(directory)) return []
  const projects = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      projects.push(JSON.parse(readFileSync(join(directory, entry.name, 'project.json'), 'utf8')))
    } catch {}
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

export async function createProject(input) {
  const repo = resolve(input.repo)
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`)
  if (!existsSync(join(repo, '.git'))) throw new Error(`not a git repository: ${repo}`)
  const baseCommit = git(repo, ['rev-parse', '--verify', `${input.baseCommit ?? 'HEAD'}^{commit}`])
  const config = isAbsolute(input.config) ? resolve(input.config) : resolve(repo, input.config ?? 'parity.config.mjs')
  if (!existsSync(config)) throw new Error(`config not found: ${config}`)
  await loadConfig(config)

  const project = {
    version: 1,
    id: newProjectId(),
    name: input.name ?? repo.split(/[\\/]/).pop(),
    repo,
    baseCommit,
    baseCommitInput: input.baseCommit ?? 'HEAD',
    config,
    status: 'draft',
    sources: [],
    matches: [],
    subtasks: [],
    nextSelection: [],
    rounds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  project.worktree = createWorktree(project)
  writeProject(project)
  logEvent('project.create', { id: project.id, repo: project.repo, baseCommit: project.baseCommit, worktree: project.worktree })
  return project
}

function createWorktree(project) {
  const directory = join(projectsDirectory(), project.id, 'worktree')
  try {
    git(project.repo, ['worktree', 'add', '--detach', directory, project.baseCommit])
    const modules = join(project.repo, 'node_modules')
    if (existsSync(modules) && !existsSync(join(directory, 'node_modules'))) {
      try { symlinkSync(modules, join(directory, 'node_modules'), 'junction') } catch {}
    }
    return directory
  } catch (error) {
    project.worktreeError = String(error?.message ?? error)
    return project.repo
  }
}

const cjk = text => (text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [])
const words = text => (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])

function tokens(text) {
  return new Set([...cjk(text), ...words(text)])
}

function scoreSource(source, candidate) {
  const left = source.location.toLowerCase()
  if (candidate.urls.some(url => url.length > 0 && left.includes(url.toLowerCase()))) return 1
  if (source.kind === 'url' && candidate.urls.some(url => url.toLowerCase() === left)) return 1
  const sourceTokens = tokens(decodeURIComponent(source.location))
  const candidateTokens = tokens(candidate.text)
  if (sourceTokens.size === 0 || candidateTokens.size === 0) return 0
  let hit = 0
  for (const token of sourceTokens) {
    if (candidateTokens.has(token)) hit += 1
  }
  return hit / sourceTokens.size
}

function candidatesFromConfig(config) {
  return config.cases.map(entry => {
    const urls = []
    if (entry.reference?.url) urls.push(entry.reference.url)
    if (entry.implementation?.url) urls.push(entry.implementation.url)
    if (entry.reference?.path) urls.push(entry.reference.path)
    return {
      caseId: entry.id,
      urls,
      text: [entry.id, entry.reference?.url, entry.reference?.path, entry.implementation?.url].filter(Boolean).join(' '),
    }
  })
}

async function analyzeOne(project, source, config, usedCases, matcher) {
  const candidates = candidatesFromConfig(config)
  const ranked = candidates
    .map(candidate => ({ ...candidate, score: scoreSource(source, candidate) }))
    .sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (best === undefined) return null
  const available = ranked.filter(candidate => !usedCases.has(candidate.caseId))
  const chosen = (best.score > 0 && !usedCases.has(best.caseId)) ? best : (available[0] ?? best)
  const confidence = Math.max(0, Math.min(1, chosen.score))
  return {
    sourceId: source.id,
    caseId: chosen.caseId,
    confidence,
    status: confidence >= 0.5 ? 'matched' : 'needs-review',
    rationale: confidence >= 0.5
      ? '设计源与 config case 的 reference/target 匹配'
      : '未找到高置信度页面，按未占用 case 自动分配，待复核',
  }
}

/** Analyze every pending source and regenerate matches/subtasks. */
export async function analyzeProject(project, options = {}) {
  const config = await loadConfig(project.config)
  const previous = new Map(project.matches.map(match => [match.sourceId, match]))
  project.matches = []
  const usedCases = new Set()
  for (const source of project.sources) {
    if (source.status === 'failed') continue
    const match = previous.get(source.id) ?? await analyzeOne(project, source, config, usedCases, options.matcher)
    if (match === null) {
      source.status = 'unmatched'
      continue
    }
    project.matches.push(match)
    usedCases.add(match.caseId)
    source.status = match.status
    logEvent('project.match', { projectId: project.id, sourceId: source.id, location: source.location, caseId: match.caseId, confidence: match.confidence, status: match.status, rationale: match.rationale })
  }
  project.subtasks = []
  const subtaskCases = new Set()
  for (const match of project.matches) {
    if (subtaskCases.has(match.caseId)) continue
    subtaskCases.add(match.caseId)
    const source = project.sources.find(item => item.id === match.sourceId)
    const caseEntry = config.cases.find(entry => entry.id === match.caseId)
    project.subtasks.push({
      id: match.caseId,
      caseId: match.caseId,
      sourceId: match.sourceId,
      title: caseEntry?.id ?? match.caseId,
      needsReview: match.status === 'needs-review',
      confidence: match.confidence,
      defaultSelected: match.status === 'matched',
    })
  }
  const defaultIds = project.subtasks.filter(task => task.defaultSelected).map(task => task.id)
  project.nextSelection = defaultIds.length > 0 ? defaultIds : project.subtasks.map(task => task.id)
  project.status = project.sources.every(source => ['matched', 'needs-review', 'unmatched'].includes(source.status))
    ? 'ready'
    : 'analyzing'
  writeProject(project)
  return project
}

export async function addSource(projectId, input, options = {}) {
  const project = readProject(projectId)
  const kind = input.kind === 'file' ? 'file' : 'url'
  const location = String(input.location ?? '').trim()
  if (location.length === 0) throw new Error('location is required')
  if (kind === 'file' && !isAbsolute(location)) throw new Error('file sources need an absolute path')
  if (project.sources.some(source => source.location === location)) throw new Error('source already exists')
  const source = {
    id: `src-${project.sources.length + 1}-${Math.random().toString(36).slice(2, 5)}`,
    kind,
    location,
    status: 'analyzing',
    addedAt: new Date().toISOString(),
  }
  project.sources.push(source)
  project.status = 'analyzing'
  logEvent('project.source.add', { projectId: project.id, sourceId: source.id, kind, location })
  writeProject(project)
  try {
    await analyzeProject(project, options)
  } catch (error) {
    const current = readProject(projectId)
    const target = current.sources.find(item => item.id === source.id)
    if (target !== undefined) {
      target.status = 'failed'
      target.error = String(error?.message ?? error)
      writeProject(current)
      logEvent('project.source.failed', { projectId, sourceId: source.id, error: String(error?.message ?? error) }, 'error')
    }
    throw error
  }
  return readProject(projectId)
}

export async function removeSource(projectId, sourceId, options = {}) {
  const project = readProject(projectId)
  project.sources = project.sources.filter(source => source.id !== sourceId)
  logEvent('project.source.remove', { projectId, sourceId })
  project.matches = project.matches.filter(match => match.sourceId !== sourceId)
  project.subtasks = project.subtasks.filter(task => task.sourceId !== sourceId)
  project.nextSelection = project.nextSelection.filter(id => project.subtasks.some(task => task.id === id))
  project.status = 'analyzing'
  writeProject(project)
  if (project.sources.length > 0) await analyzeProject(project, options)
  else {
    project.status = 'draft'
    writeProject(project)
  }
  return readProject(projectId)
}
export function setSelection(projectId, selection) {
  const project = readProject(projectId)
  const ids = new Set(project.subtasks.map(task => task.id))
  project.nextSelection = (selection ?? []).filter(id => ids.has(id))
  writeProject(project)
  return project
}

export async function runRound(projectId, options = {}) {
  const project = readProject(projectId)
  const selected = project.nextSelection.filter(id => project.subtasks.some(task => task.id === id))
  if (selected.length === 0) throw new Error('no subtasks selected for this round')
  const number = project.rounds.length + 1
  const round = {
    id: `round-${number}`,
    number,
    status: 'running',
    selection: selected,
    skipped: project.subtasks.filter(task => !selected.includes(task.id)).map(task => task.id),
    startedAt: new Date().toISOString(),
  }
  project.rounds.push(round)
  project.status = 'running'
  writeProject(project)
  logEvent('project.round.start', { projectId, round: number, selection: selected })

  try {
    const result = await runConfig({
      configPath: project.config,
      repoRoot: project.worktree ?? project.repo,
      caseIds: selected,
      baselineMode: 'ephemeral',
      headless: options.headless !== false,
    })
    round.status = 'completed'
    round.runDir = result.runDir
    round.summary = result.manifest.summary ?? null
    round.finishedAt = new Date().toISOString()
    round.reportPath = buildRoundReport(project, round, result)
    project.status = 'ready'
    writeProject(project)
    logEvent('project.round.done', { projectId, round: number, summary: round.summary, reportPath: round.reportPath })
    return { project, round }
  } catch (error) {
    round.status = 'failed'
    round.error = String(error?.message ?? error)
    round.finishedAt = new Date().toISOString()
    project.status = 'ready'
    writeProject(project)
    logEvent('project.round.failed', { projectId, round: number, error: String(error?.message ?? error) }, 'error')
    throw error
  }
}

function buildRoundReport(project, round, result) {
  const directory = join(projectsDirectory(), project.id, 'rounds', round.id)
  const assets = join(directory, 'assets')
  mkdirSync(assets, { recursive: true })
  const manifest = result.manifest
  const summary = manifest.summary ?? {}
  const cases = (manifest.cases ?? []).map(entry => {
    const viewports = (entry.viewports ?? []).map(viewport => {
      const files = {}
      const sourceDir = join(result.runDir, 'cases', entry.id, viewport.viewportId)
      for (const name of ['reference.png', 'implementation.png', 'diff.png']) {
        const source = join(sourceDir, name)
        if (existsSync(source)) {
          copyFileSync(source, join(assets, `${entry.id}-${viewport.viewportId}-${name}`))
          files[name.replace('.png', '')] = `${entry.id}-${viewport.viewportId}-${name}`
        }
      }
      return {
        id: viewport.viewportId,
        status: viewport.status,
        pixels: viewport.pixels?.metrics?.mismatchRatio ?? null,
        geometry: viewport.geometry?.available === true ? (viewport.geometry.pass === true ? 'pass' : 'fail') : 'unavailable',
        styles: viewport.styles?.available === true ? (viewport.styles.pass === true ? 'pass' : 'fail') : 'unavailable',
        files,
      }
    })
    return { id: entry.id, status: entry.status, viewports }
  })
  const rows = cases.map(entry => `
    <section class="case">
      <div class="case-h"><strong>${escapeHtml(entry.id)}</strong><span class="pill ${entry.status === 'verified' ? 'ok' : 'bad'}">${escapeHtml(entry.status)}</span></div>
      ${entry.viewports.map(viewport => `
        <div class="vp">
          <div class="kv">${escapeHtml(viewport.id)} · pixels ${viewport.pixels === null ? '—' : `${(viewport.pixels * 100).toFixed(2)}%`} · geometry ${viewport.geometry} · styles ${viewport.styles}</div>
          <div class="shots">
            ${viewport.files.reference ? `<figure><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.reference)}"><figcaption>reference</figcaption></figure>` : ''}
            ${viewport.files.implementation ? `<figure><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.implementation)}"><figcaption>implementation</figcaption></figure>` : ''}
            ${viewport.files.diff ? `<figure><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.diff)}"><figcaption>diff</figcaption></figure>` : ''}
          </div>
        </div>`).join('')}
    </section>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Round ${round.number} report</title>
  <style>
  body{margin:0;background:#f7f8fa;color:#0f172a;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px}
  .page{max-width:1000px;margin:0 auto;padding:28px}
  h1{font-size:18px;margin:0}
  .sub{color:#64748b;font-size:12px;margin-top:4px}
  .stats{display:flex;gap:26px;margin:16px 0}
  .stats b{display:block;font-size:20px}
  .stats span{color:#64748b;font-size:11px}
  .case{background:#fff;border:1px solid #e5eaf1;border-radius:9px;padding:14px;margin-bottom:10px}
  .case-h{display:flex;gap:8px;align-items:center}
  .pill{border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600}
  .ok{background:#e8f8ef;color:#15803d}.bad{background:#fdecec;color:#b91c1c}
  .kv{color:#64748b;font-size:12px;margin-top:6px}
  .shots{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
  figure{margin:0;width:31%;min-width:220px}
  img{width:100%;border:1px solid #e2e8f0;border-radius:6px;display:block}
  figcaption{color:#94a3b8;font-size:10px;margin-top:3px}
  </style></head><body><div class="page">
  <h1>Round ${round.number} 对齐报告</h1>
  <div class="sub">${escapeHtml(project.name)} · base ${escapeHtml(project.baseCommit.slice(0, 7))} · ${escapeHtml(round.finishedAt ?? '')}</div>
  <div class="stats">
    <div><b>${summary.verified ?? 0}/${manifest.cases?.length ?? 0}</b><span>cases passed</span></div>
    <div><b>${summary.failed ?? 0}</b><span>failed</span></div>
  </div>
  ${rows}
  </div></body></html>`
  const path = join(directory, 'report.html')
  writeFileSync(path, html)
  return path
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function deleteProject(projectId) {
  const project = readProject(projectId)
  deleteGitRefs(project, project.rounds)
  if (typeof project.worktree === 'string' && resolve(project.worktree) !== resolve(project.repo)) {
    try { unlinkSync(join(project.worktree, 'node_modules')) } catch {}
    try { git(project.repo, ['worktree', 'remove', '--force', project.worktree]) } catch {}
  }
  rmSync(join(projectsDirectory(), project.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return project
}

/** Remove failed/interrupted rounds, or all rounds when mode is "all". */
function deleteGitRefs(project, rounds) {
  const branches = [...new Set([project.branch, ...rounds.map(round => round.branch)].filter(branch => typeof branch === 'string' && branch.length > 0))]
  const tags = [...new Set(rounds.map(round => round.tag ?? (Number.isInteger(round.number) ? `pp-r${String(round.number).padStart(2, '0')}` : null)).filter(tag => typeof tag === 'string'))]
  if (branches.length === 0 && tags.length === 0) return
  const worktree = project.worktree
  if (typeof worktree === 'string' && existsSync(worktree)) {
    try { git(worktree, ['switch', '--detach', project.baseCommit]) } catch {}
  }
  for (const branch of branches) {
    if (!branch.startsWith('pp/')) continue
    try { git(project.repo, ['branch', '-D', branch]) } catch {}
  }
  for (const tag of tags) {
    if (!tag.startsWith('pp-r')) continue
    try { git(project.repo, ['tag', '-d', tag]) } catch {}
  }
}
export function cleanRounds(projectId, mode = 'failed') {
  const project = readProject(projectId)
  if (project.rounds.some(round => round.status === 'running')) {
    throw new Error('cannot clean rounds while a round is running')
  }
  const keep = mode === 'all' ? [] : project.rounds.filter(round => round.status === 'completed')
  const remove = project.rounds.filter(round => !keep.includes(round))
  deleteGitRefs(project, remove)
  for (const round of remove) {
    rmSync(join(projectsDirectory(), project.id, 'rounds', round.id), { recursive: true, force: true })
  }
  project.rounds = keep
  writeProject(project)
  logEvent('project.rounds.clean', { projectId, mode, removed: remove.map(round => round.number) })
  return project
}
export function projectSummary(project) {
  return {
    ...project,
    sources: project.sources.map(source => ({
      id: source.id,
      kind: source.kind,
      location: source.location,
      status: source.status,
      error: source.error ?? null,
    })),
    stats: {
      matched: project.sources.filter(source => source.status === 'matched').length,
      review: project.sources.filter(source => source.status === 'needs-review').length,
      failed: project.sources.filter(source => source.status === 'failed').length,
      pending: project.sources.filter(source => !['matched', 'needs-review', 'unmatched', 'failed'].includes(source.status)).length,
    },
  }
}









