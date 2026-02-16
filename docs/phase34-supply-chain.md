# Phase 3.4 Supply-chain Envelope Gate

Commands:
- `npm run eval:phase34:ci`
- `npm run eval:phase34:release`

Mechanism:
1. Executes phase-3.1 real-oracle validation.
2. Runs `scripts/oracles/analyze-supply-chain.mjs`.
3. Enforces:
   - package closure count bound from `evaluation.config.json.phase34.maxOraclePackageCount`
   - required root packages present (`lynx`, `w3m`, `links2`)
   - runtime fingerprints available for each required engine
4. Writes:
   - `reports/oracle-supply-chain.json`
   - `reports/eval-phase34-summary.json`

Pass condition:
- `reports/eval-phase34-summary.json.ok` is `true`.
