/**
 * Demonstrates HTML-to-terminal rendering through verge-browser primitives.
 * Run: npm run build && node examples/render-document.mjs
 */
import { parse } from "@ismail-elkorchi/html-parser";

import { renderDocumentToTerminal } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runRenderDocument() {
  const tree = parse("<article><h1>Docs</h1><p>Deterministic output.</p></article>");
  const rendered = renderDocumentToTerminal({
    tree,
    requestUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const combined = rendered.lines.join("\n");
  assert(combined.includes("Docs"), "render output should include heading text");
  assert(combined.includes("Deterministic output"), "render output should include paragraph text");
  return rendered;
}

if (import.meta.main) {
  runRenderDocument();
  console.log("render-document ok");
}
