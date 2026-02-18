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
npm run eval:phase31:release
npm run eval:phase32:release
npm run eval:phase33:release
npm run eval:phase34:release
npm run test:bench
```

## Commit style
Use Conventional Commits:
- `feat(scope): summary`
- `fix(scope): summary`
- `chore(scope): summary`
- `docs(scope): summary`
