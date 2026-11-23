# Pixel parity

Design-faithful frontend implementation: render, measure, and iterate until the code
matches the reference — instead of judging by eye.

## Install

Not published to npm yet. Add this checkout from **Plugins → Add plugin**, or link it
into a profile:

```
dsh plugin --profile web add /path/to/dsh-pixel-parity
```

Replacing an installed version needs a DSH restart; a newly added bundle activates
through HMR. Publishing is planned; see `docs/RELEASE.md`.

## What it adds

- **`parity_run`** — runs a repo-level config across cases and viewports. Each case
  compares a reference (web URL or design image) with an implementation (web URL) and
  judges three layers:
  - **G geometry**: anchor boxes (x/y/w/h) within 1px, missing anchors fail hard;
  - **S styles**: computed color, typography, spacing, radius, shadow, gap;
  - **P pixels**: masked screenshot diff (dynamic regions excluded).
- **`parity_init`** — scans a repo for the framework, package manager, dev command,
  port, route table, and Playwright, then writes a config draft with the TODOs already
  pointing at the first route.
- **`parity_approve`** — promotes the passing viewports of a run to baselines, keeping
  the anchor snapshot so regression stays geometry-aware.
- **`parity_report`** — summarizes a finished run (newest by default) without re-capturing:
  status per case/viewport, pixel ratio, geometry failures, style diffs, worst regions.
- **`parity_diagnose`** — turns a run into ranked fix targets: geometry deltas first, then
  style diffs, then the largest pixel regions with the IR nodes that overlap them. Use it
  after every run to decide the next code change.
- **Run panel** — a **PP** launcher in the session header opens a right-side drawer with
  recent runs, per-case statuses, deltas, and diff thumbnails, served by `/pixel-parity/*`.
  It refreshes while open, accepts a repo path, and can re-run the last arguments or approve
  the latest baseline. See [docs/PANEL.md](docs/PANEL.md).
- **`parity_login`** — opens a headed browser for an interactive login, waits for a URL
  fragment/regex or selector, then saves a Playwright storageState file for configs.
- **`parity_check`** — single-shot image-vs-page comparison for repos without a config.
- **Dev server start** — `targets.implementation.start` (plus `baseUrl`) launches the app
  when the URL is not already reachable, waits for readiness, and stops it after the run.
- **IR export** (`--export-ir`) — writes a renderer-neutral `ir.json` (tokens, node tree,
  measured text runs) plus `generated.html` rendered back from it. This is the seam for
  other targets (QML, desktop); see [docs/IR.md](docs/IR.md).
- **QML export** (`--export-qml`) — writes `generated.qml` (absolute snapshot) and
  `generated.semantic.qml` (Row/Column + table mapping where provable), renders both with
  Qt's `qmlscene`, and records the pixel difference (5.56% / 5.77% on the prototype).
  See [docs/QML.md](docs/QML.md).
- **Figma input** — a case can use a Figma frame (`kind: "figma"`) as its reference: the
  frame is converted to the same IR, rendered to an image, and compared like any other
  reference. See [docs/FIGMA.md](docs/FIGMA.md).
- **Component export** (`--export-component`) — writes `generated.component.html` +
  `.css`: readable classes, token variables, restored `::before`/`::after`, relative
  assets, and pruned defaults. Repeated subtrees are clustered into
  `components/*.html` partials with `{{text}}` slots plus `generated.components.json`
  (prototype: 16-row table, 11 nav links, 6 info blocks, 4 nav buttons). Renders at 0.43%
  pixels with 100 classes for 337 nodes and ~59 KB of CSS (pruned and shorthand-merged
  from 159 KB). See [docs/COMPONENT.md](docs/COMPONENT.md).
- **`pixel-parity` skill** — the workflow: config → anchors → run → fix by layer → re-run.

Statuses are explicit: `verified` (G/S/P pass), `image-verified` (pixels only, no DOM
evidence), `failed`, `incomplete` (capture error).

## The alignment loop

This is **not** a design-to-code generator. The model edits the real implementation; the
plugin supplies a measurable loop:

```
parity_run → parity_diagnose → edit code → parity_run → compare delta
```

Every manifest records `iteration`, `parentRun`, and `delta` (pixel change vs the previous
run), so "did this change help?" is measured rather than claimed. `parity_diagnose` ranks
the next fix: geometry deltas first, then style diffs, then the largest pixel regions with
the IR nodes that overlap them. See [docs/WORKFLOW.md](docs/WORKFLOW.md).

### Autopilot

`parity_align` is the autopilot entry point: it turns a failed run into an executable plan
(geometry → styles → structure → mock data → pixels) and instructs the agent to execute it
immediately in the target repository — including creating fixtures or local mock data when
the data area is empty. The loop stops only for missing credentials, unavailable assets, or
a genuine product decision. The skill carries the same protocol, so the user does not have
to ask for structure work or mock data.

