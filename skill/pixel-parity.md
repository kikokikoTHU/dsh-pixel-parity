# Pixel parity workflow

Make an implementation measurably match a reference. Two modes:

- **Repo alignment** (`parity_run`): a config file maps reference(s) to implementation
  routes/windows across viewports; each case is judged on geometry, styles, and pixels.
- **Quick check** (`parity_check`): one page against one design image, when no repo config
  exists yet.

## Repo alignment

### 1. Write the config

Run `parity_init` first when the repo has no config:

```
parity_init({ repo: "/abs/path/to/repo" })
```

It reports the detected framework, package manager, dev command, port, route table, and
whether Playwright is available, then writes a draft config. Read the warnings: a missing
Playwright means geometry/style evidence will be unavailable. Fill in the reference URL
and add cases for the screens you are aligning.

A config looks like this (`<repo>/parity.config.mjs`; `.json` and `.js` also work):

```js
export default {
  version: 2,
  viewports: [
    { id: 'desktop', width: 1440, height: 900, dpr: 1 },
    { id: 'mobile', width: 390, height: 844, dpr: 3 },
  ],
  defaults: {
    tolerance: 24,
    maxMismatch: 0.01,
    maxRegionMismatch: 0.4,
    geometryTolerance: 1,
  },
  targets: {
    reference: { baseUrl: 'https://example.dev/proto/' },
    implementation: { baseUrl: 'http://127.0.0.1:5173' },
  },
  cases: [
    {
      id: 'settings',
      reference: { url: 'settings.html' },
      implementation: { path: '/settings' },
      anchors: {
        header: { ref: 'header.app', impl: '[data-parity="header"]' },
        form: { ref: 'form.settings', impl: '[data-parity="settings-form"]' },
      },
      masks: [{ ref: 'tbody', impl: 'tbody' }],
    },
  ],
}
```

Rules:

- One case = one reference (URL or image) × one implementation URL. Do not drive
  navigation by clicking; open the target URL directly.
- Anchors are the contract: semantic containers (header, sidebar, filter bar, table,
  pager). Prefer stable `data-parity` attributes on the implementation side over CSS
  classes.
- Masks are only for genuinely dynamic content: table bodies, charts, timestamps,
  animated widgets. Never mask a region whose layout you are trying to verify.
- For data-driven pages, prefer `fixtures` over masks: point `implementation.fixtures`
  at a module that default-exports `(page) => Promise<void>` and answers API requests
  with fixed data (Playwright route interception). Fixed data makes the whole case
  comparable; masks hide the data region but cannot verify it.
- Thresholds may be changed only with a measured reason (text-dense design,
  non-deterministic content), and the reason must be reported.

### Tolerances

Two independent knobs, both percentage/pixel based:

| Knob | Meaning | Default |
| --- | --- | --- |
| `maxMismatch` | share of mismatched pixels allowed, `0`–`1` | `0.01` (1%) |
| `maxRegionMismatch` | share allowed inside one 16×16 grid cell | `0.4` (40%) |
| `geometryTolerance` | anchor edge delta allowed, in CSS pixels | `1` |

Set them in `defaults`, per case in `cases[].thresholds`, or per run as
`parity_run({ ..., geometryTolerance: 4, maxMismatch: 0.02 })` (the CLI equivalents are
`--geometry-tolerance` and `--max-mismatch`).

For a one-line policy, set `defaults.preset`:

| Preset | maxMismatch | maxRegionMismatch | geometryTolerance |
| --- | --- | --- | --- |
| `strict` (default) | 1% | 40% | 1px |
| `balanced` | 2% | 50% | 2px |
| `tolerant` | 5% | 60% | 4px |

Explicit numeric values in `defaults` or `cases[].thresholds` override the preset.

When the product only needs "close enough", raise `geometryTolerance` first: it accepts
small layout shifts without hiding real color/typography errors, because styles are still
compared exactly and the pixel ratio is still reported. Do not raise `maxMismatch` past a
few percent to paper over a layout bug — check `pixels.regions` first.

### 2. Add anchors to the implementation

Add `data-parity="<name>"` to the containers already referenced by `cases[].anchors`.
This is an attribute-only change: no styling, no behavior. If the repo cannot be
touched, map to existing stable selectors instead and accept the churn risk.

### Interaction steps and iframes

A screen behind a login, modal, or filter needs preparation, not a different config
shape: put ordered `steps` and an optional Playwright `storageState` on the target.

