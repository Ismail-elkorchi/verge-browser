# Mutation Pilot (Advisory)

This document describes the first selective mutation-testing pilot for `verge-browser`.

## Scope

Pilot target:
- `dist/app/security.js`

Pilot exclusions:
- network orchestration and fetch runtime paths
- oracle runtime/superiority/fingerprint/supply-chain validation flows
- release attestation workflows and publish path

Why this scope:
- `src/app/security.ts` is a pure, deterministic policy module.
- It is critical for protocol allowlist and content-type policy behavior.
- The pilot is fast and non-blocking.

## Commands

```bash
npm run mutation:pilot
```

The pilot command builds once, applies configured mutants, and runs focused tests:
- config: `scripts/mutation/pilot-config.json`
- output: `docs/reference/mutation-pilot-report.json`

## Baseline and hardening delta

Baseline snapshot (before hardening tests):
- report: `docs/reference/mutation-pilot-report-baseline.json`
- result: `killed=1`, `survived=3`, `total=4`

Survivors identified in baseline:
- `file-protocol-removed`
- `html-content-type-disabled`
- `null-content-type-default-deny`

Hardening changes introduced in this pilot:
- added explicit allowlist test for `file:` protocol
- added `text/html` acceptance test
- added missing-content-type default-allow test

Final pilot result after hardening:
- report: `docs/reference/mutation-pilot-report.json`
- result: `killed=4`, `survived=0`, `total=4`

## Residual risk

This pilot is advisory and intentionally limited to pure policy logic.
Release attestation/oracle mutation scope remains out of this first pilot.