### Tasks

For work that spans more than one iteration, use `parity_task`:

```
parity_task({ action: "create", repo, config: "parity.config.mjs", cases: ["projects"] })
parity_task({ action: "step", repo, taskId })      // one measurement + plan
parity_task({ action: "report", repo, taskId })    // task report (iteration history + images)
parity_task({ action: "status" | "list" | "delete", repo, taskId })
```

A task persists under the plugin installation directory at
`<plugin>/data/tasks/<taskId>/task.json` (reports and assets live beside it), records
`repo`, `config`, `cases`, `viewports`, `goal`, `dependenciesRoot`, and every iteration
(`runDir`, pixels, delta, plan) and its single alignment measurement. It ends as
`converged` (passes) or `failed` (differences remain), with the plan kept for the report.
The PP panel lists tasks from that store without a repository path, with Report /
Download / Delete actions. Report unlocks after that one run; there is no iteration
budget and no automatic resume. A `<task>/checkpoint.json` is still written for crash
recovery and inspection.

IR / QML / component exports are optional inspection and portability seams for reviewing
what was captured; they are not the alignment mechanism.

## Repo alignment

Create `parity.config.mjs` in the repo (or let `parity_init` draft it):

```
parity_init({ repo: "/abs/path/to/repo" })
```

It detects the workspace app, dev command and port, routes, and Playwright availability,
and writes a draft whose single case points at the first detected route with a
`REPLACE_WITH_REFERENCE_URL` placeholder. It never overwrites an existing config without
`force`.

Then fill in the reference and anchors:

```js
export default {
  version: 2,
  viewports: [{ id: 'desktop', width: 1440, height: 900, dpr: 1 }],
  targets: {
    reference: { baseUrl: 'https://example.dev/proto/' },
    implementation: { baseUrl: 'http://127.0.0.1:5173' },
  },
  cases: [{
    id: 'settings',
    reference: { url: 'settings.html' },
    implementation: {
      path: '/settings',
      fixtures: './parity/fixtures.mjs',   // optional: Playwright route interception
    },
    anchors: {
      header: { ref: 'header.app', impl: '[data-parity="header"]' },
      form: { ref: 'form.settings', impl: '[data-parity="settings-form"]' },
    },
    masks: [{ ref: 'tbody', impl: 'tbody' }],
  }],
}
```

`fixtures` points at a module that default-exports `(page, context) => Promise<void>`;
use it to answer API requests with fixed data so a data-driven page renders
deterministically. It requires Playwright (the Chrome CLI fallback cannot intercept
requests).

Need a post-login page, an open modal, or a filtered table? Give a target ordered
interaction steps and, if needed, a saved browser state:

```js
implementation: {
  url: "http://localhost:5173/records",
  storageState: "./.parity/state.json",   // Playwright storageState
  steps: [
    { action: "click", selector: "[data-testid=filter]" },
    { action: "fill", selector: "input[name=q]", value: "AOI-01" },
    { action: "waitFor", selector: ".row" },
  ],
},
```

Supported actions: `click`, `fill`, `press`, `hover`, `scroll` (`x`/`y`), `wait`
(`ms`), `waitFor` (`selector`, optional `state`). Steps run in order before capture;
`storageState` loads cookies/localStorage for that target. Both require Playwright;
the Chrome CLI fallback fails with an explicit message instead of capturing a
different state.

Capture the logged-in state once, then reference the file:

```
parity_login({
  repo: "/abs/path/to/repo",
  url: "http://localhost:5173/login",
  waitForUrl: "/dashboard",          // or waitForSelector: "[data-testid=home]"
})
→ <repo>/.parity/state.json
```

`parity_login` opens a real window (headless only for automated tests), waits for the
condition, and writes Playwright's `storageState`. CLI equivalent:

```
node <plugin>/cli.mjs login --repo . --url http://localhost:5173/login --wait-url /dashboard
```

Add `settle` when the page keeps changing after load:

```js
implementation: {
  settle: { networkIdle: true, selector: ".row", timeoutMs: 15000 },
},
```

Defaults wait for `document.fonts.ready`, decode pending images, then wait 120 ms.
`networkIdle` and `selector` are opt-in. Cross-origin `@font-face` rules are read
through CDP, so fonts from third-party stylesheets are materialized too.

Anchors inside an iframe use `frame >>> selector` (or `{ selector, frame }`):

```js
anchors: {
  inner: { ref: "iframe#app >>> .row", impl: { selector: ".row", frame: "iframe#app" } },
},
```

The measured rect is translated into page coordinates, and styles are computed inside
the frame. Screenshots already include iframe pixels; this adds DOM evidence for the
same region, and IR export captures one iframe level (absolute rendering places it
correctly; semantic output approximates the flow).

Then:

