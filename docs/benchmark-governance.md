# Benchmark Governance

Commands:
- `npm run test:bench`
- `npm run eval:ci`
- `npm run eval:release`

Artifacts:
- `reports/bench.json`
- `reports/bench-governance.json`

Rules:
1. Benchmarks are deterministic by fixed corpus sampling (`hashInt(caseId)` ordering).
2. Required benchmark names come from `evaluation.config.json.benchmarks.required`.
3. `reports/bench-governance.json.ok` must be `true` for CI and release evaluation.
4. Governance checks schema completeness and benchmark coverage; it does not apply host-specific throughput thresholds.
