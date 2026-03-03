# @ismail-elkorchi/verge-browser

Deterministic terminal browsing utilities and CLI workflows for turning HTML input into auditable, reproducible terminal output.

## Install

```bash
npm install @ismail-elkorchi/verge-browser @ismail-elkorchi/html-parser
```

```ts
import { resolveInputUrl } from "jsr:@ismail-elkorchi/verge-browser";
```

## Success Path

```ts
import { parse } from "@ismail-elkorchi/html-parser";
import {
  formatHelpText,
  parseCommand,
  renderDocumentToTerminal,
  resolveInputUrl
} from "@ismail-elkorchi/verge-browser";

const resolved = resolveInputUrl("example.com");
const command = parseCommand("bookmark add release-notes");

const tree = parse("<article><h1>Docs</h1><p>Deterministic output.</p></article>");
const rendered = renderDocumentToTerminal({
  tree,
  requestUrl: resolved,
  finalUrl: resolved,
  status: 200,
  statusText: "OK",
  fetchedAtIso: "2026-01-01T00:00:00.000Z",
  width: 80
});

console.log(command.kind);
console.log(rendered.lines.slice(0, 4).join("\n"));
console.log(formatHelpText().includes("open <url>"));
```

Runnable examples:

```bash
npm run examples:run
```

## Options / API Reference

- [Options and API reference](./docs/reference/options.md)

## When To Use

- You need deterministic terminal rendering for HTML content.
- You need scriptable command parsing and URL resolution utilities.
- You need a CLI-oriented browsing flow with reproducible behavior.

## When Not To Use

- You need JavaScript execution or a full browser engine.
- You need pixel-accurate visual rendering.
- You need unrestricted network protocols or unbounded content ingestion.

## Security Note

Network access is policy-constrained (protocol allowlist, content checks, bounded fetch behavior). HTML parsing is deterministic but does not sanitize untrusted content for downstream rendering contexts. See [SECURITY.md](./SECURITY.md).
