# Fingerprint drift gate

Commands:
- `npm run eval:oracle-fingerprint:ci`
- `npm run eval:oracle-fingerprint:release`

Mechanism:
1. Executes oracle runtime validation.
2. Validates fingerprint inputs from `scripts/oracles/oracle-image.lock.json`:
   - package list is non-empty
   - package records contain `name`, `version`, `debSha256`, `downloadUrl`
   - package list is sorted by `name`/`version` and contains no duplicates
3. Recomputes image fingerprint from lock package inputs.
4. Compares recomputed fingerprint against `reports/oracle-runtime.json.image.fingerprint`.
5. Verifies binary fingerprint completeness for `lynx`, `w3m`, `links2`.
6. Writes `reports/eval-oracle-fingerprint-summary.json`.

Pass condition:
- `reports/eval-oracle-fingerprint-summary.json.ok` is `true`.
