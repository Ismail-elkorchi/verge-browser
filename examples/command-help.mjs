/**
 * What it does: parses a CLI command and generates deterministic help output.
 * Expected output: prints "command-help ok" when parse/help assertions pass.
 * Constraints: command grammar must stay aligned with `parseCommand` behavior.
 * Run: npm run build && node examples/command-help.mjs
 */
import { pathToFileURL } from "node:url";

import { formatHelpText, parseCommand } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runCommandHelp() {
  const parsed = parseCommand("bookmark add reference-page");
  assert(parsed.kind === "bookmark-add", "parseCommand should parse bookmark add");
  assert(parsed.name === "reference-page", "parseCommand should preserve bookmark name");

  const help = formatHelpText();
  assert(help.includes("Ctrl+L"), "help text should explain address and search focus");
  assert(help.includes("Ctrl+T / Ctrl+W"), "help text should explain tab management");
  assert(help.includes("Alt+Left/Right"), "help text should explain page history navigation");
  assert(help.includes("save text <path>"), "help text should include export actions");
  return parsed;
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  runCommandHelp();
  console.log("command-help ok");
}