```
parity_run({ repo: "/abs/path/to/repo", config: "parity.config.mjs" })
```

Artifacts land in `<repo>/.parity/runs/<runId>/`: `manifest.json`, and per
case/viewport `reference.png`, `implementation.png`, `diff.png`, `metrics.json`.
Add `.parity/` to the repo's `.gitignore`: runs and baselines are local evidence,
not source.

The same run works without DSH:

```
node <plugin>/cli.mjs run --config parity.config.mjs --repo .
node <plugin>/cli.mjs approve --repo . --note "initial baseline"
```

Exit code 0 means every case passed; 1 means a failure or incomplete case.

## Baselines and the baseline decision

A case backed by an online reference has no baseline on its first run. With
`baselineMode` omitted (`auto`), `parity_run` asks once for the whole run:

| Choice | Mode | Effect |
| --- | --- | --- |
| 对齐在线原型并固化基线 | `pin` | compare against the live reference; a passing run saves the baseline |
| 仅本次比对，不保存基线 | `ephemeral` | compare once, save nothing |
| 与已有基线回归 | `baseline` | skip the live reference, compare against the saved baseline |

When every case already has a baseline, `auto` uses `baseline` without asking. Set
`baselineMode` explicitly to skip the question; CI should pin the mode rather than rely
on a prompt. Only a passing run writes a baseline.

A baseline stores the implementation screenshot plus the anchor snapshot (boxes and
computed styles), so `baseline` runs still verify geometry and styles offline.

`parity_approve` promotes the passing viewports of a run (default: the newest) to
baselines. Re-approving is the deliberate way to accept a design change; never delete a
baseline just to make a regression pass.

## IR export

`parity_run({ ..., exportIr: true })` or `node cli.mjs run --export-ir` writes `ir.json`,
`generated.html`, and `generated.semantic.html` per case/viewport. The IR is a static
snapshot — design tokens, a node tree with boxes and layout kinds (flex/grid/table/block),
table column widths, SVG geometry, materialized `@font-face`/image files, generated
pseudo-elements, shadow-DOM composition, and measured text runs. On a 362-node real page the
absolute render reproduces the screen at **0.72%** pixel difference; the semantic render
(layout re-run by the browser, with 3 measured pins) keeps 335 of 337 boxes within 1px at
**0.52%** pixels. It is the seam for future generators (QML, desktop).
See [docs/IR.md](docs/IR.md).

## Judging rules
| Check | Default | Meaning |
| --- | --- | --- |
| `geometryTolerance` | 1px | per edge of every anchor |
| `maxMismatch` | 1% | mismatched pixels after masking |
| `maxRegionMismatch` | 40% | any single 16×16 grid cell |
| anchors | required for `verified` | missing selector = hard failure |

All three are configurable: in `defaults`, per case in `cases[].thresholds`, or per run via
`parity_run({ ..., geometryTolerance: 4, maxMismatch: 0.02 })` / `--geometry-tolerance 4
--max-mismatch 0.02`. A `defaults.preset` of `strict` (1%, 1px), `balanced` (2%, 2px), or
`tolerant` (5%, 4px) sets all three at once; explicit numbers override the preset. Raise
`geometryTolerance` when small layout shifts are acceptable; the pixel ratio and style
diffs are still reported, so the tolerance stays visible rather than silent.

Masks exist for genuinely dynamic content (table bodies, charts, timestamps). Do not
mask a region whose layout is being verified.

## Requirements

- **Playwright** in the target repo (preferred; gives geometry and styles) **or** a
  Chromium-based browser (Chrome/Edge; pixels only, status becomes `image-verified`).
- The implementation must be reachable at the configured URL (dev server, static server,
  or `file://`).

## Surfaces

`web` is implemented. `electron` and `desktop` are reserved adapter ids: the interface
exists, but a run over them fails explicitly rather than pretending to verify.

## Layout

- `index.js` — DSH plugin: registers `parity_check`, `parity_run`, and the skill.
- `cli.mjs` — standalone runner CLI.
- `core/config.mjs` — config loading/normalization.
- `core/runner.mjs` — case orchestration, artifacts, manifest.
- `core/compare.mjs` — G/S judgment and masked P comparison.
- `core/baselines.mjs` — baseline storage and run approval.
- `adapters/web.mjs` — Playwright driver with Chrome CLI fallback.
- `lib/` — PNG codec, pixel diff, palette, image loading, browser discovery.
- `skill/pixel-parity.md` — the workflow the agent follows.
- `test/` — v1 engine tests (`run-tests.js`) and v2 core tests (`v2.test.mjs`).

## Tests

```
ELECTRON_RUN_AS_NODE=1 <electron> test/run-tests.js
PARITY_REPO=<repo-with-playwright> ELECTRON_RUN_AS_NODE=1 <electron> test/v2.test.mjs
```




