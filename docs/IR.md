# IR v1 — renderer-neutral screen description

`parity_run --export-ir` captures the implementation DOM and writes, per case/viewport:

```
.parity/runs/<runId>/cases/<case>/<viewport>/
  ir.json                   # IR v1 document (with size pins)
  generated.html            # absolute-layout render (fidelity proof)
  generated.flow.html       # flow-only render before pins (debug)
  generated.semantic.html   # layout-preserving clone (portability proof)
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
| Size pins after synthesis | 120 (2 iterations) |
| Box within 1px | 225 |
| Box within 2px | 328 |
| Box off by more than 2px | 9 |
| Pixel difference (minimal pins) | 2.04% |
| Pixel difference (all sizes pinned) | 0.61% |

The two pixel numbers are the honest trade-off: pinning every size reproduces the pixels
but makes the IR a coordinate dump; minimal pins keep 328 of 337 boxes within 2px and move
the rest by at most a few pixels. Pins are data, so a generator can choose how much of the
viewport it wants to inherit.

Pin distribution tells you where the IR still lacks layout information:

| Kind | Pinned / total | Why |
| --- | --- | --- |
| flex | 49 / 62 | content-driven flex sizes that the capture cannot re-derive |
| block | 30 / 94 | explicit block sizes |
| inline | 21 / 37 | inline boxes whose width depends on text shaping |
| table | 20 / 139 | table and row boxes only; cells derive from columns/rows |
| grid | 0 / 5 | grid layout reproduces from templates |

The last fix matters: a font stack containing `"Microsoft YaHei"` broke the HTML attribute
and silently changed the font. Any generator must escape quoted font families.

## Limits (v1)

- One screen, static: no interactions, states, hover, or responsive rules.
- Images and `<canvas>` are boxes only; no asset payloads.
- Layout **kinds** are captured (flex/grid/table/block), item props
  (`flexGrow`/`flexShrink`/`flexBasis`) are stored, and tables carry `columnWidths`
  (derived from the first row) plus `colspan`/`rowspan`. Flow layout alone reproduces
  about a third of the page; 120 of 337 nodes carry size pins.
- Table cells derive their size from columns and rows; they are deliberately not pinned.
- SVG geometry (`<circle cx>`, `<path d>`, ...) is not captured yet, so icon nodes render
  empty and count as the few remaining >2px boxes.
- Text runs are captured for one line box; wrapped multi-line text is approximated.
- Captures above 2000 nodes are truncated (`source.truncated`).

## Next

1. Capture SVG geometry attributes (and image `src`/alt) so icons and assets survive.
2. Derive flex item sizes from content/flex-basis to drop more pins.
3. Carry images and fonts as referenced assets.
4. A semantic HTML/CSS generator (usable code, not just a fidelity proof).
5. A QML generator + desktop capture adapter.
6. Figma as another IR source.