```js
implementation: {
  url: "http://localhost:5173/records",
  storageState: "./.parity/state.json",
  steps: [
    { action: "click", selector: "[data-testid=filter]" },
    { action: "fill", selector: "input[name=q]", value: "AOI-01" },
    { action: "waitFor", selector: ".row" },
  ],
},
```

Actions: `click`, `fill`, `press`, `hover`, `scroll`, `wait`, `waitFor`. Steps run
before capture and before `hide`/`waitFor`. They need Playwright; the Chrome CLI
fallback fails loudly rather than capturing the wrong state.

Anchors inside an iframe use `frame >>> selector`:

```js
anchors: { inner: { ref: "iframe#app >>> .row", impl: { selector: ".row", frame: "iframe#app" } } }
```

Rects are translated to page coordinates; styles come from the frame. Screenshots
already include iframe pixels, so this only adds DOM evidence.

For a logged-in page, capture the state once:

```
parity_login({ repo: "/abs/path", url: "http://localhost:5173/login", waitForUrl: "/dashboard" })
```

It opens a real window; finish the login there. The saved
`<repo>/.parity/state.json` goes into `implementation.storageState`.

If the page settles late, add `settle`:

```js
settle: { networkIdle: true, selector: ".row", timeoutMs: 15000 }
```

Defaults: fonts ready, image decode, 120 ms delay. Cross-origin `@font-face` rules
are read through CDP.

### 3. Run

```
parity_run({ repo: "/abs/path/to/repo", config: "parity.config.mjs" })
```

Use `cases` / `viewports` to narrow a run. The run writes
`<repo>/.parity/runs/<runId>/` with `manifest.json`, and per case/viewport
`reference.png`, `implementation.png`, `diff.png`, `metrics.json`.

Add `exportIr: true` when the captured screen should feed another target (a QML or desktop
generator, a static mock, a design diff). That writes `ir.json` — design tokens, a node
tree with boxes, and measured text runs — plus `generated.html` rendered back from it. The
run fails if the IR is invalid, so a broken export never looks like a passing run.

Use `exportComponent: true` when the user wants code rather than a proof: it writes
`generated.component.html` + `generated.component.css` with deduplicated classes, token
variables, and restored pseudo-elements, plus `generated.components.json` and
`components/*.html` partials (`{{text}}` slots) for repeated subtrees, and records
`component.mismatchRatio`. The output is a starting point, not a finished component
library — say so when reporting it.

Statuses:

- `verified` — geometry, styles, and pixels pass.
- `image-verified` — pixels pass, but no anchors were available (image reference or no
  DOM surface). This is weaker evidence; say so.
- `failed` — at least one layer failed.
- `incomplete` — capture failed (missing selector, wrong viewport, server down).

### 4. Baselines

The first run against an online reference has no baseline yet. With `baselineMode`
omitted (default `auto`), the tool asks once for the whole run:

- **对齐在线原型并固化基线** (`pin`) — compare against the live reference; if the run
  passes, save the implementation screenshot and anchor snapshot as the baseline.
- **仅本次比对，不保存基线** (`ephemeral`) — compare once, save nothing.
- **与已有基线回归** (`baseline`) — skip the live reference and compare against the
  saved baseline (works offline; cases without a baseline become `incomplete`).

When every case already has a baseline, `auto` uses `baseline` without asking. Set
`baselineMode` explicitly to skip the question. Only a passing run writes a baseline:
never pin a failing implementation.

Baselines live in `<repo>/.parity/baselines/<case>@<viewport>/` (`implementation.png` +
`baseline.json` with the anchor snapshot). Regression therefore keeps geometry and style
evidence, not just a picture.

To approve a run explicitly (for example after reviewing a passing `pin` run):

```
parity_approve({ repo: "/abs/path/to/repo", runDir: "…/.parity/runs/<id>", note: "why" })
```

`parity_approve` defaults to the newest run and only promotes `verified` /
`image-verified` viewports. Re-approving is the deliberate way to accept a design change;
do not delete a baseline to make a regression pass.

To summarize a run without capturing anything again:

```
parity_report({ repo: "/abs/path/to/repo" })
```

It defaults to the newest run and prints status per case/viewport, pixel ratio, geometry
failures (with counts), style diff/warning counts, and the worst regions. Use it after a
long run, or in CI logs, instead of re-reading the manifest by hand.

