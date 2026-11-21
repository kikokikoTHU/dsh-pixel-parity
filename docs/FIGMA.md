# Figma input

A case can use a Figma frame as its reference instead of a URL or an image.

```js
export default {
  version: 2,
  viewports: [{ id: 'desktop', width: 1440, height: 900 }],
  targets: {
    implementation: { baseUrl: 'http://127.0.0.1:7620' },
  },
  cases: [{
    id: 'settings',
    reference: {
      kind: 'figma',
      fileKey: 'AbC123…',
      nodeId: '0:1',
      // tokenEnv: 'FIGMA_TOKEN'   default; read from the process environment
    },
    implementation: { path: '/settings' },
  }],
}
```

The token needs `file_content:read`. Set it in the environment that launches DSH:

```powershell
$env:FIGMA_TOKEN = 'figd_…'
```

## Pipeline

```
Figma REST (/v1/files/:key/nodes?ids=:node)
        │
        ▼
figmaToIr(): frames, auto-layout, fills, strokes, padding, corner radius, text
        │
        ▼
reference.ir.json  →  reference.semantic.html  →  headless screenshot = reference image
        │
        ▼
pixel comparison with the implementation (status `image-verified`)
```

- `figmaToIr` reuses the same IR builder as the web capture, so tokens, typography and
  layout kinds come out identical.
- The frame size must equal the configured viewport; a mismatch fails with an explicit
  message instead of cropping.
- The rendered reference is an **image**, so geometry/style layers have no DOM anchors on
  the reference side yet; the status is `image-verified`.

## Mapping

| Figma | IR |
| --- | --- |
| FRAME / GROUP / COMPONENT / INSTANCE | `div` |
| `layoutMode: HORIZONTAL/VERTICAL` | `display: flex` with `flexDirection`, `gap`, `justifyContent`, `alignItems` |
| `padding*` | `paddingTop/Right/Bottom/Left` |
| `fills[0]` SOLID | `backgroundColor` |
| `strokes[0]` + `strokeWeight` | `borderTopWidth` / `borderTopColor` |
| `cornerRadius` | `borderRadius` |
| TEXT `characters` + `style` | `textRuns` + typography token |
| VECTOR / BOOLEAN_OPERATION / image fills | plain box (geometry only, no paint) |

## Offline / tests

`reference.document` accepts an inline Figma document (the `document` field of a node
payload). Tests use this to avoid the network; the runner then skips the API call.

## Limits

- Vector artwork and image fills are not rendered; they become empty boxes.
- Component instances are flattened into their current appearance.
- One frame per case; variants and prototype interactions are not modelled.
- Text is captured as one run per node, not per styled span.
- The Figma API is fetched at run time, so CI needs the token and network access.

## Next

1. Fetch image fills via `/v1/images` and store them as assets.
2. Render vectors by exporting the node as SVG (`/v1/images?format=svg`).
3. Map Figma component props/variants to IR component instances.
