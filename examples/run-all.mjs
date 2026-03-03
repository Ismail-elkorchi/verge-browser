import process from "node:process";

import { parse } from "@ismail-elkorchi/html-parser";

import { formatHelpText, parseCommand, renderDocumentToTerminal, resolveInputUrl } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCommandScenario() {
  const parsed = parseCommand("bookmark add reference-page");
  assert(parsed.kind === "bookmark-add", "parseCommand should parse bookmark add");
  assert(parsed.name === "reference-page", "parseCommand should preserve bookmark name");
  const help = formatHelpText();
  assert(help.includes("open <url>"), "formatHelpText should document open command");
}

function runUrlScenario() {
  const absolute = resolveInputUrl("example.com");
  assert(absolute === "https://example.com/", "resolveInputUrl should normalize bare hostnames");
  const resolved = resolveInputUrl("/docs", "https://example.com/base");
  assert(resolved === "https://example.com/docs", "resolveInputUrl should resolve relative paths");
}

function runRenderScenario() {
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
  assert(combined.includes("Docs"), "renderDocumentToTerminal should include heading content");
  assert(combined.includes("Deterministic output"), "renderDocumentToTerminal should include paragraph content");
}

runCommandScenario();
runUrlScenario();
runRenderScenario();

process.stdout.write("examples:run ok\n");
