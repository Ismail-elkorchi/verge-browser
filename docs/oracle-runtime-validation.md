# Oracle Runtime Validation

Oracle runtime validation checks rendering claims with real terminal browser binaries.

## Commands
- `npm run eval:oracle-runtime:ci`
- `npm run eval:oracle-runtime:release`
- `npm run oracle:lock:refresh` (maintainer action, updates `scripts/oracles/oracle-image.lock.json`)
- `npm run oracle:lock:refresh -- --snapshot-id=YYYYMMDDTHHMMSSZ` (explicit immutable snapshot)
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
5. Executes each engine with a deterministic runner policy:
   - environment: `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `LANGUAGE=C`, `TZ=UTC`, `TERM=dumb`, `NO_COLOR=1`
   - per-engine argument templates are emitted in `reports/oracle-runtime.json.runnerPolicy`.
6. Executes each engine against sampled corpus cases and records baseline outputs.
7. Evaluates `verge-browser` against those real baselines with the same metric definitions used in the core render eval.
   - Oracle runtime validation enforces metric floors and coverage.
   - Comparative superiority delta is reported but not a blocking gate in this pass.

## Reproducibility contract
- Package identity is lock-driven (`name`, `version`, `.deb` `sha256`, `suite`, `component`).
- Replay source is lock-driven:
  - `sourcePolicy.mode = snapshot-replay`
  - `sourcePolicy.snapshotRoot`
  - `sourcePolicy.snapshotId`
- Each locked package carries a direct replay URL (`downloadUrl`) and pool path (`filename`).
- Rootfs content fingerprint is derived from the lock file package list + hashes.
- Binary fingerprints are captured per run (`path`, `sizeBytes`, `sha256`, `version` output).
- Lock refresh verifies signed release metadata:
  - fetches `dists/<suite>/InRelease` from the snapshot
  - verifies signatures with `gpgv` and Ubuntu archive keyring
  - verifies signed `Packages` index hashes
  - verifies each locked package `(name, version, filename, sha256)` is present in the signed index

## Artifacts
- `reports/oracle-runtime.json`
- `reports/render-baselines-real.json`
- `reports/render-verge-real.json`
- `reports/render-score-real.json`
- `reports/eval-oracle-runtime-summary.json`

## Runtime notes
- This pass does not require `sudo`.
- Lock replay requires `curl` and `dpkg-deb`.
- Lock refresh additionally requires `apt`, `apt-cache`, `gpgv`, and the Ubuntu archive keyring at `/usr/share/keyrings/ubuntu-archive-keyring.gpg`.
- The default release sample size is 320 cases at widths `80` and `120`.
