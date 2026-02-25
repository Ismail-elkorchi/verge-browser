# Supply-chain envelope gate

Commands:
- `npm run eval:oracle-supply-chain:ci`
- `npm run eval:oracle-supply-chain:release`

Mechanism:
1. Executes oracle runtime validation.
2. Runs `scripts/oracles/analyze-supply-chain.mjs`.
3. Enforces:
   - package closure count bound from `evaluation.config.json.oracleSupplyChain.maxOraclePackageCount`
   - required root packages present (`lynx`, `w3m`, `links2`)
   - runtime fingerprints available for each required engine
   - provenance policy from `evaluation.config.json.oracleSupplyChain.provenancePolicy`:
     - snapshot replay source mode
     - HTTPS-only snapshot and package index URLs
     - signed release metadata key presence/format
     - HTTPS-only package download URLs
4. Writes:
   - `reports/oracle-supply-chain.json`
   - `reports/eval-oracle-supply-chain-summary.json`

Pass condition:
- `reports/eval-oracle-supply-chain-summary.json.ok` is `true`.

Negative drift coverage:
- `test/fixtures/oracle-supply-chain-policy-cases.json` contains malformed lock scenarios.
- `test/control/oracle-supply-chain-policy-fixtures.test.js` enforces deterministic failures for each scenario.
