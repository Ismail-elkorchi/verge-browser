# @ismail-elkorchi/verge-browser

Terminal browsing primitives with safe fetch helpers, HTML snapshots, and auditable text rendering.

## When To Use

- You need deterministic terminal rendering from HTML input.
- You need command parsing, URL resolution, and policy-checked fetch helpers.
- You need reproducible output for automation and audits.

## What This Is Not

- You need full browser JavaScript execution.
- You need pixel-accurate rendering.
- You need unrestricted network protocol access.

## Behavioral Boundaries

- The interactive `verge` CLI is supported from the npm package on Node.js.
- The published JSR package is utility-only. It does not publish a global `verge` command.
- The renderer produces deterministic text output for the same parsed input and terminal width.
- Line wrapping and link/control line numbers can change when terminal width changes.
- Pages that depend on client-side JavaScript or anti-bot challenges can render partially or fail open with explicit diagnostics.

## Install

Node.js global CLI:

```bash
npm install --global @ismail-elkorchi/verge-browser
```

Open the built-in help screen or browse a page:

```bash
verge about:help
verge https://example.com
```

Node.js library usage:

```bash
npm install @ismail-elkorchi/verge-browser
```

JSR/Deno library usage:

```bash
deno add jsr:@ismail-elkorchi/verge-browser
```

The documented CLI distribution is the npm `verge` binary on Node.js. The
JSR/Deno surface and Bun support in this package are library primitives, not a
separately published global `verge` command.

## CLI Quickstart

Use the Node.js CLI when you want an interactive terminal session:

```bash
verge https://example.com
```

Inside the session, the primary browse loop is page-first:

```txt
] or Tab   focus the next link or control
Enter      open the focused target
h          go back
g          open the location palette
l          open the links overview
?          open help
q          quit
```

`verge` opens the first positional target immediately. If no target is provided, the CLI reopens the latest history URL when one exists, otherwise it falls back to `about:help`.

`verge <url> --once` is an automation flag that loads the initial target and
exits without entering the interactive browsing loop. It is not the right mode
when you want terminal output to stay on screen for manual browsing.

Use `:` when you want the action palette instead of direct browse keys. Actions such as `documents`, `history`, `bookmark add`, `save text <path>`, `save csv <path>`, `download <path>`, and `open-external` all run from that palette.

Use `--screen-reader` when you want the screen-reader-friendly chrome profile.

## Import

```ts
import { parseCommand, renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";
```

```ts
import { DEFAULT_SECURITY_POLICY, assertAllowedUrl, resolveHref, resolveInputUrl } from "jsr:@ismail-elkorchi/verge-browser";
```

Low-level parsing helpers such as `parseHtml()` are exported from `@ismail-elkorchi/verge-browser`, so npm consumers do not need a separate `@ismail-elkorchi/html-parser` install for normal library usage.

The published JSR package currently exposes the safe URL and fetch-policy utility surface. Use the npm package for the full terminal browser and CLI-oriented API.

## Copy/Paste Examples

### Example 1: Parse command input

```ts
import { parseCommand } from "@ismail-elkorchi/verge-browser";

const command = parseCommand("open https://example.com");
console.log(command.kind);
```

### Example 2: Resolve URLs safely

```ts
import { resolveHref, resolveInputUrl } from "@ismail-elkorchi/verge-browser";

const base = resolveInputUrl("example.com");
console.log(resolveHref("/docs", base));
```

### Example 3: Render HTML to terminal output

```ts
import { parseHtml, renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";

const tree = parseHtml("<h1>Hello</h1>");
const rendered = renderDocumentToTerminal({
  tree,
  requestUrl: "https://example.com",
  finalUrl: "https://example.com",
  status: 200,
  statusText: "OK",
  fetchedAtIso: "2026-01-01T00:00:00.000Z",
  width: 80
});

console.log(rendered.lines.length > 0);
```

### Example 4: Policy-checked fetch

```ts
import { assertAllowedUrl, fetchPage } from "@ismail-elkorchi/verge-browser";

const url = "https://example.com";
assertAllowedUrl(url);
const page = await fetchPage(url);
console.log(page.status);
```

Run packaged examples:

```bash
npm run examples:run
```

## Compatibility

Runtime compatibility matrix:

| Runtime | Status |
| --- | --- |
| Node.js | Supported (CLI and library) |
| Deno | Supported (library primitives) |
| Bun | Supported (library primitives) |
| Browser (evergreen) | Supported (library primitives) |

The Node.js package surface is verified against Node 20, 22, and 24.

## Security and Safety Notes

- URL and protocol checks are mandatory for network workflows.
- Parsing/rendering is deterministic but not a sanitizer for downstream HTML execution.
- Handle `NetworkFetchError` as a first-class expected failure mode.
- Expect remote output to reflect the package's allow-list, retry policy, and terminal width rather than browser-engine layout.

## Documentation

- [Docs index](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/index.md)
- [First session tutorial](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/tutorial/first-session.md)
- [CLI reference](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/reference/cli.md)
