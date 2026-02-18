# Phase 4 local rehearsal: visible-text integration

Date: 2026-02-16
Consumer: `verge-browser` (local-only)

## Goal
Replace local visible-text extraction in evaluation with `html-parser`:
- `visibleText(tree)`
- `visibleTextTokens(tree)`

## Change
- File changed locally:
  - `scripts/eval/render-eval-lib.mjs`
- Old reference path:
  - local `collectVisibleText(...)` implementation
- New reference path:
  - `extractVisibleText(tree)` + `visibleTextTokens(tree)` from `html-parser`

## Commands
- Before:
  - `npm run eval:ci`
  - read `reports/render-score.json.metrics.verge.textTokenF1`
- After integration:
  - `npm run eval:ci`
  - read `reports/render-score.json.metrics.verge.textTokenF1`

## Metric delta
- Baseline `textTokenF1`: `1.0`
- After integration `textTokenF1`: `0.9873475089783854`
- Delta: `-0.0126524910216146`

## Interpretation
- The consumer now uses the library contract rather than duplicated local logic.
- The score reduction indicates semantic differences between old local extraction and contract-driven extraction.
- Current score remains above the existing floor used by `verge-browser` CI.

## Follow-up signal for html-parser
- Keep `visible-text` fixtures explicit and deterministic.
- Expand fixtures for table/list/hidden edge cases that correlate with observed score movement.
