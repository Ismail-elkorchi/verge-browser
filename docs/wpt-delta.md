# WPT-Derived Delta Check

This repository tracks a deterministic, offline subset of Web Platform Tests for render/parser regression deltas.

## Inputs
- Corpus file: `scripts/oracles/corpus/wpt-delta-v1.json`
- Expected outputs: `scripts/oracles/corpus/wpt-delta-v1.expected.json`
- Corpus refresh command: `npm run oracle:wpt-delta:corpus`

## Command
- `npm run eval:wpt-delta`

## Check behavior
For each case, the check recomputes and compares:
- source payload hash (`sha256`)
- parse error count (`parseErrorCount`)
- visible text hash (`visibleTextSha256`)
- render output hash at width 80 (`render80Sha256`)
- render output hash at width 120 (`render120Sha256`)

The check fails on any mismatch, missing expected entry, extra expected entry, category coverage loss, or case-count under 100.

## Refresh workflow
- Refresh expected outputs after intentional renderer/parser changes:
  - `npm run oracle:wpt-delta:refresh`
- Refresh corpus from pinned WPT commit when expanding or updating the subset:
  - `npm run oracle:wpt-delta:corpus`
- Re-run gate:
  - `npm run eval:wpt-delta`
