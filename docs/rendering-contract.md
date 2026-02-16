# Rendering Contract (Phase 3)

This document defines the measurable rendering contract for `verge-browser`.

## Benchmark definition
- Corpus file: `scripts/oracles/corpus/render-v3.json`
- Minimum case count: `1000` (current: `1200`)
- Widths for every case: `[60, 80, 100, 120]`
- Holdout rule: `sha256(caseId) % 10 == 0`

## Profiles
- `ci`:
  - execute full corpus
  - `executedFraction >= 0.9`
  - `executedSurface >= 250`
- `release`:
  - execute full corpus (including holdout)
  - `executedFraction == 1.0`
  - `executedSurface >= 1000`

## Metrics
All metrics are in `[0, 1]`.

1. `textTokenF1`
- F1 over token multisets extracted from rendered semantic text versus corpus-derived reference text.

2. `linkLabelF1`
- F1 over token multisets from rendered link labels versus reference link labels.

3. `tableMatrixF1`
- F1 over token multisets from rendered table cell text versus reference table cell text.

4. `preWhitespaceExact`
- Per case: `1` when every reference `<pre>` block appears exactly in output, else `0`.
- Cases without `<pre>` blocks score `1`.
- Final score is mean across executed surface.

5. `outlineF1`
- F1 over heading signatures (`hN:text`) extracted from rendered output versus reference headings.

## Determinism check
For every executed case/width, rendering is executed twice and output hashes must match.

## Comparative gate
For each metric `m`:
- `verge(m) >= max(lynx(m), w3m(m), links2(m)) + 0.005`

## Floors
- `textTokenF1 >= 0.970`
- `linkLabelF1 >= 0.995`
- `tableMatrixF1 >= 0.950`
- `preWhitespaceExact >= 0.995`
- `outlineF1 >= 0.980`
