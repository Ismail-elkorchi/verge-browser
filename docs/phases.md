# Phase Roadmap (3.2 to 12)

This file defines strict, falsifiable acceptance criteria for the implemented phases.
Each phase is complete only when its command(s) exit with code `0` and required report fields match this contract.

## Phase 3.2 — Real-oracle superiority gate
Acceptance criteria:
- `npm run eval:phase32:release` passes.
- `reports/eval-phase32-summary.json` exists.
- `reports/eval-phase32-summary.json.ok` is `true`.
- For every metric in `evaluation.config.json.render.metrics`:
  - `metrics.<name>.ok` is `true`.
  - `metrics.<name>.verge >= metrics.<name>.bestBaseline + evaluation.config.json.render.comparativeWinDelta`.

## Phase 3.3 — Binary fingerprint drift gate
Acceptance criteria:
- `npm run eval:phase33:release` passes.
- `reports/eval-phase33-summary.json` exists.
- `reports/eval-phase33-summary.json.ok` is `true`.
- `reports/eval-phase33-summary.json.fingerprint.match` is `true`.
- `reports/eval-phase33-summary.json.engines.missing` is empty.
- `reports/eval-phase33-summary.json.engines.weakFingerprints` is empty.

## Phase 3.4 — Oracle supply-chain envelope gate
Acceptance criteria:
- `npm run eval:phase34:release` passes.
- `reports/eval-phase34-summary.json` exists.
- `reports/eval-phase34-summary.json.ok` is `true`.
- `reports/oracle-supply-chain.json.ok` is `true`.
- `reports/oracle-supply-chain.json.packageCount <= evaluation.config.json.phase34.maxOraclePackageCount`.

## Phase 4 — Rendering parity hardening
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/render-score.json.metrics.verge.textTokenF1 >= 0.97`.
- `reports/render-score.json.metrics.verge.tableMatrixF1 >= 0.95`.
- `reports/render-score.json.metrics.verge.preWhitespaceExact >= 0.995`.
- `test/control/render.test.js` passes list nesting, pre, and table assertions.

## Phase 5 — Navigation and command ergonomics
Acceptance criteria:
- `npm test` passes.
- `test/control/pager.test.js` passes.
- `test/control/search.test.js` passes.
- `test/control/shortcuts.test.js` passes.
- `test/control/storage.test.js` passes.

## Phase 6 — Stream-first parse path
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/stream.json` exists and `reports/stream.json.overall.ok` is `true`.
- `reports/stream.json.checks` includes:
  - `stream-serialize-parity` with `ok=true`
  - `stream-max-input-budget` with `ok=true`
  - `stream-max-buffered-budget` with `ok=true`
  - `tokenize-stream-deterministic` with `ok=true`

## Phase 7 — Form interaction surface
Acceptance criteria:
- `npm test` passes.
- `test/control/forms.test.js` passes.
- Command parser supports:
  - `form list`
  - `form submit <index> [name=value ...]`

## Phase 8 — Transport security hardening
Acceptance criteria:
- `npm test` passes.
- `test/control/fetch-page.test.js` passes protocol and size-limit checks.
- Redirect protocol enforcement rejects unsupported protocols.
- Content-type gate rejects non-HTML payloads.

## Phase 9 — Agent observability
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/agent.json` exists and `reports/agent.json.overall.ok` is `true`.
- `reports/agent.json.features.trace.ok` is `true`.
- `reports/agent.json.features.spans.ok` is `true`.
- `reports/agent.json.features.outline.ok` is `true`.
- `reports/agent.json.features.chunk.ok` is `true`.

## Phase 10 — Structural rewrite operations
Acceptance criteria:
- `npm test` passes.
- `test/control/commands.test.js` parses all patch command forms.
- `test/control/session.test.js` verifies `applyEdits` changes output deterministically.
- Patch commands supported:
  - `patch remove-node <id>`
  - `patch replace-text <id> <value>`
  - `patch set-attr <id> <name> <value>`
  - `patch remove-attr <id> <name>`
  - `patch insert-before <id> <html>`
  - `patch insert-after <id> <html>`

## Phase 11 — CI and release automation hardening
Acceptance criteria:
- `.github/workflows/ci.yml` runs `npm run ci`.
- `.github/workflows/release.yml` runs `npm run release:check`.
- `.github/workflows/oracle-phases.yml` runs phases 3.2, 3.3, and 3.4.
- `npm run release:check` passes locally.

## Phase 12 — Benchmark governance
Acceptance criteria:
- `npm run test:bench` passes.
- `reports/bench.json` exists with benchmark entries for configured widths.
- `reports/bench-governance.json` exists and `ok=true`.
- `reports/bench-governance.json.benchmarksCompared` equals emitted benchmark count.

## Phase 13 — Cookie jar parse + match determinism
Acceptance criteria:
- `npm run eval:phase-ladder:ci` passes.
- `reports/phase-ladder.json.checks.phase13.ok` is `true`.
- Cookie parsing/merge/header checks are deterministic for identical inputs.

## Phase 14 — Form submission request synthesis (GET + POST)
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase14.ok` is `true`.
- `form submit` supports both GET and POST forms.

## Phase 15 — Local recall index persistence
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase15.ok` is `true`.
- Index search returns deterministic ranking for repeated inputs.

## Phase 16 — Reader/download command surface
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase16.ok` is `true`.
- Command parser accepts `reader` and `download <path>`.

## Phase 17 — Navigation diagnostics completeness
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase17.ok` is `true`.
- Diagnostics include request method, cookie usage, and duration fields.

## Phase 18 — Command grammar hardening for stateful navigation
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase18.ok` is `true`.
- Command parser accepts `cookie list`, `cookie clear`, and `recall open <index>`.

## Phase 19 — Transport policy verification
Acceptance criteria:
- `npm run eval:phase-ladder:ci` passes.
- `reports/phase-ladder.json.checks.phase19.ok` is `true`.
- Protocol/content-type security checks reject disallowed inputs.

## Phase 20 — POST transport + Set-Cookie capture
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase20.ok` is `true`.
- `fetchPage` POST request path captures `Set-Cookie` headers.

## Phase 21 — Cookie store replay integration
Acceptance criteria:
- `npm test` passes.
- `reports/phase-ladder.json.checks.phase21.ok` is `true`.
- Cookie store replay produces deterministic header output.

## Phase 22 — Stream invariants carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/phase-ladder.json.checks.phase22.ok` is `true`.
- `reports/stream.json.overall.ok` is `true`.

## Phase 23 — Agent report carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/phase-ladder.json.checks.phase23.ok` is `true`.
- `reports/agent.json.overall.ok` is `true`.

## Phase 24 — Benchmark governance carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/phase-ladder.json.checks.phase24.ok` is `true`.
- `reports/bench-governance.json.ok` is `true`.

## Phase 25 — Release integrity continuity
Acceptance criteria:
- `npm run eval:release` passes.
- `reports/phase-ladder.json.checks.phase25.ok` is `true`.
- `reports/release-integrity.json.ok` is `true` in release profile.

## Phase 26 — Integrated phase ladder gate
Acceptance criteria:
- `npm run eval:ci` passes.
- `npm run eval:release` passes.
- `reports/phase-ladder.json.checks.phase26.ok` is `true`.
- `reports/phase-ladder.json.overall.ok` is `true`.
