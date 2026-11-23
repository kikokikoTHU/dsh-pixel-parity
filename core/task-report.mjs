/**
 * Task report: one HTML document per task with iteration history, the latest
 * before/after screenshots, and the current plan.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory for one task's persisted artifacts (plugin data dir, not the repo). */
function taskDirectory(id) {
  const root = process.env.PIXEL_PARITY_TASK_DIR === undefined
    ? resolve(HERE, '..', 'data', 'tasks')
    : resolve(process.env.PIXEL_PARITY_TASK_DIR)
  return join(root, id)
}

/**
 * Generate `<task>/report.html` and return its path.
 * @param {object} task - task record.
 * @returns {string} report path.
 */
export function buildTaskReport(task) {
  const directory = taskDirectory(task.id)
  const assets = join(directory, 'report-assets')
  mkdirSync(assets, { recursive: true })

  const latest = task.runs.at(-1)
  const firstCase = latest?.cases?.[0]
  const firstViewport = firstCase?.viewports?.[0]
  const artifacts = {}
  if (latest !== undefined && firstCase !== undefined && firstViewport !== undefined) {
    const base = join(latest.runDir, 'cases', firstCase.id, firstViewport.id)
    for (const name of ['reference', 'implementation', 'diff']) {
      const source = join(base, `${name}.png`)
      if (!existsSync(source)) continue
      const target = join(assets, `${name}.png`)
      copyFileSync(source, target)
      artifacts[name] = target
    }
  }

  const rows = task.runs.map(run => {
    const pixels = run.cases.flatMap(entry => entry.viewports.map(viewport => viewport.pixels)).filter(value => value !== null)
    const mean = pixels.length === 0 ? '—' : `${(pixels.reduce((sum, value) => sum + value, 0) / pixels.length * 100).toFixed(2)}%`
    const delta = run.delta === null || run.delta === undefined ? '—' : `${run.delta.meanChange > 0 ? '+' : ''}${(run.delta.meanChange * 100).toFixed(2)}%`
    return `<tr><td>${run.iteration}</td><td>${escapeHtml(run.status)}</td><td>${mean}</td><td>${delta}</td><td><code>${escapeHtml(run.runDir)}</code></td></tr>`
  }).join('\n')

  const plan = task.plan?.steps?.length
    ? `<ol>${task.plan.steps.map(step => `<li><b>[${escapeHtml(step.kind)}]</b> ${escapeHtml(step.target)} — ${escapeHtml(step.action)}</li>`).join('')}</ol>`
    : '<p class="muted">No pending plan.</p>'

  const image = name => artifacts[name] === undefined
    ? ''
    : `<figure><img src="report-assets/${name}.png" alt="${name}"><figcaption>${name}</figcaption></figure>`

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PixelParity task ${escapeHtml(task.id)}</title>
<style>
  body { margin: 0; background: #f5f7fa; color: #1c2430; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 13px; line-height: 1.7; }
  .page { width: 1100px; margin: 24px auto 60px; background: #fff; border: 1px solid #dfe4ec; border-radius: 10px; overflow: hidden; }
  header { padding: 24px 32px; background: linear-gradient(135deg,#1b2a41,#28405f); color: #fff; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header p { margin: 0; color: #c9d6e6; font-size: 12px; }
  section { padding: 18px 32px; border-top: 1px solid #dfe4ec; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #dfe4ec; padding: 6px 8px; text-align: left; }
  th { background: #f3f6fa; }
  .bad { color: #c0392b; font-weight: 600; } .ok { color: #16794b; font-weight: 600; }
  .muted { color: #5c6878; }
  img { width: 100%; display: block; border: 1px solid #dfe4ec; border-radius: 6px; margin-top: 6px; }
  figure { margin: 8px 0 0; }
  figcaption { font-size: 11px; color: #5c6878; }
  code { background: #f2f4f8; padding: 0 4px; border-radius: 3px; font-size: 11px; }
</style></head><body>
<div class="page">
  <header><h1>PixelParity task · ${escapeHtml(task.id)}</h1>
  <p>${escapeHtml(task.repo)} · ${escapeHtml(task.config)} · 目标 maxMismatch ${(task.goal.maxMismatch * 100).toFixed(1)}%</p></header>
  <section>
    <h2>状态</h2>
    <p>status <b>${escapeHtml(task.status)}</b> · iteration ${task.iteration}/${task.maxIterations}${task.blockedReason === null ? '' : ` · ${escapeHtml(task.blockedReason)}`}</p>
    <h2>迭代历史</h2>
    <table><tr><th>iteration</th><th>status</th><th>mean pixels</th><th>delta</th><th>run</th></tr>${rows || '<tr><td colspan="5" class="muted">No runs yet.</td></tr>'}</table>
  </section>
  <section>
    <h2>下一步计划</h2>
    ${plan}
  </section>
  <section>
    <h2>最新对比</h2>
    ${image('reference')}
    ${image('implementation')}
    ${image('diff')}
  </section>
</div></body></html>`

  const path = join(directory, 'report.html')
  writeFileSync(path, html)
  return path
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
