import assert from "node:assert/strict";
import test from "node:test";

import { parseHtml, renderDocumentToTerminal } from "../../dist/mod.js";

test("parseHtml supports low-level rendering from the verge-browser entrypoint", () => {
  const tree = parseHtml("<main><h1>Docs</h1><p>Deterministic output.</p></main>");
  const rendered = renderDocumentToTerminal({
    tree,
    requestUrl: "https://example.test",
    finalUrl: "https://example.test",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const output = rendered.lines.join("\n");
  assert.match(output, /Docs/);
  assert.match(output, /Deterministic output/);
});
