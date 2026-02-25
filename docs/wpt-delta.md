# WPT-Derived Delta Check

This repository tracks a deterministic, offline subset of Web Platform Tests for render/parser regression deltas.

## Inputs
- Corpus file: `scripts/oracles/corpus/wpt-delta-v1.json`
- Expected outputs: `scripts/oracles/corpus/wpt-delta-v1.expected.json`

## Command
- `npm run eval:wpt-delta`

## Check behavior
For each case, the check recomputes and compares:
- source payload hash (`sha256`)
- parse error count (`parseErrorCount`)
- visible text hash (`visibleTextSha256`)
- render output hash at width 80 (`render80Sha256`)
- render output hash at width 120 (`render120Sha256`)

The check fails on any mismatch, missing expected entry, extra expected entry, or case-count under 12.

## Refresh workflow
- Refresh expected outputs after intentional renderer/parser changes:
  - `npm run oracle:wpt-delta:refresh`
- Re-run gate:
  - `npm run eval:wpt-delta`
