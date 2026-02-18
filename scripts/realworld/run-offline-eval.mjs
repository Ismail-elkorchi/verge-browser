import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";

import { parseBytes, parseStream, visibleText, visibleTextTokens } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";
import {
  corpusPath,
  decodeUtf8,
  ensureCorpusDirs,
  percentile,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  toFixedMillis,
  writeJson,
  writeNdjson
} from "./lib.mjs";

const WIDTHS = Object.freeze([80, 120]);
const CHUNK_PATTERN = Object.freeze([13, 5, 29, 7, 17, 11, 19]);

function stableNodeShape(node) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (node.kind === "element") {
    return {
      id: node.id,
      kind: node.kind,
      tagName: node.tagName,
      attributes: node.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value
      })),
      children: node.children.map(stableNodeShape)
    };
  }
  if (node.kind === "text" || node.kind === "comment") {
    return {
      id: node.id,
      kind: node.kind,
      value: node.value
    };
  }
  if (node.kind === "doctype") {
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      publicId: node.publicId ?? null,
      systemId: node.systemId ?? null
    };
  }
  return null;
}

function stableTreeFingerprint(tree) {
  return JSON.stringify({
    kind: tree.kind,
    children: tree.children.map(stableNodeShape),
    errors: tree.errors.map((error) => ({
      code: error.code,
      parseErrorId: error.parseErrorId,
      nodeId: error.nodeId ?? null,
      span: error.span ?? null
    }))
  });
}

function nodeCount(tree) {
  let total = 0;
  function walk(node) {
    total += 1;
    if (node.kind === "element") {
      for (const childNode of node.children) {
        walk(childNode);
      }
    }
  }
  for (const childNode of tree.children) {
    walk(childNode);
  }
  return total;
}

function streamFromChunkPattern(bytes) {
  let offset = 0;
  let chunkIndex = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const patternSize = CHUNK_PATTERN[chunkIndex % CHUNK_PATTERN.length] ?? 16;
      const nextOffset = Math.min(bytes.byteLength, offset + patternSize);
      controller.enqueue(bytes.subarray(offset, nextOffset));
      offset = nextOffset;
      chunkIndex += 1;
    }
  });
}

