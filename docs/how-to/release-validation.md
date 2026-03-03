# How-to: Release Validation

Use this sequence before requesting a release cut.

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
