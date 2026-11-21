/**
 * Pixel parity — make a frontend implementation measurably match its design.
 *
 * The plugin exposes one tool (`parity_check`) that renders a page in headless
 * Chromium, diffs it against the design image, and writes a red-masked diff plus
 * a JSON report, and registers the matching workflow skill.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runParityCheck } from './lib/check.js'
import { runConfig } from './core/runner.mjs'
import { approveRun } from './core/baselines.mjs'
import { initRepo } from './core/init.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Cordis plugin name. */
export const name = 'dsh-pixel-parity'

/** The tool registry and the skill registry are both required. */
export const inject = ['tools', 'skills']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['page', 'design', 'width', 'height'],
  properties: {
    page: {
      type: 'string',
      description: 'Page to render: an http(s) URL, a file:// URL, or a local HTML file path (relative paths resolve against the process working directory).',
    },
    design: {
      type: 'string',
      description: 'Design image to compare against: an absolute path to a PNG (decoded directly) or a JPEG/WebP the host can decode.',
    },
    width: {
      type: 'integer',
      description: 'Viewport width in CSS pixels. Rendered pixels are width x dpr and must equal the design image width.',
    },
    height: {
      type: 'integer',
      description: 'Viewport height in CSS pixels. Rendered pixels are height x dpr and must equal the design image height.',
    },
    dpr: {
      type: 'number',
      description: 'Device pixel ratio, 0.5-8. Default 1; use 2 when the design is an @2x export.',
    },
    tolerance: {
      type: 'integer',
      description: 'Per-channel difference (0-255) above which a pixel counts as mismatched. Default 24, which tolerates anti-aliasing but not wrong colors or positions.',
    },
    maxMismatch: {
      type: 'number',
      description: 'Largest acceptable share of mismatched pixels overall, 0-1. Default 0.01 (1%). The check fails above it.',
    },
    maxRegionMismatch: {
      type: 'number',
      description: 'Largest acceptable mismatch share inside one 16x16 grid cell, 0-1. Default 0.4 (40%). Catches a wrong block that a 1% overall budget would hide; raise it only with a stated reason for text-dense designs.',
    },
    outputDir: {
      type: 'string',
      description: 'Directory for screenshot.png, diff.png, and report.json. Default: a new run folder under the OS temp directory. Pass a project path when the artifacts should be kept.',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'verdict', 'design', 'screenshot', 'viewport', 'metrics', 'regions', 'artifacts'],
  properties: {
    pass: { type: 'boolean' },
    verdict: { type: 'string' },
    design: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'width', 'height', 'palette'],
      properties: {
        path: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        palette: {
          type: 'array',
          description: 'Most frequent colors in the design, most common first.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['hex', 'share'],
            properties: {
              hex: { type: 'string' },
              share: { type: 'number' },
            },
          },
        },
      },
    },
    screenshot: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'width', 'height', 'browser', 'uniform'],
      properties: {
        path: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        browser: { type: 'string' },
        uniform: { type: 'boolean', description: 'True when one color covers at least 99.5% of the screenshot.' },
      },
    },
    viewport: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'dpr'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        dpr: { type: 'number' },
      },
    },
    metrics: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'totalPixels', 'mismatchPixels', 'mismatchRatio', 'meanDelta', 'maxDelta', 'tolerance', 'bounds'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        totalPixels: { type: 'integer' },
        mismatchPixels: { type: 'integer' },
        mismatchRatio: { type: 'number' },
        meanDelta: { type: 'number' },
        maxDelta: { type: 'integer' },
        tolerance: { type: 'integer' },
        bounds: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'w', 'h'],
          description: 'Bounding box of all mismatched pixels; zero size when nothing differs.',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer' },
            h: { type: 'integer' },
          },
        },
      },
    },
    regions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'w', 'h', 'mismatchRatio', 'meanDelta'],
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          w: { type: 'integer' },
          h: { type: 'integer' },
          mismatchRatio: { type: 'number' },
          meanDelta: { type: 'number' },
        },
      },
    },
    artifacts: {
      type: 'object',
      additionalProperties: false,
      required: ['screenshot', 'diff', 'report'],
      properties: {
        screenshot: { type: 'string' },
        diff: { type: 'string' },
        report: { type: 'string' },
      },
    },
  },
}

