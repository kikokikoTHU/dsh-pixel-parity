#!/usr/bin/env node
/**
 * Parity CLI.
 *
 *   node cli.mjs run --config parity.config.mjs [--repo .] [--deps .]
 *                    [--baseline-mode auto|pin|ephemeral|baseline]
 *                    [--case id] [--viewport id] [--out dir] [--json] [--headed]
 *   node cli.mjs approve [--repo .] [--run dir] [--case id] [--note text]
 *
 * `run` exit code 0 means every case passed (verified or image-verified);
 * 1 means a failure or an incomplete case; 2 means the run itself failed.
 */

import process from 'node:process'
import { resolve } from 'node:path'
import { runConfig } from './core/runner.mjs'
import { approveRun, latestRunDir } from './core/baselines.mjs'
import { initRepo } from './core/init.mjs'

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'run'

if (args.help === true || command === 'help') {
  printHelp()
  process.exit(0)
}

const repoRoot = args.repo === undefined ? process.cwd() : resolve(String(args.repo))

if (command === 'run') {
  await run()
} else if (command === 'approve') {
  approve()
} else if (command === 'init') {
  init()
} else {
  console.error(`unknown command "${command}"`)
  printHelp()
  process.exit(2)
}

async function run() {
  const configPath = args.config === undefined ? resolve('parity.config.mjs') : resolve(String(args.config))
  const baselineMode = args.baselineMode === undefined ? 'auto' : String(args.baselineMode)
  if (!['auto', 'pin', 'ephemeral', 'baseline'].includes(baselineMode)) {
    console.error(`--baseline-mode must be auto, pin, ephemeral, or baseline (got "${baselineMode}")`)
    process.exit(2)
  }
  try {
    const result = await runConfig({
      configPath,
      repoRoot,
      dependenciesRoot: args.deps === undefined ? undefined : resolve(String(args.deps)),
      caseIds: list(args.case),
      viewportIds: list(args.viewport),
      outDir: args.out === undefined ? undefined : resolve(String(args.out)),
      headless: args.headed !== true,
      baselineMode,
    })
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ runDir: result.runDir, summary: result.summary, manifest: result.manifest }, null, 2)}\n`)
    } else {
      printSummary(result)
    }
    process.exit(result.summary.failed > 0 || result.summary.incomplete > 0 ? 1 : 0)
  } catch (error) {
    console.error(`parity run failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

function approve() {
  try {
    const result = approveRun({
      repoRoot,
      runDir: args.run === undefined ? undefined : resolve(String(args.run)),
      cases: list(args.case),
      note: args.note === undefined ? undefined : String(args.note),
    })
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      console.log(`Approved ${result.approved.length} baseline(s) from ${result.runDir}`)
      for (const entry of result.approved) console.log(`  ${entry.case} @ ${entry.viewport}`)
      for (const entry of result.skipped) console.log(`  skipped ${entry.case} @ ${entry.viewport}: ${entry.reason}`)
    }
    process.exit(result.approved.length === 0 ? 1 : 0)
  } catch (error) {
    console.error(`parity approve failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

function init() {
  try {
    const result = initRepo({
      repoRoot,
      output: args.output === undefined ? undefined : String(args.output),
      force: args.force === true,
    })
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      console.log(`${result.created ? 'Created' : 'Exists '} ${result.configPath}`)
      console.log(`  framework: ${result.detection.framework}`)
      console.log(`  package:   ${result.detection.packageManager}`)
      console.log(`  dev:       ${result.detection.devCommand ?? '(none)'}`)
      console.log(`  port:      ${result.detection.port} (${result.detection.portSource ?? 'default'})`)
      console.log(`  playwright:${result.detection.playwright ? ' yes' : ' no'}`)
      console.log(`  routes:    ${result.detection.routes.length === 0 ? '(none detected)' : result.detection.routes.map(route => route.path).join(', ')}`)
      for (const warning of result.warnings) console.log(`  warning:   ${warning}`)
      console.log('\nNext: set the reference URL in the config, map cases, then run "node cli.mjs run".')
    }
    process.exit(0)
  } catch (error) {
    console.error(`parity init failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      parsed._.push(token)
      continue
    }
    const [flag, inline] = token.slice(2).split('=', 2)
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (inline !== undefined) {
      assign(parsed, key, inline)
      continue
    }
    if (key === 'json' || key === 'headed' || key === 'help' || key === 'force') {
      parsed[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = true
      continue
    }
    index += 1
    assign(parsed, key, value)
  }
  return parsed
}

function assign(target, key, value) {
  if (key === 'case' || key === 'viewport') {
    target[key] = [...(target[key] ?? []), value]
    return
  }
  target[key] = value
}

function list(value) {
  if (value === undefined) return undefined
  const items = Array.isArray(value) ? value : [value]
  return items.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean)
}

function printSummary(result) {
  const { summary, manifest, runDir } = result
  console.log(`PixelParity run ${manifest.runId}`)
  console.log(`  config:   ${manifest.config.path}`)
  console.log(`  repo:     ${manifest.repo.root}${manifest.repo.commit === null ? '' : ` @ ${manifest.repo.commit.slice(0, 8)}`}`)
  console.log(`  driver:   ${manifest.driver}`)
  console.log(`  baseline: ${manifest.decision.mode} (${manifest.decision.source})`)
  console.log('')
  for (const entry of manifest.cases) {
    for (const viewport of entry.viewports) {
      const status = viewport.status.padEnd(14)
      const pixels = viewport.pixels?.metrics
      const detail = pixels === undefined
        ? viewport.error ?? ''
        : `${(pixels.mismatchRatio * 100).toFixed(2)}% pixels, mean ${pixels.meanDelta}`
      const geometry = viewport.geometry?.available === true && viewport.geometry.pass === false
        ? ' geometry-fail'
        : ''
      const baseline = viewport.baseline?.written === true ? ' baseline-written' : viewport.baseline?.used === true ? ' vs-baseline' : ''
      console.log(`  ${status} ${entry.id} @ ${viewport.viewportId}${geometry}${baseline}  ${detail}`)
    }
  }
  console.log('')
  console.log(`  ${summary.verified} verified, ${summary['image-verified']} image-verified, ${summary.failed} failed, ${summary.incomplete} incomplete`)
  console.log(`  artifacts: ${runDir}`)
}

function printHelp() {
  console.log(`Usage: node cli.mjs <run|approve|init> [options]

init:
  --repo <dir>           repository root (default: cwd)
  --output <file>        config path relative to the repo (default: parity.config.mjs)
  --force                overwrite an existing config
  --json                 print the detection result as JSON

run:
  --config <file>        parity config (.mjs/.js/.json)
  --repo <dir>           repository root (default: cwd)
  --deps <dir>           where playwright resolves from (default: repo)
  --baseline-mode <mode> auto | pin | ephemeral | baseline (default: auto)
  --case <id>            run one case (repeatable or comma-separated)
  --viewport <id>        run one viewport (repeatable or comma-separated)
  --out <dir>            artifact directory (default: <repo>/.parity/runs/<runId>)
  --json                 print the full manifest as JSON
  --headed               show the browser window

approve:
  --repo <dir>           repository root
  --run <dir>            run directory (default: newest)
  --case <id>            approve only these cases
  --note <text>          note stored with the baseline
  --json                 print the result as JSON`)
}
