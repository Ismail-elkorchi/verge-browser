# verge-browser

`verge-browser` is a deterministic terminal web browser built with `html-parser`.
It targets modern Node terminals and focuses on controlled rendering, auditable behavior, and reproducible outputs.

## Positioning
- Terminal-first browsing for HTML content.
- Deterministic rendering from parsed tree to terminal lines.
- Link indexing for keyboard navigation.
- Strict development gates (`lint`, `typecheck`, `test`, `build`).

`verge-browser` is not a JavaScript runtime, not a CSS engine, and not a full browser engine.

## Runtime model
- Runtime dependency: `html-parser` (local file dependency during development).
- Runtime fetch: Web `fetch` API in Node.
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
- `links`
- `open <index>`
- `open <url>`
- `go <url>`
- `back`
- `forward`
- `reload`
- `quit`

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Architecture
- `src/cli.ts`: interactive command loop and terminal integration.
- `src/app/fetch-page.ts`: deterministic fetch boundary.
- `src/app/session.ts`: history, navigation state, page lifecycle.
- `src/app/render.ts`: AST-to-terminal rendering pipeline.
- `src/app/commands.ts`: command parser.
- `src/app/url.ts`: URL resolution and normalization.

## Security posture
- No dynamic code execution in rendering.
- Network operations are timeout-bounded.
- Parsing is delegated to `html-parser` and remains deterministic for equal input/options.
