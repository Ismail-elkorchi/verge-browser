import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse, visibleText } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readWptDeltaCorpus(corpusPath = resolve("scripts/oracles/corpus/wpt-delta-v1.json")) {
  const raw = await readFile(corpusPath, "utf8");
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload?.cases) || payload.cases.length === 0) {
    throw new Error("invalid wpt delta corpus: empty cases");
  }
  return payload;
}

export function evaluateWptDeltaCase(caseEntry) {
  const tree = parse(caseEntry.html, {
    trace: false,
    captureSpans: false
  });

  const render80 = renderDocumentToTerminal({
    tree,
    requestUrl: "https://wpt.example/",
    finalUrl: "https://wpt.example/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const render120 = renderDocumentToTerminal({
    tree,
    requestUrl: "https://wpt.example/",
    finalUrl: "https://wpt.example/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 120
  });

  const visible = visibleText(tree, {
    trim: true,
    skipHiddenSubtrees: false,
    includeControlValues: true,
    includeAccessibleNameFallback: false
  });

  return {
    id: caseEntry.id,
    snapshotId: caseEntry.snapshotId,
    sourcePath: caseEntry.sourcePath,
    sha256: caseEntry.sha256,
    parseErrorCount: Array.isArray(tree.parseErrors) ? tree.parseErrors.length : 0,
    visibleTextSha256: sha256(visible),
    render80Sha256: sha256(render80.lines.join("\n")),
    render120Sha256: sha256(render120.lines.join("\n")),
    linkCount80: render80.links.length,
    lineCount80: render80.lines.length
  };
}

export function normalizeExpectedById(expectedEntries) {
  const map = new Map();
  for (const entry of expectedEntries) {
    map.set(entry.id, entry);
  }
  return map;
}
