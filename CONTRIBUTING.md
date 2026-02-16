# Contributing

## Workflow
- Use feature branches and reviewable pull requests.
- Keep changes scoped and test-backed.

## Local checks
Run before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Commit style
Use Conventional Commits:
- `feat(scope): summary`
- `fix(scope): summary`
- `chore(scope): summary`
- `docs(scope): summary`
