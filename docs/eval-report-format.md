# Evaluation Report Format

All evaluation outputs are artifacts under `reports/`.

## reports/render-baselines.json
- `suite`: `"render-baselines"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `corpus`: `{ name, totalCases, widths }`
- `engines`: `[{ engine, version, runner }]`
- `casesByEngine`:
  - key per engine (`lynx`, `w3m`, `links2`)
  - list entries:
    - `{ id, width, holdout, outputHash, normalizedOutput, metrics }`

## reports/render-verge.json
- `suite`: `"render-verge"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `corpus`: `{ name, totalCases, widths }`
- `cases` entries:
  - `{ id, width, holdout, output, normalizedOutput, outputHash, metrics }`
- `determinism`:
  - `{ ok, mismatches[] }`

## reports/render-score.json
- `suite`: `"render-score"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `metrics`:
  - `verge`
  - `lynx`
  - `w3m`
  - `links2`
  - each metric set:
    - `textTokenF1`
    - `linkLabelF1`
    - `tableMatrixF1`
    - `preWhitespaceExact`
    - `outlineF1`
- `coverage`:
  - `{ totalSurface, executedSurface, skippedSurface, holdoutExcluded, executedFraction }`
- `corpusViolations`: `string[]`

## reports/eval-summary.json
- `suite`: `"eval"`
- `profile`: `"ci"` or `"release"`
- `timestamp`: ISO-8601
- `reports`: absolute paths to generated reports
- `gates`:
  - `{ ok, failures[] }`
  - includes phase-ladder status via `reports/phase-ladder.json`

## reports/agent.json
- `suite`: `"agent"`
- `timestamp`: ISO-8601
- `features`:
  - `trace`: `{ ok, details }`
  - `spans`: `{ ok, details }`
  - `patch`: `{ ok, details }`
  - `outline`: `{ ok, details }`
  - `chunk`: `{ ok, details }`
  - `stream`: `{ ok, details }`
- `overall`: `{ ok }`

## reports/stream.json
- `suite`: `"stream"`
- `timestamp`: ISO-8601
- `checks`:
  - entries: `{ id, ok, observed, expected }`
- `overall`: `{ ok }`

## reports/bench.json
- `suite`: `"bench"`
- `timestamp`: ISO-8601
- `sampleCases`: number
- `benchmarks`:
  - entries:
    - `{ name, width, cases, durationMs, casesPerSecond, p95CaseMs }`

## reports/bench-governance.json
- `suite`: `"bench-governance"`
- `timestamp`: ISO-8601
- `requiredBenchmarks`: `string[]`
- `emittedBenchmarks`: `string[]`
- `missingBenchmarks`: `string[]`
- `minimumSampleCases`: number
- `sampleCases`: number
- `benchmarksCompared`: number
- `ok`: boolean

## reports/release-integrity.json
- `suite`: `"release-integrity"`
- `timestamp`: ISO-8601
- `tarball`:
  - `{ filename, packageSize, unpackedSize }`
- `files`:
  - `{ count, hasDist, hasReadme, hasLicense, forbiddenPrefixes, forbiddenEntries }`
- `ok`: boolean

## reports/phase-ladder.json
- `suite`: `"phase-ladder"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `checks`:
  - `phase13` through `phase26`
  - each entry: `{ ok, details }`
- `overall`: `{ ok }`

## reports/oracle-runtime.json
- `suite`: `"oracle-runtime"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `image`:
  - `{ rootfsPath, lockPath, fingerprint, packageCount, rootPackages }`
- `engines`:
  - keys: `lynx`, `w3m`, `links2`
  - values:
    - `{ engine, path, sizeBytes, sha256, version }`

## reports/render-baselines-real.json
Same shape as `reports/render-baselines.json` with engine metadata `runner: "real-binary"` and binary fingerprint fields.

## reports/render-verge-real.json
Same shape as `reports/render-verge.json` for the sampled phase-3.1 run.

## reports/render-score-real.json
Same shape as `reports/render-score.json` for the sampled phase-3.1 run.

## reports/eval-phase31-summary.json
- `suite`: `"phase31-real-oracles"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `selection`: `{ sampleCases, widths }`
- `gates`: `{ ok, failures[] }`
- `runtime`:
  - `hasAllEngineFingerprints`
  - `engineRecordChecks`
- `reports`: paths to generated artifacts

## reports/eval-phase32-summary.json
- `suite`: `"phase32-superiority"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `phase31GatesOk`: boolean
- `metrics`:
  - key per metric:
    - `{ verge, bestBaseline, required, ok }`
- `failures`: `string[]`
- `ok`: boolean

## reports/eval-phase33-summary.json
- `suite`: `"phase33-fingerprint-drift"`
- `timestamp`: ISO-8601
- `fingerprint`:
  - `{ runtime, expected, match }`
- `engines`:
  - `{ required, missing, weakFingerprints }`
- `ok`: boolean

## reports/oracle-supply-chain.json
- `suite`: `"oracle-supply-chain"`
- `timestamp`: ISO-8601
- `maxOraclePackageCount`: number
- `packageCount`: number
- `requiredRootPackages`: `string[]`
- `missingRootPackages`: `string[]`
- `hasAllEngineFingerprints`: boolean
- `imageFingerprint`: string
- `ok`: boolean

## reports/eval-phase34-summary.json
- `suite`: `"phase34-supply-chain"`
- `timestamp`: ISO-8601
- `phase31`: `{ ok }`
- `supplyChain`:
  - `{ ok, packageCount, maxOraclePackageCount, missingRootPackages }`
- `ok`: boolean
