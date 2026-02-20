# Layout pilot (local)

This document defines the bounded C8 pilot for `verge-browser`.

## Scope

Included surface:

- block flow
- inline flow

Excluded surface:

- grid
- flex
- absolute positioning
- table layout model

## Source set

Pinned source manifest:

- `scripts/realworld/layout/wpt-subset.v1.json`

The manifest pins:

- upstream repository (`web-platform-tests/wpt`)
- exact commit
- case paths
- expected sha256 for each case
- two independent snapshots (`snapshot-a`, `snapshot-b`)

## Execution

1. Fetch and verify pinned files:

```bash
npm run field:layout:wpt:fetch
```

2. Run offline differential pilot:

```bash
npm run field:layout:wpt:run
```

## Pass conditions

The run writes `realworld/corpus/layout/reports/layout-pilot.json` and passes only when all checks pass:

- minimum available engine count (>=2)
- minimum per-snapshot engine agreement (`meanEngineAgreementF1 >= 0.9`)
- snapshot drift constraints:
  - `|snapshotA.meanVergeVsEngineF1 - snapshotB.meanVergeVsEngineF1| <= 0.05`
  - `|snapshotA.meanEngineAgreementF1 - snapshotB.meanEngineAgreementF1| <= 0.05`

## Notes

- This pilot is local-only and is not wired into CI.
- Cached WPT sources and reports are under ignored corpus paths.
