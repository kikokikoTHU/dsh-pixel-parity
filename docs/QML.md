# QML generation (step 2)

`parity_run --export-qml` writes `generated.qml` and renders it through Qt's `qmlscene`,
so the same IR produces a desktop snapshot outside the browser.

## What is generated

```qml
Rectangle {
  width: 1440; height: 900; color: "#ffffff"
  FontLoader { id: irFont0; source: "assets/fonts/6089….woff2" }
  Rectangle { x: 0; y: 0; width: 232; height: 900; color: "#1e2c42" … }
  Text { x: 20; y: 19; text: "AOI SPC"; font.pixelSize: 16; font.family: "Inter"; color: "#ffffff" }
}
```

Mapping:

| IR | QML |
| --- | --- |
| node box | `Rectangle` with `x/y/width/height` (parent-relative) |
| background / border / radius | `Rectangle.color`, `border.width/color`, `radius` |
| text run | `Text` positioned at the run box, `font.pixelSize/weight/family/letterSpacing` |
| `@font-face` assets | `FontLoader` rows |
| `img` attributes | `Image { source; fillMode: Stretch }` |
| colors | `rgb()/rgba()` normalized to `#RRGGBB` / `#AARRGGBB` |
| pinned / authored sizes | used as-is (no layout engine in v1) |

The render is a **static snapshot**: boxes are absolute, so Qt layout managers are not
exercised yet. That is deliberate — it proves the IR carries enough information to render
on another engine before a semantic generator redesigns layout.

## Render check

`adapters/qml.mjs` locates `qmlscene` (known Qt paths, `PATH`, or `PIXEL_PARITY_QMLSCENE`),
writes a small harness that loads the component and calls
`grabToImage(...).saveToFile(...)`, then compares the capture with the browser screenshot.

- Windows note: `qmlscene` is a GUI-subsystem executable. It must not be spawned with a
  stderr pipe or `windowsHide` — both prevent the window from rendering. Completion is
  observed through the screenshot file appearing with a stable size.
- The check is skipped with `qml.error` when `qmlscene` is not available.

## Measured

Prototype page (1440×900, 337 nodes):

| Metric | Result |
| --- | --- |
| QML screenshot | produced |
| Pixel difference vs browser screenshot | **5.56%** |
| Extra run time | ≈ 1–2 s |

The difference is dominated by text shaping/anti-aliasing (Qt vs Chromium) and by SVG
icons, which are not rendered in QML yet.

## Limits

- Static absolute snapshot; no interaction, states, or responsive behavior.
- Flex/table layout kinds are not mapped to `Row`/`Column`/`TableView` yet.
- Inline SVG (`circle`, `path`) renders empty; `img` URLs work.
- WOFF2 `@font-face` loading depends on the Qt build's FreeType support; otherwise the font
  falls back and text metrics shift.
- Text runs are single-line; wrapped text is approximated.

## Next

1. Map `layout.kind` to `Row`/`Column`/`ColumnLayout` and tables to `TableView`.
2. Render inline SVG via a data-URI `Image`.
3. A semantic QML component generator (reusable delegates, theme tokens).
