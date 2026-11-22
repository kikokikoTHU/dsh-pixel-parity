# Run panel

The plugin adds a **PP** launcher to the session header and a right-side drawer:

```
… session title            [PP•]  ⚙  ⋯     ← header utilities

                            ┌──────────────────────────────┐
                            │ Pixel parity  1✓ / 1✗ ▶ ✓ ⟳ ×│
                            │ [repo path…]              ↺  │
                            │ iter 2  1✓  −0.43%   Show    │
                            │ iter 1  1✗  geometry +0.43%  │
                            └──────────────────────────────┘
```

The launcher shows a red badge with the failed count of the latest run. Clicking it opens
the drawer; Escape, the close button, or a click outside closes it. The drawer refreshes
every 4 seconds while open, and the badge refreshes every 20 seconds.

## Actions

| Button | Effect |
| --- | --- |
| ◉ (diagnose) | fetches `parity_diagnose` for the latest run and lists its top findings |
| ▶ | re-runs the last `parity_run` arguments with `baselineMode: ephemeral` (never writes a baseline) |
| ✓ | approves the latest run as the baseline, same as `parity_approve` |
| ⟳ | reloads the overview |
| ↺ | clears the repo override and follows the most recent `parity_run` |

The repo field accepts an absolute path; it is persisted in `localStorage` and validated by
the Host (the path must contain `.parity/runs`).

## Where the data comes from

Same-origin endpoints registered on the DSH web server:

| Endpoint | Purpose |
| --- | --- |
| `GET /pixel-parity/overview?repo=…` | recent runs under `<root>/.parity/runs` (max 20 per root) |
| `GET /pixel-parity/artifact?path=…` | a PNG artifact inside a run directory |
| `GET /pixel-parity/diagnose?runDir=…` | `parity_diagnose` value for one run |
| `POST /pixel-parity/run` | start a run with the last `parity_run` arguments |
| `GET /pixel-parity/job` | status of the panel-launched run |
| `POST /pixel-parity/approve` | approve a run (`{ runDir }`) |

Roots scanned: the repository of the most recent `parity_run`, the repo path chosen in the
panel, plus optional `config.repos` from the plugin row:

```yaml
- id: dsh-pixel-parity
  name: dsh-pixel-parity
  config:
    repos:
      - /abs/path/to/frontend
```

Write endpoints only accept run directories under a scanned `<root>/.parity/runs/`, and the
artifact endpoint serves only `.png` files inside a run.

## Client registration

`client.js` registers two slots:

```js
ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
  name: 'conversation.session.header.utilities', id: 'pixel-parity-launcher', order: 40,
}, Launcher))
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'pixel-parity-drawer', order: 40,
}, Drawer))
```

The two components communicate through a module-level store, and both read
`/pixel-parity/overview`. `package.json` declares:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

## Limits

- The drawer overlays the chat column; it does not resize the conversation.
- Only `.parity/runs` is scanned, not arbitrary artifact directories.
- ▶ reuses the last `parity_run` arguments; it cannot edit the config or change cases.
- The panel shows runs only after a `parity_run` in this app session (or a configured
  `repos` entry / repo path), because it targets the repository the model is working on.
- Panel labels use a small English/Chinese dictionary selected from `navigator.language`;
  other languages fall back to English.

## Verification

- Host: `parity_run` then `GET /pixel-parity/overview` returns the run; artifact paths are
  restricted (covered by `test/v2.test.mjs`).
- Client: after a restart, the **PP** launcher appears in the header; the drawer opens on
  click. Visual verification in the running GUI remains a manual step.
