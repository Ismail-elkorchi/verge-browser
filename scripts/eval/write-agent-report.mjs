import {
  applyPatchPlan,
  chunk,
  computePatch,
  findById,
  getAttributeValue,
  isHtmlBudgetExceededError,
  outline,
  parse,
  parseBytes,
  parseStream,
  tokenizeByteStreamEager,
  walk
} from "@ismail-elkorchi/html-parser";
import { resolve } from "node:path";
import { TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";

import { writeJsonReport } from "./render-eval-lib.mjs";

const SAMPLE_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><title>agent report</title></head>",
  "<body>",
  "<h1>Alpha</h1>",
  "<p id=\"entry\">alpha <b>beta</b> gamma</p>",
  "<ul><li>one</li><li>two</li></ul>",
  "<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>b</td></tr></table>",
  "</body>",
  "</html>"
].join("");

const MALFORMED_HTML = "<html><body><p><div>x</p></body></html>";

function streamFromBytesInChunks(bytes, chunkSize) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkSize);
      const chunkBytes = bytes.slice(offset, end);
      offset = end;
      controller.enqueue(chunkBytes);
    }
  });
}

async function collectStreamTokens(bytes, chunkSize) {
  return tokenizeByteStreamEager(streamFromBytesInChunks(bytes, chunkSize));
}

function sortedKinds(trace) {
  return trace?.summary.eventKinds ?? [];
}

function collectSpanTargets(tree) {
  const output = {
    elementNodeId: null,
    textNodeId: null
  };
  walk(tree, (node) => {
    if (node.kind === "element" && node.span && output.elementNodeId === null) {
      output.elementNodeId = node.id;
    }
    if (node.kind === "text" && node.span && output.textNodeId === null) {
      output.textNodeId = node.id;
    }
  });
  return output;
}

function stableJson(value) {
  return JSON.stringify(value);
}

