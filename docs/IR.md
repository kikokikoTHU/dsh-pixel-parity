# IR v1 — renderer-neutral screen description

`parity_run --export-ir` captures the implementation DOM and writes, per case/viewport:

```
.parity/runs/<runId>/cases/<case>/<viewport>/
  ir.json                   # IR v1 document (with size pins)
  generated.html            # absolute-layout render (fidelity proof)
  generated.flow.html       # flow-only render before pins (debug)
  generated.semantic.html   # layout-preserving clone (portability proof)
  assets/fonts/*.woff2      # materialized @font-face files
```

The goal is to prove the IR keeps enough information to reproduce a screen, before any
other generator (QML, WPF, ...) is written. It is a **static snapshot**, not a UI
framework: layout is literal page coordinates for v1.

## Pipeline

```
DOM (Playwright) → IR (tokens + tree + measured text runs) → HTML (absolute layout)
```

- Capture walks visible elements from `<body>`: tag, box, filtered computed styles, text
  runs, children (max 2000 nodes, depth 14).
- Text is captured as **measured runs** (`Range.getClientRects()`), not as a string on the
  element: this is what makes the render reproduce glyph positions.
- Colors and typography are extracted into token tables; nodes reference tokens.
- The render is deliberately literal; a future generator emits semantic markup.

## Shape

```json
{
  "ir": "1.0",
  "source": {
    "kind": "web",
    "url": "http://127.0.0.1:7620/monitor-record",
    "viewport": { "width": 1440, "height": 900, "dpr": 1 },
    "canvas": { "width": 1440, "height": 900 },
    "capturedAt": "2026-11-21T14:59:37.775Z",
    "truncated": false
  },
  "tokens": {
    "colors": { "color.1": "#FFFFFF", "color.2": "#1E2C42" },
    "typography": {
      "type.1": { "fontFamily": "Inter, sans-serif", "fontSize": "14px", "fontWeight": "400", "lineHeight": "normal", "letterSpacing": "normal" }
    },
    "radius": { "radius.1": "4px" }
  },
  "root": {
    "id": "n1",
    "tag": "body",
    "role": "container",
    "box": { "x": 0, "y": 0, "w": 1440, "h": 900 },
    "style": { "backgroundColor": "color.1", "typography": "type.1" },
    "children": [
      {
        "id": "n2",
        "tag": "td",
        "role": "text",
        "box": { "x": 359, "y": 415, "w": 253.9, "h": 44 },
        "style": { "display": "table-cell", "paddingLeft": "12px", "typography": "type.1" },
        "textRuns": [{ "text": "2026-08-04 14:30:00", "box": { "x": 371, "y": 427.5, "w": 137.9, "h": 19 } }]
      }
    ]
  }
}
```

## Validation

`validateIr()` checks the version, source canvas, unique node ids, numeric boxes, text-run
boxes, and that every `color.*` / `type.*` / `radius.*` reference exists. `parity_run`
fails the case if the produced IR is invalid.

## Layout model

Every node carries a `layout` classification and keeps its captured box:

```json
"layout": { "kind": "flex", "direction": "row", "justify": "flex-start", "align": "center", "gap": "8px" }
```

- `kind`: `flex` | `grid` | `table` | `inline` | `block`.
- Flex containers keep direction/justify/align/wrap/gap; grid keeps template columns/rows.
- Items keep `flexGrow`/`flexShrink`/`flexBasis`/`alignSelf`/`order`.
- `box` remains the measured geometry, used for verification and for the absolute renderer.

The semantic renderer (`core/ir-html.mjs`) rebuilds the element tree with these layout
kinds and computed styles, lets the browser re-run layout, and keeps `data-ir` ids so every
node can be checked back against the IR. A QML generator can map the same `layout.kind`
instead of copying coordinates.

### Size synthesis

The first semantic render emits **no** explicit sizes; `core/runner.mjs` then captures it
and compares node boxes with the original. Any node whose width or height drifts by more
than 1px gets a pin:

```json
"layout": { "kind": "flex", "pins": { "width": true } }
```

Pins are recorded in the IR, so a generator knows exactly which sizes are load-bearing
instead of inheriting a viewport-bound coordinate dump. Synthesis runs at most 3 rounds;
`ir.pins`, `ir.iterations`, and box-accuracy counters are reported in the run result.

## Assets

- `@font-face` rules from same-origin stylesheets are captured into `assets.fonts`
  (`family`, `weight`, `style`, `src`, `format`). The runner downloads remote and
  `data:` fonts into `assets/fonts/`, rewrites the IR to relative paths, and the semantic
  renderer emits the matching `@font-face` rules. Without this, icon fonts (PrimeIcons,
  Font Awesome) fall back to system glyphs and every icon width is wrong.
