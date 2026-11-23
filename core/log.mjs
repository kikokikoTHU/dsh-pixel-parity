/**
 * Lightweight append-only event log for observing PixelParity runs.
 * Stored under the plugin data directory so it survives restarts.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function logPath() {
  const data = process.env.PIXEL_PARITY_DATA_DIR === undefined
    ? resolve(HERE, '..', 'data')
    : resolve(process.env.PIXEL_PARITY_DATA_DIR)
  return join(data, 'logs', 'pixel-parity.log')
}

export function logEvent(event, data = {}, level = 'info') {
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, data })
    appendFileSync(path, `${line}\n`)
  } catch {
    // logging must never break the operation
  }
}

export function readLogs(limit = 100) {
  const path = logPath()
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-limit)
  const entries = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      entries.push({
        at: parsed.at,
        level: parsed.level ?? 'info',
        event: parsed.event ?? '',
        data: parsed.data ?? {},
      })
    } catch {}
  }
  return entries
}
