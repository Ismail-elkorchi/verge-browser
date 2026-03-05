# Releasing

## Publish model

Publishing is performed via GitHub Actions OIDC (tokenless):
- npm Trusted Publishing
- JSR OIDC publishing

Use `.github/workflows/publish.yml` for release-driven publish and `.github/workflows/publish-manual.yml` for manual dry-runs or controlled publish runs.

## Required checks before publish

```bash
npm ci
npm run check:fast
npm run docs:lint:jsr
npm run docs:test:jsr
npm run examples:run
npm pack --dry-run
node scripts/quality/doc-required.mjs
```

## Release notes and changelog

```bash
node scripts/release/render-notes.mjs --dry-run
node scripts/release/update-changelog.mjs --dry-run
```

Reference details: `docs/reference/releasing.md`.
