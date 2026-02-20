# CI node reliability sample (rolling windows, stratified)

## Scope
This report measures `CI` workflow `node` job reliability using stratified rolling windows per event type.

## Method
- Sample source: GitHub Actions runs fetched with `gh` CLI.
- Job under test: `node` in workflow `CI`.
- Exclusions: cancelled runs and missing/cancelled `node` jobs.
- Strata:
  - `push`
  - `pull_request`
- Window profile:
  - rolling windows per stratum: 3 (`current`, `prior-1`, `prior-2`)
  - sample size per window:
    - `push`: 5 runs
    - `pull_request`: 9 runs
  - comparison for claim:
    - `current` vs `prior-1` per stratum
- Confidence interval model:
  - Wilson interval for each failure-rate estimate.
  - Normal approximation interval for failure-rate delta.
- Command:
  - `npm run ci:reliability:sample:stratified`
- Artifact:
  - `reports/ci-node-reliability.json`

## Claim criterion
Reliability improvement is claimable only if:
- for each stratum and overall, `current` vs `prior-1` failure-rate confidence intervals are non-overlapping
- and the upper bound of the failure-rate delta interval is below 0

Claim status values:
- `improved`: strict criterion satisfied.
- `not-improved`: enough evidence exists, strict criterion not satisfied.
- `insufficient-evidence`: windows are not comparable or both compared windows have zero failures.

Use:
- `npm run ci:reliability:claim`
to enforce this criterion (`--require-non-overlap`).

## Latest stratified result
Run `npm run ci:reliability:sample:stratified` and read `reports/ci-node-reliability.json`.
The report includes:
- per-stratum window summaries and confidence intervals
- current vs prior delta intervals
- strict claim result (`claim.canClaimImprovement`)

## Sample composition
- Windows are selected independently per stratum (`push`, `pull_request`).
- Each stratum is sorted by recency and sampled deterministically from completed runs with completed `node` jobs.

## Interpretation boundary
This method quantifies uncertainty and blocks over-claiming when intervals overlap.
It still does not isolate all external factors (runner fleet variance, network variability, and unrelated repository changes across historical runs).
