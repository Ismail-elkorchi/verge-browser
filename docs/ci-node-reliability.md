# CI node reliability sample (before/after oracle-image cache hardening)

## Scope
This report measures `CI` workflow `node` job reliability before and after commit `fd9887b1d9e3577b306deb75c1185be8cd774964` (`ci(oracle): prebuild and cache oracle image artifacts`), with stratified sampling by event type.

## Method
- Sample source: GitHub Actions runs fetched with `gh` CLI.
- Job under test: `node` in workflow `CI`.
- Exclusions: cancelled runs and missing/cancelled `node` jobs.
- Strata:
  - `push`
  - `pull_request`
- Sample size profile:
  - `push`: 5 before + 5 after
  - `pull_request`: 9 before + 9 after
  - total: 28 runs
- Confidence interval model:
  - Wilson interval for each failure-rate estimate.
  - Normal approximation interval for failure-rate delta.
- Command:
  - `npm run ci:reliability:sample:stratified`
- Artifact:
  - `reports/ci-node-reliability.json`

## Claim criterion
Reliability improvement is claimable only if:
- before/after failure-rate confidence intervals are non-overlapping
- and the upper bound of the failure-rate delta interval is below 0

Use:
- `npm run ci:reliability:claim`
to enforce this criterion (`--require-non-overlap`).

## Latest stratified result
- Before (overall): failed 2 / total 14, failure rate 0.142857, CI [0.040093, 0.399419]
- After (overall): failed 0 / total 14, failure rate 0.000000, CI [0.000000, 0.215317]
- Delta failure rate: -0.142857, CI [-0.326160, 0.040446]
- Claim status: `false` (interval criterion not met)

## Sample composition
- Before and after samples are selected independently per stratum (`push`, `pull_request`).
- Each stratum is sorted by recency and sampled deterministically from completed runs with completed `node` jobs.

## Interpretation boundary
This method quantifies uncertainty and blocks over-claiming when intervals overlap.
It still does not isolate all external factors (runner fleet variance, network variability, and unrelated repository changes across historical runs).
