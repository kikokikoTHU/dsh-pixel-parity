/**
 * Detect mock/fixture/demo/seed data introduced by one subtask commit.
 *
 * The check is scoped to files changed since the subtask started, so
 * pre-existing mocks in the repository do not block unrelated work.
 */

import { execFileSync } from 'node:child_process'

const MOCK_PATH = /(^|\/)(?:mock|mocks|fixture|fixtures|__fixtures__|demo|demos|seed|seeds)(?:\/|$)/i
const MOCK_FILE = /(?:^|[._-])(?:mock|fixture|demo|seed)(?:[._-]|$)/i
const MOCK_CONTENT = [
  /from\s+['"][^'"]*(?:mock|fixture|demo|seed)[^'"]*['"]/i,
  /require\(\s*['"][^'"]*(?:mock|fixture|demo|seed)[^'"]*['"]\s*\)/i,
  /data-source\s*=\s*['"]showcase['"]/i,
  /temporary\s+(?:design\s+)?fixture/i,
  /design\s+fixture/i,
  /demo\s+(?:data|values|rows)/i,
  /演示数据/i,
  /设计数据快照/i,
]

function git(worktree, args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true })
}

function looksBinary(buffer) {
  return buffer.includes(0)
}

export function scanMockArtifacts(worktree, baseCommit) {
  const names = git(worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', baseCommit, 'HEAD'])
    .split(/\r?\n/)
    .map(name => name.trim())
    .filter(name => name.length > 0)
  const files = []
  for (const path of names) {
    const reasons = []
    if (MOCK_PATH.test(path)) reasons.push('mock path')
    const base = path.split('/').at(-1) ?? path
    if (MOCK_FILE.test(base)) reasons.push('mock file name')
    if (reasons.length === 0) {
      let buffer
      try {
        buffer = execFileSync('git', ['-C', worktree, 'show', `HEAD:${path}`], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      } catch {
        continue
      }
      if (!looksBinary(buffer)) {
        const text = buffer.toString('utf8')
        for (const pattern of MOCK_CONTENT) {
          if (pattern.test(text)) {
            reasons.push(`content: ${pattern.source}`)
            break
          }
        }
      }
    }
    if (reasons.length > 0) files.push({ path, reasons })
  }
  return files
}

