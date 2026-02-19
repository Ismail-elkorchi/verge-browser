# Acceptance Gates

Evaluation is executed through:
- `npm run eval:ci`
- `npm run eval:release`

Artifacts are written to `reports/`.

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

## G-311 Phase ladder gate (13 to 26)
- enforced in `eval:ci` and `eval:release`
- `reports/phase-ladder.json` exists
- `reports/phase-ladder.json.overall.ok` is `true`
- required phase checks:
  - `checks.phase13.ok` through `checks.phase26.ok`

## G-312 Network outcome taxonomy gate
- `reports/network-outcomes.json` exists
- `reports/network-outcomes.json.overall.ok` is `true`
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
- `scripts/oracles/oracle-image.lock.json` contains package versions + `.deb` hashes + direct replay URLs.
- `reports/oracle-runtime.json.image.fingerprint` derives from the lock package set.

### V-404 Real-baseline report integrity
- `reports/render-baselines-real.json` includes case records for all engines.
- per-engine record counts equal executed surface in `reports/render-score-real.json.coverage.executedSurface`.

### V-405 Validation posture
- Oracle runtime gates enforce coverage, determinism, and metric floors.
- Comparative superiority delta is recorded in metrics but is non-blocking for this validation pass.

## Phase-3.2 validation gates (strict superiority)
Executed by:
- `npm run eval:oracle-superiority:ci`
- `npm run eval:oracle-superiority:release`

### V-406 Superiority gate
- `reports/eval-oracle-superiority-summary.json.ok` is `true`.
- for each configured render metric:
  - `verge >= bestBaseline + comparativeWinDelta`.

## Phase-3.3 validation gates (fingerprint drift)
Executed by:
- `npm run eval:oracle-fingerprint:ci`
- `npm run eval:oracle-fingerprint:release`

### V-407 Fingerprint identity gate
- `reports/eval-oracle-fingerprint-summary.json.ok` is `true`.
- lock-derived fingerprint equals runtime image fingerprint.
- engine fingerprints for `lynx`, `w3m`, `links2` are present and complete.

## Phase-3.4 validation gates (oracle supply chain)
Executed by:
- `npm run eval:oracle-supply-chain:ci`
- `npm run eval:oracle-supply-chain:release`

### V-408 Supply-chain envelope gate
- `reports/eval-oracle-supply-chain-summary.json.ok` is `true`.
- `reports/oracle-supply-chain.json.ok` is `true`.
- package closure count is bounded by `evaluation.config.json.oracleSupplyChain.maxOraclePackageCount`.
