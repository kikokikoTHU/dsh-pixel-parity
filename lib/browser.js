/**
 * Headless Chromium screenshots.
 *
 * The DSH host already ships a Chromium-based browser runtime, but capturing a
 * page through a separate browser process keeps rendering deterministic: every
 * run starts a fresh profile, disables extensions, and uses the same flags.
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

function windowsCandidates() {
  const local = process.env.LOCALAPPDATA
  if (typeof local !== 'string' || local.length === 0) return WINDOWS_CANDIDATES
  return [
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ...WINDOWS_CANDIDATES,
  ]
}

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const LINUX_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']

/**
 * Locate a Chromium-based browser executable.
 * @returns {string | undefined} absolute path or command name.
 */
export function findBrowser() {
  const configured = process.env.PIXEL_PARITY_BROWSER
  if (typeof configured === 'string' && configured.length > 0) {
    if (configured.includes('/') || configured.includes('\\')) {
      if (existsSync(configured)) return configured
    } else {
      return configured
    }
  }
  if (process.platform === 'win32') {
    return windowsCandidates().find(candidate => existsSync(candidate)) ?? findOnPath(['chrome', 'msedge'])
  }
  if (process.platform === 'darwin') {
    return MAC_CANDIDATES.find(candidate => existsSync(candidate))
  }
  return findOnPath(LINUX_COMMANDS) ?? LINUX_COMMANDS[0]
}

function findOnPath(names) {
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['', '.exe'] : ['']
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (directory.length === 0) continue
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(directory, name + extension)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * Capture one page at one viewport into a PNG file.
 * @param {{url: string, width: number, height: number, dpr: number, outPath: string, signal?: AbortSignal}} input - capture request.
 * @returns {Promise<{browser: string, bytes: number}>} capture result.
 */
export async function captureScreenshot(input) {
  const browser = findBrowser()
  if (browser === undefined) {
    throw new Error('no Chromium-based browser found: set PIXEL_PARITY_BROWSER to chrome, msedge, or an absolute executable path')
  }
  if (existsSync(input.outPath)) rmSync(input.outPath, { force: true })

  const profileDir = join(tmpdir(), `pixel-parity-profile-${process.pid}-${Date.now()}`)
  const baseArgs = [
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--no-pings',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    `--user-data-dir=${profileDir}`,
    `--force-device-scale-factor=${input.dpr}`,
    `--window-size=${input.width},${input.height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${input.outPath}`,
  ]

  let lastError
  try {
    for (const headless of ['--headless=new', '--headless']) {
      const args = [headless, ...baseArgs, input.url]
      try {
        await runProcess(browser, args, input.signal)
        if (existsSync(input.outPath)) {
          const bytes = statSync(input.outPath).size
          if (bytes > 0) return { browser, bytes }
        }
        lastError = new Error(`browser exited without writing ${input.outPath}`)
      } catch (error) {
        lastError = error
        if (isAbort(error, input.signal)) throw error
      }
    }
    throw lastError ?? new Error('screenshot failed')
  } finally {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // A browser still shutting down can hold the profile; the OS temp cleanup wins.
    }
  }
}

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError'
}

function runProcess(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timeout = 90000
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`browser timed out after ${timeout / 1000}s`))
    }, timeout)
    const onAbort = () => {
      child.kill()
      reject(Object.assign(new Error('screenshot aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (data) => {
      stderr += String(data)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`cannot start ${command}: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`${command.split(/[\\/]/).pop()} exited with code ${code}: ${lastLines(stderr)}`))
    })
  })
}

function lastLines(text, count = 6) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  return lines.slice(-count).join(' | ') || '(no output)'
}
