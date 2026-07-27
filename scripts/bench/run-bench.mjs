import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "@ismail-elkorchi/html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

const WIDTHS = [80, 120];
const SAMPLE_CASES = 300;

function createBenchmarkHtml(index) {
  const listItems = Array.from(
    { length: 4 + (index % 5) },
    (_, itemIndex) =>
      `<li>Item ${String(itemIndex + 1)} for case ${String(index)} <a href="/items/${String(index)}/${String(itemIndex)}">open</a></li>`
  ).join("");
  const tableRows = Array.from(
    { length: 3 + (index % 4) },
    (_, rowIndex) =>
      `<tr><td>${String(rowIndex + 1)}</td><td>value-${String(index)}-${String(rowIndex)}</td></tr>`
  ).join("");
  const malformedFormatting =
    index % 3 === 0
      ? "<p><b><i>misnested formatting</b> remains readable</i></p>"
      : "";

  return `<!doctype html>
<html>
  <head><title>Benchmark ${String(index)}</title></head>
  <body>
    <main>
      <h1>Case ${String(index)}</h1>
      <p>Deterministic terminal rendering benchmark with links, lists, tables, and text wrapping.</p>
      <ul>${listItems}</ul>
      <table><thead><tr><th>Row</th><th>Value</th></tr></thead><tbody>${tableRows}</tbody></table>
      <pre>line one
  line two
\tline three</pre>
      ${malformedFormatting}
    </main>
  </body>
</html>`;
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(nsValue) {
  return Number(nsValue) / 1_000_000;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return sortedValues[index] ?? 0;
}

async function main() {
  const selectedCases = Array.from(
    { length: SAMPLE_CASES },
    (_, index) => ({
      id: `benchmark-${String(index + 1)}`,
      html: createBenchmarkHtml(index + 1)
    })
  );
  const benchmarks = [];

  for (const width of WIDTHS) {
    const perCaseMs = [];
    const startedAt = nowNs();

    for (const caseItem of selectedCases) {
      const caseStart = nowNs();
      const document = parse(caseItem.html, {
        captureSpans: false,
        trace: "none"
      });
      renderDocumentToTerminal({
        tree: document.tree,
        requestUrl: `https://bench.example/${caseItem.id}`,
        finalUrl: `https://bench.example/${caseItem.id}`,
        status: 200,
        statusText: "OK",
        fetchedAtIso: "1970-01-01T00:00:00.000Z",
        width
      });
      const caseDurationMs = nsToMs(nowNs() - caseStart);
      perCaseMs.push(caseDurationMs);
    }

    const durationMs = nsToMs(nowNs() - startedAt);
    const casesPerSecond = durationMs <= 0 ? 0 : (selectedCases.length / durationMs) * 1000;

    benchmarks.push({
      name: `render-width-${String(width)}`,
      width,
      cases: selectedCases.length,
      durationMs,
      casesPerSecond,
      p95CaseMs: percentile(perCaseMs, 0.95)
    });
  }

  const report = {
    suite: "bench",
    timestamp: new Date().toISOString(),
    sampleCases: selectedCases.length,
    benchmarks
  };

  const reportPath = resolve("reports/bench.json");
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`bench report written: ${reportPath}\n`);
}

await main();
