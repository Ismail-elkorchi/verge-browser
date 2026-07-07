# Release Validation

Use this page for maintainer release checks and publish readiness.

## Publish model

Publishing is done by GitHub Actions OIDC workflows:
- `.github/workflows/publish.yml` for release-triggered publish.
- `.github/workflows/publish-manual.yml` for manual dry-run and controlled publish.

## Verification commands

```bash
npm ci
npm run release:check
npm run docs:html:jsr
node scripts/release/render-notes.mjs --dry-run
node scripts/release/update-changelog.mjs --dry-run
```

## Release note format

Release note bullets are rendered as:
- `[PR title] (#123)`

Author suffixes are intentionally excluded.
