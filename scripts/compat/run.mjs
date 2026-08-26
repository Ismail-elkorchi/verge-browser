import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { renderDocument } from "../../dist/presentation/pipeline.js";
import {
  cssCoordinate,
  cssLengthFromFixed,
  cssPixels,
  cssPx,
  cssRect
} from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(scriptDirectory, "corpus.json");
const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

function argumentsFor(argv) {
  let check = false;
  let report = "reports/compatibility.json";
  for (const argument of argv) {
    if (argument === "--check") check = true;
    else if (argument.startsWith("--report=")) report = argument.slice("--report=".length);
    else throw new Error(`Unsupported compatibility argument: ${argument}`);
  }
  return { check, report };
}

function normalized(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function includesText(haystack, needle) {
  return normalized(haystack).toLocaleLowerCase("und").includes(normalized(needle).toLocaleLowerCase("und"));
}

function recall(expected, actual, matches = (left, right) => includesText(right, left)) {
  if (expected.length === 0) return { matched: 0, expected: 0, ratio: 1 };
  let matched = 0;
  for (const value of expected) if (actual.some((candidate) => matches(value, candidate))) matched += 1;
  return { matched, expected: expected.length, ratio: matched / expected.length };
}

function renderFixture(html, id, columns = 120, rows = 60) {
  const url = `https://compat.verge.test/${id}/`;
  const document = parseWebDocument(html, { requestUrl: url, finalUrl: url });
  const viewportWidth = cssLengthFromFixed(columns * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(rows * ROW_HEIGHT);
  const pipeline = renderDocument({
    document,
    state: createDocumentState(document),
    resources: [],
    mediaEnvironment: {
      viewportWidthCssPx: cssPixels(viewportWidth),
      viewportHeightCssPx: cssPixels(viewportHeight),
      mediaType: "screen",
      prefersColorScheme: "light",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine"
    },
    layoutContext: {
      viewport: { width: viewportWidth, height: viewportHeight },
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT),
      initialContainingBlock: cssRect(
        cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight
      ),
      scrollport: cssRect(
        cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight
      )
    },
    terminalContext: {
      columns,
      rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      cellMeasurer: terminalCellMeasurer()
    }
  });
  return { document, pipeline };
}

function unsupportedFrequency(diagnostics, code) {
  const values = {};
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== code) continue;
    values[diagnostic.detail] = (values[diagnostic.detail] ?? 0) + diagnostic.occurrences;
  }
  return values;
}

function fixtureResult(fixture, hash, first, second) {
  const logicalText = normalized(first.pipeline.textSearchIndex.text);
  const cellText = normalized(first.pipeline.terminal.cellBuffer.rows.map((row) => row.text).join("\n"));
  const accessibleNodes = new Set(first.pipeline.terminal.accessibilityBounds.map((entry) => entry.documentNode));
  const headings = first.pipeline.terminal.accessibilityBounds
    .filter((entry) => entry.role === "heading")
    .map((entry) => entry.name);
  const landmarks = first.document.landmarks
    .filter((entry) => accessibleNodes.has(entry.node) && entry.landmark !== null)
    .map((entry) => entry.landmark);
  const linkNodes = new Set(first.pipeline.terminal.focusMap.targets
    .filter((entry) => entry.action.kind === "link")
    .map((entry) => entry.node));
  const links = first.document.links.filter((entry) => linkNodes.has(entry.node)).map((entry) => entry.label);
  const controlNodes = new Set(first.pipeline.terminal.focusMap.targets
    .filter((entry) => entry.action.kind === "form-control")
    .map((entry) => entry.node));
  const controls = first.document.controls.filter((entry) => controlNodes.has(entry.node)).map((entry) => entry.label);
  const text = recall(fixture.expected.text, [logicalText]);
  const heading = recall(fixture.expected.headings, headings);
  const landmark = recall(fixture.expected.landmarks, landmarks, (expected, actual) => expected === actual);
  const link = recall(fixture.expected.links, links);
  const control = recall(fixture.expected.controls, controls);
  let readingCursor = 0;
  let readingMatches = 0;
  const foldedLogical = logicalText.toLocaleLowerCase("und");
  for (const phrase of fixture.expected.text) {
    const index = foldedLogical.indexOf(normalized(phrase).toLocaleLowerCase("und"), readingCursor);
    if (index < 0) continue;
    readingMatches += 1;
    readingCursor = index + normalized(phrase).length;
  }
  const stablePayload = JSON.stringify({
    logicalText,
    rows: first.pipeline.terminal.cellBuffer.rows.map((row) => row.text),
    headings,
    landmarks,
    links,
    controls,
    style: first.pipeline.styles.outcome,
    layout: first.pipeline.layout.outcome,
    displayList: first.pipeline.displayList.outcome,
    cellBuffer: first.pipeline.terminal.cellBuffer.outcome
  });
  const secondPayload = JSON.stringify({
    logicalText: normalized(second.pipeline.textSearchIndex.text),
    rows: second.pipeline.terminal.cellBuffer.rows.map((row) => row.text),
    headings: second.pipeline.terminal.accessibilityBounds.filter((entry) => entry.role === "heading").map((entry) => entry.name),
    landmarks: second.document.landmarks.filter((entry) => new Set(second.pipeline.terminal.accessibilityBounds.map((bound) => bound.documentNode)).has(entry.node) && entry.landmark !== null).map((entry) => entry.landmark),
    links: second.document.links.filter((entry) => second.pipeline.terminal.focusMap.forNode(entry.node) !== null).map((entry) => entry.label),
    controls: second.document.controls.filter((entry) => second.pipeline.terminal.focusMap.forNode(entry.node) !== null).map((entry) => entry.label),
    style: second.pipeline.styles.outcome,
    layout: second.pipeline.layout.outcome,
    displayList: second.pipeline.displayList.outcome,
    cellBuffer: second.pipeline.terminal.cellBuffer.outcome
  });
  return {
    id: fixture.id,
    category: fixture.category,
    license: "MIT",
    sha256: hash,
    scriptRequired: fixture.scriptRequired === true,
    metrics: {
      meaningfulVisibleTextRecall: text,
      headingRecall: heading,
      landmarkRecall: landmark,
      linkRecall: link,
      formControlRecall: control,
      readingOrderAgreement: fixture.expected.text.length === 0 ? 1 : readingMatches / fixture.expected.text.length,
      blankPage: logicalText.length === 0 && cellText.length === 0,
      clippedOrUnreachableContent: fixture.expected.text.filter((phrase) =>
        includesText(logicalText, phrase) && first.pipeline.terminal.search(phrase).ranges.length === 0),
      unsupportedSelectors: unsupportedFrequency(first.pipeline.styles.diagnostics, "selector-unknown"),
      unsupportedAtRules: unsupportedFrequency(first.pipeline.styles.diagnostics, "unsupported-at-rule"),
      unsupportedProperties: unsupportedFrequency(first.pipeline.styles.diagnostics, "property-unsupported"),
      unsupportedValues: unsupportedFrequency(first.pipeline.styles.diagnostics, "value-unsupported"),
      stylesheetFailures: first.pipeline.styles.diagnostics.filter((entry) => entry.code.startsWith("stylesheet-")),
      layoutTruncation: first.pipeline.layout.outcome.status === "truncated" ? first.pipeline.layout.outcome : null,
      terminalTruncations: first.pipeline.terminal.truncations,
      deterministic: stablePayload === secondPayload
    }
  };
}

