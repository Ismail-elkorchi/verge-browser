# Visible-text mismatch triage (local)

Date: 2026-02-16
Profile: ci (`npm run eval:ci`)

Observed mismatch families from `reports/render-verge.json` (`textTokenF1 < 1`):
- `foreign-content`
- `scripting-flag`

The following semantic patterns were selected for synthetic fixture reproduction in `html-parser`.

1. Script exclusion with body fallback text surface (`render-v3-0024`, `render-v3-0032`)
2. Leading `noscript` outside visible body text surface (`render-v3-0024` variant)
3. `hidden` subtree suppression containing `noscript` fallback (`render-v3-0024` variant)
4. `aria-hidden="true"` subtree suppression containing `noscript` fallback (`render-v3-0024` variant)
5. SVG `title` + `text` adjacency token fusion (`render-v3-0004`)
6. SVG adjacency before paragraph break (`render-v3-0004` with block continuation)
7. MathML operator retention in `mi/mo/mi` text extraction (`render-v3-0012`)
8. MathML adjacent token fusion without explicit separators (`render-v3-0012` variant)
9. SVG + MathML inline adjacency in one text run (`render-v3-0004`, `render-v3-0012`)
10. Paragraph break behavior around foreign-content text (`render-v3-0004` variant)
11. Table-cell boundary tokenization when cells contain foreign content (`render-v3-0004` variant)
12. `noscript` wrapping foreign-content subtree before visible paragraph (`render-v3-0024` variant)

Mapped fixture additions in `html-parser`:
- `case-033` .. `case-044`

## Automated triage pipeline

Local-only commands:

1. `npm run field:oracles`
2. `npm run field:visible-text:ab`
3. `npm run field:triage:fixtures`

Artifacts are written under ignored paths in `realworld/corpus/`:
- `reports/visible-text-policy-compare.ndjson`
- `reports/visible-text-policy-compare.json`
- `triage/visible-text-fixture-candidates.json`
- `triage/visible-text-fixture-candidates.md`

The generated candidates contain only synthetic HTML snippets and expected text outputs.

Policy search notes:
- `field:visible-text:ab` now evaluates multiple fallback policies against offline oracle outputs.
- The report selects `recommendedCandidatePolicyId` deterministically using:
  1. highest mean delta from baseline
  2. highest mean normalized token F1
  3. lowest worse-count
