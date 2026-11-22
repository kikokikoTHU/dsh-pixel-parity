# The alignment loop

This plugin is an **LLM-native alignment harness**, not a low-code frontend generator.
The plugin measures; the model edits real code. The product is the loop:

```
parity_run  →  parity_diagnose  →  edit implementation  →  parity_run  →  compare delta
     ↑                                                                        │
     └──────────────────────── until verified or tolerance accepted ─────────┘
```

`parity_diagnose` and the manifest's `iteration` / `parentRun` / `delta` fields exist so
each round has a measurable "did this change help?" answer. Exports (IR, QML, component
HTML/CSS) are inspection and portability seams, not the alignment loop.

## One round

1. **Run** the narrowest case:

   ```
   parity_run({ repo, config, cases: ["monitor-record"], viewports: ["desktop"] })
   ```

2. **Diagnose** instead of reading `metrics.json`:

   ```
   parity_diagnose({ repo, runDir })
   ```

   The output is ranked: geometry anchor deltas first (hard failures), then style diffs,
   then the largest pixel regions with the IR nodes that overlap them. Each finding
   carries a suggested next check.

3. **Choose one finding.** Fix the largest geometry delta before touching pixels or
   styles; a 4px layout shift is not a color problem. Change the token or the rule, not a
   one-off value.

4. **Re-run** the same command. Then compare:

   - `delta.meanChange < 0` → the change improved the match;
   - `delta.viewports[i].improved` → per viewport;
   - `iteration` increments and `parentRun` points at the previous run.

5. **Keep or revert.** Keep the change only when the failing layer improved and no other
   layer regressed. If pixel ratio went up, revert before trying the next hypothesis.

## When to stop

- Every selected viewport is `verified` (or `image-verified` where DOM evidence genuinely
  does not exist); or
- the remaining differences are covered by an explicitly chosen tolerance
  (`defaults.preset: balanced|tolerant` or per-run `geometryTolerance` / `maxMismatch`) and
  the report states which preset was used and why.

Never "stop" by masking a region you are trying to align, and never approve a baseline
before convergence — a baseline freezes whatever state you approved.

## Guardrails

- **No blind translation.** Generating IR/QML/component output is not alignment; it can be
  a starting draft, but the loop above is what proves the implementation matches.
- **One hypothesis per round.** Bundling several edits makes the delta uninterpretable.
- **No silent threshold changes.** If a threshold moved, record the measured reason.
- **Two flat rounds = wrong hypothesis**, not "needs a looser threshold". Re-read the
  diagnosis, check the DOM/selector, then change direction.

## Evidence to report

At the end of a loop, report:

- run ids / iterations used and the final `delta` chain;
- final statuses per case/viewport;
- remaining findings that are accepted by tolerance, with the preset named;
- artifacts (`diff.png`, `metrics.json`, `ir.json` when exported).
