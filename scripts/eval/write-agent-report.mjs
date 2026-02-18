import { parse, parseBytes, parseStream, tokenizeStream, outline, chunk, computePatch, applyPatchPlan } from "html-parser";
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
  const stream = streamFromBytesInChunks(bytes, chunkSize);
  const tokens = [];
  for await (const token of tokenizeStream(stream, {})) {
    tokens.push(token);
  }
  return tokens;
}

function sortedKinds(trace) {
  const kinds = new Set((trace ?? []).map((event) => event.kind));
  return [...kinds].sort((left, right) => left.localeCompare(right));
}

function findElementAndTextWithSpans(node, output) {
  if (node.kind === "element" && node.span && !output.elementNodeId) {
    output.elementNodeId = node.id;
  }
  if (node.kind === "text" && node.span && !output.textNodeId) {
    output.textNodeId = node.id;
  }
  if (node.kind === "element") {
    for (const child of node.children) {
      findElementAndTextWithSpans(child, output);
    }
  }
}

function collectSpanTargets(tree) {
  const output = {
    elementNodeId: null,
    textNodeId: null
  };
  for (const node of tree.children) {
    findElementAndTextWithSpans(node, output);
  }
  return output;
}

function findElementById(node, nodeId) {
  if (node.kind === "element" && node.id === nodeId) {
    return node;
  }
  if (node.kind !== "element") {
    return null;
  }
  for (const child of node.children) {
    const result = findElementById(child, nodeId);
    if (result) {
      return result;
    }
  }
  return null;
}

function findTextById(node, nodeId) {
  if (node.kind === "text" && node.id === nodeId) {
    return node;
  }
  if (node.kind !== "element") {
    return null;
  }
  for (const child of node.children) {
    const result = findTextById(child, nodeId);
    if (result) {
      return result;
    }
  }
  return null;
}

function stableJson(value) {
  return JSON.stringify(value);
}

async function main() {
  const bytes = new TextEncoder().encode(SAMPLE_HTML);
  const parsedForTrace = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: true,
    budgets: {
      maxInputBytes: 512 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const parsedForTraceSecond = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: true,
    budgets: {
      maxInputBytes: 512 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const malformedTrace = parse(MALFORMED_HTML, {
    captureSpans: true,
    trace: true,
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
      trace: true,
      budgets: {
        maxTraceEvents: 2,
        maxTraceBytes: 64 * 1024
      }
    });
  } catch (error) {
    if (error instanceof Error && error.name === "BudgetExceededError") {
      traceBudgetFailure = true;
    }
  }

  const traceKinds = sortedKinds(parsedForTrace.trace);
  const malformedTraceKinds = sortedKinds(malformedTrace.trace);
  const traceFeature = {
    ok:
      traceKinds.length >= 3 &&
      malformedTraceKinds.includes("parseError") &&
      stableJson(parsedForTrace.trace ?? []) === stableJson(parsedForTraceSecond.trace ?? []) &&
      traceBudgetFailure,
    details: {
      eventCount: parsedForTrace.trace?.length ?? 0,
      kinds: traceKinds,
      malformedKinds: malformedTraceKinds,
      budgetFailureObserved: traceBudgetFailure,
      deterministic: stableJson(parsedForTrace.trace ?? []) === stableJson(parsedForTraceSecond.trace ?? [])
    }
  };

  const parsedForSpans = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: false
  });
  const spanTargets = collectSpanTargets(parsedForSpans);
  const spanFeature = {
    ok: spanTargets.elementNodeId !== null && spanTargets.textNodeId !== null,
    details: {
      elementNodeId: spanTargets.elementNodeId,
      textNodeId: spanTargets.textNodeId
    }
  };

  const parsedForPatch = parse(SAMPLE_HTML, {
    captureSpans: true,
    trace: false
  });
  const patchTargets = collectSpanTargets(parsedForPatch);
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
    const patchPlan = computePatch(SAMPLE_HTML, [
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
    const patchedHtml = applyPatchPlan(SAMPLE_HTML, patchPlan);
    const patchedTree = parse(patchedHtml, {
      captureSpans: true,
      trace: false
    });
    const patchedElement = patchedTree.children
      .map((child) => findElementById(child, elementTarget))
      .find((child) => child !== null);
    const patchedText = patchedTree.children
      .map((child) => findTextById(child, textTarget))
      .find((child) => child !== null);

    const patchedAttrPresent = patchedElement
      ? patchedElement.attributes.some((attribute) => attribute.name === "data-agent" && attribute.value === "ok")
      : false;
    const patchedTextValue = patchedText ? patchedText.value : "";

    patchFeature = {
      ok: patchedAttrPresent && patchedTextValue.includes("rewritten"),
      details: {
        operationsChecked: ["replaceText", "setAttr"],
        patchedText: patchedTextValue,
        patchedAttrPresent
      }
    };
  }

  const outlineFirst = outline(parsedForSpans);
  const outlineSecond = outline(parse(SAMPLE_HTML, { captureSpans: true, trace: false }));
  const outlineFeature = {
    ok: stableJson(outlineFirst) === stableJson(outlineSecond) && outlineFirst.entries.length > 0,
    details: {
      entryCount: outlineFirst.entries.length,
      deterministic: stableJson(outlineFirst) === stableJson(outlineSecond)
    }
  };

  const chunksFirst = chunk(parsedForSpans, { maxChars: 80, maxNodes: 5, maxBytes: 256 });
  const chunksSecond = chunk(parse(SAMPLE_HTML, { captureSpans: true, trace: false }), {
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

  const streamTree = await parseStream(streamFromBytesInChunks(bytes, 17), {
    captureSpans: true,
    trace: true,
    budgets: {
      maxInputBytes: 512 * 1024,
      maxBufferedBytes: 256 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const fromBytes = parseBytes(bytes, {
    captureSpans: true,
    trace: false
  });
  const streamTokensFirst = await collectStreamTokens(bytes, 13);
  const streamTokensSecond = await collectStreamTokens(bytes, 13);
  const streamFeature = {
    ok:
      stableJson(streamTree.children) === stableJson(fromBytes.children) &&
      stableJson(streamTokensFirst) === stableJson(streamTokensSecond),
    details: {
      parseParity: stableJson(streamTree.children) === stableJson(fromBytes.children),
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
