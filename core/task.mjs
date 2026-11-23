/**
 * Persisted alignment task. Task metadata and reports live under the plugin's
 * own `data/tasks/` directory, so they survive sessions and do not depend on a
 * repository being scanned. `repo` stays in the metadata for the actual runs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConfig } from './runner.mjs'
import { diagnoseRun } from './diagnose.mjs'
import { buildAlignmentPlan } from './plan.mjs'
import { buildTaskReport } from './task-report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Root of the task store: `<plugin>/data/tasks`, overridable for tests. */
export function tasksDirectory() {
  return process.env.PIXEL_PARITY_TASK_DIR === undefined
    ? resolve(HERE, '..', 'data', 'tasks')
    : resolve(process.env.PIXEL_PARITY_TASK_DIR)
}

export function taskPath(id) {
  return join(tasksDirectory(), id, 'task.json')
}

function newTaskId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `task-${stamp}-${suffix}`
}

/**
 * Create a task and persist it under the plugin's data directory.
 * @param {{repo: string, config: string, cases?: string[], viewports?: string[], goal?: object, maxIterations?: number, dependenciesRoot?: string, id?: string}} input
 * @returns {object} task.
 */
export function createTask(input) {
  const repo = resolve(input.repo)
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`)
  if (typeof input.config !== 'string' || input.config.length === 0) throw new Error('config is required')
  const config = isAbsolute(input.config) ? resolve(input.config) : resolve(repo, input.config)
  if (!existsSync(config)) throw new Error(`config not found: ${config}`)
  const now = new Date().toISOString()
  const task = {
    version: 2,
    id: input.id ?? newTaskId(),
    repo,
    config,
    cases: Array.isArray(input.cases) ? input.cases : [],
    viewports: Array.isArray(input.viewports) ? input.viewports : [],
    dependenciesRoot: typeof input.dependenciesRoot === 'string' ? resolve(input.dependenciesRoot) : null,
    goal: {
      maxMismatch: typeof input.goal?.maxMismatch === 'number' ? input.goal.maxMismatch : 0.01,
      requireGeometry: input.goal?.requireGeometry !== false,
      requireStyles: input.goal?.requireStyles !== false,
    },
    maxIterations: Number.isInteger(input.maxIterations) && input.maxIterations > 0 ? input.maxIterations : 4,
    autoResume: input.autoResume !== false,
    status: 'draft',
    iteration: 0,
    createdAt: now,
    updatedAt: now,
    runs: [],
    plan: null,
    currentRunDir: null,
    reportPath: null,
    blockedReason: null,
  }
  saveTask(task)
  writeCheckpoint(task)
  return task
}

export function saveTask(task) {
  task.updatedAt = new Date().toISOString()
  const directory = join(tasksDirectory(), task.id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`)
}

