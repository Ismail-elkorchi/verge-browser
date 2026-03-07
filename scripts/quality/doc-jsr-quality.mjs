import { execFileSync } from "node:child_process";

const ENTRYPOINT = "jsr/mod.ts";
const REQUIRED_SYMBOLS = [
  "assertAllowedProtocol",
  "assertAllowedUrl",
  "isHtmlLikeContentType",
  "resolveInputUrl",
  "resolveHref"
];

const docJson = JSON.parse(execFileSync("deno", ["doc", "--json", "--no-lock", "--sloppy-imports", ENTRYPOINT], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
}));

const nodes = new Map((docJson.nodes ?? []).map((node) => [node.name, node]));
const issues = [];

for (const symbolName of REQUIRED_SYMBOLS) {
  const node = nodes.get(symbolName);
  if (!node) {
    issues.push(`${symbolName}: missing from ${ENTRYPOINT}`);
    continue;
  }

  const summary = node.jsDoc?.doc?.replace(/\s+/g, " ").trim() ?? "";
  if (summary.length < 24) {
    issues.push(`${symbolName}: missing meaningful summary`);
  }

  const tags = Array.isArray(node.jsDoc?.tags) ? node.jsDoc.tags : [];
  if (!tags.some((tag) => tag.kind === "example")) {
    issues.push(`${symbolName}: missing @example`);
  }

  if (containsWeakType(node.functionDef ?? node)) {
    issues.push(`${symbolName}: public JSR signature still exposes any/unknown`);
  }
}

if (issues.length > 0) {
  process.stderr.write("doc-jsr-quality: selected JSR surfaces failed quality checks\n");
  for (const issue of issues) {
    process.stderr.write(`- ${issue}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`doc-jsr-quality: verified ${REQUIRED_SYMBOLS.length} selected JSR surfaces\n`);
}

function containsWeakType(value) {
  if (typeof value === "string") {
    return value === "any" || value === "unknown";
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((entry) => containsWeakType(entry));
}
