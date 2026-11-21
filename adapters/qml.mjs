/**
 * QML render check: run a generated component through qmlscene and grab a PNG.
 *
 * Used only for verification ("does the IR render outside the browser?"), not
 * as an interactive desktop surface.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { decodePng } from '../lib/png.js'

const KNOWN_PATHS = [
  'C:\\Qt\\Qt5.14.2\\5.14.2\\msvc2017_64\\bin\\qmlscene.exe',
  'C:\\Qt\\5.15.2\\msvc2019_64\\bin\\qmlscene.exe',
  'C:\\Qt\\6.5.0\\msvc2019_64\\bin\\qmlscene.exe',
]

/**
 * Locate `qmlscene`.
 * @returns {string | undefined} executable path.
 */
export function findQmlScene() {
  const configured = process.env.PIXEL_PARITY_QMLSCENE
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  for (const candidate of KNOWN_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (directory.length === 0) continue
    for (const name of process.platform === 'win32' ? ['qmlscene.exe', 'qmlscene.bat'] : ['qmlscene']) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Render a QML file and capture its window content.
 * @param {string} qmlPath - component to load.
 * @param {{width: number, height: number, outPath?: string, timeoutMs?: number}} options - window size and output.
 * @returns {Promise<{width: number, height: number, data: Uint8Array}>} captured image.
 */
export async function captureQml(qmlPath, options) {
  const scene = findQmlScene()
  if (scene === undefined) {
    throw new Error('qmlscene not found; install Qt or set PIXEL_PARITY_QMLSCENE to the executable')
  }
  const directory = dirname(qmlPath)
  const shotName = '__ir_shot.png'
  const shotPath = join(directory, shotName)
  const harnessName = '__ir_harness.qml'
  const harnessPath = join(directory, harnessName)
  if (existsSync(shotPath)) rmSync(shotPath, { force: true })
  writeFileSync(harnessPath, harnessSource(basename(qmlPath), options.width, options.height, shotName))
  await renderToFile(scene, harnessName, directory, shotPath, options.timeoutMs ?? 20000)
  if (!existsSync(shotPath)) throw new Error('qmlscene exited without producing a screenshot')
  const bytes = readFileSync(shotPath)
  if (options.outPath !== undefined) writeFileSync(options.outPath, bytes)
  return decodePng(bytes)
}

/**
 * Run qmlscene until the screenshot file appears, then stop it.
 *
 * qmlscene is a GUI-subsystem executable: its exit event is not reliable when
 * spawned from a console host, so the artifact is the completion signal.
 */
async function renderToFile(scene, harnessName, cwd, shotPath, timeoutMs) {
  const child = spawn(scene, [harnessName], { cwd, stdio: 'ignore' })
  let spawnError
  child.on('error', (error) => { spawnError = error })
  const started = Date.now()
  let lastSize = -1
  try {
    while (Date.now() - started < timeoutMs) {
      if (spawnError !== undefined) throw new Error(`cannot start qmlscene: ${spawnError.message}`)
      if (existsSync(shotPath)) {
        const size = statSync(shotPath).size
        if (size > 0 && size === lastSize) return
        lastSize = size
      } else {
        lastSize = -1
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error(`qmlscene produced no screenshot within ${timeoutMs}ms`)
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

function harnessSource(component, width, height, shotName) {
  return `import QtQuick 2.14
import QtQuick.Window 2.14

Window {
  id: win
  visible: true
  width: ${width}
  height: ${height}
  color: "#ffffff"
  Loader { anchors.fill: parent; source: "${component}" }
  Timer {
    interval: 900
    running: true
    repeat: false
    onTriggered: {
      win.contentItem.grabToImage(function (result) {
        result.saveToFile("${shotName}")
        Qt.quit()
      })
    }
  }
}
`
}
