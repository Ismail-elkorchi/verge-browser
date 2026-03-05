/**
 * What it does: parses a CLI command and generates deterministic help output.
 * Expected output: prints "command-help ok" when parse/help assertions pass.
 * Constraints: command grammar must stay aligned with `parseCommand` behavior.
 * Run: npm run build && node examples/command-help.mjs
 */
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
  assert(help.includes("open <url>"), "help text should include open command");
  return parsed;
}

if (import.meta.main) {
  runCommandHelp();
  console.log("command-help ok");
}
