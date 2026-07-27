# Contributing

Create a focused branch, install the locked dependencies, and keep behavior
changes covered by tests.

```bash
npm ci
npm run check
```

When public APIs or documentation change, also run:

```bash
npm run jsr:check
npm run examples:run
```

`npm run release:check` is the complete clean-install, cross-runtime,
documentation, deterministic fuzz, and packed-consumer qualification. Run it
before a release. Use the benchmark when work may affect parsing or rendering
performance:

```bash
npm run test:bench
```
