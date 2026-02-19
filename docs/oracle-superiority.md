# Superiority gate

Commands:
- `npm run eval:oracle-superiority:ci`
- `npm run eval:oracle-superiority:release`

Mechanism:
1. Executes oracle runtime validation.
2. Reads `reports/render-score-real.json`.
3. Enforces strict comparative win per configured metric:
   - `verge(metric) >= bestBaseline(metric) + comparativeWinDelta`.
4. Writes `reports/eval-oracle-superiority-summary.json`.

Pass condition:
- `reports/eval-oracle-superiority-summary.json.ok` is `true`.