const DESCRIPTION = [
  'Compare a rendered page with a design image, pixel by pixel.',
  'Renders `page` in headless Chromium at exactly `width` x `height` CSS pixels (times `dpr`), screenshots it, and diffs it against `design`.',
  'Writes screenshot.png, diff.png (mismatched pixels in red over a dimmed design) and report.json to `outputDir`.',
  'Returns pass plus the reason, the mismatch ratio and pixel count, mean and maximum channel delta, the bounding box of all differences, and the worst 16x16 grid regions.',
  'It also returns the design palette (most frequent colors and their share) so colors can be taken from the image instead of guessed.',
  'A run fails when the overall ratio exceeds `maxMismatch`, when one grid cell exceeds `maxRegionMismatch`, or when the screenshot is one flat color while the design is not (a blank page or failed load).',
  'The screenshot must have the same pixel dimensions as the design; when they differ the call fails instead of rescaling.',
  'Use it in a loop: fix the largest region first, then re-run until `pass` is true.',
].join(' ')

const RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'config'],
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path to the repository root whose implementation is checked.',
    },
    config: {
      type: 'string',
      description: 'Path to the parity config: absolute, or relative to `repo`. Supports .mjs, .js, and .json.',
    },
    cases: {
      type: 'array',
      description: 'Only run these case ids. Default: every case in the config.',
      items: { type: 'string' },
    },
    viewports: {
      type: 'array',
      description: 'Only run these viewport ids. Default: every viewport in the config.',
      items: { type: 'string' },
    },
    outputDir: {
      type: 'string',
      description: 'Artifact directory. Default: <repo>/.parity/runs/<runId>.',
    },
    headless: {
      type: 'boolean',
      description: 'Run the browser headless. Default true; false shows the window for debugging.',
    },
    baselineMode: {
      type: 'string',
      enum: ['auto', 'pin', 'ephemeral', 'baseline'],
      description: 'How to treat baselines. auto asks when an online reference has no baseline; pin saves a baseline after a passing run; ephemeral never saves; baseline compares against the saved baseline (offline regression).',
    },
    dependencies: {
      type: 'string',
      description: 'Directory where Playwright resolves from. Default: the repo root.',
    },
    exportIr: {
      type: 'boolean',
      description: 'Also export IR v1 (ir.json) and a generated static HTML render (generated.html) per case/viewport. Requires Playwright.',
    },
  },
}

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'passed', 'summary', 'cases', 'decision'],
  properties: {
    runDir: { type: 'string' },
    passed: { type: 'boolean' },
    decision: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'source'],
      properties: {
        mode: { type: 'string' },
        source: { type: 'string' },
        cases: { type: 'array', items: { type: 'string' } },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['cases', 'viewports', 'verified', 'imageVerified', 'failed', 'incomplete'],
      properties: {
        cases: { type: 'integer' },
        viewports: { type: 'integer' },
        verified: { type: 'integer' },
        imageVerified: { type: 'integer' },
        failed: { type: 'integer' },
        incomplete: { type: 'integer' },
      },
    },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'viewports'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          viewports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'status', 'geometry', 'styles'],
              properties: {
                id: { type: 'string' },
                status: { type: 'string' },
                mismatchRatio: { type: 'number' },
                geometry: { type: 'string' },
                styles: { type: 'string' },
                ir: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['path', 'generated', 'semantic', 'nodes', 'truncated', 'pins', 'iterations', 'within1', 'within2', 'over2'],
                  properties: {
                    path: { type: 'string' },
                    generated: { type: 'string' },
                    semantic: { type: 'string' },
                    nodes: { type: 'integer' },
                    truncated: { type: 'boolean' },
                    pins: { type: 'integer' },
                    iterations: { type: 'integer' },
                    within1: { type: 'integer' },
                    within2: { type: 'integer' },
                    over2: { type: 'integer' },
                  },
                },
                error: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

const APPROVE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path to the repository root that owns the run and its baselines.',
    },
    runDir: {
      type: 'string',
      description: 'Run directory to approve. Default: the newest run under <repo>/.parity/runs.',
    },
    cases: {
      type: 'array',
      description: 'Approve only these case ids. Default: every passing case in the run.',
      items: { type: 'string' },
    },
    note: {
      type: 'string',
      description: 'Short note stored with the baseline (for example why it was re-approved).',
    },
  },
}

const APPROVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'approved', 'skipped'],
  properties: {
    runDir: { type: 'string' },
    approved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['case', 'viewport', 'path'],
        properties: {
          case: { type: 'string' },
          viewport: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['case', 'viewport', 'reason'],
        properties: {
          case: { type: 'string' },
          viewport: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const BASELINE_OPTIONS = {
  pin: '对齐在线原型并固化基线',
  ephemeral: '仅本次比对，不保存基线',
  baseline: '与已有基线回归',
}

const INIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path to the repository root to scan.',
    },
    output: {
      type: 'string',
      description: 'Config path relative to the repo. Default: parity.config.mjs.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite an existing config. Default false.',
    },
  },
}

const INIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['configPath', 'created', 'detected', 'warnings'],
  properties: {
    configPath: { type: 'string' },
    created: { type: 'boolean' },
    detected: {
      type: 'object',
      additionalProperties: false,
      required: ['framework', 'packageManager', 'devCommand', 'port', 'playwright', 'routes'],
      properties: {
        framework: { type: 'string' },
        packageManager: { type: 'string' },
        devCommand: { type: 'string' },
        port: { type: 'integer' },
        playwright: { type: 'boolean' },
        routes: { type: 'array', items: { type: 'string' } },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const RUN_DESCRIPTION = [
  'Run a parity config that aligns a repository implementation with a reference.',
  'Each case compares a reference (web URL or design image) with an implementation (web URL) and judges three layers: geometry of anchor elements, computed styles of those anchors, and pixel difference with dynamic regions masked.',
  'Statuses are `verified` (all three layers pass), `image-verified` (pixels pass but no anchors), `failed`, or `incomplete` (capture error).',
  'Writes reference.png, implementation.png, diff.png, metrics.json per case/viewport and manifest.json per run under `outputDir`.',
  'The config file (parity.config.mjs) declares viewports, cases, anchors, masks, and thresholds; the repo must provide either Playwright (preferred) or a Chromium-based browser.',
].join(' ')

/**
 * Register the parity tool and the workflow skill.
 * @param {object} ctx - Cordis context with tools and skills services.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'parity_check',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const regionText = value.regions.length === 0
          ? 'none'
          : value.regions.map(region => `(${region.x},${region.y}) ${region.w}x${region.h} ${(region.mismatchRatio * 100).toFixed(1)}%`).join(', ')
        const paletteText = value.design.palette
          .slice(0, 5)
          .map(color => `${color.hex} ${(color.share * 100).toFixed(1)}%`)
          .join(', ')
        return [{
          type: 'text',
          text: [
            value.verdict,
            `Mismatch: ${value.metrics.mismatchPixels} px of ${value.metrics.totalPixels}, mean delta ${value.metrics.meanDelta}, max delta ${value.metrics.maxDelta}, tolerance ${value.metrics.tolerance}.`,
            `Difference bounds: x ${value.metrics.bounds.x}, y ${value.metrics.bounds.y}, ${value.metrics.bounds.w}x${value.metrics.bounds.h}.`,
            `Worst regions (x,y w x h mismatch): ${regionText}`,
            `Design palette: ${paletteText || 'single color'}`,
            `Diff image: ${value.artifacts.diff}`,
            `Report: ${value.artifacts.report}`,
          ].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      return runParityCheck(normalize(args), exec)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_run',
    description: RUN_DESCRIPTION,
    parameters: RUN_PARAMETERS,
    output: {
      schema: RUN_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [
          value.passed ? 'PASS' : 'FAIL',
          `Run: ${value.runDir}`,
          `Baseline: ${value.decision.mode} (${value.decision.source})`,
        ]
        for (const entry of value.cases) {
          for (const viewport of entry.viewports) {
            const ratio = viewport.mismatchRatio === undefined ? '' : ` ${(viewport.mismatchRatio * 100).toFixed(2)}% pixels`
            const error = viewport.error === undefined ? '' : ` error=${viewport.error}`
            lines.push(`${viewport.status.padEnd(15)} ${entry.id} @ ${viewport.id}${ratio} geometry=${viewport.geometry} styles=${viewport.styles}${error}`)
          }
        }
        lines.push(`${value.summary.verified} verified, ${value.summary.imageVerified} image-verified, ${value.summary.failed} failed, ${value.summary.incomplete} incomplete`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const repo = text(args.repo, 'repo')
      const configPath = isAbsolute(args.config) ? args.config : join(repo, args.config)
      const result = await runConfig({
        configPath,
        repoRoot: repo,
        dependenciesRoot: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
        caseIds: arrayOfText(args.cases, 'cases'),
        viewportIds: arrayOfText(args.viewports, 'viewports'),
        outDir: args.outputDir === undefined ? undefined : text(args.outputDir, 'outputDir'),
        headless: args.headless !== false,
        baselineMode: args.baselineMode === undefined ? 'auto' : text(args.baselineMode, 'baselineMode'),
        exportIr: args.exportIr === true,
        ask: createBaselineAsker(ctx, exec),
        signal: exec?.signal,
      })
      return buildRunValue(result)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_approve',
    description: 'Promote a passing parity run to baselines. Each approved case/viewport stores its implementation screenshot and anchor snapshot, so later `baseline` runs can verify geometry, styles, and pixels offline.',
    parameters: APPROVE_PARAMETERS,
    output: {
      schema: APPROVE_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [`Approved ${value.approved.length} baseline(s) from ${value.runDir}`]
        for (const entry of value.approved) lines.push(`  ${entry.case} @ ${entry.viewport}`)
        for (const entry of value.skipped) lines.push(`  skipped ${entry.case} @ ${entry.viewport}: ${entry.reason}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const repo = text(args.repo, 'repo')
      const result = approveRun({
        repoRoot: repo,
        runDir: args.runDir === undefined ? undefined : text(args.runDir, 'runDir'),
        cases: arrayOfText(args.cases, 'cases'),
        note: args.note === undefined ? undefined : text(args.note, 'note'),
      })
      return {
        runDir: result.runDir,
        approved: result.approved,
        skipped: result.skipped,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_init',
    description: 'Scan a repository and write a parity config draft. Detects the framework, package manager, dev command and port, the route table, and Playwright availability. Never overwrites an existing config unless `force` is true. The draft still needs the reference URL filled in.',
    parameters: INIT_PARAMETERS,
    output: {
      schema: INIT_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [`${value.created ? 'Created' : 'Exists '} ${value.configPath}`]
        lines.push(`Framework: ${value.detected.framework} (${value.detected.packageManager})`)
        lines.push(`Dev command: ${value.detected.devCommand || '(none found)'} on port ${value.detected.port}`)
        lines.push(`Playwright: ${value.detected.playwright ? 'available' : 'missing (pixels only)'}`)
        lines.push(`Routes: ${value.detected.routes.length === 0 ? '(none detected)' : value.detected.routes.join(', ')}`)
        for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const result = initRepo({
        repoRoot: text(args.repo, 'repo'),
        output: args.output === undefined ? undefined : text(args.output, 'output'),
        force: args.force === true,
      })
      return {
        configPath: result.configPath,
        created: result.created,
        detected: {
          framework: result.detection.framework,
          packageManager: result.detection.packageManager,
          devCommand: result.detection.devCommand ?? '',
          port: result.detection.port,
          playwright: result.detection.playwright,
          routes: result.detection.routes.map(route => route.path),
        },
        warnings: result.warnings,
      }
    },
  }))

  const skillBody = readFileSync(join(here, 'skill', 'pixel-parity.md'), 'utf8')
  ctx.effect(() => ctx.skills.register({
    name: 'pixel-parity',
    description: 'Align a repository implementation with a design image, reference page, or prototype using measured geometry, computed styles, and masked pixel checks, with baselines for regression.',
    whenToUse: 'A frontend repo (or a single page) must be made to match a design or prototype, or an already aligned implementation must be kept from drifting.',
    source: 'bundled',
    content: skillBody,
    resourceBase: { kind: 'directory', path: join(here, 'skill') },
  }))
}

function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parity_check arguments must be an object')
  }
  const page = text(raw.page, 'page')
  const design = text(raw.design, 'design')
  const width = integer(raw.width, 'width', 1, 16384)
  const height = integer(raw.height, 'height', 1, 16384)
  const dpr = raw.dpr === undefined ? 1 : number(raw.dpr, 'dpr', 0.5, 8)
  const tolerance = raw.tolerance === undefined ? 24 : integer(raw.tolerance, 'tolerance', 0, 255)
  const maxMismatch = raw.maxMismatch === undefined ? 0.01 : number(raw.maxMismatch, 'maxMismatch', 0, 1)
  const maxRegionMismatch = raw.maxRegionMismatch === undefined ? 0.4 : number(raw.maxRegionMismatch, 'maxRegionMismatch', 0, 1)
  const outputDir = raw.outputDir === undefined ? undefined : text(raw.outputDir, 'outputDir')
  return { page, design, width, height, dpr, tolerance, maxMismatch, maxRegionMismatch, outputDir }
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function integer(value, field, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function number(value, field, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a number between ${minimum} and ${maximum}`)
  }
  return value
}

function arrayOfText(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`)
  return value.map(entry => text(entry, field))
}

/**
 * Build the interactive baseline asker for this execution.
 * Returns undefined when the host has no user-questions service, which makes
 * the runner fall back to a non-interactive mode.
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool execution context.
 * @returns {Function | undefined} asker taking {cases, viewports} and resolving a mode.
 */
function createBaselineAsker(ctx, exec) {
  const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
  if (service === undefined || service === null || typeof service.ask !== 'function') return undefined
  return async (context) => {
    try {
      const answer = await service.ask({
        ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
        ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        questions: [{
          id: 'baseline-mode',
          header: '基准策略',
          question: `检测到 ${context.cases.length} 个 case 的参考物是在线页面，且尚无本地基线。这次如何建立基准？`,
          detail: context.cases.map(entry => `${entry.id}: ${entry.reference}`).join('\n'),
          options: [
            { label: BASELINE_OPTIONS.pin, description: '以当前在线页面为准完成本次比对；通过后保存为基线，之后回归只比基线。' },
            { label: BASELINE_OPTIONS.ephemeral, description: '只做这一次比对，不写基线；原型更新后需要重新决定。' },
            { label: BASELINE_OPTIONS.baseline, description: '跳过在线抓取，直接比对本地基线；缺少基线的 case 会标记 incomplete。' },
          ],
        }],
      })
      const selected = answer?.answers?.find(entry => entry.id === 'baseline-mode')?.selected?.[0]
      if (selected === BASELINE_OPTIONS.pin) return 'pin'
      if (selected === BASELINE_OPTIONS.ephemeral) return 'ephemeral'
      if (selected === BASELINE_OPTIONS.baseline) return 'baseline'
      return undefined
    } catch {
      return undefined
    }
  }
}

function buildRunValue(result) {
  const manifest = result.manifest
  return {
    runDir: result.runDir,
    passed: manifest.summary.failed === 0 && manifest.summary.incomplete === 0,
    decision: {
      mode: manifest.decision?.mode ?? 'auto',
      source: manifest.decision?.source ?? 'auto',
      ...(Array.isArray(manifest.decision?.cases) ? { cases: manifest.decision.cases } : {}),
    },
    summary: {
      cases: manifest.summary.cases,
      viewports: manifest.summary.viewports,
      verified: manifest.summary.verified,
      imageVerified: manifest.summary['image-verified'],
      failed: manifest.summary.failed,
      incomplete: manifest.summary.incomplete,
    },
    cases: manifest.cases.map(entry => ({
      id: entry.id,
      status: entry.status,
      viewports: entry.viewports.map(viewport => ({
        id: viewport.viewportId,
        status: viewport.status,
        ...(viewport.pixels?.metrics === undefined ? {} : { mismatchRatio: viewport.pixels.metrics.mismatchRatio }),
        geometry: viewport.geometry?.available === true ? (viewport.geometry.pass ? 'pass' : 'fail') : 'unavailable',
        styles: viewport.styles?.available === true ? (viewport.styles.pass ? 'pass' : 'fail') : 'unavailable',
        ...(viewport.ir === undefined ? {} : { ir: viewport.ir }),
        ...(viewport.error === undefined ? {} : { error: viewport.error }),
      })),
    })),
  }
}
