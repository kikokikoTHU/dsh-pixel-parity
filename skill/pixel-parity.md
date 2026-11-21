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
  defaults: { tolerance: 24, maxMismatch: 0.01, maxRegionMismatch: 0.4 },
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

### 2. Add anchors to the implementation

Add `data-parity="<name>"` to the containers already referenced by `cases[].anchors`.
This is an attribute-only change: no styling, no behavior. If the repo cannot be
touched, map to existing stable selectors instead and accept the churn risk.

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

### 5. Fix by layer, then re-run

1. Read the failing status and `metrics.json`.
2. Geometry first: a layout offset shifts everything else and makes pixel noise.
3. Styles second: colors, font size/weight/line-height, spacing, radius. These come from
   tokens; fix the token, not the one-off rule.
4. Pixels last: open `diff.png`, fix the largest region.
5. Re-run the same command. Keep a one-line log per iteration.

Stop when every case is `verified` (or `image-verified` where DOM evidence genuinely
does not exist). Cap at 8 iterations; beyond that the cause is structural.

### 6. Report

- Config path, cases, viewports, and driver (Playwright or Chrome CLI).
- Final statuses and mismatch ratios, run directory, residual differences with cause.

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
