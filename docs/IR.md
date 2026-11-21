# IR v1 — renderer-neutral screen description

`parity_run --export-ir` captures the implementation DOM and writes, per case/viewport:

```
.parity/runs/<runId>/cases/<case>/<viewport>/
  ir.json          # IR v1 document
  generated.html   # static HTML rendered back from the IR
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

## Fidelity

Measured on a real 345-node prototype page (1440×900):

| Step | Pixel difference vs the original page |
| --- | --- |
| First IR render | 6.94% |
| Measured text runs | 5.73% |
| Typography token fix | 5.42% |
| Escaped `style` attributes | **0.61%** |

The last fix matters: a font stack containing `"Microsoft YaHei"` broke the HTML attribute
and silently changed the font. Any generator must escape quoted font families.

## Limits (v1)

- One screen, static: no interactions, states, hover, or responsive rules.
- Images and `<canvas>` are boxes only; no asset payloads.
- Layout is absolute page coordinates. It reproduces the captured viewport but is not a
  portability model yet (`flex`/constraints come next).
- Text runs are captured for one line box; wrapped multi-line text is approximated.
- Captures above 2000 nodes are truncated (`source.truncated`).

## Next

1. Normalize layout into flex/stack/anchors so the IR is not viewport-bound.
2. Carry images and fonts as referenced assets.
3. A semantic HTML/CSS generator (usable code, not just a fidelity proof).
4. A QML generator + desktop capture adapter.
5. Figma as another IR source.