async function main() {
  const bytes = new TextEncoder().encode(SAMPLE_HTML);
  const parsedForTrace = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: "events",
    budgets: {
      maxInputBytes: 512 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const parsedForTraceSecond = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: "events",
    budgets: {
      maxInputBytes: 512 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const malformedTrace = parse(MALFORMED_HTML, {
    captureSpans: true,
    trace: "events",
    budgets: {
      maxInputBytes: 256 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });

  let traceBudgetFailure = false;
  try {
    parse(SAMPLE_HTML, {
      captureSpans: true,
      trace: "events",
      budgets: {
        maxTraceEvents: 2,
        maxTraceBytes: 64 * 1024
      }
    });
  } catch (error) {
    if (isHtmlBudgetExceededError(error) && error.budget === "maxTraceEvents") {
      traceBudgetFailure = true;
    }
  }

  const traceKinds = sortedKinds(parsedForTrace.tree.trace);
  const malformedTraceKinds = sortedKinds(malformedTrace.tree.trace);
  const traceFeature = {
    ok:
      traceKinds.length >= 3 &&
      malformedTraceKinds.includes("parseError") &&
      stableJson(parsedForTrace.tree.trace) === stableJson(parsedForTraceSecond.tree.trace) &&
      traceBudgetFailure,
    details: {
      eventCount: parsedForTrace.tree.trace?.summary.eventCount ?? 0,
      kinds: traceKinds,
      malformedKinds: malformedTraceKinds,
      budgetFailureObserved: traceBudgetFailure,
      deterministic: stableJson(parsedForTrace.tree.trace) === stableJson(parsedForTraceSecond.tree.trace)
    }
  };

  const parsedForSpans = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: "none"
  });
  const spanTargets = collectSpanTargets(parsedForSpans.tree);
  const spanFeature = {
    ok: spanTargets.elementNodeId !== null && spanTargets.textNodeId !== null,
    details: {
      elementNodeId: spanTargets.elementNodeId,
      textNodeId: spanTargets.textNodeId
    }
  };

  const parsedForPatch = parse(SAMPLE_HTML, {
    captureSpans: true,
    sourceRetention: "text",
    trace: "none"
  });
  const patchTargets = collectSpanTargets(parsedForPatch.tree);
  const elementTarget = patchTargets.elementNodeId;
  const textTarget = patchTargets.textNodeId;
  let patchFeature = {
    ok: false,
    details: {
      operationsChecked: ["replaceText", "setAttr"],
      patchedText: "",
      patchedAttrPresent: false
    }
  };

  if (elementTarget !== null && textTarget !== null) {
    const patchPlan = computePatch(parsedForPatch, [
      {
        kind: "replaceText",
        target: textTarget,
        value: "rewritten"
      },
      {
        kind: "setAttr",
        target: elementTarget,
        name: "data-agent",
        value: "ok"
      }
    ]);
    const patchedHtml = applyPatchPlan(parsedForPatch, patchPlan);
    const patchedDocument = parse(patchedHtml, {
      captureSpans: true,
      trace: "none"
    });
    const patchedElement = findById(patchedDocument.tree, elementTarget);
    const patchedText = findById(patchedDocument.tree, textTarget);

    const patchedAttrPresent = patchedElement?.kind === "element" &&
      getAttributeValue(patchedElement, "data-agent") === "ok";
    const patchedTextValue = patchedText?.kind === "text" ? patchedText.value : "";

    patchFeature = {
      ok: patchedAttrPresent && patchedTextValue.includes("rewritten"),
      details: {
        operationsChecked: ["replaceText", "setAttr"],
        patchedText: patchedTextValue,
        patchedAttrPresent
      }
    };
  }

  const outlineFirst = outline(parsedForSpans.tree);
  const outlineSecond = outline(parse(SAMPLE_HTML, { captureSpans: true, trace: "none" }).tree);
  const outlineFeature = {
    ok: stableJson(outlineFirst) === stableJson(outlineSecond) && outlineFirst.entries.length > 0,
    details: {
      entryCount: outlineFirst.entries.length,
      deterministic: stableJson(outlineFirst) === stableJson(outlineSecond)
    }
  };

  const chunksFirst = chunk(parsedForSpans.tree, { maxChars: 80, maxNodes: 5, maxBytes: 256 });
  const chunksSecond = chunk(parse(SAMPLE_HTML, { captureSpans: true, trace: "none" }).tree, {
    maxChars: 80,
    maxNodes: 5,
    maxBytes: 256
  });
  const chunkFeature = {
    ok: stableJson(chunksFirst) === stableJson(chunksSecond) && chunksFirst.length > 0,
    details: {
      chunkCount: chunksFirst.length,
      deterministic: stableJson(chunksFirst) === stableJson(chunksSecond)
    }
  };

  const streamDocument = await parseStream(streamFromBytesInChunks(bytes, 17), {
    captureSpans: true,
    trace: "events",
    budgets: {
      maxInputBytes: 512 * 1024,
      maxEncodingPrescanBytes: 256 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const fromBytes = parseBytes(bytes, {
    captureSpans: true,
    trace: "none"
  });
  const streamTokensFirst = await collectStreamTokens(bytes, 13);
  const streamTokensSecond = await collectStreamTokens(bytes, 13);
  const streamFeature = {
    ok:
      stableJson(streamDocument.tree.children) === stableJson(fromBytes.tree.children) &&
      stableJson(streamTokensFirst) === stableJson(streamTokensSecond),
    details: {
      parseParity: stableJson(streamDocument.tree.children) === stableJson(fromBytes.tree.children),
      tokenDeterministic: stableJson(streamTokensFirst) === stableJson(streamTokensSecond),
      tokenCount: streamTokensFirst.length
    }
  };

  const report = {
    suite: "agent",
    timestamp: new Date().toISOString(),
    features: {
      trace: traceFeature,
      spans: spanFeature,
      patch: patchFeature,
      outline: outlineFeature,
      chunk: chunkFeature,
      stream: streamFeature
    },
    overall: {
      ok: traceFeature.ok && spanFeature.ok && patchFeature.ok && outlineFeature.ok && chunkFeature.ok && streamFeature.ok
    }
  };

  const reportPath = resolve("reports/agent.json");
  await writeJsonReport(reportPath, report);

  if (!report.overall.ok) {
    throw new Error("agent report checks failed");
  }

  process.stdout.write(`agent report ok: ${reportPath}\n`);
}

await main();
