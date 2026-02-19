# Oracle Runtime Validation

Oracle runtime validation checks rendering claims with real terminal browser binaries.

## Commands
- `npm run eval:oracle-runtime:ci`
- `npm run eval:oracle-runtime:release`
- `npm run oracle:lock:refresh` (maintainer action, updates `scripts/oracles/oracle-image.lock.json`)
- GitHub PR CI job: `.github/workflows/ci.yml` (`node`, runs `npm run eval:oracle-runtime:ci`)
- Scheduled/manual workflow: `.github/workflows/oracle-runtime-validation.yml`

## What the pass does
1. Builds a rootless oracle host image under `tmp/oracle-image/` from Ubuntu `.deb` packages.
2. Pins package versions and `.deb` hashes in `scripts/oracles/oracle-image.lock.json`.
3. Extracts binaries and runtime libraries into `tmp/oracle-image/rootfs/`.
4. Captures binary fingerprints for:
   - `lynx`
   - `w3m`
   - `links2`
5. Executes each engine against sampled corpus cases and records baseline outputs.
6. Evaluates `verge-browser` against those real baselines with the same metric definitions used in the core render eval.
   - Oracle runtime validation enforces metric floors and coverage.
   - Comparative superiority delta is reported but not a blocking gate in this pass.

## Reproducibility contract
- Package identity is lock-driven (`name`, `version`, `.deb` `sha256`).
- Each locked package carries a direct replay URL (`downloadUrl`) and pool path (`filename`).
- Rootfs content fingerprint is derived from the lock file package list + hashes.
- Binary fingerprints are captured per run (`path`, `sizeBytes`, `sha256`, `version` output).

## Artifacts
- `reports/oracle-runtime.json`
- `reports/render-baselines-real.json`
- `reports/render-verge-real.json`
- `reports/render-score-real.json`
- `reports/eval-oracle-runtime-summary.json`

## Runtime notes
- This pass does not require `sudo`.
- Lock replay requires `curl` and `dpkg-deb`.
- Lock refresh additionally requires `apt` and `apt-cache`.
- The default release sample size is 320 cases at widths `80` and `120`.
