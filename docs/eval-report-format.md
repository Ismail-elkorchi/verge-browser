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
  - includes capability-ladder status via `reports/capability-ladder.json`

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

## reports/runtime-matrix.json
- `suite`: `"runtime-matrix"`
- `profile`: `"ci"` or `"release"`
- `timestamp`: ISO-8601
- `requiredRuntimes`: `string[]`
- `requireRuntimeMatrix`: `boolean`
- `runtimes`:
  - keys: `node`, `deno`, `bun`
  - values: `{ ok, hash, error, missing }`
- `hashesAgree`: `boolean`
- `overall`: `{ ok, actualOk }`

## reports/eval-coherence.json
- `suite`: `"eval-coherence"`
- `profile`: `"ci"` or `"release"`
- `timestamp`: ISO-8601
- `requireFlags`: `string[]`
- `unknownRequireFlags`: `string[]`
- `missingProducerScripts`: `{ flag, scriptPath }[]`
- `missingReports`: `{ flag, reportPath }[]`
- `overall`: `{ ok }`

## reports/network-outcomes.json
- `suite`: `"network-outcomes"`
- `timestamp`: ISO-8601
- `requiredKinds`: `string[]`
- `coverage`:
  - `{ presentKinds, missingKinds }`
- `replayFixtureCount`: number (`> 0`)
- `cases`:
  - entries: `{ id, expectedKind, actualKind, ok, detailCode, detailMessage }`
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

## reports/capability-ladder.json
- `suite`: `"capability-ladder"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `checks`:
  - `capability13` through `capability26`
  - each entry: `{ ok, details }`
- `overall`: `{ ok }`

## reports/oracle-runtime.json
- `suite`: `"oracle-runtime"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `image`:
  - `{ rootfsPath, lockPath, fingerprint, packageCount, rootPackages, sourcePolicy, releaseMetadata }`
  - `sourcePolicy`:
    - `{ mode, snapshotRoot, snapshotId, keyringPath, mirrors }`
  - `releaseMetadata[]`:
    - `{ suite, inReleaseUrl, inReleaseSha256, signatureKey, packageIndexes[] }`
    - `packageIndexes[]`:
      - `{ component, indexPath, indexUrl, indexSha256 }`
- `engines`:
  - keys: `lynx`, `w3m`, `links2`
  - values:
    - `{ engine, path, sizeBytes, sha256, version }`

## reports/render-baselines-real.json
Same shape as `reports/render-baselines.json` with engine metadata `runner: "real-binary"` and binary fingerprint fields.

## reports/render-verge-real.json
Same shape as `reports/render-verge.json` for the sampled oracle runtime run.

## reports/render-score-real.json
Same shape as `reports/render-score.json` for the sampled oracle runtime run.

## reports/eval-oracle-runtime-summary.json
- `suite`: `"oracle-runtime-validation"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `selection`: `{ sampleCases, widths }`
- `gates`: `{ ok, failures[] }`
- `runtime`:
  - `hasAllEngineFingerprints`
  - `hasSnapshotPolicy`
  - `hasReleaseMetadata`
  - `engineRecordChecks`
- `reports`: paths to generated artifacts

## reports/eval-oracle-superiority-summary.json
- `suite`: `"oracle-superiority-check"`
- `timestamp`: ISO-8601
- `profile`: `"ci"` or `"release"`
- `runtimeValidationOk`: boolean
- `metrics`:
  - key per metric:
    - `{ verge, bestBaseline, required, ok }`
- `failures`: `string[]`
- `ok`: boolean

## reports/eval-oracle-fingerprint-summary.json
- `suite`: `"oracle-fingerprint-drift-check"`
- `timestamp`: ISO-8601
- `fingerprint`:
  - `{ runtime, expected, lockDeclared, match }`
- `diagnostics`:
  - `{ packageCount, packagesWithDownloadUrl, fingerprintInputValidationOk, fingerprintInputValidationIssues, lockDeclaredMatchesExpected, runtimeMatchesLockDeclared }`
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

## reports/eval-oracle-supply-chain-summary.json
- `suite`: `"oracle-supply-chain-check"`
- `timestamp`: ISO-8601
- `runtimeValidation`: `{ ok }`
- `supplyChain`:
  - `{ ok, packageCount, maxOraclePackageCount, missingRootPackages }`
- `ok`: boolean

## reports/oracle-workflow-policy.json
- `suite`: `"oracle-workflow-policy"`
- `timestamp`: ISO-8601
- `workflows`: `string[]`
- `violations`: `{ path, line, reason }[]`
- `ok`: boolean

## Local field reports (`realworld/corpus/reports/*`)
These reports are local-only artifacts and are not part of CI.

### realworld/corpus/reports/cohort-governance-v4.json
- `suite`: `"cohort-governance-v4"`
- `generatedAtIso`: ISO-8601
- `runId`: stable hash from governance inputs
- `policy`:
  - `{ configPath, version, promotedPolicyId, decisionSurface }`
- `counts`: `{ comparedPages, comparedRecords }`
- `cohorts[]`:
  - `{ id, description, weight, quota, observed, scores, checks }`
  - `scores` includes:
    - `baselineMeanNormalizedTokenF1`
    - `candidateMeanNormalizedTokenF1`
    - `meanDeltaNormalizedTokenF1`
    - `residualWeightedDeltaNormalizedTokenF1`
- `weightedAggregate`:
  - `{ baselineMeanNormalizedTokenF1, candidateMeanNormalizedTokenF1, meanDeltaNormalizedTokenF1, residualWeightedDeltaNormalizedTokenF1 }`
- `snapshot`: `{ ids, fingerprint }`
- `cohortMembership`: map of cohort id to deterministic page list
- `checks`: governance checks (`policyGates`, `decisionSurfaceMatch`, `cohortCoverage`, `cohortQuotas`, `weightSum`, `snapshotCoverage`)
- `ok`: boolean

### realworld/corpus/reports/cohort-snapshot-fingerprint-v1.json
- `suite`: `"cohort-snapshot-fingerprint"`
- `version`: `"v1"`
- `generatedAtIso`: ISO-8601
- `runId`: stable hash
- `promotedPolicyId`: policy id used for governance scoring
- `decisionSurface`: policy decision surface id
- `snapshotIds`: deterministic sorted list
- `inputHashes`:
  - `cohortConfigSha256`
  - `pageSurfaceReportSha256`
  - `policySummaryReportSha256`
  - `policyNdjsonReportSha256`
  - `residualReportSha256`
- `cohortMembershipHash`: hash of cohort membership mapping
- `snapshotFingerprint`: canonical snapshot identity hash
