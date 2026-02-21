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
npm run field:visible-text:ab
npm run field:governance
npm run field:report
```

Layout pilot commands (local-only):

```bash
npm run field:layout:wpt:fetch
npm run field:layout:wpt:run
```

Layout pilot uses a pinned WPT subset manifest:

- `scripts/realworld/layout/wpt-subset.v1.json`

Raw WPT files are cached under ignored paths:

- `realworld/corpus/layout/cache/wpt/<commit>/...`

Reports are written under ignored paths:

- `realworld/corpus/layout/reports/layout-wpt-fetch.json`
- `realworld/corpus/layout/reports/layout-pilot.json`
- `realworld/corpus/layout/reports/layout-pilot.ndjson`
- `realworld/corpus/reports/cohort-governance-v4.json`
- `realworld/corpus/reports/cohort-snapshot-fingerprint-v1.json`

Visible-text policy compare dependency:

- `field:visible-text:ab` requires css-parser style-signal helpers.
- Module lookup order:
  1. `VERGE_CSS_PARSER_MODULE_PATH`
  2. `../css-parser/dist/mod.js` (sibling repository default)

Oracle source selection:

- `VERGE_ORACLE_SOURCE=auto` (default): use host binaries if all are installed, otherwise use the rootless oracle image.
- `VERGE_ORACLE_SOURCE=host`: only use host binaries from `PATH`.
- `VERGE_ORACLE_SOURCE=image`: only use the rootless oracle image binaries.
- `VERGE_ORACLE_REBUILD_LOCK=0`: keep the local image lock file if already present (default rebuild is enabled).

Visible-text policy candidates:

- `baseline`: html-parser default visible-text contract.
- `rendered-terminal-v1`: terminal-aligned rendered-visible approximation that does not skip `hidden`/`aria-hidden` subtrees.
- `rendered-style-v1`: style-signal filtered rendered-visible approximation using css-parser selectors and declarations.

Cohort governance policy:

- policy manifest: `scripts/realworld/cohorts/cohort-governance-v4.json`
- required cohorts:
  - `standards-reference`
  - `application-auth-challenge`
  - `dynamic-interaction-heavy`
- release decision artifact requirements:
  - per-cohort score table
  - weighted aggregate deltas
  - snapshot fingerprint for replay identity