function aggregateErrorIds(pageResults) {
  const counts = new Map();
  for (const result of pageResults) {
    for (const parseErrorId of result.parseErrorIds) {
      counts.set(parseErrorId, (counts.get(parseErrorId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([parseErrorId, count]) => ({ parseErrorId, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.parseErrorId.localeCompare(right.parseErrorId);
    });
}

function topBy(pageResults, key, limit = 10) {
  return [...pageResults]
    .sort((left, right) => right[key] - left[key])
    .slice(0, limit)
    .map((result) => ({
      sha256: result.sha256,
      finalUrl: result.finalUrl,
      [key]: result[key]
    }));
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const pagesManifestPath = corpusPath(corpusDir, "manifests/pages.ndjson");
  const pageManifestRecords = await readNdjson(pagesManifestPath);
  const uniquePages = new Map();
  for (const record of pageManifestRecords) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (typeof record.sha256 !== "string" || record.sha256.length === 0) {
      continue;
    }
    if (!uniquePages.has(record.sha256)) {
      uniquePages.set(record.sha256, record);
    }
  }

  const pages = [...uniquePages.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
  const runId = sha256HexString(
    JSON.stringify({
      script: "run-offline-eval-v1",
      pages: pages.map((page) => page.sha256)
    })
  );

  const previousReportPath = corpusPath(corpusDir, "reports/field-pages.ndjson");
  const previousEntries = await readNdjson(previousReportPath);
  const stableTimingBySha = new Map();
  for (const previousEntry of previousEntries) {
    if (previousEntry?.runId !== runId || typeof previousEntry.sha256 !== "string") {
      continue;
    }
    stableTimingBySha.set(previousEntry.sha256, {
      parseTimeMs: previousEntry.parseTimeMs,
      parseStreamTimeMs: previousEntry.parseStreamTimeMs,
      renderTimeMs: previousEntry.renderTimeMs
    });
  }

  const pageResults = [];
  for (const page of pages) {
    const pagePath = corpusPath(corpusDir, `cache/html/${page.sha256}.bin`);
    const pageBytes = new Uint8Array(await readFile(pagePath));

    const parseStartedAt = performance.now();
    const treeFromBytes = parseBytes(pageBytes, {
      captureSpans: true,
      trace: false
    });
    const parseElapsedMs = performance.now() - parseStartedAt;

    const streamStartedAt = performance.now();
    const treeFromStream = await parseStream(streamFromChunkPattern(pageBytes), {
      captureSpans: true,
      trace: false
    });
    const streamElapsedMs = performance.now() - streamStartedAt;

    const bytesHtml = decodeUtf8(pageBytes);
    const bytesFingerprint = stableTreeFingerprint(treeFromBytes);
    const streamFingerprint = stableTreeFingerprint(treeFromStream);
    const streamParityOk = bytesFingerprint === streamFingerprint;

    const renderStartedAt = performance.now();
    const renderedByWidth = WIDTHS.map((width) => renderDocumentToTerminal({
      tree: treeFromBytes,
      requestUrl: page.url,
      finalUrl: page.finalUrl,
      status: page.status ?? 200,
      statusText: "OK",
      fetchedAtIso: page.fetchedAtIso ?? "1970-01-01T00:00:00.000Z",
      width
    }));
    const renderElapsedMs = performance.now() - renderStartedAt;

    const visibleTextValue = visibleText(treeFromBytes);
    const visibleTextTokenList = visibleTextTokens(treeFromBytes);

    const measuredPageResult = {
      runId,
      sha256: page.sha256,
      url: page.url,
      finalUrl: page.finalUrl,
      status: page.status,
      contentType: page.contentType ?? null,
      contentLength: page.contentLength ?? pageBytes.byteLength,
      parseTimeMs: toFixedMillis(parseElapsedMs),
      parseStreamTimeMs: toFixedMillis(streamElapsedMs),
      renderTimeMs: toFixedMillis(renderElapsedMs),
      nodeCount: nodeCount(treeFromBytes),
      parseErrorCount: treeFromBytes.errors.length,
      parseErrorIds: treeFromBytes.errors.map((error) => error.parseErrorId).sort((left, right) => left.localeCompare(right)),
      visibleTextBytes: new TextEncoder().encode(visibleTextValue).byteLength,
      tokenCount: visibleTextTokenList.length,
      streamParityOk,
      widthLineCounts: renderedByWidth.map((entry, index) => ({
        width: WIDTHS[index] ?? 0,
        lineCount: entry.lines.length
      })),
      contentSha256: sha256HexString(bytesHtml)
    };

    const stableTiming = stableTimingBySha.get(page.sha256);
    pageResults.push(stableTiming
      ? {
          ...measuredPageResult,
          parseTimeMs: stableTiming.parseTimeMs,
          parseStreamTimeMs: stableTiming.parseStreamTimeMs,
          renderTimeMs: stableTiming.renderTimeMs
        }
      : measuredPageResult);
  }

  const parseTimes = pageResults.map((result) => result.parseTimeMs);
  const renderTimes = pageResults.map((result) => result.renderTimeMs);
  const parityMismatches = pageResults.filter((result) => !result.streamParityOk);
  const summary = {
    suite: "field-offline",
    runId,
    generatedAtIso: new Date().toISOString(),
    corpus: {
      pageCount: pageResults.length
    },
    parity: {
      parseBytesVsParseStreamMismatches: parityMismatches.length,
      mismatchPages: parityMismatches.map((result) => result.sha256)
    },
    timing: {
      parseMs: {
        p50: toFixedMillis(percentile(parseTimes, 0.5)),
        p95: toFixedMillis(percentile(parseTimes, 0.95))
      },
      renderMs: {
        p50: toFixedMillis(percentile(renderTimes, 0.5)),
        p95: toFixedMillis(percentile(renderTimes, 0.95))
      }
    },
    worst: {
      parseTimeMs: topBy(pageResults, "parseTimeMs"),
      renderTimeMs: topBy(pageResults, "renderTimeMs")
    },
    parseErrorIdFrequency: aggregateErrorIds(pageResults)
  };

  const pageReportPath = corpusPath(corpusDir, "reports/field-pages.ndjson");
  const summaryReportPath = corpusPath(corpusDir, "reports/field-summary.json");
  await writeNdjson(pageReportPath, pageResults);
  await writeJson(summaryReportPath, summary);
  process.stdout.write(`field-offline ok: pages=${String(pageResults.length)} runId=${runId}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-offline failed: ${message}\n`);
  process.exit(1);
});
