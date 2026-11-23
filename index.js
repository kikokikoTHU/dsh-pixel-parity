/**
 * Pixel parity — make a frontend implementation measurably match its design.
 *
 * The plugin exposes one tool (`parity_check`) that renders a page in headless
 * Chromium, diffs it against the design image, and writes a red-masked diff plus
 * a JSON report, and registers the matching workflow skill.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runParityCheck } from './lib/check.js'
import { runConfig } from './core/runner.mjs'
import { captureLoginState } from './adapters/web.mjs'
import { approveRun } from './core/baselines.mjs'
import { initRepo } from './core/init.mjs'
import { buildReport, renderReport, resolveRunDir } from './core/report.mjs'
import { diagnoseRun } from './core/diagnose.mjs'
import { buildAlignmentPlan, readManifest } from './core/plan.mjs'
import { createTask, deleteTask, listTasks, readTask, recoverInterruptedTasks, reportTask, stepTask, taskSummary } from './core/task.mjs'
import { overview, resolveArtifact } from './core/panel.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Repository of the most recent parity_run; the read-only panel scans it. */
let lastRunRoot
/** Repository chosen in the panel's path field, kept for artifact/diagnose routes. */
let panelRepoOverride
/** Arguments of the most recent parity_run, reused by the panel's Run button. */
let lastRunRequest
/** The panel-launched run job, if any. */
let activeJob
/** The panel-launched task-step job, if any. */
let taskJob
/** Abort controller for the active task step. */
let taskJobController
/** The panel-launched repo batch job, if any. */
let repoJob

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
    exportQml: {
      type: 'boolean',
      description: 'Also generate a QML snapshot (generated.qml) and render it with qmlscene when available, recording the pixel difference.',
    },
    exportComponent: {
      type: 'boolean',
      description: 'Also generate a maintainable HTML component and stylesheet (generated.component.html/.css), plus component partials with text slots for repeated subtrees (components/*.html and generated.components.json), recording the pixel difference.',
    },
    geometryTolerance: {
      type: 'number',
      description: 'Allowed anchor delta in CSS pixels for this run (overrides config; default 1). Raise it to tolerate small layout shifts.',
    },
    maxMismatch: {
      type: 'number',
      description: 'Allowed share of mismatched pixels for this run, 0-1 (overrides config; default 0.01 = 1%).',
    },
  },
}

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'passed', 'summary', 'cases', 'decision'],
  properties: {
    runDir: { type: 'string' },
    iteration: { type: 'integer' },
    delta: {
      type: 'object',
      additionalProperties: false,
      required: ['meanChange', 'improved', 'viewports'],
      properties: {
        meanChange: { type: 'number' },
        improved: { type: 'boolean' },
        viewports: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['case', 'viewport', 'pixels', 'previous', 'change', 'improved'],
            properties: {
              case: { type: 'string' },
              viewport: { type: 'string' },
              pixels: { type: 'number' },
              previous: { type: 'number' },
              change: { type: 'number' },
              improved: { type: 'boolean' },
            },
          },
        },
      },
    },
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
                  required: ['path', 'generated', 'semantic', 'nodes', 'truncated', 'pins', 'pruned', 'iterations', 'within1', 'within2', 'over2'],
                  properties: {
                    path: { type: 'string' },
                    generated: { type: 'string' },
                    semantic: { type: 'string' },
                    nodes: { type: 'integer' },
                    truncated: { type: 'boolean' },
                    pins: { type: 'integer' },
                    pruned: { type: 'integer' },
                    iterations: { type: 'integer' },
                    within1: { type: 'integer' },
                    within2: { type: 'integer' },
                    over2: { type: 'integer' },
                    qml: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['path'],
                      properties: {
                        path: { type: 'string' },
                        screenshot: { type: 'string' },
                        mismatchRatio: { type: 'number' },
                        error: { type: 'string' },
                        semantic: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['path', 'screenshot', 'mismatchRatio'],
                          properties: {
                            path: { type: 'string' },
                            screenshot: { type: 'string' },
                            mismatchRatio: { type: 'number' },
                          },
                        },
                      },
                    },
                    component: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['html', 'css'],
                      properties: {
                        html: { type: 'string' },
                        css: { type: 'string' },
                        screenshot: { type: 'string' },
                        mismatchRatio: { type: 'number' },
                        error: { type: 'string' },
                        componentsJson: { type: 'string' },
                        partials: { type: 'array', items: { type: 'string' } },
                      },
                    },
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