function aggregate(results) {
  const total = (path) => results.reduce((value, result) => value + path(result).expected, 0);
  const matched = (path) => results.reduce((value, result) => value + path(result).matched, 0);
  const ratio = (path) => {
    const expected = total(path);
    return expected === 0 ? 1 : matched(path) / expected;
  };
  const frequencies = (path) => {
    const values = {};
    for (const result of results) {
      for (const [name, count] of Object.entries(path(result))) values[name] = (values[name] ?? 0) + count;
    }
    return values;
  };
  return {
    meaningfulVisibleTextRecall: ratio((entry) => entry.metrics.meaningfulVisibleTextRecall),
    headingRecall: ratio((entry) => entry.metrics.headingRecall),
    landmarkRecall: ratio((entry) => entry.metrics.landmarkRecall),
    linkRecall: ratio((entry) => entry.metrics.linkRecall),
    formControlRecall: ratio((entry) => entry.metrics.formControlRecall),
    readingOrderAgreement: results.reduce((value, entry) => value + entry.metrics.readingOrderAgreement, 0) / results.length,
    scriptRequiredFixtures: results.filter((entry) => entry.scriptRequired).map((entry) => entry.id),
    unexplainedBlankPages: results.filter((entry) => entry.metrics.blankPage && !entry.scriptRequired).map((entry) => entry.id),
    clippedOrUnreachableContent: results.flatMap((entry) => entry.metrics.clippedOrUnreachableContent.map((text) => ({
      fixture: entry.id,
      text
    }))),
    unsupportedSelectorFrequency: frequencies((entry) => entry.metrics.unsupportedSelectors),
    unsupportedAtRuleFrequency: frequencies((entry) => entry.metrics.unsupportedAtRules),
    unsupportedPropertyFrequency: frequencies((entry) => entry.metrics.unsupportedProperties),
    unsupportedValueFrequency: frequencies((entry) => entry.metrics.unsupportedValues),
    stylesheetAndResourceFailures: results.flatMap((entry) => entry.metrics.stylesheetFailures.map((failure) => ({
      fixture: entry.id,
      failure
    }))),
    nondeterministicFixtures: results.filter((entry) => !entry.metrics.deterministic).map((entry) => entry.id),
    layoutTruncations: results.filter((entry) => entry.metrics.layoutTruncation !== null).map((entry) => entry.id),
    terminalTruncations: results.filter((entry) => entry.metrics.terminalTruncations.length > 0).map((entry) => entry.id)
  };
}

const options = argumentsFor(process.argv.slice(2));
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const results = [];
for (const fixture of corpus.fixtures) {
  const path = resolve(scriptDirectory, fixture.file);
  const html = await readFile(path, "utf8");
  const hash = createHash("sha256").update(html).digest("hex");
  if (fixture.sha256 !== hash) throw new Error(`Fixture checksum mismatch for ${fixture.id}: ${hash}`);
  const first = renderFixture(html, fixture.id);
  const second = renderFixture(html, fixture.id);
  results.push(fixtureResult(fixture, hash, first, second));
}
const summary = aggregate(results);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpusLicense: corpus.license,
  fixtureCount: results.length,
  categories: results.map((entry) => entry.category),
  summary,
  fixtures: results
};
await mkdir(dirname(resolve(options.report)), { recursive: true });
await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (options.check) {
  const gatesPass = summary.meaningfulVisibleTextRecall >= 0.95
    && summary.linkRecall >= 0.95
    && summary.formControlRecall >= 0.95
    && summary.headingRecall >= 0.95
    && summary.landmarkRecall >= 0.95
    && summary.readingOrderAgreement === 1
    && summary.unexplainedBlankPages.length === 0
    && summary.clippedOrUnreachableContent.length === 0
    && summary.nondeterministicFixtures.length === 0
    && summary.layoutTruncations.length === 0
    && summary.terminalTruncations.length === 0;
  if (!gatesPass) throw new Error("Offline compatibility gates failed; inspect the machine-readable report.");
}