- `<img src>` (absolute) and `alt` are captured as node attributes; image bytes are not
  downloaded yet.
- Cross-origin stylesheets that block `cssRules` are skipped; serve those fonts
  same-origin or declare them in the target page.

## Authored sizes

Measured pins are a fallback. When the source CSS already says how big a box is, the IR
keeps that declaration instead:

- Same-origin `CSSStyleRule`s are scanned for `width` / `height` / `min-*` / `max-*` /
  `flex-basis`; matching rules are applied in document order, then inline styles.
- Only fixed `px` `width`/`height` values that match the measured box within 1px are kept
  (as `node.authored`); percentages and values that contradict the box are dropped.
- The semantic renderer emits authored values after pins, so design intent wins.

On the 337-node page this moved **70 sizes from measured pins to authored values**: pins
went from 94 to 24 with identical box accuracy.

## Fidelity

Measured on a real 345-node prototype page (1440×900):

| Step | Pixel difference vs the original page |
| --- | --- |
| First IR render | 6.94% |
| Measured text runs | 5.73% |
| Typography token fix | 5.42% |
| Escaped `style` attributes | **0.61%** |

Semantic render (layout re-run by the browser instead of absolute boxes):

| Metric | Result |
| --- | --- |
| Nodes | 337 (col/colgroup nodes are folded into `columnWidths`) |
| Authored sizes | 201 |
| Size pins after synthesis | 94 → **24** after authored sizes |
| Pins pruned as redundant | 4 |
| Box within 1px | 229 |
| Box within 2px | 332 |
| Box off by more than 2px | 5 |
| Pixel difference (minimal pins) | 2.02% |
| Pixel difference (all sizes pinned) | 0.61% |

Pruning removes a pin, re-renders, and keeps the removal only when box accuracy does not
regress. It is bounded to 30 renders and only tries block-level nodes; after authored sizes
replaced most explicit sizes, only 4 pins were pruned.

Second sample — anubis `/projects` (a PrimeVue app with an icon font):

| Metric | Result |
| --- | --- |
| Nodes | 106 |
| Final pins | 24 (15 pruned) |
| Box within 1px | 89 |
| Box over 2px | 17 |
| Pixel difference | 0.28% |
| Font materialized | PrimeIcons, 35 KB |

The two pixel numbers are the honest trade-off: pinning every size reproduces the pixels
but makes the IR a coordinate dump; minimal pins keep 332 of 337 boxes within 2px and move
the rest by at most a few pixels. Pins are data, so a generator can choose how much of the
viewport it wants to inherit. The five outliers are four 10px inline icon spans (rendered
7px wide because the inline box depends on glyph metrics) and one `<input>` shifted 15.6px
by flex distribution.

Pin distribution tells you where the IR still lacks layout information:

| Kind | Pinned / total | Why |
| --- | --- | --- |
| flex | 23 / 62 | content-driven flex sizes that neither CSS nor flow explains |
| block | 1 / 94 | one explicit block size that survived pruning |
| inline | 0 / 37 | inline boxes are reproduced from text runs |
| table | 0 / 139 | columns/rows reproduce the cells |
| grid | 0 / 5 | grid layout reproduces from templates |

The last fix matters: a font stack containing `"Microsoft YaHei"` broke the HTML attribute
and silently changed the font. Any generator must escape quoted font families.

## Limits (v1)

- One screen, static: no interactions, states, hover, or responsive rules.
- Images and `<canvas>` are boxes only; no asset payloads.
- Layout **kinds** are captured (flex/grid/table/block), item props
  (`flexGrow`/`flexShrink`/`flexBasis`) are stored, tables carry `columnWidths` and
  `colspan`/`rowspan`, and SVG geometry (`viewBox`, `cx/cy/r`, `d`, `points`, ...) plus
  `img.src` are kept as `attributes` on the node, and fixed source sizes are kept as
  `authored`. Flow layout alone reproduces about a third of the page; only 24 of 337 nodes
  still carry measured size pins.
- Table cells derive their size from columns and rows; they are deliberately not pinned.
- Fonts are materialized; image bytes are not (only their absolute URLs are captured).
- Cross-origin stylesheets that expose no `cssRules` are skipped, so their fonts are not
  materialized.
- Inline icon spans and form controls can still drift a few pixels; they are the remaining
  outliers.
- Text runs are captured for one line box; wrapped multi-line text is approximated.
- Captures above 2000 nodes are truncated (`source.truncated`).

## Next

1. Materialize image bytes (`img.src`, `background-image`) into `assets/images/`.
2. Derive flex item sizes from content/flex-basis to drop more pins.
3. A semantic HTML/CSS generator (usable code, not just a fidelity proof).
4. A QML generator + desktop capture adapter.
5. Figma as another IR source.
