# Component export

`parity_run --export-component` (tool: `exportComponent: true`) turns the IR into
maintainable HTML and CSS instead of an inline-styled fidelity proof.

```
.parity/runs/<runId>/cases/<case>/<viewport>/
  generated.component.html
  generated.component.css
  component.png              # render of the component
```

## What it produces

- **Real markup**: the semantic tree (`header`, `nav`, `table`, `td`, `svg`, …) with text
  as element content, not absolutely positioned spans.
- **Shared classes**: every distinct declaration set becomes one readable class
  (`div-container`, `button-button-2`); 337 nodes on the prototype collapse to 100 rules.
  Parents that differ only in generated content still get separate classes, so their
  `::before`/`::after` rules cannot override each other.
- **Token variables**: a `:root` block with `--color-*`, `--type-*-font-size`,
  `--radius-*`; declarations reference them (`var(--color-3)`).
- **Generated content restored**: pseudo children become `.name::before` / `.name::after`
  rules with their `content`, size and paint.
- **Pruned CSS**: default values (`padding: 0`, zero-width borders, `opacity: 1`,
  flex defaults) are omitted, and a small base reset removes the UA button border that
  would otherwise reappear once `border: 0` is pruned.
- **Assets stay relative**: `assets/images/...`, `assets/fonts/...`, plus `@font-face`
  rules for materialized fonts.
- **Layout preserved**: flex/grid/table properties, padding/borders, and only the sizes the
  IR actually knows (authored or pinned).

Measured on the prototype (1440×900, 337 nodes):

| Metric | Result |
| --- | --- |
| Pixel difference vs the page | **0.44%** |
| Classes / nodes | 100 / 337 |
| CSS size | ~93 KB (pruned from 159 KB) |
| Inline styles | only `<col>` widths inside `<colgroup>` |

The component render is slightly *closer* than the semantic render (0.52%) because
`::before`/`::after` are laid out natively instead of being placed at estimated boxes.

## Limits

- Class names are generated (`c1`, `c2`, …); there is no component extraction, naming, or
  prop model. Repeated cards stay repeated markup.
- The CSS still lists every captured property that is not a default; pruning cut it by
  ~42%, and shorthand merging / unused-property analysis is the next step.
- One file per case/viewport; no breakpoints or responsive rules.
- Absolute/fixed nodes keep their absolute position, since the flow that produced them is
  not recoverable.
- Text uses natural wrapping; per-line runs are only used for measurement.

## Next

1. Prune redundant declarations and deduplicate shorthand properties.
2. Extract repeated subtrees into named components with slots.
3. Emit an optional stripped variant with absolute positioning removed.
