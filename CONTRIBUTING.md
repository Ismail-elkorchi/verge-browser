# Contributing

## Workflow
- Use feature branches and reviewable pull requests.
- Keep changes scoped and test-backed.

## Local checks
Run before opening a pull request:

```bash
npm run ci
```

For release candidate checks:

```bash
npm run release:check
```

Standalone evaluation commands:

```bash
npm run eval:ci
npm run eval:release
npm run eval:oracle-runtime:release
npm run eval:oracle-superiority:release
npm run eval:oracle-fingerprint:release
npm run eval:oracle-supply-chain:release
npm run test:bench
```

## Commit style
Use Conventional Commits:
- `feat(scope): summary`
- `fix(scope): summary`
- `chore(scope): summary`
- `docs(scope): summary`
