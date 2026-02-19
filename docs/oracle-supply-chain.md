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
4. Writes:
   - `reports/oracle-supply-chain.json`
   - `reports/eval-oracle-supply-chain-summary.json`

Pass condition:
- `reports/eval-oracle-supply-chain-summary.json.ok` is `true`.