const REPORT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path to the repository root that owns .parity/runs.',
    },
    runDir: {
      type: 'string',
      description: 'Run directory to summarize. Default: the newest run under <repo>/.parity/runs.',
    },
    cases: {
      type: 'array',
      description: 'Only these case ids.',
      items: { type: 'string' },
    },
  },
}

const REPORT_VIEWPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'geometryFailures', 'styleDiffs', 'styleWarnings', 'regions'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    pixels: { type: 'number' },
    meanDelta: { type: 'number' },
    geometry: { type: 'boolean' },
    geometryFailures: { type: 'integer' },
    styleDiffs: { type: 'integer' },
    styleWarnings: { type: 'integer' },
    regions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'w', 'h'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
      },
    },
    error: { type: 'string' },
  },
}

const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'summary', 'cases'],
  properties: {
    runDir: { type: 'string' },
    runId: { type: 'string' },
    config: { type: 'string' },
    repo: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string' },
        commit: { type: 'string' },
      },
    },
    baseline: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string' },
        source: { type: 'string' },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['cases', 'viewports', 'verified', 'image-verified', 'failed', 'incomplete'],
      properties: {
        cases: { type: 'integer' },
        viewports: { type: 'integer' },
        verified: { type: 'integer' },
        'image-verified': { type: 'integer' },
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
          viewports: { type: 'array', items: REPORT_VIEWPORT_SCHEMA },
        },
      },
    },
  },
}

const DIAGNOSE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path to the repository root that owns .parity/runs.',
    },
    runDir: {
      type: 'string',
      description: 'Run directory to diagnose. Default: the newest run under <repo>/.parity/runs.',
    },
    cases: { type: 'array', items: { type: 'string' }, description: 'Only these case ids.' },
    viewports: { type: 'array', items: { type: 'string' }, description: 'Only these viewport ids.' },
  },
}

const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'w', 'h'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layer', 'severity', 'summary', 'suggestion'],
  properties: {
    layer: { type: 'string' },
    severity: { type: 'number' },
    summary: { type: 'string' },
    suggestion: { type: 'string' },
    anchor: { type: 'string' },
    property: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    delta: BOX_SCHEMA,
    region: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'w', 'h', 'mismatchRatio'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        mismatchRatio: { type: 'number' },
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tag', 'role', 'box', 'coverage'],
        properties: {
          id: { type: 'string' },
          tag: { type: 'string' },
          role: { type: 'string' },
          box: BOX_SCHEMA,
          coverage: { type: 'number' },
        },
      },
    },
  },
}

const DIAGNOSE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'viewports'],
  properties: {
    runDir: { type: 'string' },
    iteration: { type: 'integer' },
    parentRun: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string' },
        runDir: { type: 'string' },
      },
    },
    delta: {
      type: 'object',
      additionalProperties: false,
      required: ['meanChange', 'improved', 'viewports'],
      properties: {
        meanChange: { type: 'number' },
        improved: { type: 'boolean' },
        viewports: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['case', 'viewport', 'pixels', 'previous', 'change', 'improved'],
            properties: {
              case: { type: 'string' },
              viewport: { type: 'string' },
              pixels: { type: 'number' },
              previous: { type: 'number' },
              change: { type: 'number' },
              improved: { type: 'boolean' },
            },
          },
        },
      },
    },
    viewports: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['case', 'viewport', 'status', 'findings', 'next'],
        properties: {
          case: { type: 'string' },
          viewport: { type: 'string' },
          status: { type: 'string' },
          findings: { type: 'array', items: FINDING_SCHEMA },
          next: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const LOGIN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'url'],
  properties: {
    repo: { type: 'string', description: 'Absolute path to the repository root.' },
    url: { type: 'string', description: 'Login page URL to open in a headed browser.' },
    storageState: { type: 'string', description: 'Output path for the storageState JSON (default .parity/state.json).' },
    waitForUrl: { type: 'string', description: 'Substring of the URL that marks login completion; prefix with re: for a regular expression.' },
    waitForSelector: { type: 'string', description: 'Selector that appears after login completes.' },
    timeoutMs: { type: 'number', description: 'How long to wait for the condition (default 300000).' },
    dependencies: { type: 'string', description: 'Directory where Playwright resolves (defaults to repo).' },
    headless: { type: 'boolean', description: 'Run without a window (default false; only for automated tests).' },
  },
}

