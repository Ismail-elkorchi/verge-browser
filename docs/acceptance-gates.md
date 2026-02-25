# Acceptance Gates

Evaluation is executed through:
- `npm run eval:ci`
- `npm run eval:release`

Artifacts are written to `reports/`.

## Runtime scope policy
- Terminal runtime targets are Node, Deno, and Bun.
- Browser runtime execution is a non-goal for this product.

## Required CI checks
- `node`
- `deno`
- `bun`

## G-301 Corpus integrity
- `scripts/oracles/corpus/render-v3.json` exists
- case count >= 1000
- every case includes widths `[60, 80, 100, 120]`
- every case `sha256` matches its HTML payload

## G-302 Coverage integrity
- `ci`: executed fraction >= 0.9 and executed surface >= 250
- `release`: executed fraction == 1.0 and executed surface >= 1000
- skipped surface must be 0
- holdout selection rule: `sha256(caseId) % 10 == 0`

## G-303 Determinism
- For each executed case/width:
  - two render runs produce identical output hash

## G-304 Render quality floors
- `textTokenF1 >= 0.970`
- `linkLabelF1 >= 0.995`
- `tableMatrixF1 >= 0.950`
- `preWhitespaceExact >= 0.995`
- `outlineF1 >= 0.980`

## G-305 Comparative win
For each metric:
- `verge >= best(lynx, w3m, links2) + 0.005`

## G-306 Report completeness
- `reports/render-baselines.json` exists and includes pinned baseline versions
- `reports/render-verge.json` exists and includes per-case output + normalized output
- `reports/render-score.json` exists with metrics + coverage
- `reports/runtime-matrix.json` exists with runtime smoke status
- `reports/eval-summary.json` exists and reports gate status

## G-307 Agent report gate
- `reports/agent.json` exists
- `reports/agent.json.overall.ok` is `true`
- required feature checks:
  - `features.trace.ok`
  - `features.spans.ok`
  - `features.patch.ok`
  - `features.outline.ok`
  - `features.chunk.ok`
  - `features.stream.ok`

## G-308 Stream invariants gate
- `reports/stream.json` exists
- `reports/stream.json.overall.ok` is `true`
- required check IDs:
  - `stream-serialize-parity`
  - `stream-max-input-budget`
  - `stream-max-buffered-budget`
  - `tokenize-stream-deterministic`

## G-309 Benchmark governance gate
- `reports/bench.json` exists
- `reports/bench-governance.json` exists
- `reports/bench-governance.json.ok` is `true`
- benchmark names emitted in `reports/bench.json` must include all names in `evaluation.config.json.benchmarks.required`

## R-310 Release integrity gate
- enforced in `eval:release`
- `reports/release-integrity.json` exists and `ok=true`
- dry-run package must include `dist/`, `README.md`, and `LICENSE`
- dry-run package must exclude `reports/`, `tmp/`, `scripts/`, and `test/`

## G-311 Capability ladder gate (13 to 26)
- enforced in `eval:ci` and `eval:release`
- `reports/capability-ladder.json` exists
- `reports/capability-ladder.json.overall.ok` is `true`
- required capability checks:
  - `checks.capability13.ok` through `checks.capability26.ok`

## G-312 Network outcome taxonomy gate
- `reports/network-outcomes.json` exists
- `reports/network-outcomes.json.overall.ok` is `true`
- `reports/network-outcomes.json.replayFixtureCount > 0`
- required taxonomy kinds are all covered:
  - `ok`
  - `http_error`
  - `timeout`
  - `dns`
  - `tls`
  - `redirect_limit`
  - `content_type_block`
  - `size_limit`
  - `unsupported_protocol`
  - `unknown`

## G-313 Oracle workflow replay policy gate
- `reports/oracle-workflow-policy.json` exists
- `reports/oracle-workflow-policy.json.ok` is `true`
- CI/release workflows do not use `--rebuild-lock` for oracle runtime validation

## G-314 Runtime matrix gate
- `reports/runtime-matrix.json` exists
- required runtime targets: `node`, `deno`, `bun`
- profile policy `requireRuntimeMatrix=true` in both `ci` and `release`
- all required runtime smoke checks pass
- required runtime hashes agree

