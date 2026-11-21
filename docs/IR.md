# IR v1 — renderer-neutral screen description

`parity_run --export-ir` captures the implementation DOM and writes, per case/viewport:

```
.parity/runs/<runId>/cases/<case>/<viewport>/
  ir.json                   # IR v1 document (with size pins)
  generated.html            # absolute-layout render (fidelity proof)
  generated.flow.html       # flow-only render before pins (debug)
  generated.semantic.html   # layout-preserving clone (portability proof)
  assets/fonts/*.woff2      # materialized @font-face files
  assets/images/*           # materialized img / background-image files
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
- `<img src>` and CSS `background-image` URLs are downloaded into `assets/images/` and
  rewritten to relative paths (remote, `data:`, and multi-layer `url()` values). The
  generated page and QML then load the local copies instead of the network.
- `background-size` / `-position` / `-repeat` are captured alongside the image so the
  painted area survives the round-trip.
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

## Generated content

- Quoted `::before` / `::after` content becomes a generated child (first / last) with the
  pseudo's computed style; an explicit `width`/`height` is kept, text-only pseudo boxes are
  sized by flow.
- Pseudo nodes carry `pseudo: "::before" | "::after"`, are never pinned, and are excluded
  from box-accuracy statistics because their geometry is synthesized.
- An empty pseudo inside a flex/grid container is kept as a zero-width item: it still
  consumes a gap, which shifts every following sibling by one spacing unit.
- `content: url(...)`, counters, and pseudo animations are skipped.
- Form controls keep their attributes, and `<select>` keeps its options, so intrinsic widths
  survive.
- `<canvas>` pixels are captured with `toDataURL('image/png')`, materialized into
  `assets/images/`, and rendered as an `<img>` / QML `Image`. Tainted canvases keep the box
  only.

## Geometry edge cases

- A **zero-size child of a flex/grid container** is captured even though it paints nothing:
  it is still a flex item and consumes one gap, which shifts every following sibling.
- **Transforms** are captured as the computed `matrix(...)`; `transformedSize` keeps the
  pre-transform layout size, so the box is the transformed bounding box while the replay
  rotates a 7×7 element into the captured 9.9×9.9 extent (this is how rotated arrows get
  their exact bounding box). The absolute renderer uses the bounding box directly and
  skips the transform.
- **`box-sizing: content-box`** is preserved: pinned sizes are converted to content size
  and the declaration is re-emitted, so borders are not counted twice.
- **Grid item alignment** (`justify-items`, `place-items`, `align-content`) is captured;
  without it, grid-centered icons land at the cell start instead of the center.

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
| Nodes | 362 captured (337 boxes + 25 pseudo-elements) |
| Authored sizes | 201 (px and `%`) |
| Size pins after synthesis | 24 → **3** |
| Pins pruned as redundant | 6 |
| Box within 1px | **330** of 337 |
| Box within 2px | 2 |
| Box off by more than 2px | 5 |
| Pixel difference, semantic render | **0.56%** |
| Pixel difference, absolute render | 0.72% |

The jump came from capturing what flow was silently missing:

- **Pseudo-elements** (`::before`/`::after`) are emitted as generated children with their
  computed size and content; the browser lays them out, so status dots and icon glyphs stop
  being 13px-short. This alone removed 20 of the 24 pins.
- **Percentage authored sizes** (`width: 100%`) are kept as source truth when the parent
  supplies the reference size.
- **`<select>` options** are captured and rendered, so the control keeps its intrinsic
  width; form-control attributes (`input`/`textarea`/`select`) are preserved too.
- The generated page declares `html { height: 100% }`, so `height:100%` chains resolve
  instead of collapsing.

Pruning removes a pin, re-renders, and keeps the removal only when box accuracy does not
regress. It is bounded to 30 renders and tries block-level nodes.

Second sample — anubis `/projects` (a PrimeVue app with an icon font):

| Metric | Result |
| --- | --- |
| Nodes | 106 |
| Final pins | 24 (15 pruned) |
| Box within 1px | 89 |
| Box over 2px | 17 |
| Pixel difference | 0.28% |
| Font materialized | PrimeIcons, 35 KB |

The remaining three pins are the pagination controls (`select`, its label, and the wrapper):
their width comes from the native widget, not from CSS. The five boxes still over 2px are
inline glyph boxes whose width depends on font metrics.

Pin distribution tells you where the IR still lacks layout information:

| Kind | Pinned / total | Why |
| --- | --- | --- |
| flex | 2 / 62 | pagination label and wrapper widths |
| block | 1 / 95 | native `<select>` intrinsic width |
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
- Fonts and images are materialized; external CSS, video, and canvas pixels are not.
- Cross-origin stylesheets that expose no `cssRules` are skipped, so their fonts are not
  materialized.
- Wrapped text is captured as one run per visual line (character bucketing); runs longer
  than 500 characters fall back to a single box.
- Outline, `filter`, `backdrop-filter`, and `mix-blend-mode` are captured (defaults
  pruned); CSS gradients survive as `background-image` strings.
- Inline icon spans and form controls can still drift a few pixels.
- Pseudo-elements with `content: url()`, counters, or animations are not captured.
- `<video>` frames are not captured (only the box); tainted canvases have no pixels.
- 3D transforms and `transform-origin` on non-centered elements are replayed only in CSS,
  not in the QML output.
- Captures above 2000 nodes are truncated (`source.truncated`).

## Next

1. A semantic HTML/CSS component generator (usable code, not just a fidelity proof).
2. Multi-breakpoint IR (responsive rules).
3. Multi-viewport QML / desktop adapters.
4. Figma vectors and image fills.
