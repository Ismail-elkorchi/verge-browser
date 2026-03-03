# How-to: Release Validation

Use this sequence before requesting a release cut.

## Package identity

- Intended public npm package name: `@ismail-elkorchi/verge-browser`
- Intended public JSR package name: `@ismail-elkorchi/verge-browser`
- Versioning policy: `0.x` while hardening is active.

## Registry ownership status (March 3, 2026)

- npm: `npm view @ismail-elkorchi/verge-browser` returns `404` (package not claimed/published yet).
- JSR: `jsr info @ismail-elkorchi/verge-browser` returns `404` (package not claimed/published yet).

## Release workflow publish policy

`.github/workflows/release.yml` intentionally does not run `npm publish` or `jsr publish`.
The release workflow only produces and verifies signed artifacts plus attestation evidence.

If registry publishing is enabled later, require all of the following first:
1. Confirm package ownership in npm and JSR.
2. Configure npm Trusted Publishing (OIDC) or token fallback with explicit approval.
3. Configure JSR OIDC repository trust (or token fallback) with explicit approval.

## Required checks

```bash
npm run release:check
```

`release:check` runs:
- lint/typecheck/tests/smoke/eval checks via `npm run check`
- release eval lanes
- `npm pack --dry-run`

## Package dry-runs

```bash
npm pack --dry-run
npm publish --dry-run
npx -y jsr publish --dry-run
```

During `npm pack` and `npm publish`, `prepack` rewrites the local development dependency:
- from: `@ismail-elkorchi/html-parser: file:../html-parser`
- to: `@ismail-elkorchi/html-parser: 0.1.0`

`postpack` restores the development manifest after packing.

## Bin path validation in packed artifact

```bash
rm -rf tmp/pack-check
mkdir -p tmp/pack-check
npm pack --pack-destination tmp/pack-check
tar -xzf tmp/pack-check/*.tgz -C tmp/pack-check
node tmp/pack-check/package/dist/cli.js about:help
```

Expected outcome:
- archive contains `package/dist/cli.js`
- CLI entrypoint runs from extracted artifact

## 0.1.0 dry-run evidence snapshot (March 3, 2026)

Dry-runs:
- `npm pack --dry-run --json`: pass
- `npm publish --dry-run --json --access public`: pass
- `npx -y jsr publish --dry-run --allow-dirty`: pass

Canary packed-artifact check:
- packed artifact extracted and CLI entrypoint run from archive
- `node package/dist/cli.js about:help` passes

Manual artifact sample review:
- required entries present: `package.json`, `dist/mod.js`, `dist/cli.js`, `README.md`, `LICENSE`
- forbidden content absent: `scripts/`, `test*/`, `docs/`, `reports/`, `realworld/`

Automation freshness evidence:
- Release Audit: failure (run `22622280903`)  
  <https://github.com/Ismail-elkorchi/verge-browser/actions/runs/22622280903>
- Runtime Latest (Non-blocking): success (run `22622280911`)  
  <https://github.com/Ismail-elkorchi/verge-browser/actions/runs/22622280911>

Residual risk from latest release-audit run:
- CI release-audit currently fails `evaluation coherence check` in release lane despite local pass
- release-audit lane must be stabilized before `0.1.0` go/no-go can be marked green