## G-315 Require-flag producer coherence gate
- `reports/eval-coherence.json` exists
- every enabled profile `require*` field is recognized
- every enabled profile `require*` field maps to an existing producer script
- every enabled profile `require*` field maps to an emitted report artifact

## G-316 WPT-derived delta gate
- `reports/wpt-delta.json` exists
- `reports/wpt-delta.json.ok` is `true`
- WPT-derived corpus has at least 12 deterministic cases
- expected file and corpus IDs are one-to-one with zero missing/extra entries
- hash and structural deltas for each case are zero:
  - `sha256`
  - `parseErrorCount`
  - `visibleTextSha256`
  - `render80Sha256`
  - `render120Sha256`

## G-317 Deterministic fuzz gate
- `reports/fuzz.json` exists
- `reports/fuzz.json.ok` is `true`
- profile policy from `evaluation.config.json.fuzz.profiles.<profile>` is applied
- crash count is zero
- deterministic mismatch count is zero
- report includes `topSlowest` seeds and durations for triage

## Oracle runtime validation gates
Executed by:
- `npm run eval:oracle-runtime:ci`
- `npm run eval:oracle-runtime:release`
- required in GitHub PR CI (`.github/workflows/ci.yml`, `node` job)
- required in release checks (`npm run release:check`)

### V-401 Real engine execution
- `lynx`, `w3m`, `links2` are executed from the rootless oracle image under `tmp/oracle-image/rootfs`.

### V-402 Binary fingerprint capture
- `reports/oracle-runtime.json` includes `sha256`, `sizeBytes`, and version output for all three engines.

### V-403 Reproducible image identity
- `scripts/oracles/oracle-image.lock.json` has `formatVersion >= 3`.
- lock source policy is snapshot-based:
  - `sourcePolicy.mode = snapshot-replay`
  - `sourcePolicy.snapshotRoot`
  - `sourcePolicy.snapshotId`
- lock package records contain package versions + `.deb` hashes + direct replay URLs.
- `reports/oracle-runtime.json.image.fingerprint` derives from the lock package set.

### V-409 Signed release metadata verification
- lock refresh verifies signed snapshot metadata:
  - `dists/<suite>/InRelease` signature verified against Ubuntu archive keyring
  - signed `Packages` index hash verified
  - each locked package exists in the signed index with matching `Filename` and `SHA256`
- `reports/oracle-runtime.json.image.releaseMetadata` is present and non-empty.

### V-413 Deterministic oracle runner policy
- `reports/oracle-runtime.json.runnerPolicy` is present.
- `reports/oracle-runtime.json.runnerPolicy.environment` pins:
  - `LANG=C.UTF-8`
  - `LC_ALL=C.UTF-8`
  - `LANGUAGE=C`
  - `TZ=UTC`
  - `TERM=dumb`
  - `NO_COLOR=1`
- `reports/oracle-runner-policy.json` exists and `ok=true`.

### V-404 Real-baseline report integrity
- `reports/render-baselines-real.json` includes case records for all engines.
- per-engine record counts equal executed surface in `reports/render-score-real.json.coverage.executedSurface`.

### V-405 Validation posture
- Oracle runtime gates enforce coverage, determinism, and metric floors.
- Comparative superiority delta is recorded in metrics but is non-blocking for this validation pass.

## Oracle superiority validation gates
Executed by:
- `npm run eval:oracle-superiority:ci`
- `npm run eval:oracle-superiority:release`

### V-406 Superiority gate
- `reports/eval-oracle-superiority-summary.json.ok` is `true`.
- for each configured render metric:
  - `verge >= bestBaseline + comparativeWinDelta`.

## Oracle fingerprint drift validation gates
Executed by:
- `npm run eval:oracle-fingerprint:ci`
- `npm run eval:oracle-fingerprint:release`
- required in GitHub PR CI (`.github/workflows/ci.yml`, `node` job)
- required in release checks (`npm run release:check`)

### V-407 Fingerprint identity gate
- `reports/eval-oracle-fingerprint-summary.json.ok` is `true`.
- lock-derived fingerprint equals runtime image fingerprint.
- engine fingerprints for `lynx`, `w3m`, `links2` are present and complete.