export function readTask(id) {
  const path = taskPath(id)
  if (!existsSync(path)) throw new Error(`task not found: ${id}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** List tasks, optionally filtered by repository. */
export function listTasks(repo) {
  const directory = tasksDirectory()
  if (!existsSync(directory)) return []
  const tasks = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const task = JSON.parse(readFileSync(join(directory, entry.name, 'task.json'), 'utf8'))
      if (repo !== undefined && resolve(task.repo) !== resolve(repo)) continue
      tasks.push(task)
    } catch {
      // skip a half-written task
    }
  }
  return tasks.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
}

/**
 * Run one measurement iteration and update the task.
 * @param {{id: string, dependenciesRoot?: string, headless?: boolean}} input
 * @returns {Promise<{task: object, plan: object|null, runDir: string}>}
 */
export async function stepTask(input) {
  const task = readTask(input.id)
  if (task.status === 'converged') return { task, plan: null, runDir: task.currentRunDir }
  if (task.status === 'paused') throw new Error(`task ${task.id} is paused; resume it first`)
  if (task.iteration >= task.maxIterations) {
    task.status = 'exhausted'
    task.blockedReason = `reached maxIterations (${task.maxIterations})`
    saveTask(task)
    return { task, plan: null, runDir: task.currentRunDir }
  }

  task.status = 'measuring'
  saveTask(task)

  let result
  try {
    result = await runConfig({
      configPath: task.config,
      repoRoot: task.repo,
      dependenciesRoot: input.dependenciesRoot ?? task.dependenciesRoot ?? undefined,
      caseIds: task.cases.length > 0 ? task.cases : undefined,
      viewportIds: task.viewports.length > 0 ? task.viewports : undefined,
      baselineMode: 'ephemeral',
      headless: input.headless !== false,
      signal: input.signal,
      task: {
        id: task.id,
        iteration: task.iteration + 1,
        maxIterations: task.maxIterations,
        parentRunDir: task.currentRunDir ?? undefined,
      },
    })
  } catch (error) {
    task.status = 'blocked'
    task.blockedReason = String(error?.message ?? error)
    saveTask(task)
    return { task, plan: null, runDir: task.currentRunDir }
  }

  const manifest = result.manifest
  const iteration = task.iteration + 1
  try {
    const manifestPath = join(result.runDir, 'manifest.json')
    const stored = JSON.parse(readFileSync(manifestPath, 'utf8'))
    stored.task = { id: task.id, iteration, maxIterations: task.maxIterations }
    writeFileSync(manifestPath, `${JSON.stringify(stored, null, 2)}\n`)
  } catch {}
  const cases = (manifest.cases ?? []).map(entry => ({
    id: entry.id,
    status: entry.status,
    viewports: (entry.viewports ?? []).map(viewport => ({
      id: viewport.viewportId,
      status: viewport.status,
      pixels: viewport.pixels?.metrics?.mismatchRatio ?? null,
      geometry: viewport.geometry?.available === true ? (viewport.geometry.pass === true ? 'pass' : 'fail') : 'unavailable',
      styles: viewport.styles?.available === true ? (viewport.styles.pass === true ? 'pass' : 'fail') : 'unavailable',
    })),
  }))
  task.iteration = iteration
  task.currentRunDir = result.runDir
  const summary = manifest.summary ?? {}
  const runStatus = (summary.failed ?? 0) > 0 ? 'failed' : (summary.incomplete ?? 0) > 0 ? 'incomplete' : 'verified'
  task.runs.push({
    iteration,
    runDir: result.runDir,
    status: runStatus,
    summary: manifest.summary ?? null,
    delta: manifest.delta ?? null,
    cases,
  })

  const passed = (summary.failed ?? 0) === 0 && (summary.incomplete ?? 0) === 0
  if (passed) {
    task.status = 'converged'
    task.plan = null
    task.blockedReason = null
  } else {
    const diagnosis = diagnoseRun(result.runDir)
    task.plan = buildAlignmentPlan(diagnosis, manifest)
    task.status = task.iteration >= task.maxIterations ? 'exhausted' : 'needs-edit'
    task.blockedReason = task.iteration >= task.maxIterations ? `reached maxIterations (${task.maxIterations})` : null
  }
  saveTask(task)
  writeCheckpoint(task)
  return { task, plan: task.plan, runDir: result.runDir }
}

/**
 * Generate (or refresh) the task report under the task directory.
 * @param {string} id - task id.
 * @returns {string} report path.
 */
export function reportTask(id) {
  const task = readTask(id)
  const path = buildTaskReport(task)
  task.reportPath = path
  saveTask(task)
  return path
}

/** Delete a task directory, including its report and report assets. */
export function deleteTask(id) {
  const task = readTask(id)
  const directory = join(tasksDirectory(), task.id)
  rmSync(directory, { recursive: true, force: true })
  return { id: task.id, repo: task.repo }
}
export function checkpointPath(id) {
  return join(tasksDirectory(), id, 'checkpoint.json')
}

export function writeCheckpoint(task) {
  const checkpoint = {
    version: 1,
    taskId: task.id,
    iteration: task.iteration,
    maxIterations: task.maxIterations,
    status: task.status,
    lastRunDir: task.currentRunDir,
    reportPath: task.reportPath,
    plan: task.plan,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(join(tasksDirectory(), task.id), { recursive: true })
  writeFileSync(checkpointPath(task.id), `${JSON.stringify(checkpoint, null, 2)}\n`)
}

/** Tasks that still have iterations left and are safe to resume. */
export function resumableTasks() {
  return listTasks().filter(task => {
    if (task.autoResume === false) return false
    if (task.iteration >= task.maxIterations) return false
    return ['draft', 'needs-edit', 'measuring'].includes(task.status)
  })
}

/** Restore tasks interrupted mid-measurement from their checkpoint. */
export function recoverInterruptedTasks() {
  for (const task of listTasks()) {
    if (task.status !== 'measuring') continue
    let checkpoint
    try {
      checkpoint = JSON.parse(readFileSync(checkpointPath(task.id), 'utf8'))
    } catch {
      checkpoint = null
    }
    task.status = 'needs-edit'
    task.blockedReason = 'interrupted: DSH closed during measurement'
    if (checkpoint !== null && Number.isInteger(checkpoint.iteration)) {
      task.iteration = checkpoint.iteration
      task.currentRunDir = checkpoint.lastRunDir ?? task.currentRunDir
    }
    saveTask(task)
    writeCheckpoint(task)
  }
}

/** Run all resumable tasks to their iteration budget. */
export async function autoResumeTasks(options = {}) {
  const intervalMs = options.intervalMs ?? 1000
  for (const task of resumableTasks()) {
    let current = task
    while (current !== null && current.iteration < current.maxIterations && ['draft', 'needs-edit', 'measuring'].includes(current.status)) {
      if (options.signal?.aborted === true) return
      try {
        const result = await stepTask({ id: current.id, dependenciesRoot: current.dependenciesRoot, headless: true })
        current = result.task
        writeCheckpoint(current)
      } catch {
        break
      }
      if (current.status === 'converged' || current.status === 'exhausted' || current.status === 'blocked') break
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
}
/** Compact task view for tools and the panel. */
export function taskSummary(task) {
  const latest = task.runs.at(-1)
  return {
    id: task.id,
    repo: task.repo,
    config: task.config,
    status: task.status,
    iteration: task.iteration,
    maxIterations: task.maxIterations,
    goal: task.goal,
    cases: task.cases,
    viewports: task.viewports,
    currentRunDir: task.currentRunDir ?? null,
    reportPath: task.reportPath ?? null,
    blockedReason: task.blockedReason ?? null,
    updatedAt: task.updatedAt,
    latest: latest === undefined
      ? null
      : {
          iteration: latest.iteration,
          status: latest.status,
          pixels: latest.cases.flatMap(entry => entry.viewports.map(viewport => viewport.pixels)).filter(value => value !== null),
          summary: latest.summary,
          delta: latest.delta,
        },
    plan: task.plan,
  }
}






