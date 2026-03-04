# Releasing

## Required Secrets

- `NPM_TOKEN`
- `JSR_TOKEN`

## Trigger Release

- Push an annotated tag: `vX.Y.Z`
- Or run `release.yml` with `workflow_dispatch` and input `version: X.Y.Z`

Both paths require the requested version to match `package.json` and `jsr.json`.

## Post-Publish Verification

- `npm view @ismail-elkorchi/verge-browser version`
- `npx -y jsr info @ismail-elkorchi/verge-browser@X.Y.Z`
- Open npm and JSR package pages to verify README and docs rendering.
