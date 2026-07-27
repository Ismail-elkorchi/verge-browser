# Contributing

Create a focused branch, install the locked dependencies, and keep behavior
changes covered by tests.

```bash
npm ci
npm run check
```

When public APIs or documentation change, also run:

```bash
npm run docs:required
npm run docs:check:jsr
npm run examples:run
```

`npm run release:check` is the complete clean-install, cross-runtime,
evaluation, oracle, documentation, and packed-consumer qualification. Run it
before a release. The benchmark and oracle-lock refresh commands are available
for work that intentionally changes their respective baselines:

```bash
npm run test:bench
npm run oracle:lock:refresh
```
