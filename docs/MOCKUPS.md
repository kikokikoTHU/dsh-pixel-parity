# Placement mockups

Simulated DSH screens for the Pixel Parity panel (1440×900). These are design
references produced as HTML renders, not screenshots of the running app.

| File | Option | Plugin feasibility |
| --- | --- | --- |
| `01-current-composer-dock.png` | Composer dock (current) | shippable today (`conversation.composer.dock`) |
| `02-header-button-right-drawer.png` | Header button + right drawer | shippable with `conversation.session.header.utilities` + `shell.overlay` |
| `03-leading-icon-left-drawer.png` | Leading icon + left drawer | shippable with `shell.leading` + `shell.overlay` |
| `04-top-tab-page.png` | Conversation view tab | needs `ctx.uiConversation.views` (data view, not a page) |
| `05-sidebar-rail-page.png` | Left rail entry | no plugin API; requires core/sidebar changes |

## Reading the mockups

- **01 dock** keeps the panel inside the composer column; it competes with typing
  space when expanded.
- **02 header + right drawer** gives the panel its own surface without covering
  the composer; the launcher carries a failure badge. Recommended.
- **03 leading icon** puts the launcher in the window-chrome seat (top-left);
  a left drawer covers the session list while open.
- **04 view tab** behaves like Trajectory: a full-width page owned by the session;
  it displaces the chat and composer while active.
- **05 left rail** is the most "native" navigation but not reachable from a plugin
  in this DSH version.

The drawer content in the mockups matches the read-only panel shipped in
`client.js`: run cards, iteration, per-case status, pixel delta, diff thumbnail.

Regenerate with `docs/mockups/generate.mjs` (requires Playwright).
