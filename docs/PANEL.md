# Read-only run panel

The plugin registers a small strip above the chat composer:

```
Pixel parity   [2✓ / 1✗]   3 runs            Refresh
```

Clicking it expands the recent runs of the current repository: iteration, status counts,
delta vs the previous run, per case/viewport status, and the `diff.png` thumbnails of each
case. It is **read-only** — it never starts a run, approves a baseline, or edits code.

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

`client.js` registers into `conversation.composer.dock` through
`ctx.slots.inject('conversation.composer.dock', …)`. `package.json` declares:

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
- One strip in the composer dock; it is not a full-page tab.
- Only `.parity/runs` is scanned, not arbitrary artifact directories.
- The panel shows runs only after a `parity_run` in this app session (or a configured
  `repos` entry), because it targets the repository the model is working on.
- Panel labels are English; wiring them through the Client locale service is pending.

## Verification

- Host: `parity_run` then `GET /pixel-parity/overview` returns the run; artifact paths are
  restricted (covered by `test/v2.test.mjs`).
- Client: after a restart, the strip appears above the composer and expands. Visual
  verification in the running GUI remains a manual step.
