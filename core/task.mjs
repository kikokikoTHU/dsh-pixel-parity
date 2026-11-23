/**
 * Persisted alignment task: one objective (cases × viewports + thresholds)
 * that survives sessions and records every iteration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { runConfig } from './runner.mjs'
import { diagnoseRun } from './diagnose.mjs'
import { buildAlignmentPlan } from './plan.mjs'
import { buildTaskReport } from './task-report.mjs'

const TASKS_DIR = '.parity/tasks'

export function tasksDirectory(repo) {
  return join(resolve(repo), TASKS_DIR)
}

export function taskPath(repo, id) {
  return join(tasksDirectory(repo), id, 'task.json')
}

/**
 * Create a task and write task.json.
 * @param {{repo: string, config: string, cases?: string[], viewports?: string[], goal?: object, maxIterations?: number}} input
 * @returns {object} task.
 */
export function createTask(input) {
  const repo = resolve(input.repo)
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`)
  if (typeof input.config !== 'string' || input.config.length === 0) throw new Error('config is required')
  const config = isAbsolute(input.config) ? input.config : resolve(repo, input.config)
  if (!existsSync(config)) throw new Error(`config not found: ${config}`)
  const now = new Date().toISOString()
  const id = input.id ?? `task-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}`
  const goal = {
    maxMismatch: typeof input.goal?.maxMismatch === 'number' ? input.goal.maxMismatch : 0.01,
    requireGeometry: input.goal?.requireGeometry !== false,
    requireStyles: input.goal?.requireStyles !== false,
  }
  const task = {
    version: 1,
    id,
    repo,
    config,
    cases: Array.isArray(input.cases) ? input.cases : [],
    viewports: Array.isArray(input.viewports) ? input.viewports : [],
    goal,
    maxIterations: Number.isInteger(input.maxIterations) && input.maxIterations > 0 ? input.maxIterations : 8,
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
  return task
}

export function saveTask(task) {
  task.updatedAt = new Date().toISOString()
  const directory = join(tasksDirectory(task.repo), task.id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`)
}

export function readTask(repo, id) {
  const path = taskPath(repo, id)
  if (!existsSync(path)) throw new Error(`task not found: ${id}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function listTasks(repo) {
  const directory = tasksDirectory(repo)
  if (!existsSync(directory)) return []
  const tasks = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      tasks.push(JSON.parse(readFileSync(join(directory, entry.name, 'task.json'), 'utf8')))
    } catch {
      // skip a half-written task
    }
  }
  return tasks.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
}

export function pauseTask(repo, id, reason = 'paused by user') {
  const task = readTask(repo, id)
  if (task.status === 'converged') return task
  task.status = 'paused'
  task.blockedReason = reason
  saveTask(task)
  return task
}

export function resumeTask(repo, id) {
  const task = readTask(repo, id)
  if (task.status === 'paused') {
    task.status = task.runs.length > 0 ? 'needs-edit' : 'draft'
    task.blockedReason = null
    saveTask(task)
  }
  return task
}

/**
 * Run one measurement iteration and update the task.
 * @param {{repo: string, id: string, dependenciesRoot?: string, headless?: boolean}} input
 * @returns {Promise<{task: object, plan: object|null, runDir: string}>}
 */
export async function stepTask(input) {
  const task = readTask(input.repo, input.id)
  if (task.status === 'converged') return { task, plan: null, runDir: task.currentRunDir }
  if (task.status === 'paused') throw new Error(`task ${task.id} is paused; resume it first`)
  if (task.iteration >= task.maxIterations) {
    task.status = 'paused'
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
      dependenciesRoot: input.dependenciesRoot,
      caseIds: task.cases.length > 0 ? task.cases : undefined,
      viewportIds: task.viewports.length > 0 ? task.viewports : undefined,
      baselineMode: 'ephemeral',
      headless: input.headless !== false,
    })
  } catch (error) {
    task.status = 'blocked'
    task.blockedReason = String(error?.message ?? error)
    saveTask(task)
    return { task, plan: null, runDir: task.currentRunDir }
  }

  const manifest = result.manifest
  const iteration = task.iteration + 1
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
  task.runs.push({
    iteration,
    runDir: result.runDir,
    status: manifest.summary?.failed === 0 && manifest.summary?.incomplete === 0 ? 'verified' : 'failed',
    summary: manifest.summary ?? null,
    delta: manifest.delta ?? null,
    cases,
  })

  const passed = manifest.summary?.failed === 0 && manifest.summary?.incomplete === 0
  if (passed) {
    task.status = 'converged'
    task.plan = null
    task.blockedReason = null
  } else {
    const diagnosis = diagnoseRun(result.runDir)
    const plan = buildAlignmentPlan(diagnosis, manifest)
    task.status = 'needs-edit'
    task.plan = plan
  }
  saveTask(task)
  return { task, plan: task.plan, runDir: result.runDir }
}

/**
 * Generate (or refresh) the task report.
 * @param {string} repo - repository root.
 * @param {string} id - task id.
 * @returns {string} report path.
 */
export function reportTask(repo, id) {
  const task = readTask(repo, id)
  const path = buildTaskReport(task)
  task.reportPath = path
  saveTask(task)
  return path
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
