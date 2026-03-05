# First Session

This tutorial runs one deterministic parse/render flow and one command-parse flow.

## Step 1: Render HTML to terminal lines

```ts
import { parse } from "@ismail-elkorchi/html-parser";
import { renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";

const tree = parse("<article><h1>Hello</h1><p>World</p></article>");
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

Expected output:
- `true`.

## Step 2: Parse commands

```ts
import { parseCommand } from "@ismail-elkorchi/verge-browser";

const command = parseCommand("open https://example.com");
console.log(command.kind);
```

Expected output:
- Deterministic command kind for the same input string.

## Step 3: Run examples

```bash
npm run examples:run
```