const LOGIN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'url', 'cookies', 'origins'],
  properties: {
    path: { type: 'string' },
    url: { type: 'string' },
    cookies: { type: 'integer' },
    origins: { type: 'integer' },
  },
}

const ALIGN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Absolute path to the repository root.' },
    runDir: { type: 'string', description: 'Run directory to plan from. Default: the newest run.' },
  },
}

const ALIGN_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'priority', 'case', 'viewport', 'target', 'action', 'verify'],
  properties: {
    kind: { type: 'string' },
    priority: { type: 'integer' },
    case: { type: 'string' },
    viewport: { type: 'string' },
    target: { type: 'string' },
    action: { type: 'string' },
    verify: { type: 'string' },
  },
}

const ALIGN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir', 'iteration', 'autonomy', 'stopWhen', 'steps'],
  properties: {
    runDir: { type: 'string' },
    iteration: { type: 'integer' },
    autonomy: { type: 'string' },
    stopWhen: { type: 'string' },
    steps: { type: 'array', items: ALIGN_STEP_SCHEMA },
  },
}

const TASK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'repo'],
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'step', 'status', 'list', 'report', 'delete'],
      description: 'create: start a task; step: run one measurement iteration; status; list; pause; resume; report.',
    },
    repo: { type: 'string', description: 'Absolute path to the repository root.' },
    taskId: { type: 'string', description: 'Task id (required except for create/list).' },
    config: { type: 'string', description: 'Config path for create (absolute or relative to repo).' },
    cases: { type: 'array', items: { type: 'string' }, description: 'Case ids to include (default: all).' },
    viewports: { type: 'array', items: { type: 'string' }, description: 'Viewport ids to include (default: all).' },
    maxIterations: { type: 'number', description: 'Iteration budget (default 8).' },
    dependencies: { type: 'string', description: 'Directory where Playwright resolves (defaults to repo).' },
  },
}

const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'repo', 'config', 'status', 'iteration', 'maxIterations', 'cases', 'viewports'],
  properties: {
    id: { type: 'string' },
    repo: { type: 'string' },
    config: { type: 'string' },
    status: { type: 'string' },
    iteration: { type: 'integer' },
    maxIterations: { type: 'integer' },
    goal: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxMismatch: { type: 'number' },
        requireGeometry: { type: 'boolean' },
        requireStyles: { type: 'boolean' },
      },
    },
    cases: { type: 'array', items: { type: 'string' } },
    viewports: { type: 'array', items: { type: 'string' } },
    currentRunDir: { type: 'string' },
    reportPath: { type: 'string' },
    blockedReason: { type: 'string' },
    updatedAt: { type: 'string' },
    latest: { type: 'object', additionalProperties: true },
    plan: { type: 'object', additionalProperties: true },
  },
}

