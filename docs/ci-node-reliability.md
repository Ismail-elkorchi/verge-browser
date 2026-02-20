# CI node reliability sample (before/after oracle-image cache hardening)

## Scope
This report measures `CI` workflow `node` job reliability before and after commit `fd9887b1d9e3577b306deb75c1185be8cd774964` (`ci(oracle): prebuild and cache oracle image artifacts`).

## Method
- Sample source: GitHub Actions runs fetched with `gh` CLI.
- Job under test: `node` in workflow `CI`.
- Exclusions: cancelled runs and missing/cancelled `node` jobs.
- Sample size: 10 runs before pivot + 10 runs after pivot (20 total).
- Confidence interval model:
  - Wilson interval for each failure-rate estimate.
  - Normal approximation interval for failure-rate delta.
- Command:
  - `npm run ci:reliability:sample -- --sample-size=10 --confidence=0.95`
- Artifact:
  - `reports/ci-node-reliability.json`

## Result
- Before pivot:
  - total: 10
  - passed: 8
  - failed: 2
  - failure rate: 0.200000
- After pivot:
  - total: 10
  - passed: 10
  - failed: 0
  - failure rate: 0.000000
- Delta:
  - failure rate: -0.200000
  - failure-rate interval (95%): [-0.447923, 0.047923]

## Sample composition
- Before sample includes historical `push` and `pull_request` CI runs immediately preceding the pivot run.
- After sample includes the immediate post-pivot `push`/`pull_request` runs and controlled `workflow_dispatch` runs on branch `ci-node-reliability-sample`.

## Interpretation boundary
This sample shows reduced observed node-job failure rate after oracle-image cache hardening under the sampled run set.
It does not isolate all external factors (runner fleet variance, network variability, and unrelated repository changes across historical runs).
