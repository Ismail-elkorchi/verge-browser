# Realworld corpus layout

The field corpus is a local artifact tree used for offline deterministic replay.
Raw HTML and CSS payloads are cached for local analysis and must never be committed.

Default corpus root:

- `realworld/corpus/`

Override with:

- `VERGE_CORPUS_DIR=/absolute/path`

Layout under the corpus root:

- `cache/html/` raw HTML bytes keyed by sha256
- `cache/css/` raw CSS payloads (inline, style attrs, linked stylesheets) keyed by sha256
- `cache/oracle/` oracle renderer stdout captures
- `manifests/pages.ndjson` page fetch manifest (url metadata + sha256 pointers)
- `manifests/css.ndjson` CSS payload manifest (source metadata + sha256 pointers)
- `reports/` offline evaluation reports
- `triage/` deterministic triage outputs

Recording commands:

```bash
npm run build
VERGE_CORPUS_DIR="$(pwd)/realworld/corpus" node dist/cli.js --record-corpus --once https://example.com/
```

Offline replay commands:

```bash
npm run field:offline
npm run field:oracles
npm run field:report
```
