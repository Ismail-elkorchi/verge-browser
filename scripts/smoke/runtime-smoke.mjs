import { parse, parseBytes, parseStream, serialize } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

function parseArgs(argv) {
  let runtime = "node";
  let reportPath = "reports/smoke-node.json";

  for (const arg of argv) {
    if (arg.startsWith("--runtime=")) {
      runtime = arg.slice("--runtime=".length);
      continue;
    }
    if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
      continue;
    }
  }

  return { runtime, reportPath };
}

function detectRuntime() {
  if (typeof Deno !== "undefined") {
    return "deno";
  }
  if (typeof Bun !== "undefined") {
    return "bun";
  }
  return "node";
}

function createHtmlStream(value) {
  const bytes = new globalThis.TextEncoder().encode(value);
  return new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 18));
      controller.enqueue(bytes.subarray(18, 47));
      controller.enqueue(bytes.subarray(47));
      controller.close();
    }
  });
}

async function sha256Hex(value) {
  const bytes = new globalThis.TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (entry) => entry.toString(16).padStart(2, "0")).join("");
}

function dirname(path) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex <= 0) {
    return ".";
  }
  return path.slice(0, slashIndex);
}

async function writeReport(path, text) {
  const runtime = detectRuntime();

  if (runtime === "deno") {
    const denoApi = globalThis.Deno;
    if (!denoApi) {
      throw new Error("Deno runtime API is unavailable");
    }
    await denoApi.mkdir(dirname(path), { recursive: true });
    await denoApi.writeTextFile(path, text);
    return;
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text, "utf8");
}

async function runSmoke(expectedRuntime) {
  const runtime = detectRuntime();
  if (runtime !== expectedRuntime) {
    throw new Error(`Runtime mismatch: expected ${expectedRuntime}, detected ${runtime}`);
  }

  const html = "<html><head><title>Runtime</title></head><body><h1>Smoke</h1><p>alpha beta</p></body></html>";
  const bytes = new globalThis.TextEncoder().encode(html);

  const treeFromText = parse(html, { captureSpans: true, trace: true });
  const treeFromBytes = parseBytes(bytes, { captureSpans: true, trace: true });
  const treeFromStream = await parseStream(createHtmlStream(html), { captureSpans: true, trace: true });

  const rendered = renderDocumentToTerminal({
    tree: treeFromText,
    requestUrl: "https://runtime.example/",
    finalUrl: "https://runtime.example/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const serialized = serialize(treeFromText);
  const serializedBytes = serialize(treeFromBytes);
  const serializedStream = serialize(treeFromStream);

  const errorIdsFromText = treeFromText.errors.map((entry) => entry.parseErrorId ?? "unknown");
  const errorIdsFromBytes = treeFromBytes.errors.map((entry) => entry.parseErrorId ?? "unknown");
  const errorIdsFromStream = treeFromStream.errors.map((entry) => entry.parseErrorId ?? "unknown");

  const checks = {
    parse: treeFromText.root !== null,
    parseBytes: treeFromBytes.root !== null,
    parseStream: treeFromStream.root !== null,
    determinism:
      serialized === serializedBytes &&
      serialized === serializedStream &&
      JSON.stringify(errorIdsFromText) === JSON.stringify(errorIdsFromBytes) &&
      JSON.stringify(errorIdsFromText) === JSON.stringify(errorIdsFromStream),
    render: rendered.lines.length > 0 && typeof rendered.title === "string" && rendered.title.length > 0,
    serialize: serialized.includes("<title>Runtime</title>")
  };

  const stablePayload = {
    serialized,
    lines: rendered.lines,
    links: rendered.links,
    errorIds: errorIdsFromText
  };

  const hash = await sha256Hex(JSON.stringify(stablePayload));

  return {
    runtime,
    ok: Object.values(checks).every((value) => value === true),
    hash,
    checks,
    details: {
      serializedBytes,
      serializedStream,
      errorIdsFromText,
      errorIdsFromBytes,
      errorIdsFromStream
    }
  };
}

async function main() {
  const { runtime, reportPath } = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();

  try {
    const result = await runSmoke(runtime);
    const report = {
      suite: "runtime-smoke",
      timestamp,
      runtime,
      ...result
    };
    await writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) {
      throw new Error("runtime smoke checks failed");
    }
  } catch (error) {
    const report = {
      suite: "runtime-smoke",
      timestamp,
      runtime,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    await writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
