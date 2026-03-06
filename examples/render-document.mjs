/**
 * What it does: renders parsed HTML into deterministic terminal lines.
 * Expected output: prints "render-document ok" and asserts heading/body text visibility.
 * Constraints: requires built verge-browser output only; no separate html-parser install is needed.
 * Run: npm run build && node examples/render-document.mjs
 */
import { parseHtml, renderDocumentToTerminal } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runRenderDocument() {
  const tree = parseHtml("<article><h1>Docs</h1><p>Deterministic output.</p></article>");
  const rendered = renderDocumentToTerminal({
    tree,
    requestUrl: "https://example.test",
    finalUrl: "https://example.test",
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
