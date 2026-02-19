# Phase 3.3 Fingerprint Drift Gate

Commands:
- `npm run eval:oracle-fingerprint:ci`
- `npm run eval:oracle-fingerprint:release`

Mechanism:
1. Executes phase-3.1 real-oracle validation.
2. Recomputes image fingerprint from `scripts/oracles/oracle-image.lock.json`.
3. Compares recomputed fingerprint against `reports/oracle-runtime.json.image.fingerprint`.
4. Verifies binary fingerprint completeness for `lynx`, `w3m`, `links2`.
5. Writes `reports/eval-oracle-fingerprint-summary.json`.

Pass condition:
- `reports/eval-oracle-fingerprint-summary.json.ok` is `true`.
