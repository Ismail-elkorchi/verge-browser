# Phase 3.2 Superiority Gate

Commands:
- `npm run eval:phase32:ci`
- `npm run eval:phase32:release`

Mechanism:
1. Executes phase-3.1 real-oracle validation.
2. Reads `reports/render-score-real.json`.
3. Enforces strict comparative win per configured metric:
   - `verge(metric) >= bestBaseline(metric) + comparativeWinDelta`.
4. Writes `reports/eval-phase32-summary.json`.

Pass condition:
- `reports/eval-phase32-summary.json.ok` is `true`.
