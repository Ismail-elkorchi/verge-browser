# Phase 3.3 Fingerprint Drift Gate

Commands:
- `npm run eval:phase33:ci`
- `npm run eval:phase33:release`

Mechanism:
1. Executes phase-3.1 real-oracle validation.
2. Recomputes image fingerprint from `scripts/oracles/oracle-image.lock.json`.
3. Compares recomputed fingerprint against `reports/oracle-runtime.json.image.fingerprint`.
4. Verifies binary fingerprint completeness for `lynx`, `w3m`, `links2`.
5. Writes `reports/eval-phase33-summary.json`.

Pass condition:
- `reports/eval-phase33-summary.json.ok` is `true`.
