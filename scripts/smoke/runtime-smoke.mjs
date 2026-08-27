import {
  createDocumentState,
  parseWebDocument,
  parseWebDocumentBytes,
  parseWebDocumentStream
} from "../../dist/document/index.js";
import { renderDocument } from "../../dist/presentation/pipeline.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import {
  cssCoordinate,
  cssLengthFromFixed,
  cssPixels,
  cssPx,
  cssRect
} from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const CSS_TEXT_MEASURER = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);

function parseArgs(argv) {
  let runtime = "node";
  let reportPath = "reports/smoke-node.json";
  for (const arg of argv) {
    if (arg.startsWith("--runtime=")) runtime = arg.slice("--runtime=".length);
    else if (arg.startsWith("--report=")) reportPath = arg.slice("--report=".length);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!["node", "deno", "bun"].includes(runtime)) throw new Error(`unsupported runtime: ${runtime}`);
  if (reportPath.length === 0) throw new Error("report path must not be empty");
  return { runtime, reportPath };
}

function detectRuntime() {
  if (typeof Deno !== "undefined") return "deno";
  if (typeof Bun !== "undefined") return "bun";
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
  return slashIndex <= 0 ? "." : path.slice(0, slashIndex);
}

async function writeReport(path, text) {
  if (detectRuntime() === "deno") {
    await globalThis.Deno.mkdir(dirname(path), { recursive: true });
    await globalThis.Deno.writeTextFile(path, text);
    return;
  }
  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text, "utf8");
}

function documentPayload(document) {
  return {
    title: document.title,
    bodyText: document.body === null ? "" : document.text(document.body),
    links: document.links.map(({ label, destination }) => ({ label, destination })),
    errors: document.diagnostics.map(({ id }) => id),
    nodeCount: document.sourceMetadata.parserNodeCount
  };
}

async function runSmoke(expectedRuntime) {
  const runtime = detectRuntime();
  if (runtime !== expectedRuntime) throw new Error(`Runtime mismatch: expected ${expectedRuntime}, detected ${runtime}`);

  const html = "<html><head><title>Runtime</title><style>h1{color:#0af}</style></head><body><h1>Smoke</h1><p>alpha beta</p><a href='/next'>Next</a></body></html>";
  const context = { requestUrl: "https://runtime.example/", finalUrl: "https://runtime.example/" };
  const bytes = new globalThis.TextEncoder().encode(html);
  const fromText = parseWebDocument(html, context);
  const fromBytes = parseWebDocumentBytes(bytes, context);
  const fromStream = await parseWebDocumentStream(createHtmlStream(html), context);
  const payloads = [fromText, fromBytes, fromStream].map(documentPayload);
  const viewportWidth = cssLengthFromFixed(40 * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(12 * ROW_HEIGHT);
  const renderPipeline = renderDocument({
    document: fromText,
    state: createDocumentState(fromText),
    resources: embeddedStylesheetSources(fromText),
    mediaEnvironment: {
      viewportWidthCssPx: cssPixels(viewportWidth),
      viewportHeightCssPx: cssPixels(viewportHeight),
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine"
    },
    layoutContext: {
      viewport: { width: viewportWidth, height: viewportHeight },
      textMeasurer: CSS_TEXT_MEASURER,
      initialContainingBlock: cssRect(
        cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight
      ),
      scrollport: cssRect(
        cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight
      )
    },
    terminalContext: {
      columns: 40,
      rows: 12,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      colorDepth: 24,
      unicode: true,
      ambiguousWidth: 1,
      cellMeasurer: terminalCellMeasurer()
    }
  });
  const checks = {
    parseText: fromText.node(fromText.root).kind === "document",
    parseBytes: fromBytes.node(fromBytes.root).kind === "document",
    parseStream: fromStream.node(fromStream.root).kind === "document",
    determinism: JSON.stringify(payloads[0]) === JSON.stringify(payloads[1])
      && JSON.stringify(payloads[0]) === JSON.stringify(payloads[2]),
    style: renderPipeline.styles.outcome.status === "complete",
    formatting: renderPipeline.formatting.outcome.status === "complete",
    layout: renderPipeline.layout.outcome.status === "complete",
    displayList: renderPipeline.displayList.outcome.status === "complete",
    cellBuffer: renderPipeline.terminal.cellBuffer.outcome.status === "complete",
    render: renderPipeline.terminal.cellBuffer.rows.some((row) => row.text.includes("Smoke"))
  };
  const stablePayload = {
    document: payloads[0],
    rows: renderPipeline.terminal.cellBuffer.rows.map((row) => row.text),
    focus: renderPipeline.terminal.focusMap.targets.map((target) => target.action.kind)
  };
  return {
    runtime,
    ok: Object.values(checks).every(Boolean),
    hash: await sha256Hex(JSON.stringify(stablePayload)),
    checks,
    details: { documentVariants: payloads }
  };
}

async function main() {
  const { runtime, reportPath } = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();
  try {
    const result = await runSmoke(runtime);
    const report = { suite: "runtime-smoke", timestamp, ...result };
    await writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) throw new Error("runtime smoke checks failed");
  } catch (error) {
    await writeReport(reportPath, `${JSON.stringify({
      suite: "runtime-smoke",
      timestamp,
      runtime,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`);
    throw error;
  }
}

await main();
