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
| `<canvas>` snapshot | `Image { source: assets/images/... }` |
| inline SVG subtree | serialized to an `svg` data URI and rendered as `Image` |
| pure rotation (`matrix`) | `rotation` + `transformOrigin: Item.Center` at the pre-transform layout size |
| CSS linear-gradient | `gradient: Gradient` (vertical, or horizontal via `Gradient.Horizontal`) |
| `background-image: url(...)` | full-size `Image` child at `z: -1`, honoring `background-size` |
| `<video poster>` | `Image` with the materialized poster |
| semantic table | `Column` of `Row`s using `layout.columnWidths` (colspan aware) |
| colors | `rgb()/rgba()` normalized to `#RRGGBB` / `#AARRGGBB` |
| pinned / authored sizes | used as-is (no layout engine at the leaves) |

The render is a **static snapshot**: boxes are absolute, so Qt layout managers are not
exercised yet. That is deliberate — it proves the IR carries enough information to render
on another engine before a semantic generator redesigns layout.

## Semantic layout mode

`--export-qml` writes two components and renders both:

- `generated.qml` — absolute snapshot (every node positioned).
- `generated.semantic.qml` — semantic mapping where it is provably safe.

A container becomes `Row` or `Column` only when all of these hold:

- layout kind is `flex` (row/column, no wrap) or `block`;
- at least two children, none absolutely positioned;
- the first child sits at the position implied by `justify-content` (`start`, `center`, or
  `end`) on the main axis;
- the gap between every consecutive pair is equal within 1px.

`justify-content: center` / `flex-end` map to Qt anchors (`anchors.horizontalCenter`,
`anchors.right` + right margin) so the group keeps its alignment instead of falling back to
absolute boxes. `space-between` behaves like start alignment once the distributed gap is
uniform, so it maps too.

Otherwise that node falls back to absolute positioning. Padding is preserved by placing
the `Row`/`Column` inside the node's `Rectangle` at `(paddingLeft, paddingTop)`; the
cross-axis offset of each child is kept so vertical centering survives.

Tables get a dedicated mapping when `layout.columnWidths` is present: rows are emitted in
document order as `Row`s inside a `Column`, each cell width comes from the captured columns
(colspan aware), so the table keeps its structure instead of a stack of absolute boxes.

Measured on the prototype (1440×900, 337 nodes):

| Mode | Pixel difference vs browser |
| --- | --- |
| absolute | 5.56% |
| semantic (Row/Column + table mapping + inline SVG) | 5.77% |

The semantic render is visually identical; the small delta comes from layout rounding.
`justify-content: center/space-between` and wrapping rows still fall back to absolute
positioning per node.

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

- Static snapshot: no interaction, states, or responsive behavior.
- Flex/block containers with sequential children map to `Row`/`Column` (start, center,
  end, and space-between alignment); `space-around`/`space-evenly` and wrapping rows still
  fall back to absolute positioning.
- Tables map to `Column`/`Row` with captured column widths. A `TableView` mapping was
  prototyped, but Qt 5.14's `TableView` did not render through the `qmlscene` screenshot
  path, so the verified Column/Row mapping is kept.
- Inline SVG is baked into a data-URI `Image`; interactions inside the SVG are lost.
- `<img>` sources are local assets; CSS `background-image` is painted as an `Image` child,
  and `linear-gradient` becomes a `Gradient` (diagonal gradients fall back to a solid color).
- Only pure-rotation transforms are replayed; skews and 3D transforms keep the bounding box.
- WOFF2 `@font-face` loading depends on the Qt build's FreeType support; otherwise the font
  falls back and text metrics shift.
- Text runs are single-line; wrapped text is approximated.

## Next

1. Map `layout.kind` to `Row`/`Column`/`ColumnLayout` and tables to `TableView`.
2. Render inline SVG via a data-URI `Image`.
3. A semantic QML component generator (reusable delegates, theme tokens).