If the config sets `targets.implementation.start`, the runner launches that command when
`baseUrl` is not already reachable, waits up to `startTimeoutMs`, and stops it after the
run. An already running server is reused and left alone.

A panel is available from the **PP** button in the session header: it lists recent runs,
statuses, deltas, and diff thumbnails, and can re-run the last arguments or approve the
latest run. Prefer the panel for quick checks; use `parity_run` / `parity_approve` when you
need different arguments or a recorded note.

### 5. Iterate: diagnose → edit → re-run

This plugin is an LLM-native alignment harness, not a generator. The loop is the product:

1. `parity_diagnose({ repo, runDir })` — ranked findings: geometry anchor deltas, then
   style diffs, then the largest pixel regions with overlapping IR nodes.
2. Pick **one** finding. Geometry first: a layout offset shifts everything else and makes
   pixel noise. Then styles (fix the token, not the one-off rule). Pixels last.
3. Change the implementation code. One hypothesis per round.
4. Re-run the same command. Read `iteration`, `parentRun`, and `delta` from the result
   (`delta.meanChange < 0` = improved). Keep the change only if the failing layer improved
   and nothing else regressed; otherwise revert before the next hypothesis.
5. Log one line per round: hypothesis → change → delta → kept/reverted.

Stop when every case is `verified` (or `image-verified` where DOM evidence genuinely does
not exist), or when the remaining gaps are covered by an explicitly chosen tolerance
preset and named in the report. Two rounds without improvement means the hypothesis is
wrong — do not answer that by loosening a threshold. Cap at 8 iterations.

Never treat IR/QML/component export as the alignment step: those exports describe what was
captured. Alignment is measured by `parity_run` + `parity_diagnose` against the real
implementation.

### Task-first execution

For any alignment that will need more than one round, create a task and drive it:

```
parity_task({ action: "create", repo, config: "parity.config.mjs", cases, viewports })
parity_task({ action: "step", repo, taskId })   // runs, updates status, returns the plan
parity_task({ action: "report", repo, taskId }) // writes the task report
```

A task records its metadata, iterations, and plan under the plugin data directory (`<plugin>/data/tasks/<id>/`), so the PP panel can list it without scanning a repository. Use
`action: "status" | "list" | "pause" | "resume"` to manage it. Prefer this over ad-hoc
`parity_run` when optimizing a page across rounds.

### Autopilot: act without asking

A failed `parity_run` is not a question for the user. Run the loop yourself:

1. `parity_align({ repo, runDir })` — returns an ordered, executable plan
   (geometry → styles → structure → mock data → pixels) and an autonomy note.
2. Execute the steps immediately in the target repository. For a structure step,
   compare the reference and implementation section by section and implement the
   missing or misplaced blocks. For a mock step, create fixtures or local mock data
   yourself (a `fixtures` module can serve API responses; component-level mock data
   is fine for a layout check).
3. Re-run `parity_run` with the same arguments; read `iteration` and `delta`.
4. Repeat until verified or the remaining differences are covered by a named
   tolerance. Cap at 8 iterations.

Do not ask the user to approve edits, choose selectors, or provide mock data. Stop
and ask only when: credentials/login are required, an asset (font/icon/image) is
unavailable, or the reference leaves a genuine product decision open.

### 6. Report

- Config path, cases, viewports, and driver (Playwright or Chrome CLI).
- Final statuses and mismatch ratios, run directory, residual differences with cause.
- Iterations used, the delta chain, and the tolerance preset if one was applied.

## Quick check

When there is no config yet, compare one page with a design image:

```
parity_check({
  page: "http://localhost:5173/",
  design: "/abs/design.png",
  width: 720, height: 450, dpr: 2,
  outputDir: "<project>/.parity"
})
```

`width x dpr` must equal the design image width. The call fails on a size mismatch
instead of rescaling.

## Determinism

Both sides are captured with the same browser, viewport, DPR, locale, timezone, reduced
motion, frozen animations, and hidden scrollbars. Do not compare screenshots taken by
different tools or at different DPRs. Font substitution still shows up as differences:
load the exact font or state the substitution.

## Surfaces

`web` is implemented (Playwright preferred, Chrome/Edge CLI fallback). `electron` and
`desktop` are reserved: the adapter interface exists, but a run over those surfaces
fails explicitly. Never describe a run as verified on a surface the tool did not
actually capture.