## Oracle supply-chain validation gates
Executed by:
- `npm run eval:oracle-supply-chain:ci`
- `npm run eval:oracle-supply-chain:release`

### V-408 Supply-chain envelope gate
- `reports/eval-oracle-supply-chain-summary.json.ok` is `true`.
- `reports/oracle-supply-chain.json.ok` is `true`.
- package closure count is bounded by `evaluation.config.json.oracleSupplyChain.maxOraclePackageCount`.

### V-409 Provenance policy gate
- `reports/oracle-supply-chain.json.provenance.ok` is `true`.
- `reports/oracle-supply-chain.json.provenance.failures` is empty.
- `reports/eval-oracle-supply-chain-summary.json.supplyChain.provenanceOk` is `true`.

## Release attestation policy gate
Executed by:
- `npm run eval:ci`
- `npm run eval:release`

### V-410 Release artifact attestation policy
- `reports/release-attestation-policy.json.ok` is `true`.
- Release workflow is split into producer and verifier jobs.
- Verifier consumes uploaded release inputs from producer before attestation verification.
- Release workflow enforces job-scoped permissions (producer: `contents:read`, `attestations:write`, `id-token:write`; verifier: `contents:read`, `attestations:read`).
- Release workflow generates provenance via `actions/attest-build-provenance@v3`.
- Release workflow verifies attestation with `gh attestation verify` constrained by repository, signer workflow, source ref, source digest, OIDC issuer, hosted-runner, and SLSA provenance predicate.
- Release workflow runs a second verification path constrained by certificate identity and source digest.
- Release verifier enforces hermetic imports for verifier scripts and writes `reports/release-verifier-hermetic.json`.
- Release workflow writes `reports/attestation-package-verify.json` and validates `reports/release-attestation-runtime.json`.
- Runtime report validation must bind expected source digest and expected tarball SHA-256 to both online and offline verification outputs.

### V-411 Oracle lock attestation policy
- `reports/oracle-lock-attestation-policy.json.ok` is `true`.
- Release workflow generates provenance attestation for `scripts/oracles/oracle-image.lock.json`.
- Release workflow verifies lock attestation with `gh attestation verify` constrained by repository, signer workflow, source ref, source digest, OIDC issuer, hosted-runner, and SLSA provenance predicate.
- Release workflow writes `reports/attestation-oracle-lock-verify.json` and includes it in runtime attestation validation.

### V-412 Offline attestation verification materials
- Release workflow exports:
  - `reports/offline-verification/package-attestation-bundle.jsonl`
  - `reports/offline-verification/oracle-lock-attestation-bundle.jsonl`
  - `reports/offline-verification/trusted_root.jsonl`
  - `reports/offline-verification/sha256.txt`
- Release workflow replays attestation verification using the exported bundles and trusted root:
  - `reports/offline-verification/package-offline-verify.json`
  - `reports/offline-verification/oracle-lock-offline-verify.json`
- Release workflow validates offline replay JSON content with:
  - `reports/offline-attestation-content-policy.json`
- `reports/offline-attestation-content-policy.json.overall.ok` is `true`.
- Offline artifacts are uploaded with release package artifacts.

## Local field governance gates
Executed manually from the local repository root:
- `npm run field:oracles`
- `npm run field:visible-text:ab`
- `npm run field:governance`

### L-601 Cohort governance v4
- `realworld/corpus/reports/cohort-governance-v4.json` exists.
- `realworld/corpus/reports/cohort-governance-v4.json.ok` is `true`.
- required cohorts are present:
  - `standards-reference`
  - `application-auth-challenge`
  - `dynamic-interaction-heavy`
- all configured cohort quota checks pass.
- weighted aggregate section includes:
  - `weightedAggregate.meanDeltaNormalizedTokenF1`
  - `weightedAggregate.residualWeightedDeltaNormalizedTokenF1`
- `realworld/corpus/reports/cohort-snapshot-fingerprint-v1.json` exists.
- snapshot fingerprint report includes:
  - `snapshotIds`
  - `inputHashes`
  - `snapshotFingerprint`
