# verge-browser

`verge-browser` is a deterministic terminal web browser built with `html-parser`.
It targets modern Node, Deno, and Bun terminals and focuses on controlled rendering, auditable behavior, and reproducible outputs.

## Positioning
- Terminal-first browsing for HTML content.
- Deterministic rendering from parsed tree to terminal lines.
- Paging and keyboard shortcuts for high-volume terminal reading.
- Persistent bookmarks and history across sessions.
- Strict development gates (`lint`, `typecheck`, `test`, `build`) and CI/release automation.
- Shortcut mapping is isolated and testable for deterministic key behavior.
- Rendering quality is measured by reproducible corpus-based evaluation.

`verge-browser` is not a JavaScript runtime, not a CSS engine, and not a full browser engine.

## Runtime model
- Runtime dependency: `html-parser` (local file dependency during development).
- Runtime targets: Node, Deno, Bun.
- Browser runtime target: out of scope.
- Rendering: parse with `html-parser`, then convert AST to terminal lines and link table.

## Usage

```bash
npm install
npm run build
npm run start -- https://example.com
```

Offline entrypoints:
- `about:help` for built-in command help page
- `file:///absolute/path/to/file.html` for local HTML files

Interactive commands:
- `help`
- `view`
- `reader`
- `links`
- `diag`
- `outline`
- `open <index>`
- `open <url>`
- `go <url>`
- `stream <url>`
- `find <query>`
- `find next`
- `find prev`
- `form list`
- `form submit <index> [name=value ...]`
- `patch remove-node <id>`
- `patch replace-text <id> <value>`
- `patch set-attr <id> <name> <value>`
- `patch remove-attr <id> <name>`
- `patch insert-before <id> <html>`
- `patch insert-after <id> <html>`
- `bookmark list`
- `bookmark add [name]`
- `bookmark open <index>`
- `cookie list`
- `cookie clear`
- `history`
- `history open <index>`
- `recall <query>`
- `recall open <index>`
- `back`
- `forward`
- `reload`
- `download <path>`
- `quit`

Keyboard shortcuts:
- `j` / `k` or `Down` / `Up`: scroll one line
- `Space` / `b`: scroll one page
- `g` / `G`: jump to top / bottom
- `/` / `n` / `N`: search prompt / next / previous match
- `h` / `f` / `r`: back / forward / reload
- `l`: links view
- `o`: outline view
- `d`: diagnostics view
- `m`: add bookmark for current page
- `H`: history view
- `?`: help view
- `:`: command prompt
- `q`: quit

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run ci
npm run smoke:cli
npm run eval:ci
npm run eval:release
npm run test:bench
npm run eval:oracle-runtime:release
npm run eval:oracle-superiority:release
npm run eval:oracle-fingerprint:release
npm run eval:oracle-supply-chain:release
npm run oracle:lock:refresh
npm run eval:capability-ladder:ci
npm run eval:capability-ladder:release
npm run release:check
```

## Evaluation
- Config: `evaluation.config.json`
- Corpus: `scripts/oracles/corpus/render-v3.json` (1200 deterministic cases)
- Commands:
  - `npm run eval:ci`
  - `npm run eval:release`
  - `npm run eval:oracle-runtime:ci`
  - `npm run eval:oracle-runtime:release`
  - `npm run oracle:lock:refresh`
  - `npm run eval:oracle-superiority:ci`
  - `npm run eval:oracle-superiority:release`
  - `npm run eval:oracle-fingerprint:ci`
  - `npm run eval:oracle-fingerprint:release`
  - `npm run eval:oracle-supply-chain:ci`
  - `npm run eval:oracle-supply-chain:release`
  - `npm run eval:capability-ladder:ci`
  - `npm run eval:capability-ladder:release`
- Contracts:
  - `docs/rendering-contract.md`
  - `docs/acceptance-gates.md`
  - `docs/eval-report-format.md`
  - `docs/oracle-runtime-validation.md`
  - `docs/oracle-superiority.md`
  - `docs/oracle-fingerprint-drift.md`
  - `docs/oracle-supply-chain.md`
  - `docs/benchmark-governance.md`
  - `docs/capability-roadmap.md`

## Persistence model
- State file stores bookmarks, history, cookies, and indexed recall documents as JSON.
- Default path:
  - `${XDG_STATE_HOME}/verge-browser/state.json`
  - fallback: `~/.local/state/verge-browser/state.json`
- History is deduplicated by URL and bounded by a fixed limit.

## Architecture
- `src/cli.ts`: interactive command loop and terminal integration.
- `src/app/fetch-page.ts`: deterministic fetch boundary.
- `src/app/forms.ts`: form extraction and deterministic GET submission URL building.
- `src/app/cookies.ts`: deterministic cookie parse/match/replay utilities.
- `src/app/pager.ts`: viewport and paging mechanics.
- `src/app/search.ts`: deterministic in-view search indexing and navigation.
- `src/app/shortcuts.ts`: keyboard shortcut mapping.
- `src/app/session.ts`: history, navigation state, page lifecycle.
- `src/app/storage.ts`: persistent bookmarks, history, cookies, and recall index.
- `src/app/render.ts`: AST-to-terminal rendering pipeline.
- `src/app/commands.ts`: command parser.
- `src/app/security.ts`: protocol/content-type/size policy enforcement.
- `src/app/url.ts`: URL resolution and normalization.

## Security posture
- No dynamic code execution in rendering.
- Network operations are bounded by timeout, redirect cap, protocol allowlist, content-type checks, and max-content-bytes.
- Parsing is delegated to `html-parser` and remains deterministic for equal input/options.
- Persistent state writes use atomic file replacement (`.tmp` + rename).

## Automation
- CI workflow: `.github/workflows/ci.yml`
  - installs dependencies
  - runs `npm run ci`
  - runs CLI smoke via `npm run smoke:cli`
- Release workflow: `.github/workflows/release.yml`
  - runs `npm run release:check`
  - produces npm package artifact (`.tgz`)
  - emits package checksum (`package.sha256`)
- Oracle validation workflow: `.github/workflows/oracle-runtime-validation.yml`
  - runs `npm run eval:oracle-runtime:release`
  - uploads oracle runtime artifacts and lock file
- Oracle ladder workflow: `.github/workflows/oracle-validation-ladder.yml`
  - runs oracle superiority, fingerprint drift, and supply-chain release checks
  - uploads oracle validation reports
