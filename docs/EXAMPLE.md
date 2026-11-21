# End-to-end example

A typical repository adoption, from an empty config to a regression-protected state.

## 1. Draft the config

```
parity_init({ repo: "/abs/path/to/app" })
```

Output:

```
Created /abs/path/to/app/parity.config.mjs
Framework: vue (yarn)
Dev command: vite --host --port 7620 --strictPort on port 7620
Playwright: available
Routes: /projects, /monitor, /monitor-record
```

The draft contains one case pointing at the first route. It is loadable but not runnable
until the reference is filled in.

## 2. Fill in references and anchors

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
    freeze: { animations: true, caret: true, clock: '2026-08-04T14:33:00+08:00' },
  },
  targets: {
    reference: { baseUrl: 'https://example.dev/prototype/', hide: ['.proto-toolbar'] },
    implementation: { baseUrl: 'http://127.0.0.1:7620' },
  },
  cases: [
    {
      id: 'monitor-record',
      reference: { url: 'records.html?device=AOI-01' },
      implementation: { path: '/monitor-record?device=AOI-01' },
      anchors: {
        breadcrumb: { ref: '.runtime-breadcrumb', impl: '[data-parity="breadcrumb"]' },
        overview: { ref: '.device-overview', impl: '[data-parity="overview"]' },
        filters: { ref: '.record-filters', impl: '[data-parity="filters"]' },
        table: { ref: '.record-table', impl: '[data-parity="table"]' },
      },
      masks: [
        { ref: '.record-table tbody', impl: '[data-parity="table"] tbody' },
      ],
    },
  ],
}
```

The implementation needs `data-parity` attributes on the containers used as `impl`
anchors. Attribute-only change: no styling, no behavior.

## 3. Start the app

```
yarn workspace @app/web dev
```

The runner attaches to a running server; it does not start one for you yet. A `start`
field in `targets.implementation` is reserved for a later phase.

## 4. First run and baseline

```
parity_run({ repo: "/abs/path/to/app", config: "parity.config.mjs" })
```

Because the reference is an online page and no baseline exists, the tool asks once:

```
基准策略：检测到 1 个 case 的参考物是在线页面，且尚无本地基线。这次如何建立基准？
  A 对齐在线原型并固化基线（推荐）
  B 仅本次比对，不保存基线
  C 与已有基线回归
```

Choose A. A passing run writes `.parity/baselines/monitor-record@desktop/` with the
implementation screenshot, anchor snapshot, and mask rectangles.

## 5. Fix by layer

```
FAIL  monitor-record @ desktop  3.42% pixels geometry=fail styles=fail
```

- Geometry failure: read `metrics.json` → `geometry.anchors[].delta`. A 4px offset on
  the filter bar is a layout bug, not a color bug.
- Style failure: `styles.diffs[]` gives `{id, property, expected, actual}` — fix the
  token, not the one-off rule.
- Pixel failure: open `diff.png`; fix the largest region from `pixels.regions`.

Re-run the same command after each fix.

## 6. Approve and regress

After the run passes:

```
parity_approve({ repo: "/abs/path/to/app", note: "initial alignment" })
```

Later changes run with the baseline:

```
parity_run({ repo: "/abs/path/to/app", config: "parity.config.mjs", baselineMode: "baseline" })
```

A regression fails on the layers that changed, offline, without fetching the live
prototype.

## Deterministic data

SPAs fetch data in the browser. Without fixtures the screenshot depends on whatever the
API returned, and masks hide the very region you are trying to align. Point
`implementation.fixtures` at a module that intercepts requests:

```js
// parity/fixtures.mjs
export default async function setup(page) {
  await page.route('**/api/hub/v1/monitoring/events**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'e1', kind: '连接变化', outcome: 'success' }], total: 1 }),
  }))
}
```

```js
implementation: { path: '/monitor-record', fixtures: './parity/fixtures.mjs' },
```

Fixtures require Playwright. Keep the fixture data in the repo next to the config so the
same run works in CI.

## CI

GitLab:

```yaml
parity:
  image: mcr.microsoft.com/playwright:v1.58.2-jammy
  script:
    - yarn install --frozen-lockfile
    - node <plugin>/cli.mjs run --config parity.config.mjs --repo . --baseline-mode baseline --json
  artifacts:
    when: always
    paths:
      - .parity/runs
```

The `baseline-mode baseline` is deliberate: CI must not pin a new baseline from a
build. Pinning is a human action after reviewing a passing run.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `size mismatch` | viewport × dpr ≠ reference pixels | adjust `width`/`height`/`dpr` or export the reference at the render scale |
| `image-verified` instead of `verified` | no anchors matched | add `data-parity` attributes and `anchors` entries |
| everything fails with ~100% pixels | dev server not running / wrong URL | open the URL; the blank-capture guard reports a uniform screenshot |
| huge diff on the table only | data differs | mask `tbody`; compare structure with anchors instead |
| font noise everywhere | reference uses a different font | load the exact font locally, or declare the substitution in the report |
