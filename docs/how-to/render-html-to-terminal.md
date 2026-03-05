# Render HTML To Terminal

Goal: convert parsed HTML into deterministic terminal lines.

```ts
import { parse } from "@ismail-elkorchi/html-parser";
import { renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";

const tree = parse("<main><h1>Release</h1><p>Stable output.</p></main>");

const rendered = renderDocumentToTerminal({
  tree,
  requestUrl: "https://example.com",
  finalUrl: "https://example.com",
  status: 200,
  statusText: "OK",
  fetchedAtIso: "2026-01-01T00:00:00.000Z",
  width: 72
});

console.log(rendered.lines.slice(0, 3));
```

Expected output:
- Stable line ordering and wrapping at fixed width.
