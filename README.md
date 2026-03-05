# @ismail-elkorchi/verge-browser

Deterministic terminal browsing utilities and CLI workflows for turning HTML input into auditable, reproducible terminal output.

## When To Use

- You need deterministic terminal rendering for HTML content.
- You need scriptable command parsing and URL resolution utilities.
- You need a CLI-oriented browsing flow with reproducible behavior.

## When Not To Use

- You need JavaScript execution or a full browser engine.
- You need pixel-accurate visual rendering.
- You need unrestricted network protocols or unbounded content ingestion.

## Install

```bash
npm install @ismail-elkorchi/verge-browser @ismail-elkorchi/html-parser
```

```bash
deno add jsr:@ismail-elkorchi/verge-browser
```

## Quickstart

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

## Options and Config Reference

- [Options and API reference](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/reference/options.md)
- [API overview](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/reference/api-overview.md)

## Error Handling and Gotchas

- `NetworkFetchError` includes structured diagnostics; log and expose it as an expected network failure class.
- URL policy checks (`assertAllowedUrl`) intentionally block unsupported protocols.
- Rendering is deterministic text output, not a visual browser layout pipeline.
- CLI helpers assume bounded input; set policies before feeding untrusted content.

## Compatibility Matrix

| Runtime | Status | Notes |
| --- | --- | --- |
| Node.js | ✅ | CI + smoke coverage |
| Deno | ✅ | CI + smoke coverage |
| Bun | ✅ | CI + smoke coverage |
| Browser | ⚠️ | Library primitives are reusable; CLI entrypoint is Node-first |

## Security Notes

Network access is policy-constrained (protocol allowlist, content checks, bounded fetch behavior). HTML parsing is deterministic but does not sanitize untrusted content for downstream rendering contexts. See [SECURITY.md](https://github.com/Ismail-elkorchi/verge-browser/blob/main/SECURITY.md).

## Design Constraints / Non-goals

- Deterministic terminal output is prioritized over full browser fidelity.
- The package does not execute page JavaScript.
- The package does not bypass URL and protocol policy controls.

## Documentation Map

- [Tutorial](https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/tutorial/first-session.md)
- [How-to guides](https://github.com/Ismail-elkorchi/verge-browser/tree/main/docs/how-to)
- [Reference](https://github.com/Ismail-elkorchi/verge-browser/tree/main/docs/reference)
- [Explanation](https://github.com/Ismail-elkorchi/verge-browser/tree/main/docs/explanation)

## Release Validation

```bash
npm run check:fast
npm run docs:lint:jsr
npm run docs:test:jsr
npm run examples:run
npm pack --dry-run
```

Release workflow details: [RELEASING.md](https://github.com/Ismail-elkorchi/verge-browser/blob/main/RELEASING.md)
