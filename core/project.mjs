/**
 * Project-style alignment: repo + base commit + design sources → matched
 * subtasks → manually triggered rounds → per-round reports.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { runConfig } from './runner.mjs'
import { logEvent } from './log.mjs'
import { buildImplementationUrl, discoverDesignPages, discoverRoutes, matchPageToRoute, routeCaseId } from './discover.mjs'

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
    ownerSessionId: typeof input.ownerSessionId === 'string' ? input.ownerSessionId : null,
    dependenciesRoot: typeof input.dependenciesRoot === 'string' ? resolve(input.dependenciesRoot) : repo,
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

async function writeGeneratedConfig(project, pages) {
  const baseConfigPath = project.baseConfig ?? project.config
  const base = await loadConfig(baseConfigPath)
  const template = base.cases.find(entry => entry.implementation?.url !== undefined) ?? base.cases[0]
  if (template === undefined) return null
  const routes = discoverRoutes(project.repo)
  const matched = []
  for (const page of pages) {
    const match = matchPageToRoute(page, routes)
    if (match === null) continue
    matched.push({ page, ...match })
  }
  if (matched.length === 0) return null
  const selected = new Set()
  const generated = []
  const usedIds = new Set(base.cases.map(entry => entry.id))
  const usedRoutes = new Set()
  for (const { page, route } of matched) {
    if (usedRoutes.has(route.path)) continue
    usedRoutes.add(route.path)
    const existing = base.cases.find(entry => entry.reference?.url === page.url)
      ?? base.cases.find(entry => entry.id === routeCaseId(route.path))
    if (existing !== undefined) {
      selected.add(existing.id)
      continue
    }
    let id = routeCaseId(route.path)
    while (usedIds.has(id)) id = `${id}-2`
    usedIds.add(id)
    generated.push({
      id,
      reference: { url: page.url },
      implementation: {
        ...template.implementation,
        url: buildImplementationUrl(template.implementation.url, route.path),
      },
      anchors: {
        sidebar: { ref: 'aside', impl: 'aside' },
        header: { ref: 'header', impl: 'header' },
        title: { ref: 'h1', impl: 'h1' },
      },
    })
  }
  const discoveryUrls = new Set(pages.map(page => page.url))
  const kept = base.cases.filter(entry => {
    if (selected.has(entry.id)) return true
    if (entry.reference?.url !== undefined && discoveryUrls.has(entry.reference.url)) return false
    return true
  })
  const cases = [...kept, ...generated]
  const directory = join(projectsDirectory(), project.id)
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'parity.generated.mjs')
  const source = `// Generated by dsh-pixel-parity. Do not edit; it wraps the project config.\n`
    + `import base from ${JSON.stringify(pathToFileURL(resolve(baseConfigPath)).href)}\n`
    + `export default { ...base, cases: ${JSON.stringify(cases, null, 2)} }\n`
  writeFileSync(target, source)
  project.baseConfig = resolve(baseConfigPath)
  project.config = target
  project.generatedCases = generated.map(entry => entry.id)
  project.discoveredRoutes = matched.map(item => ({ page: item.page.url, route: item.route.path, title: item.route.title, confidence: item.confidence }))
  logEvent('project.discovery.cases', { projectId: project.id, generated: project.generatedCases, routes: project.discoveredRoutes })
  return target
}

export async function discoverProjectSources(projectId, entryUrl, options = {}) {
  const project = readProject(projectId)
  let pages
  try {
    pages = await discoverDesignPages(entryUrl, { ...options, dependenciesRoot: project.dependenciesRoot })
  } catch (error) {
    logEvent('project.discovery.failed', { projectId, entryUrl, error: String(error?.message ?? error) }, 'error')
    return null
  }
  if (pages.length <= 1) return null
  const discoveredRoutes = discoverRoutes(project.repo)
  const seenRoutes = new Set()
  const uniquePages = []
  for (const page of pages) {
    const match = matchPageToRoute(page, discoveredRoutes)
    if (match !== null) {
      if (seenRoutes.has(match.route.path)) continue
      seenRoutes.add(match.route.path)
    }
    uniquePages.push(page)
  }
  pages = uniquePages
  project.discovery = { entryUrl, pages, discoveredAt: new Date().toISOString() }
  for (const page of pages) {
    if (project.sources.some(source => source.location === page.url)) continue
    project.sources.push({
      id: `src-${project.sources.length + 1}-${Math.random().toString(36).slice(2, 5)}`,
      kind: 'url',
      location: page.url,
      title: page.heading || page.title,
      discovered: true,
      status: 'analyzing',
      addedAt: new Date().toISOString(),
    })
  }
  project.status = 'analyzing'
  try {
    await writeGeneratedConfig(project, pages)
    await analyzeProject(project, options)
    writeProject(project)
    logEvent('project.discovery.done', { projectId, pages: pages.length, subtasks: project.subtasks.length })
  } catch (error) {
    project.status = 'ready'
    writeProject(project)
    logEvent('project.discovery.error', { projectId, error: String(error?.message ?? error) }, 'error')
    throw error
  }
  return readProject(projectId)
}
export async function addSource(projectId, input, options = {}) {
  const project = readProject(projectId)
  const kind = input.kind === 'file' ? 'file' : 'url'
  const location = String(input.location ?? '').trim()
  if (location.length === 0) throw new Error('location is required')
  if (kind === 'file' && !isAbsolute(location)) throw new Error('file sources need an absolute path')
  if (project.sources.some(source => source.location === location)) throw new Error('source already exists')
  if (kind === 'url' && project.sources.length === 0 && project.discoveryAttempted !== true && input.discover !== false) {
    project.discoveryAttempted = true
    writeProject(project)
    const discovered = await discoverProjectSources(projectId, location, options)
    if (discovered !== null) return discovered
  }
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

function projectSlug(project) {
  const repo = basename(project.repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'repo'
  const short = String(project.id).split('-').at(-1) ?? 'proj'
  return `${repo}-${short}`
}

function roundBranch(project, number) {
  return `pp/${projectSlug(project)}/r${String(number).padStart(2, '0')}`
}

function gitHead(worktree) {
  return git(worktree, ['rev-parse', 'HEAD'])
}

function remoteRefs(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/remotes'])
}

function averagePixels(manifest) {
  const values = []
  for (const entry of manifest?.cases ?? []) {
    for (const viewport of entry.viewports ?? []) {
      if (typeof viewport.pixels?.metrics?.mismatchRatio === 'number') values.push(viewport.pixels.metrics.mismatchRatio)
    }
  }
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function makeBrief(project, round, subtask, before) {
  const caseEntry = before.manifest?.cases?.find(entry => entry.id === subtask.caseId)
  const viewports = caseEntry?.viewports ?? []
  const details = viewports.map(viewport => {
    const pixels = viewport.pixels?.metrics?.mismatchRatio
    return `- ${viewport.viewportId}: pixels ${typeof pixels === 'number' ? `${(pixels * 100).toFixed(2)}%` : 'n/a'}, geometry ${viewport.geometry?.pass === false ? 'fail' : 'pass'}, styles ${viewport.styles?.pass === false ? 'fail' : 'pass'}${viewport.error ? `, error: ${viewport.error}` : ''}`
  }).join('\n')
  return [
    `You are fixing ONE alignment subtask in a git worktree.`,
    `Project: ${project.name} (${project.id})`,
    `Round: ${round.number}`,
    `Subtask: ${subtask.title} (${subtask.id}, case ${subtask.caseId})`,
    `Branch: ${round.branch}`,
    `Design source: ${project.sources.find(source => source.id === subtask.sourceId)?.location ?? 'unknown'}`,
    `Current measurement:`,
    details || '- no viewport detail',
    ``,
    `Goals:`,
    `1. Inspect the implementation and the reference/diff artifacts.`,
    `2. Achieve COMPLETE alignment: visual shell AND information architecture/business content. Do not stop at CSS or shell-only changes.`,
    `3. Stop as soon as the page is verified: pixels <= 1%, geometry pass, styles pass. Do not chase sub-percent differences; commit immediately after a passing run.`,
    `4. If the current page is a different workflow (for example a query form instead of a statistics dashboard), REPLACE the page content with the prototype structure, and move the existing business flow to a compatible route/tab if needed.`,
    `5. For EVERY data-bearing region (KPI values, chart series, tables, timestamps), create a temporary local mock/fixture that reproduces the DESIGN's exact values, labels, row counts, and ordering. Do this even when a real API exists; do not align the UI against real data.`,
    `6. Put the temporary mock behind a clearly replaceable adapter. A cleanup pass will delete it after acceptance.`,
    `7. Update routes, navigation, tests, and fixtures so the app remains coherent.`,
    `8. You may change app implementation, tests, and temporary mocks. Do not change parity config, design sources, .parity, or vite.pp.config.js.`,
    `9. Do not run git push, git remote, or network commands.`,
    `10. Create EXACTLY ONE commit with this shape:`,
    `   pp(${subtask.id}): align ${subtask.title} to design`,
    `   ...`,
    `   PP-Project: ${project.id}`,
    `   PP-Round: ${round.number}`,
    `   PP-Subtask: ${subtask.id}`,
    `   PP-Base-Commit: ${project.baseCommit.slice(0, 7)}`,
    `11. Leave the worktree clean for tracked files (git status --porcelain -uno must be empty).`,
    `12. Reply with the commit sha and a short summary of changed files.`,
  ].join('\n')
}

function makeCleanupBrief(project, round, subtask, entry) {
  return [
    `The mock-data alignment for this subtask is ACCEPTED (${typeof entry.after === 'number' ? `${(entry.after * 100).toFixed(2)}% pixels` : 'verified'}).`,
    `Now remove the temporary design mock and restore the real data path.`,
    `Project: ${project.name} (${project.id})`,
    `Round: ${round.number}`,
    `Subtask: ${subtask.title} (${subtask.id})`,
    `Branch: ${round.branch}`,
    ``,
    `Requirements:`,
    `1. Remove the temporary fixtures, mock arrays, design-snapshot values, and demo-only adapters introduced for this task.`,
    `2. Connect the page to the real application data source/service. Keep the accepted visual layout.`,
    `3. If the real source lacks data, use the real service/client and show a real empty/loading/error state; never silently fall back to demo data.`,
    `4. Real values may differ from the design. Do NOT try to make real data match the design, and do NOT restore the mock to hide the difference.`,
    `5. Update imports, routes, and tests so no reference to the removed mock remains.`,
    `6. Do not change parity config, design sources, .parity, or vite.pp.config.js. Do not push.`,
    `7. Acceptance is based on the mock capture; real-data visual differences are informational.`,
    `8. Commit EXACTLY ONE cleanup commit:`,
    `   pp(${subtask.id}): use real data for ${subtask.title}`,
    `   ...`,
    `   PP-Project: ${project.id}`,
    `   PP-Round: ${round.number}`,
    `   PP-Subtask: ${subtask.id}`,
    `   PP-Base-Commit: ${project.baseCommit.slice(0, 7)}`,
    `   PP-Stage: real-data`,
    `9. Leave git status --porcelain -uno empty and reply with the commit sha.`,
    `If no mock data exists, make no changes and reply "NO-MOCK".`,
  ].join('\n')
}

async function removeMockData(project, round, entry, subtask, worktree, options) {
  const headBefore = gitHead(worktree)
  const remoteBefore = remoteRefs(project.repo)
  round.phase = 'removing-mock'
  round.progress = { phase: round.phase, subtaskId: subtask.id, updatedAt: new Date().toISOString() }
  writeProject(project)
  try {
    await options.editor({ cwd: worktree, project, round, subtask, before: null, brief: makeCleanupBrief(project, round, subtask, entry) })
    const headAfter = gitHead(worktree)
    const status = git(worktree, ['status', '--porcelain', '--untracked-files=no'])
    if (headAfter === headBefore && status.length === 0) {
      entry.cleanup = 'no-mock'
    } else if (headAfter === headBefore) {
      throw new Error('mock cleanup left uncommitted tracked changes')
    } else {
      const commit = await validateAgentCommit(worktree, project.repo, headBefore, remoteBefore, round, subtask)
      entry.cleanup = 'committed'
      entry.cleanupSha = commit.sha.slice(0, 12)
      entry.cleanupMessage = commit.message.split('\n')[0]
      round.commits.push({ subtaskId: subtask.id, sha: entry.cleanupSha, message: entry.cleanupMessage, stage: 'real-data' })
    }
  } catch (error) {
    try { git(worktree, ['reset', '--hard', headBefore]) } catch {}
    entry.cleanup = 'failed'
    entry.cleanupError = String(error?.message ?? error)
  }
  round.phase = 'measuring-real'
  round.progress = { phase: round.phase, subtaskId: subtask.id, updatedAt: new Date().toISOString() }
  writeProject(project)
  try {
    const real = await runConfig({
      configPath: project.config,
      repoRoot: worktree,
      dependenciesRoot: project.dependenciesRoot ?? undefined,
      referenceCacheDir: join(projectsDirectory(), project.id, 'cache', 'references'),
      caseIds: [subtask.caseId],
      baselineMode: 'ephemeral',
      headless: options.headless !== false,
      outDir: join(projectsDirectory(), project.id, 'runs', `${round.id}-${subtask.id}-after-real`),
    })
    entry.afterReal = averagePixels(real.manifest)
    entry.afterRealRunDir = real.runDir
    entry.realSummary = real.manifest.summary ?? null
  } catch (error) {
    entry.realError = String(error?.message ?? error)
  }
}


async function validateAgentCommit(worktree, repo, headBefore, remoteBefore, round, subtask) {
  const headAfter = gitHead(worktree)
  if (headAfter === headBefore) throw new Error('agent did not create a commit')
  const count = Number(git(worktree, ['rev-list', '--count', `${headBefore}..HEAD`]))
  if (count !== 1) throw new Error(`agent created ${count} commits; exactly one is required`)
  const status = git(worktree, ['status', '--porcelain', '--untracked-files=no'])
  if (status.length > 0) throw new Error(`worktree has tracked changes after commit: ${status}`)
  if (remoteRefs(repo) !== remoteBefore) throw new Error('remote refs changed during the round (push is forbidden)')
  const message = git(worktree, ['log', '-1', '--pretty=%B'])
  for (const trailer of ['PP-Project:', 'PP-Round:', 'PP-Subtask:', 'PP-Base-Commit:']) {
    if (!message.includes(trailer)) throw new Error(`commit message is missing ${trailer}`)
  }
  return { sha: headAfter, message }
}

async function runAlignmentRound(project, round, options) {
  const worktree = project.worktree
  if (typeof worktree !== 'string' || !existsSync(worktree)) throw new Error('project worktree is missing')
  const dirty = git(worktree, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.length > 0) throw new Error(`worktree has tracked changes before the round: ${dirty}`)
  const previous = [...project.rounds].reverse().find(item => item.status === 'completed' && typeof item.headSha === 'string')
  const startRef = previous?.headSha ?? project.baseCommit
  round.branch = roundBranch(project, round.number)
  round.startRef = startRef
  git(worktree, ['switch', '-C', round.branch, startRef])
  round.headBefore = gitHead(worktree)
  round.commits = []
  round.subtasks = []
  round.phase = 'measuring-before'
  round.progress = { phase: round.phase, updatedAt: new Date().toISOString() }
  writeProject(project)

  for (const subtaskId of round.selection) {
    const subtask = project.subtasks.find(item => item.id === subtaskId)
    if (subtask === undefined) continue
    const headBefore = gitHead(worktree)
    const remoteBefore = remoteRefs(project.repo)
    round.phase = 'measuring-before'
    round.progress = { phase: round.phase, subtaskId: subtask.id, updatedAt: new Date().toISOString() }
    writeProject(project)
    const before = await runConfig({
      configPath: project.config,
      repoRoot: worktree,
      dependenciesRoot: project.dependenciesRoot ?? undefined,
      referenceCacheDir: join(projectsDirectory(), project.id, 'cache', 'references'),
      caseIds: [subtask.caseId],
      baselineMode: 'ephemeral',
      headless: options.headless !== false,
      outDir: join(projectsDirectory(), project.id, 'runs', `${round.id}-${subtask.id}-before`),
    })
    const entry = { subtaskId, caseId: subtask.caseId, before: averagePixels(before.manifest), beforeRunDir: before.runDir, status: 'edited', sha: null, error: null }
    try {
      round.phase = 'agent-editing'
      round.progress = { phase: round.phase, subtaskId: subtask.id, updatedAt: new Date().toISOString() }
      writeProject(project)
      await options.editor({
        cwd: worktree,
        project,
        round,
        subtask,
        before,
        brief: makeBrief(project, round, subtask, before),
      })
      const commit = await validateAgentCommit(worktree, project.repo, headBefore, remoteBefore, round, subtask)
      round.phase = 'measuring-after'
      round.progress = { phase: round.phase, subtaskId: subtask.id, commit: commit.sha.slice(0, 12), updatedAt: new Date().toISOString() }
      writeProject(project)
      const after = await runConfig({
        configPath: project.config,
        repoRoot: worktree,
        dependenciesRoot: project.dependenciesRoot ?? undefined,
        referenceCacheDir: join(projectsDirectory(), project.id, 'cache', 'references'),
        caseIds: [subtask.caseId],
        baselineMode: 'ephemeral',
        headless: options.headless !== false,
        outDir: join(projectsDirectory(), project.id, 'runs', `${round.id}-${subtask.id}-after`),
      })
      const afterPixels = averagePixels(after.manifest)
      entry.after = afterPixels
      entry.sha = commit.sha.slice(0, 12)
      entry.message = commit.message.split('\n')[0]
      entry.runDir = after.runDir
      entry.afterRunDir = after.runDir
      const passed = (after.manifest.summary?.failed ?? 1) === 0
      const improved = beforePixels(entry) === null || afterPixels === null || entry.after <= entry.before + 0.0005
      if (!passed && !improved) {
        git(worktree, ['reset', '--hard', headBefore])
        entry.status = 'rolled-back'
        entry.error = `no improvement (${(entry.before * 100).toFixed(2)}% -> ${(afterPixels * 100).toFixed(2)}%)`
      } else {
        round.commits.push({ subtaskId, sha: entry.sha, message: entry.message })
        entry.status = 'committed'
        round.afterResult = after
        if (passed) {
          await removeMockData(project, round, entry, subtask, worktree, options)
        } else {
          entry.cleanup = 'skipped-unverified'
        }
      }
    } catch (error) {
      try { git(worktree, ['reset', '--hard', headBefore]) } catch {}
      entry.status = 'failed'
      entry.error = String(error?.message ?? error)
    }
    round.subtasks.push(entry)
    round.progress = { phase: entry.status === 'committed' ? 'subtask-done' : 'subtask-failed', subtaskId: subtask.id, before: entry.before, after: entry.after ?? null, updatedAt: new Date().toISOString() }
    writeProject(project)
  }
  round.headSha = gitHead(worktree)
  round.status = round.subtasks.some(entry => entry.status === 'failed' || entry.status === 'rolled-back') ? 'failed' : 'completed'
  round.phase = round.status
  round.progress = { phase: round.phase, before: round.subtasks[0]?.before ?? null, after: round.subtasks[0]?.after ?? null, updatedAt: new Date().toISOString() }
  if (round.status === 'completed' && round.commits.length > 0) {
    try { git(worktree, ['tag', '-f', `pp-r${String(round.number).padStart(2, '0')}`, 'HEAD']) } catch {}
  }
  round.finishedAt = new Date().toISOString()
  round.summary = round.afterResult?.manifest?.summary ?? null
  if (round.afterResult !== undefined) round.reportPath = buildRoundReport(project, round, round.afterResult)
  return round
}

function beforePixels(entry) { return entry.before ?? null }
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
    if (typeof options.editor === 'function') {
      await runAlignmentRound(project, round, options)
      project.status = 'ready'
      writeProject(project)
      logEvent('project.round.done', { projectId, round: number, summary: round.summary, reportPath: round.reportPath, branch: round.branch, commits: round.commits })
      return { project, round }
    }
    const result = await runConfig({
      configPath: project.config,
      repoRoot: project.worktree ?? project.repo,
      dependenciesRoot: project.dependenciesRoot ?? undefined,
      referenceCacheDir: join(projectsDirectory(), project.id, 'cache', 'references'),
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

function loadRunCase(runDir, caseId) {
  try {
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'))
    return manifest.cases?.find(entry => entry.id === caseId) ?? null
  } catch {
    return null
  }
}

function copyViewportShots(runDir, caseId, viewportId, prefix, assets) {
  const files = {}
  const sourceDir = join(runDir, 'cases', caseId, viewportId)
  for (const name of ['reference.png', 'implementation.png', 'diff.png']) {
    const source = join(sourceDir, name)
    if (existsSync(source)) {
      const target = `${prefix}-${caseId}-${viewportId}-${name}`
      copyFileSync(source, join(assets, target))
      files[name.replace('.png', '')] = target
    }
  }
  return files
}

function comparisonSide(project, round, runDir, caseId, label, entry) {
  if (typeof runDir !== 'string') return ''
  const caseEntry = loadRunCase(runDir, caseId)
  if (caseEntry === null) return ''
  return caseEntry.viewports.map(viewport => {
    const prefix = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const files = copyViewportShots(runDir, caseId, viewport.viewportId, `${prefix}-${entry.subtaskId}`, join(projectsDirectory(), project.id, 'rounds', round.id, 'assets'))
    const pixels = viewport.pixels?.metrics?.mismatchRatio
    const geometry = viewport.geometry?.available === true ? (viewport.geometry.pass === true ? 'pass' : 'fail') : 'unavailable'
    const styles = viewport.styles?.available === true ? (viewport.styles.pass === true ? 'pass' : 'fail') : 'unavailable'
    return `<div class="vp">
      <div class="kv">${escapeHtml(label)} · ${escapeHtml(viewport.viewportId)} · pixels ${typeof pixels === 'number' ? `${(pixels * 100).toFixed(2)}%` : '—'} · geometry ${geometry} · styles ${styles}</div>
      <div class="shots">
        ${files.reference ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.reference)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.reference)}"></a><figcaption>reference</figcaption></figure>` : ''}
        ${files.implementation ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.implementation)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.implementation)}"></a><figcaption>implementation</figcaption></figure>` : ''}
        ${files.diff ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.diff)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(files.diff)}"></a><figcaption>diff</figcaption></figure>` : ''}
      </div>
    </div>`
  }).join('')
}

function buildComparisonReport(project, round, directory, assets) {
  const sections = round.subtasks.map(entry => {
    const beforeDir = entry.beforeRunDir ?? join(projectsDirectory(), project.id, 'runs', `${round.id}-${entry.subtaskId}-before`)
    const afterDir = entry.afterRunDir ?? entry.runDir
    const before = comparisonSide(project, round, beforeDir, entry.caseId, 'Before', entry)
    const showReal = entry.afterRealRunDir !== undefined && entry.cleanup !== 'no-mock'
    const after = comparisonSide(project, round, afterDir, entry.caseId, showReal ? 'After · mock data' : 'After', entry)
    const afterReal = showReal ? comparisonSide(project, round, entry.afterRealRunDir, entry.caseId, 'After · real data (informational)', entry) : ''
    const beforePixels = typeof entry.before === 'number' ? `${(entry.before * 100).toFixed(2)}%` : '—'
    const afterPixels = typeof entry.after === 'number' ? `${(entry.after * 100).toFixed(2)}%` : '—'
    return `<section class="case">
      <div class="case-h"><strong>${escapeHtml(entry.subtaskId)}</strong><span class="pill ${entry.status === 'committed' ? 'ok' : 'bad'}">${escapeHtml(entry.status)}</span><span class="mut">${escapeHtml(beforePixels)} → ${escapeHtml(afterPixels)}</span></div>
      <div class="compare">
        <div class="side"><h3>Before</h3>${before || '<div class="mut">no before capture</div>'}</div>
        <div class="side"><h3>${showReal ? 'After · mock data' : 'After'}</h3>${after || '<div class="mut">no after capture</div>'}</div>
        ${showReal ? `<div class="side"><h3>After · real data (informational)</h3>${afterReal || '<div class="mut">no real-data capture</div>'}</div>` : ''}
      </div>
      <div class="kv">${entry.sha == null ? '' : `alignment commit ${escapeHtml(entry.sha)}`}${entry.cleanupSha == null ? '' : ` · real-data commit ${escapeHtml(entry.cleanupSha)}`}${entry.afterReal === undefined ? '' : ` · real ${(entry.afterReal * 100).toFixed(2)}%`}${entry.cleanupError == null ? '' : ` · cleanup failed: ${escapeHtml(entry.cleanupError)}`}${entry.realError == null ? '' : ` · real capture failed: ${escapeHtml(entry.realError)}`}${entry.error == null ? '' : ` · ${escapeHtml(entry.error)}`}</div>
    </section>`
  }).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Round ${round.number} report</title>
  <style>
  body{margin:0;background:#f7f8fa;color:#0f172a;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px}
  .page{max-width:1600px;margin:0 auto;padding:28px}
  h1{font-size:18px;margin:0}
  h3{font-size:12px;margin:0 0 6px;color:#334155}
  .sub{color:#64748b;font-size:12px;margin-top:4px}
  .mut{color:#94a3b8;font-size:11px}
  .case{background:#fff;border:1px solid #e5eaf1;border-radius:9px;padding:14px;margin-bottom:12px}
  .case-h{display:flex;gap:8px;align-items:center;margin-bottom:10px}
  .pill{border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600}
  .ok{background:#e8f8ef;color:#15803d}.bad{background:#fdecec;color:#b91c1c}
  .compare{display:block}
  .side{width:100%;margin-bottom:20px}
  .side h3{font-size:13px;margin:0 0 8px;color:#334155}
  .kv{color:#64748b;font-size:11px;margin-top:6px}
  .shots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
  figure{margin:0;min-width:0}
  .shot{display:block;cursor:zoom-in}
  img{width:100%;height:auto;border:1px solid #e2e8f0;border-radius:6px;display:block}
  figcaption{color:#94a3b8;font-size:10px;margin-top:3px}
  </style></head><body><div class="page">
  <h1>Round ${round.number} 对齐报告</h1>
  <div class="sub">${escapeHtml(project.name)} · base ${escapeHtml(project.baseCommit.slice(0, 7))}${round.branch === undefined ? '' : ' · ' + escapeHtml(round.branch)} · ${(round.commits ?? []).length} commits</div>
  ${sections}
  </div></body></html>`
  const path = join(directory, 'report.html')
  writeFileSync(path, html)
  return path
}

function buildRoundReport(project, round, result) {
  const directory = join(projectsDirectory(), project.id, 'rounds', round.id)
  const assets = join(directory, 'assets')
  mkdirSync(assets, { recursive: true })
  if (Array.isArray(round.subtasks) && round.subtasks.length > 0) {
    return buildComparisonReport(project, round, directory, assets)
  }
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
            ${viewport.files.reference ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.reference)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.reference)}"></a><figcaption>reference</figcaption></figure>` : ''}
            ${viewport.files.implementation ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.implementation)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.implementation)}"></a><figcaption>implementation</figcaption></figure>` : ''}
            ${viewport.files.diff ? `<figure><a class="shot" href="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.diff)}" target="_blank" rel="noreferrer"><img src="/pixel-parity/project/asset?projectId=${encodeURIComponent(project.id)}&round=${round.number}&name=${encodeURIComponent(viewport.files.diff)}"></a><figcaption>diff</figcaption></figure>` : ''}
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
  <div class="sub">${escapeHtml(project.name)} · base ${escapeHtml(project.baseCommit.slice(0, 7))} · ${escapeHtml(round.finishedAt ?? '')}${round.branch === undefined ? '' : ' · ' + escapeHtml(round.branch)}</div>
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

export function regenerateRoundReport(projectId, roundNumber) {
  const project = readProject(projectId)
  const round = project.rounds.find(item => item.number === Number(roundNumber))
  if (round === undefined) throw new Error(`round not found: ${roundNumber}`)
  const directory = join(projectsDirectory(), project.id, 'rounds', round.id)
  mkdirSync(join(directory, 'assets'), { recursive: true })
  if (Array.isArray(round.subtasks) && round.subtasks.length > 0) {
    round.reportPath = buildComparisonReport(project, round, directory, join(directory, 'assets'))
  } else if (typeof round.runDir === 'string') {
    const manifest = JSON.parse(readFileSync(join(round.runDir, 'manifest.json'), 'utf8'))
    round.reportPath = buildRoundReport(project, round, { runDir: round.runDir, manifest })
  } else {
    throw new Error('round has no capture data to report')
  }
  writeProject(project)
  return round.reportPath
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



















