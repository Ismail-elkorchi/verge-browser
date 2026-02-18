import { parseBytes, parseStream, serialize, tokenizeStream } from "html-parser";
import { resolve } from "node:path";
import { TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";

import { writeJsonReport } from "./render-eval-lib.mjs";

function streamFromChunks(bytes, chunkSize) {
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

async function tokensFromStream(bytes, chunkSize) {
  const stream = streamFromChunks(bytes, chunkSize);
  const tokens = [];
  for await (const token of tokenizeStream(stream, {})) {
    tokens.push(token);
  }
  return tokens;
}

function budgetErrorMatches(error, budgetName) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name !== "BudgetExceededError") {
    return false;
  }
  const payload = error.payload;
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return payload.budget === budgetName;
}

async function main() {
  const html = "<!doctype html><html><head><title>stream</title></head><body><p>alpha beta gamma</p><p>delta</p></body></html>";
  const bytes = new TextEncoder().encode(html);

  const parseBytesTree = parseBytes(bytes, {
    captureSpans: true,
    trace: false
  });
  const parseStreamTree = await parseStream(streamFromChunks(bytes, 9), {
    captureSpans: true,
    trace: true,
    budgets: {
      maxInputBytes: 256 * 1024,
      maxBufferedBytes: 64 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const serializeParity = serialize(parseBytesTree) === serialize(parseStreamTree);

  const checks = [];
  checks.push({
    id: "stream-serialize-parity",
    ok: serializeParity,
    observed: serialize(parseStreamTree),
    expected: serialize(parseBytesTree)
  });

  let maxInputBudgetRaised = false;
  try {
    await parseStream(streamFromChunks(bytes, bytes.length), {
      budgets: {
        maxInputBytes: Math.max(1, bytes.length - 5),
        maxBufferedBytes: 64 * 1024
      }
    });
  } catch (error) {
    maxInputBudgetRaised = budgetErrorMatches(error, "maxInputBytes");
  }
  checks.push({
    id: "stream-max-input-budget",
    ok: maxInputBudgetRaised,
    observed: maxInputBudgetRaised ? "budget-exceeded" : "no-error",
    expected: "budget-exceeded(maxInputBytes)"
  });

  let maxBufferedBudgetRaised = false;
  try {
    await parseStream(streamFromChunks(bytes, bytes.length), {
      budgets: {
        maxInputBytes: 256 * 1024,
        maxBufferedBytes: 8
      }
    });
  } catch (error) {
    maxBufferedBudgetRaised = budgetErrorMatches(error, "maxBufferedBytes");
  }
  checks.push({
    id: "stream-max-buffered-budget",
    ok: maxBufferedBudgetRaised,
    observed: maxBufferedBudgetRaised ? "budget-exceeded" : "no-error",
    expected: "budget-exceeded(maxBufferedBytes)"
  });

  const tokensFirst = await tokensFromStream(bytes, 7);
  const tokensSecond = await tokensFromStream(bytes, 7);
  const tokenDeterministic = JSON.stringify(tokensFirst) === JSON.stringify(tokensSecond);
  checks.push({
    id: "tokenize-stream-deterministic",
    ok: tokenDeterministic,
    observed: tokenDeterministic ? "stable" : "mismatch",
    expected: "stable"
  });

  const report = {
    suite: "stream",
    timestamp: new Date().toISOString(),
    checks,
    overall: {
      ok: checks.every((check) => check.ok)
    }
  };

  const reportPath = resolve("reports/stream.json");
  await writeJsonReport(reportPath, report);

  if (!report.overall.ok) {
    throw new Error("stream report checks failed");
  }

  process.stdout.write(`stream report ok: ${reportPath}\n`);
}

await main();
