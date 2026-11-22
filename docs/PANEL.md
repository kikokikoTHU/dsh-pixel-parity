# Read-only run panel

The plugin adds a **PP** launcher to the session header and a right-side drawer:

```
… session title            [PP•]  ⚙  ⋯     ← header utilities

                            ┌──────────────────────────────┐
                            │ Pixel parity  1✓ / 1✗   ⟳ ×  │
                            │ C:\…\pp-loop-demo            │
                            │ iter 2  1✓  −0.43%   Show    │
                            │ iter 1  1✗  geometry +0.43%  │
                            └──────────────────────────────┘
```

The launcher shows a red badge with the failed count of the latest run. Clicking it opens
the drawer; Escape, the close button, or a click outside closes it. It is **read-only** — it
never starts a run, approves a baseline, or edits code.

## Where the data comes from

Two same-origin endpoints are registered on the DSH web server:

| Endpoint | Purpose |
| --- | --- |
| `GET /pixel-parity/overview` | recent runs under `<root>/.parity/runs` (max 20 per root) |
| `GET /pixel-parity/artifact?path=…` | a PNG artifact inside a run directory |

Roots scanned: the repository of the most recent `parity_run`, plus optional
`config.repos` from the plugin row:

```yaml
- id: dsh-pixel-parity
  name: dsh-pixel-parity
  config:
    repos:
      - /abs/path/to/frontend
```

The artifact endpoint refuses any path outside a `<root>/.parity/runs/` directory and only
serves `.png` files, so the panel cannot read arbitrary files.

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

- Read-only: run/diagnose/approve stay in chat or CLI.
- The drawer overlays the chat column; it does not resize the conversation.
- Only `.parity/runs` is scanned, not arbitrary artifact directories.
- The panel shows runs only after a `parity_run` in this app session (or a configured
  `repos` entry), because it targets the repository the model is working on.
- Panel labels use a small English/Chinese dictionary selected from `navigator.language`;
  other languages fall back to English.

## Verification

- Host: `parity_run` then `GET /pixel-parity/overview` returns the run; artifact paths are
  restricted (covered by `test/v2.test.mjs`).
- Client: after a restart, the **PP** launcher appears in the header; the drawer opens on
  click. Visual verification in the running GUI remains a manual step.
