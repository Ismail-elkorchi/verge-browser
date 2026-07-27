import {
  isHtmlBudgetExceededError,
  parseBytes,
  parseStream,
  serialize,
  tokenizeByteStreamEager
} from "@ismail-elkorchi/html-parser";
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
  return tokenizeByteStreamEager(streamFromChunks(bytes, chunkSize));
}

function budgetErrorMatches(error, budgetName) {
  return isHtmlBudgetExceededError(error) && error.budget === budgetName;
}

async function main() {
  const html = "<!doctype html><html><head><title>stream</title></head><body><p>alpha beta gamma</p><p>delta</p></body></html>";
  const bytes = new TextEncoder().encode(html);

  const bytesDocument = parseBytes(bytes, {
    captureSpans: true,
    trace: "none"
  });
  const streamDocument = await parseStream(streamFromChunks(bytes, 9), {
    captureSpans: true,
    trace: "events",
    budgets: {
      maxInputBytes: 256 * 1024,
      maxEncodingPrescanBytes: 64 * 1024,
      maxTraceEvents: 2_048,
      maxTraceBytes: 512 * 1024
    }
  });
  const serializeParity = serialize(bytesDocument.tree) === serialize(streamDocument.tree);

  const checks = [];
  checks.push({
    id: "stream-serialize-parity",
    ok: serializeParity,
    observed: serialize(streamDocument.tree),
    expected: serialize(bytesDocument.tree)
  });

  let maxInputBudgetRaised = false;
  try {
    await parseStream(streamFromChunks(bytes, bytes.length), {
      budgets: {
        maxInputBytes: Math.max(1, bytes.length - 5),
        maxEncodingPrescanBytes: 64 * 1024
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

  let maxDecodedBudgetRaised = false;
  try {
    await parseStream(streamFromChunks(bytes, bytes.length), {
      budgets: {
        maxInputBytes: 256 * 1024,
        maxDecodedUtf8Bytes: 8
      }
    });
  } catch (error) {
    maxDecodedBudgetRaised = budgetErrorMatches(error, "maxDecodedUtf8Bytes");
  }
  checks.push({
    id: "stream-max-decoded-budget",
    ok: maxDecodedBudgetRaised,
    observed: maxDecodedBudgetRaised ? "budget-exceeded" : "no-error",
    expected: "budget-exceeded(maxDecodedUtf8Bytes)"
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
