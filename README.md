# @ismail-elkorchi/verge-browser

Deterministic terminal browsing utilities and CLI helpers for auditable text-first browsing workflows.

No runtime dependencies are added beyond declared package dependencies.

## When To Use

- You need deterministic terminal rendering from HTML input.
- You need command parsing, URL resolution, and policy-checked fetch helpers.
- You need reproducible output for automation and audits.

## When Not To Use

- You need full browser JavaScript execution.
- You need pixel-accurate rendering.
- You need unrestricted network protocol access.

## Install

```bash
npm install @ismail-elkorchi/verge-browser
```

```bash
deno add jsr:@ismail-elkorchi/verge-browser
```

## Import

```ts
import { parseCommand, renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";
```

```txt
import { parseCommand, renderDocumentToTerminal } from "jsr:@ismail-elkorchi/verge-browser";
```

Low-level parsing helpers such as `parseHtml()` are exported from `@ismail-elkorchi/verge-browser`, so npm consumers do not need a separate `@ismail-elkorchi/html-parser` install for normal library usage.

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
import { DEFAULT_SECURITY_POLICY, assertAllowedUrl, fetchPage } from "@ismail-elkorchi/verge-browser";

const url = "https://example.com";
assertAllowedUrl(url, DEFAULT_SECURITY_POLICY);
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

## Security and Safety Notes

- URL and protocol checks are mandatory for network workflows.
- Parsing/rendering is deterministic but not a sanitizer for downstream HTML execution.
- Handle `NetworkFetchError` as a first-class expected failure mode.

## Documentation

- [Docs index](./docs/index.md)
- [First session tutorial](./docs/tutorial/first-session.md)
- [Options reference](./docs/reference/options.md)
