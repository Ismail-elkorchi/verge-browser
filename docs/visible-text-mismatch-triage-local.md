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
3. `npm run field:triage:taxonomy`
4. `npm run field:triage:fixtures`

`field:visible-text:ab` loads css-parser style-signal primitives from:
- `VERGE_CSS_PARSER_MODULE_PATH` when set, otherwise
- `../css-parser/dist/mod.js` (sibling repository default).

Artifacts are written under ignored paths in `realworld/corpus/`:
- `reports/visible-text-policy-compare.ndjson`
- `reports/visible-text-policy-compare.json`
- `reports/visible-text-residual-taxonomy.json`
- `reports/visible-text-residual-minimization.json`
- `triage/visible-text-fixture-candidates.json`
- `triage/visible-text-fixture-candidates.md`
- `triage/minimized/*.html` (local-only minimized residual inputs)

The generated candidates contain only synthetic HTML snippets and expected text outputs.

Policy and taxonomy notes:
- `field:visible-text:ab` evaluates candidate policies against offline oracle outputs.
- Candidate set includes `rendered-style-v1` (style-signal filtered rendered-visible approximation).
- Policy promotion uses `meaningful-content` as the decision surface and keeps baseline when candidate delta is negative.
- `field:triage:taxonomy` classifies baseline residual mass into deterministic buckets (`missing:<sourceRole>` / `extra:oracle`) and deterministic `extra:oracle:*` subclasses.
- Top-bucket coverage must be at least `0.95` of baseline residual mass.
- `extra:oracle:unclassified` residual share must be at most `0.05`.
- `field:triage:fixtures` builds synthetic fixture candidates from observed top baseline buckets only.