const TASK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string' },
    task: TASK_VIEW_SCHEMA,
    tasks: { type: 'array', items: TASK_VIEW_SCHEMA },
    plan: { type: 'object', additionalProperties: true },
    reportPath: { type: 'string' },
    deleted: { type: 'boolean' },
    taskId: { type: 'string' },
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
export function apply(ctx, config) {
  const panelRoots = () => {
    const roots = [lastRunRoot, panelRepoOverride, ...(Array.isArray(config?.repos) ? config.repos : [])]
    return roots.filter(root => typeof root === 'string' && root.length > 0)
  }

  const registerPanelRoutes = (scoped) => {
    const server = scoped?.webServer
    if (server === undefined) return
    const asJson = value => new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    const readJson = async (request) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 65536) throw new Error('request body is too large')
      }
      return body.length === 0 ? {} : JSON.parse(body)
    }
    const respondJson = (response, status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    const inRuns = (directory) => {
      const target = resolve(directory)
      return panelRoots().some(root => target.startsWith(`${join(resolve(root), '.parity', 'runs')}${sep}`))
    }
    scoped.effect(() => {
      const disposers = [
        server.register({
          kind: 'exact',
          path: '/pixel-parity/overview',
          resource: async (request) => {
            const roots = panelRoots()
            const requested = new URL(request.url).searchParams.get('repo')
            if (requested !== null && requested.length > 0) {
              const candidate = resolve(requested)
              if (!existsSync(join(candidate, '.parity', 'runs'))) {
                return new Response(JSON.stringify({ error: `no .parity/runs under ${candidate}` }), {
                  status: 400,
                  headers: { 'content-type': 'application/json; charset=utf-8' },
                })
              }
              roots.unshift(candidate)
              panelRepoOverride = candidate
            }
            return asJson(overview(roots))
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/artifact',
          resource: async (request) => {
            const artifact = resolveArtifact(panelRoots(), new URL(request.url).searchParams.get('path'))
            if (artifact === undefined) return new Response('not found', { status: 404 })
            return new Response(readFileSync(artifact.path), { headers: { 'content-type': artifact.type } })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/diagnose',
          resource: async (request) => {
            const runDir = new URL(request.url).searchParams.get('runDir')
            if (runDir === null || !inRuns(runDir)) return new Response(JSON.stringify({ error: 'runDir must be a run under .parity/runs' }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } })
            try {
              return asJson(diagnoseRun(runDir))
            } catch (error) {
              return new Response(JSON.stringify({ error: String(error?.message ?? error) }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } })
            }
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/job',
          resource: async () => asJson(activeJob ?? null),
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/run',
          handler: async (request, response) => {
            if (activeJob?.status === 'running') {
              respondJson(response, 409, { error: 'a panel run is already in progress' })
              return
            }
            if (lastRunRequest === undefined) {
              respondJson(response, 409, { error: 'run parity_run once so the panel knows the config' })
              return
            }
            const jobId = `panel-${Date.now()}`
            activeJob = { id: jobId, status: 'running', startedAt: new Date().toISOString(), repo: lastRunRequest.repo }
            runConfig({
              configPath: lastRunRequest.config,
              repoRoot: lastRunRequest.repo,
              dependenciesRoot: lastRunRequest.dependencies,
              caseIds: lastRunRequest.cases,
              viewportIds: lastRunRequest.viewports,
              baselineMode: 'ephemeral',
              headless: true,
            }).then((result) => {
              activeJob = {
                id: jobId,
                status: 'done',
                runDir: result.runDir,
                summary: result.manifest.summary,
                finishedAt: new Date().toISOString(),
              }
            }).catch((error) => {
              activeJob = { id: jobId, status: 'error', error: String(error?.message ?? error), finishedAt: new Date().toISOString() }
            })
            respondJson(response, 202, { jobId })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/approve',
          handler: async (request, response) => {
            let body
            try {
              body = await readJson(request)
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
              return
            }
            const runDir = typeof body.runDir === 'string' ? body.runDir : undefined
            if (runDir === undefined || !inRuns(runDir)) {
              respondJson(response, 400, { error: 'runDir must be a run under .parity/runs' })
              return
            }
            try {
              respondJson(response, 200, approveRun({ runDir, note: typeof body.note === 'string' ? body.note : 'approved from panel' }))
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/tasks',
          resource: async (request) => {
            const requested = new URL(request.url).searchParams.get('repo')
            const tasks = listTasks(requested === null || requested.length === 0 ? undefined : resolve(requested))
            return asJson({ tasks: tasks.map(task => taskSummary(task)) })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/task/step',
          handler: async (request, response) => {
            let body
            try {
              body = await readJson(request)
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
              return
            }
            if (taskJob?.status === 'running') {
              respondJson(response, 200, { jobId: taskJob.id, running: true })
              return
            }
            const id = String(body.taskId ?? '')
            const job = { id: `taskjob-${Date.now()}`, taskId: id, status: 'running', startedAt: new Date().toISOString() }
            taskJob = job
            const controller = new AbortController()
            taskJobController = controller
            stepTask({
              id,
              dependenciesRoot: typeof body.dependencies === 'string' ? body.dependencies : undefined,
              signal: controller.signal,
            }).then((result) => {
              taskJobController = null
              taskJob = {
                ...job,
                status: 'done',
                task: taskSummary(result.task),
                ...(result.plan === null || result.plan === undefined ? {} : { plan: result.plan }),
                finishedAt: new Date().toISOString(),
              }
            }).catch((error) => {
              taskJobController = null
              taskJob = { ...job, status: 'error', error: String(error?.message ?? error), finishedAt: new Date().toISOString() }
            })
            respondJson(response, 202, { jobId: job.id })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/task/job',
          resource: async () => asJson(taskJob ?? null),
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/repo/run',
          handler: async (request, response) => {
            let body
            try {
              body = await readJson(request)
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
              return
            }
            if (repoJob?.status === 'running') {
              respondJson(response, 200, { jobId: repoJob.id, running: true })
              return
            }
            const repo = resolve(String(body.repo ?? ''))
            const pending = listTasks(repo).filter(task => task.runs.length === 0)
            const job = {
              id: `repojob-${Date.now()}`,
              repo,
              status: 'running',
              total: pending.length,
              done: 0,
              failed: 0,
              startedAt: new Date().toISOString(),
            }
            repoJob = job
            void (async () => {
              for (const task of pending) {
                if (repoJob?.id !== job.id) return
                try {
                  await stepTask({ id: task.id })
                  job.done += 1
                } catch {
                  job.failed += 1
                }
              }
              repoJob = { ...job, status: 'done', finishedAt: new Date().toISOString() }
            })()
            respondJson(response, 202, { jobId: job.id, total: pending.length })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/repo/job',
          resource: async () => asJson(repoJob ?? null),
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/task/report-file',
          resource: async (request) => {
            const id = new URL(request.url).searchParams.get('taskId') ?? ''
            if (id.length === 0 || /[\\/]/.test(id)) return new Response('bad task', { status: 400 })
            let task
            try {
              task = readTask(id)
            } catch {
              return new Response('task not found', { status: 404 })
            }
            if (typeof task.reportPath !== 'string' || !existsSync(task.reportPath)) {
              return new Response('report not found; generate it first', { status: 404 })
            }
            return new Response(readFileSync(task.reportPath), {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'content-disposition': `inline; filename="${id}-report.html"`,
              },
            })
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/task/report',
          handler: async (request, response) => {
            try {
              const body = await readJson(request)
              const path = reportTask(String(body.taskId ?? ''))
              respondJson(response, 200, { reportPath: path })
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
        server.register({
          kind: 'exact',
          path: '/pixel-parity/task/delete',
          handler: async (request, response) => {
            try {
              const body = await readJson(request)
              const taskId = String(body.taskId ?? '')
              if (taskJob?.status === 'running' && taskJob.taskId === taskId) {
                taskJobController?.abort()
                taskJob = { ...taskJob, status: 'error', error: 'cancelled by delete' }
              }
              const removed = deleteTask(taskId)
              respondJson(response, 200, { deleted: true, taskId: removed.id })
            } catch (error) {
              respondJson(response, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        const timer = setTimeout(() => {
          try {
            recoverInterruptedTasks()
          } catch {}
        }, 5000)
        return () => clearTimeout(timer)
      })
    })
  }

  if (typeof ctx.inject === 'function') {
    // webServer is optional: the plugin still works in hosts without a web server.
    ctx.inject(['webServer'], registerPanelRoutes)
  } else if (typeof ctx.get === 'function') {
    const server = ctx.get('webServer')
    if (server !== undefined) registerPanelRoutes({ webServer: server, effect: callback => ctx.effect(callback) })
  }
  ctx.effect(() => ctx.tools.register({
    name: 'parity_login',
    description: 'Open a headed browser for an interactive login, wait for a URL fragment or selector that marks completion, then save a Playwright storageState file. Reference it from a config target as `storageState` so later parity_run captures the logged-in page.',
    parameters: LOGIN_PARAMETERS,
    output: {
      schema: LOGIN_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{
          type: 'text',
          text: [`Saved ${value.path}`, `URL: ${value.url}`, `Cookies: ${value.cookies}, origins: ${value.origins}`].join('\n'),
        }]
      },
    },
    async execute(args) {
      const repo = text(args.repo, 'repo')
      const raw = args.storageState === undefined ? '.parity/state.json' : text(args.storageState, 'storageState')
      return captureLoginState({
        repoRoot: repo,
        dependenciesRoot: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
        url: text(args.url, 'url'),
        storageState: isAbsolute(raw) ? raw : join(repo, raw),
        waitForUrl: args.waitForUrl === undefined ? undefined : text(args.waitForUrl, 'waitForUrl'),
        waitForSelector: args.waitForSelector === undefined ? undefined : text(args.waitForSelector, 'waitForSelector'),
        timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        headless: args.headless === true,
      })
    },
  }))

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
      lastRunRoot = repo
      const configPath = isAbsolute(args.config) ? args.config : join(repo, args.config)
      const thresholds = {}
      if (args.geometryTolerance !== undefined) thresholds.geometryTolerance = Number(args.geometryTolerance)
      if (args.maxMismatch !== undefined) thresholds.maxMismatch = Number(args.maxMismatch)
      const caseIds = arrayOfText(args.cases, 'cases')
      const viewportIds = arrayOfText(args.viewports, 'viewports')
      lastRunRequest = {
        repo,
        config: configPath,
        cases: caseIds,
        viewports: viewportIds,
        dependencies: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
      }
      const result = await runConfig({
        configPath,
        repoRoot: repo,
        dependenciesRoot: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
        caseIds,
        viewportIds,
        outDir: args.outputDir === undefined ? undefined : text(args.outputDir, 'outputDir'),
        headless: args.headless !== false,
        baselineMode: args.baselineMode === undefined ? 'auto' : text(args.baselineMode, 'baselineMode'),
        exportIr: args.exportIr === true,
        exportQml: args.exportQml === true,
        exportComponent: args.exportComponent === true,
        thresholds: Object.keys(thresholds).length === 0 ? undefined : thresholds,
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
    name: 'parity_report',
    description: 'Summarize a finished parity run without re-capturing: status per case/viewport, pixel ratio, geometry failures, style diffs, and the worst regions. Defaults to the newest run under <repo>/.parity/runs.',
    parameters: REPORT_PARAMETERS,
    output: {
      schema: REPORT_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderReport(value) }]
      },
    },
    async execute(args) {
      const repo = text(args.repo, 'repo')
      const report = buildReport(resolveRunDir(repo, args.runDir === undefined ? undefined : text(args.runDir, 'runDir')))
      const cases = arrayOfText(args.cases, 'cases') ?? []
      if (cases.length > 0) report.cases = report.cases.filter(entry => cases.includes(entry.id))
      return report
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_diagnose',
    description: 'Turn a finished run into ranked fix targets: geometry anchor deltas first, then style diffs, then the largest pixel regions with the IR nodes that overlap them. Use it after every parity_run to decide the next code change, instead of reading metrics.json by hand.',
    parameters: DIAGNOSE_PARAMETERS,
    output: {
      schema: DIAGNOSE_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [`PixelParity diagnose ${value.runDir} (iteration ${value.iteration ?? 1})`]
        if (value.delta !== undefined) {
          lines.push(`delta: mean ${(value.delta.meanChange * 100).toFixed(2)}% pixels (${value.delta.improved ? 'improved' : 'regressed'})`)
        }
        for (const viewport of value.viewports) {
          lines.push(`${viewport.status.padEnd(15)} ${viewport.case} @ ${viewport.viewport}`)
          for (const finding of viewport.findings.slice(0, 5)) lines.push(`  [${finding.layer}] ${finding.summary}`)
          if (viewport.next.length > 0) lines.push(`  next: ${viewport.next[0]}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const repo = text(args.repo, 'repo')
      const runDir = resolveRunDir(repo, args.runDir === undefined ? undefined : text(args.runDir, 'runDir'))
      const diagnosis = diagnoseRun(runDir, {
        cases: arrayOfText(args.cases, 'cases') ?? undefined,
        viewports: arrayOfText(args.viewports, 'viewports') ?? undefined,
      })
      if (diagnosis.parentRun === null) delete diagnosis.parentRun
      if (diagnosis.delta === null) delete diagnosis.delta
      return diagnosis
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_align',
    description: 'AUTOPILOT entry point. After a failed parity_run, call this to get an executable alignment plan (geometry → styles → structure → mock data → pixels). The agent must execute the steps immediately in the target repository, create fixtures/mock data itself when data is missing, and re-run parity_run; do not ask the user for permission, structure work, or mock data. Stop only for missing credentials, unavailable assets, or a product decision.',
    parameters: ALIGN_PARAMETERS,
    output: {
      schema: ALIGN_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [`Alignment plan ${value.runDir} (iteration ${value.iteration})`]
        lines.push(`AUTOPILOT: ${value.autonomy}`)
        for (const [index, step] of value.steps.entries()) {
          lines.push(`${index + 1}. [${step.kind}] ${step.case} @ ${step.viewport} — ${step.target}`)
          lines.push(`   action: ${step.action}`)
          lines.push(`   verify: ${step.verify}`)
        }
        lines.push(`stop: ${value.stopWhen}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const repo = text(args.repo, 'repo')
      const runDir = resolveRunDir(repo, args.runDir === undefined ? undefined : text(args.runDir, 'runDir'))
      const manifest = readManifest(runDir)
      const diagnosis = diagnoseRun(runDir)
      return {
        runDir,
        iteration: diagnosis.iteration ?? 1,
        ...buildAlignmentPlan(diagnosis, manifest),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'parity_task',
    description: 'Persisted alignment task: one objective (cases × viewports + thresholds) that owns the check → align → report loop. Use action=create for a new task, action=step to run one iteration and receive the plan, action=report to write the task report, action=status/list/pause/resume to manage it. Prefer this over ad-hoc parity_run for ongoing optimization.',
    parameters: TASK_PARAMETERS,
    output: {
      schema: TASK_OUTPUT_SCHEMA,
      render(_args, value) {
        if (value.action === 'list') {
          const lines = [`PixelParity tasks (${value.tasks?.length ?? 0})`]
          for (const task of value.tasks ?? []) lines.push(`${task.status.padEnd(12)} ${task.id}  iter ${task.iteration}/${task.maxIterations}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const task = value.task
        if (task === undefined) return [{ type: 'text', text: value.reportPath ?? value.action }]
        const lines = [`Task ${task.id} · ${task.status} · iter ${task.iteration}/${task.maxIterations}`]
        if (value.reportPath !== undefined) lines.push(`report: ${value.reportPath}`)
        if (task.currentRunDir !== undefined) lines.push(`run: ${task.currentRunDir}`)
        if (task.blockedReason !== undefined) lines.push(`blocked: ${task.blockedReason}`)
        for (const step of value.plan?.steps ?? task.plan?.steps ?? []) {
          lines.push(`next: [${step.kind}] ${step.target} — ${step.action}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const action = text(args.action, 'action')
      const repo = text(args.repo, 'repo')
      lastRunRoot = repo
      panelRepoOverride = repo
      const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => item === null ? undefined : item))
      if (action === 'create') {
        if (args.config === undefined) throw new Error('parity_task create needs config')
        const task = createTask({
          repo,
          config: text(args.config, 'config'),
          cases: arrayOfText(args.cases, 'cases'),
          viewports: arrayOfText(args.viewports, 'viewports'),
          maxIterations: args.maxIterations === undefined ? undefined : Number(args.maxIterations),
          dependenciesRoot: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
        })
        return { action, task: clean(taskSummary(task)) }
      }
      if (action === 'list') {
        return { action, tasks: listTasks(repo).map(task => clean(taskSummary(task))) }
      }
      const taskId = text(args.taskId, 'taskId')
      if (action === 'status') {
        return { action, task: clean(taskSummary(readTask(taskId))) }
      }
      if (action === 'report') {
        const reportPath = reportTask(taskId)
        return { action, task: clean(taskSummary(readTask(taskId))), reportPath }
      }
      if (action === 'delete') {
        const removed = deleteTask(taskId)
        return { action, deleted: true, taskId: removed.id }
      }
      if (action === 'step') {
        const result = await stepTask({
          id: taskId,
          dependenciesRoot: args.dependencies === undefined ? undefined : text(args.dependencies, 'dependencies'),
        })
        return {
          action,
          task: clean(taskSummary(result.task)),
          ...(result.plan === null || result.plan === undefined ? {} : { plan: clean(result.plan) }),
        }
      }
      throw new Error(`unknown parity_task action: ${action}`)
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
    iteration: manifest.iteration ?? 1,
    ...(manifest.delta === null || manifest.delta === undefined ? {} : { delta: manifest.delta }),
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










