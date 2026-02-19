# Capability Roadmap (3.2 to 12)

This file defines strict, falsifiable acceptance criteria for the implemented capabilities.
Each capability is complete only when its command(s) exit with code `0` and required report fields match this contract.

## Capability 3.2 — Real-oracle superiority gate
Acceptance criteria:
- `npm run eval:oracle-superiority:release` passes.
- `reports/eval-oracle-superiority-summary.json` exists.
- `reports/eval-oracle-superiority-summary.json.ok` is `true`.
- For every metric in `evaluation.config.json.render.metrics`:
  - `metrics.<name>.ok` is `true`.
  - `metrics.<name>.verge >= metrics.<name>.bestBaseline + evaluation.config.json.render.comparativeWinDelta`.

## Capability 3.3 — Binary fingerprint drift gate
Acceptance criteria:
- `npm run eval:oracle-fingerprint:release` passes.
- `reports/eval-oracle-fingerprint-summary.json` exists.
- `reports/eval-oracle-fingerprint-summary.json.ok` is `true`.
- `reports/eval-oracle-fingerprint-summary.json.fingerprint.match` is `true`.
- `reports/eval-oracle-fingerprint-summary.json.engines.missing` is empty.
- `reports/eval-oracle-fingerprint-summary.json.engines.weakFingerprints` is empty.

## Capability 3.4 — Oracle supply-chain envelope gate
Acceptance criteria:
- `npm run eval:oracle-supply-chain:release` passes.
- `reports/eval-oracle-supply-chain-summary.json` exists.
- `reports/eval-oracle-supply-chain-summary.json.ok` is `true`.
- `reports/oracle-supply-chain.json.ok` is `true`.
- `reports/oracle-supply-chain.json.packageCount <= evaluation.config.json.oracleSupplyChain.maxOraclePackageCount`.

## Capability 4 — Rendering parity hardening
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/render-score.json.metrics.verge.textTokenF1 >= 0.97`.
- `reports/render-score.json.metrics.verge.tableMatrixF1 >= 0.95`.
- `reports/render-score.json.metrics.verge.preWhitespaceExact >= 0.995`.
- `test/control/render.test.js` passes list nesting, pre, and table assertions.

## Capability 5 — Navigation and command ergonomics
Acceptance criteria:
- `npm test` passes.
- `test/control/pager.test.js` passes.
- `test/control/search.test.js` passes.
- `test/control/shortcuts.test.js` passes.
- `test/control/storage.test.js` passes.

## Capability 6 — Stream-first parse path
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/stream.json` exists and `reports/stream.json.overall.ok` is `true`.
- `reports/stream.json.checks` includes:
  - `stream-serialize-parity` with `ok=true`
  - `stream-max-input-budget` with `ok=true`
  - `stream-max-buffered-budget` with `ok=true`
  - `tokenize-stream-deterministic` with `ok=true`

## Capability 7 — Form interaction surface
Acceptance criteria:
- `npm test` passes.
- `test/control/forms.test.js` passes.
- Command parser supports:
  - `form list`
  - `form submit <index> [name=value ...]`

## Capability 8 — Transport security hardening
Acceptance criteria:
- `npm test` passes.
- `test/control/fetch-page.test.js` passes protocol and size-limit checks.
- Redirect protocol enforcement rejects unsupported protocols.
- Content-type gate rejects non-HTML payloads.

## Capability 9 — Agent observability
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/agent.json` exists and `reports/agent.json.overall.ok` is `true`.
- `reports/agent.json.features.trace.ok` is `true`.
- `reports/agent.json.features.spans.ok` is `true`.
- `reports/agent.json.features.outline.ok` is `true`.
- `reports/agent.json.features.chunk.ok` is `true`.

## Capability 10 — Structural rewrite operations
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

## Capability 11 — CI and release automation hardening
Acceptance criteria:
- `.github/workflows/ci.yml` runs `npm run ci`.
- `.github/workflows/release.yml` runs `npm run release:check`.
- `.github/workflows/oracle-validation-ladder.yml` runs capabilities 3.2, 3.3, and 3.4.
- `npm run release:check` passes locally.

## Capability 12 — Benchmark governance
Acceptance criteria:
- `npm run test:bench` passes.
- `reports/bench.json` exists with benchmark entries for configured widths.
- `reports/bench-governance.json` exists and `ok=true`.
- `reports/bench-governance.json.benchmarksCompared` equals emitted benchmark count.

## Capability 13 — Cookie jar parse + match determinism
Acceptance criteria:
- `npm run eval:capability-ladder:ci` passes.
- `reports/capability-ladder.json.checks.capability13.ok` is `true`.
- Cookie parsing/merge/header checks are deterministic for identical inputs.

## Capability 14 — Form submission request synthesis (GET + POST)
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability14.ok` is `true`.
- `form submit` supports both GET and POST forms.

## Capability 15 — Local recall index persistence
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability15.ok` is `true`.
- Index search returns deterministic ranking for repeated inputs.

## Capability 16 — Reader/download command surface
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability16.ok` is `true`.
- Command parser accepts `reader` and `download <path>`.

## Capability 17 — Navigation diagnostics completeness
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability17.ok` is `true`.
- Diagnostics include request method, cookie usage, and duration fields.

## Capability 18 — Command grammar hardening for stateful navigation
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability18.ok` is `true`.
- Command parser accepts `cookie list`, `cookie clear`, and `recall open <index>`.

## Capability 19 — Transport policy verification
Acceptance criteria:
- `npm run eval:capability-ladder:ci` passes.
- `reports/capability-ladder.json.checks.capability19.ok` is `true`.
- Protocol/content-type security checks reject disallowed inputs.

## Capability 20 — POST transport + Set-Cookie capture
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability20.ok` is `true`.
- `fetchPage` POST request path captures `Set-Cookie` headers.

## Capability 21 — Cookie store replay integration
Acceptance criteria:
- `npm test` passes.
- `reports/capability-ladder.json.checks.capability21.ok` is `true`.
- Cookie store replay produces deterministic header output.

## Capability 22 — Stream invariants carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/capability-ladder.json.checks.capability22.ok` is `true`.
- `reports/stream.json.overall.ok` is `true`.

## Capability 23 — Agent report carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/capability-ladder.json.checks.capability23.ok` is `true`.
- `reports/agent.json.overall.ok` is `true`.

## Capability 24 — Benchmark governance carried forward
Acceptance criteria:
- `npm run eval:ci` passes.
- `reports/capability-ladder.json.checks.capability24.ok` is `true`.
- `reports/bench-governance.json.ok` is `true`.

## Capability 25 — Release integrity continuity
Acceptance criteria:
- `npm run eval:release` passes.
- `reports/capability-ladder.json.checks.capability25.ok` is `true`.
- `reports/release-integrity.json.ok` is `true` in release profile.

## Capability 26 — Integrated capability ladder gate
Acceptance criteria:
- `npm run eval:ci` passes.
- `npm run eval:release` passes.
- `reports/capability-ladder.json.checks.capability26.ok` is `true`.
- `reports/capability-ladder.json.overall.ok` is `true`.
