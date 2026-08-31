import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserSession } from "../../dist/app/session.js";
import { createDocumentState } from "../../dist/document/index.js";
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
const DEFAULT_VARIANTS = Object.freeze([
  Object.freeze({ id: "narrow", columns: 40, rows: 120, scrollRow: 0 }),
  Object.freeze({ id: "medium", columns: 80, rows: 90, scrollRow: 0 }),
  Object.freeze({ id: "wide", columns: 120, rows: 70, scrollRow: 0 })
]);

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

function htmlFields() {
  return new HttpFields([{ name: "content-type", value: "text/html; charset=utf-8" }]);
}

function cssFields() {
  return new HttpFields([{ name: "content-type", value: "text/css" }]);
}

async function loadResourceBytes(resource) {
  const bytes = await readFile(resolve(scriptDirectory, resource.file));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (resource.sha256 !== hash) {
    throw new Error(`Resource checksum mismatch for ${resource.requestUrl}: ${hash}`);
  }
  return bytes;
}

async function openFixture(fixture, html, requests) {
  const requestUrl = fixture.requestUrl ?? `https://compat.verge.test/${fixture.id}/index.html`;
  const declaredResources = fixture.resources ?? corpus.resourceSets?.[fixture.resourceSet] ?? [];
  const resources = new Map(declaredResources.map((resource) => [resource.requestUrl, resource]));
  const session = new BrowserSession({
    defaultParseMode: "text",
    ...(fixture.stylesheetPolicy === undefined ? {} : { stylesheetPolicy: fixture.stylesheetPolicy }),
    loader: async (url) => {
      if (url !== requestUrl) throw new Error(`Unexpected offline page request: ${url}`);
      return {
        requestUrl: url,
        finalUrl: url,
        status: 200,
        statusText: "OK",
        contentType: "text/html",
        html,
        responseFields: htmlFields(),
        networkOutcome: {
          kind: "ok", finalUrl: url, status: 200, statusText: "OK",
          detailCode: "HTTP_200", detailMessage: "200 OK"
        },
        fetchedAtIso: "2026-08-27T00:00:00.000Z"
      };
    },
    streamLoader: async () => {
      throw new Error("The offline compatibility harness uses buffered page fixtures.");
    },
    stylesheetLoader: async (url) => {
      requests.push(url);
      const resource = resources.get(url);
      if (resource === undefined) throw new Error(`Unexpected offline stylesheet request: ${url}`);
      return {
        requestUrl: url,
        finalUrl: resource.finalUrl ?? url,
        contentType: "text/css",
        bytes: await loadResourceBytes(resource),
        responseFields: cssFields(),
        ...(resource.transportEncodingLabel === undefined
          ? {}
          : { transportEncodingLabel: resource.transportEncodingLabel })
      };
    }
  });
  try {
    return await session.open(requestUrl);
  } finally {
    await session.close();
  }
}

function renderSnapshot(snapshot, variant) {
  const viewportWidth = cssLengthFromFixed(variant.columns * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(variant.rows * ROW_HEIGHT);
  const scrollY = cssLengthFromFixed(variant.scrollRow * ROW_HEIGHT);
  return renderDocument({
    document: snapshot.document,
    state: createDocumentState(snapshot.document),
    resources: snapshot.stylesheets,
    styleDiagnostics: snapshot.styleDiagnostics,
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
        cssCoordinate(cssPx(0)), cssCoordinate(scrollY), viewportWidth, viewportHeight
      )
    },
    terminalContext: {
      columns: variant.columns,
      rows: variant.rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      cellMeasurer: terminalCellMeasurer()
    }
  });
}

function allowedDiagnostic(fixture, diagnostic) {
  return (fixture.allowedDiagnostics ?? []).some((allowance) => allowance.code === diagnostic.code
    && (allowance.sourceUrl === undefined || allowance.sourceUrl === diagnostic.sourceUrl));
}

function unsupportedFrequency(diagnostics, code) {
  const values = {};
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== code) continue;
    const key = `${diagnostic.code}:${diagnostic.sourceUrl}`;
    values[key] = (values[key] ?? 0) + diagnostic.occurrences;
  }
  return values;
}

function stablePayload(snapshot, pipeline, requests) {
  return JSON.stringify({
    requests,
    stylesheets: snapshot.stylesheets.map((entry) => ({
      sourceUrl: entry.sourceUrl,
      rootOrder: entry.rootOrder,
      dependencyOrder: entry.dependencyOrder,
      importDepth: entry.importDepth,
      importedFrom: entry.importedFrom
    })),
    logicalText: normalized(pipeline.textSearchIndex.text),
    rows: pipeline.terminal.cellBuffer.rows.map((row) => row.text),
    style: pipeline.styles.outcome,
    layout: pipeline.layout.outcome,
    displayList: pipeline.displayList.outcome,
    cellBuffer: pipeline.terminal.cellBuffer.outcome,
    truncations: pipeline.terminal.truncations
  });
}

function principalRectangle(snapshot, pipeline, elementId) {
  const documentNode = snapshot.document.elementById(elementId);
  if (documentNode === undefined || documentNode === null) return null;
  const fragment = pipeline.layout.forDocumentNode(documentNode)
    .find((candidate) => candidate.kind === "box" && candidate.borderRect.width > 0 && candidate.borderRect.height > 0);
  if (fragment === undefined) return null;
  return {
    x: cssPixels(fragment.borderRect.x),
    y: cssPixels(fragment.borderRect.y),
    width: cssPixels(fragment.borderRect.width),
    height: cssPixels(fragment.borderRect.height)
  };
}

function boxRelationshipFailures(fixture, variant, snapshot, pipeline) {
  const gridExpectations = fixture.expected.gridStructureByVariant?.[variant.id]
    ?? fixture.expected.gridStructure
    ?? [];
  const tableExpectations = fixture.expected.tableStructureByVariant?.[variant.id]
    ?? fixture.expected.tableStructure
    ?? [];
  const expectations = [...gridExpectations, ...tableExpectations];
  const failures = [];
  const rectangleCache = new Map();
  const rectangle = (id) => {
    if (!rectangleCache.has(id)) rectangleCache.set(id, principalRectangle(snapshot, pipeline, id));
    return rectangleCache.get(id);
  };
  for (const expectation of expectations) {
    const first = rectangle(expectation.first);
    const second = rectangle(expectation.second);
    if (first === null || second === null) {
      failures.push({ ...expectation, reason: first === null ? "missing-first-fragment" : "missing-second-fragment" });
      continue;
    }
    const firstEndX = first.x + first.width;
    const firstEndY = first.y + first.height;
    const secondEndX = second.x + second.width;
    const secondEndY = second.y + second.height;
    const matches = expectation.relation === "same-row" ? first.y < secondEndY && second.y < firstEndY
      : expectation.relation === "same-column" ? first.x < secondEndX && second.x < firstEndX
      : expectation.relation === "left-of" ? firstEndX <= second.x
      : expectation.relation === "right-of" ? secondEndX <= first.x
      : expectation.relation === "above" ? first.y < second.y
      : expectation.relation === "below" ? second.y < first.y
      : expectation.relation === "contains" ? first.x <= second.x && first.y <= second.y
        && firstEndX >= secondEndX && firstEndY >= secondEndY
      : expectation.relation === "overlaps" ? first.x < secondEndX && second.x < firstEndX
        && first.y < secondEndY && second.y < firstEndY
      : expectation.relation === "wider-than" ? first.width > second.width
      : expectation.relation === "taller-than" ? first.height > second.height
      : false;
    if (!matches) failures.push({ ...expectation, reason: "relationship-mismatch", firstRectangle: first, secondRectangle: second });
  }
  return failures;
}

function tableHeaderRelationshipFailures(fixture, snapshot) {
  const failures = [];
  for (const expectation of fixture.expected.tableHeaders ?? []) {
    const cell = snapshot.document.elementById(expectation.cell);
    if (cell === null || cell === undefined) {
      failures.push({ ...expectation, reason: "missing-cell" });
      continue;
    }
    const actual = new Set(snapshot.document.semantic(cell)?.tableHeaders ?? []);
    for (const headerId of expectation.headers) {
      const header = snapshot.document.elementById(headerId);
      if (header === null || header === undefined || !actual.has(header)) failures.push({ ...expectation, missingHeader: headerId, reason: "missing-header-relationship" });
    }
  }
  return failures;
}

function collapsedBorderSegmentMetrics(fixture, pipeline) {
  const segments = [];
  const pending = [pipeline.layout.root];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const fragment = pipeline.layout.fragment(id);
    pending.push(...fragment.children);
    if (fragment.kind === "box") segments.push(...(fragment.tableCollapsedBorderSegments ?? []));
  }
  const expectation = fixture.expected.collapsedBorderSegments;
  const failures = [];
  if (expectation !== undefined && segments.length < expectation.minimum) {
    failures.push({
      reason: "too-few-collapsed-border-segments",
      expectedMinimum: expectation.minimum,
      actual: segments.length
    });
  }
  if (expectation?.maximum !== undefined && segments.length > expectation.maximum) {
    failures.push({
      reason: "too-many-collapsed-border-segments",
      expectedMaximum: expectation.maximum,
      actual: segments.length
    });
  }
  const ids = new Set();
  for (const segment of segments) {
    if (ids.has(segment.id)) failures.push({ reason: "duplicate-collapsed-border-segment", id: segment.id });
    ids.add(segment.id);
  }
  return { count: segments.length, failures };
}

function caseResult(fixture, variant, hash, snapshot, pipeline, deterministic, requests) {
  const logicalText = normalized(pipeline.textSearchIndex.text);
  const paintedText = normalized(pipeline.terminal.cellBuffer.rows.map((row) => row.text).join("\n"));
  const accessibleNodes = new Set(pipeline.terminal.accessibilityBounds.map((entry) => entry.documentNode));
  const headings = pipeline.terminal.accessibilityBounds
    .filter((entry) => entry.role === "heading").map((entry) => entry.name);
  const landmarks = snapshot.document.landmarks
    .filter((entry) => accessibleNodes.has(entry.node) && entry.landmark !== null).map((entry) => entry.landmark);
  const linkNodes = new Set(pipeline.terminal.focusMap.targets
    .filter((entry) => entry.action.kind === "link").map((entry) => entry.node));
  const links = snapshot.document.links.filter((entry) => linkNodes.has(entry.node)).map((entry) => entry.label);
  const controlNodes = new Set(pipeline.terminal.focusMap.targets
    .filter((entry) => entry.action.kind === "form-control").map((entry) => entry.node));
  const controls = snapshot.document.controls.filter((entry) => controlNodes.has(entry.node)).map((entry) => entry.label);
  const expectedText = fixture.expected.text;
  const logicalTextRecall = recall(expectedText, [logicalText]);
  const paintedPhrases = expectedText.filter((phrase) => pipeline.terminal.search(phrase).ranges.length > 0);
  const paintedTextRecall = recall(expectedText, paintedPhrases, (expected, actual) => expected === actual);
  const heading = recall(fixture.expected.headings, headings);
  const landmark = recall(fixture.expected.landmarks, landmarks, (expected, actual) => expected === actual);
  const link = recall(fixture.expected.links, links);
  const control = recall(fixture.expected.controls, controls);
  let readingCursor = 0;
  let readingMatches = 0;
  const foldedLogical = logicalText.toLocaleLowerCase("und");
  for (const phrase of expectedText) {
    const normalizedPhrase = normalized(phrase).toLocaleLowerCase("und");
    const index = foldedLogical.indexOf(normalizedPhrase, readingCursor);
    if (index < 0) continue;
    readingMatches += 1;
    readingCursor = index + normalizedPhrase.length;
  }
  const diagnostics = [...snapshot.styleDiagnostics, ...pipeline.styles.diagnostics];
  const uniqueDiagnostics = diagnostics.filter((entry, index) => diagnostics.findIndex((candidate) =>
    candidate.code === entry.code && candidate.sourceUrl === entry.sourceUrl && candidate.detail === entry.detail
  ) === index);
  const unexpected = uniqueDiagnostics.filter((entry) => !allowedDiagnostic(fixture, entry));
  const collapsedBorders = collapsedBorderSegmentMetrics(fixture, pipeline);
  return {
    id: `${fixture.id}:${variant.id}`,
    fixture: fixture.id,
    variant,
    category: fixture.category,
    license: "MIT",
    sha256: hash,
    scriptRequired: fixture.scriptRequired === true,
    stylesheetRequests: requests,
    metrics: {
      logicalMeaningfulTextRecall: logicalTextRecall,
      paintedCellMeaningfulTextRecall: paintedTextRecall,
      headingRecall: heading,
      landmarkRecall: landmark,
      linkRecall: link,
      formControlRecall: control,
      sourceLinkedActionRecall: recall([...fixture.expected.links, ...fixture.expected.controls], [...links, ...controls]),
      readingOrderAgreement: expectedText.length === 0 ? 1 : readingMatches / expectedText.length,
      blankPage: logicalText.length === 0 && paintedText.length === 0,
      clippedLogicalText: expectedText.filter((phrase) => !includesText(logicalText, phrase)),
      clippedPaintedText: expectedText.filter((phrase) =>
        includesText(logicalText, phrase) && pipeline.terminal.search(phrase).ranges.length === 0),
      stylesheetRequestContract: {
        missing: (fixture.expected.requiredStylesheetRequests ?? []).filter((url) => !requests.includes(url)),
        incorrectlyRequested: (fixture.expected.avoidedStylesheetRequests ?? []).filter((url) => requests.includes(url))
      },
      unsupportedSelectors: unsupportedFrequency(unexpected, "selector-unknown"),
      unsupportedAtRules: unsupportedFrequency(unexpected, "unsupported-at-rule"),
      unsupportedProperties: unsupportedFrequency(unexpected, "property-unsupported"),
      unsupportedValues: unsupportedFrequency(unexpected, "value-unsupported"),
      stylesheetFailures: unexpected.filter((entry) => entry.code.startsWith("stylesheet-")),
      resourceFailures: unexpected.filter((entry) => entry.code === "resource-failure"),
      unexpectedDiagnostics: unexpected,
      layoutTruncation: pipeline.layout.outcome.status === "truncated" ? pipeline.layout.outcome : null,
      displayListTruncation: pipeline.displayList.outcome.status === "truncated" ? pipeline.displayList.outcome : null,
      cellBufferTruncation: pipeline.terminal.cellBuffer.outcome.status === "truncated"
        ? pipeline.terminal.cellBuffer.outcome : null,
      terminalTruncations: pipeline.terminal.truncations,
      boxRelationshipFailures: boxRelationshipFailures(fixture, variant, snapshot, pipeline),
      tableHeaderRelationshipFailures: tableHeaderRelationshipFailures(fixture, snapshot),
      collapsedBorderSegmentCount: collapsedBorders.count,
      collapsedBorderSegmentFailures: collapsedBorders.failures,
      deterministic
    }
  };
}

function aggregate(results) {
  const ratio = (path) => {
    const expected = results.reduce((sum, entry) => sum + path(entry).expected, 0);
    const matched = results.reduce((sum, entry) => sum + path(entry).matched, 0);
    return expected === 0 ? 1 : matched / expected;
  };
  const frequencies = (path) => {
    const values = {};
    for (const result of results) {
      for (const [name, count] of Object.entries(path(result))) values[name] = (values[name] ?? 0) + count;
    }
    return values;
  };
  return {
    logicalMeaningfulTextRecall: ratio((entry) => entry.metrics.logicalMeaningfulTextRecall),
    paintedCellMeaningfulTextRecall: ratio((entry) => entry.metrics.paintedCellMeaningfulTextRecall),
    headingRecall: ratio((entry) => entry.metrics.headingRecall),
    landmarkRecall: ratio((entry) => entry.metrics.landmarkRecall),
    linkRecall: ratio((entry) => entry.metrics.linkRecall),
    formControlRecall: ratio((entry) => entry.metrics.formControlRecall),
    sourceLinkedActionRecall: ratio((entry) => entry.metrics.sourceLinkedActionRecall),
    readingOrderAgreement: results.reduce((sum, entry) => sum + entry.metrics.readingOrderAgreement, 0) / results.length,
    scriptRequiredFixtures: [...new Set(results.filter((entry) => entry.scriptRequired).map((entry) => entry.fixture))],
    unexplainedBlankPages: results.filter((entry) => entry.metrics.blankPage && !entry.scriptRequired).map((entry) => entry.id),
    clippedLogicalText: results.flatMap((entry) => entry.metrics.clippedLogicalText.map((value) => ({ case: entry.id, text: value }))),
    clippedPaintedText: results.flatMap((entry) => entry.metrics.clippedPaintedText.map((value) => ({ case: entry.id, text: value }))),
    stylesheetRequestContractFailures: results.flatMap((entry) => [
      ...entry.metrics.stylesheetRequestContract.missing.map((url) => ({ case: entry.id, kind: "missing", url })),
      ...entry.metrics.stylesheetRequestContract.incorrectlyRequested.map((url) => ({ case: entry.id, kind: "incorrectly-requested", url }))
    ]),
    unsupportedSelectorFrequency: frequencies((entry) => entry.metrics.unsupportedSelectors),
    unsupportedAtRuleFrequency: frequencies((entry) => entry.metrics.unsupportedAtRules),
    unsupportedPropertyFrequency: frequencies((entry) => entry.metrics.unsupportedProperties),
    unsupportedValueFrequency: frequencies((entry) => entry.metrics.unsupportedValues),
    stylesheetAndResourceFailures: results.flatMap((entry) => [
      ...entry.metrics.stylesheetFailures, ...entry.metrics.resourceFailures
    ].map((failure) => ({ case: entry.id, failure }))),
    unexpectedDiagnostics: results.flatMap((entry) => entry.metrics.unexpectedDiagnostics.map((diagnostic) => ({
      case: entry.id, diagnostic
    }))),
    nondeterministicCases: results.filter((entry) => !entry.metrics.deterministic).map((entry) => entry.id),
    layoutTruncations: results.filter((entry) => entry.metrics.layoutTruncation !== null).map((entry) => entry.id),
    displayListTruncations: results.filter((entry) => entry.metrics.displayListTruncation !== null).map((entry) => entry.id),
    cellBufferTruncations: results.filter((entry) => entry.metrics.cellBufferTruncation !== null).map((entry) => entry.id),
    terminalTruncations: results.filter((entry) => entry.metrics.terminalTruncations.length > 0).map((entry) => entry.id),
    boxRelationshipFailures: results.flatMap((entry) => entry.metrics.boxRelationshipFailures.map((failure) => ({
      case: entry.id,
      failure
    }))),
    tableHeaderRelationshipFailures: results.flatMap((entry) => entry.metrics.tableHeaderRelationshipFailures.map((failure) => ({
      case: entry.id,
      failure
    }))),
    collapsedBorderSegmentFailures: results.flatMap((entry) => entry.metrics.collapsedBorderSegmentFailures.map((failure) => ({
      case: entry.id,
      failure
    })))
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
  const variants = fixture.variants ?? DEFAULT_VARIANTS;
  for (const variant of variants) {
    const firstRequests = [];
    const secondRequests = [];
    const firstSnapshot = await openFixture(fixture, html, firstRequests);
    const secondSnapshot = await openFixture(fixture, html, secondRequests);
    const first = renderSnapshot(firstSnapshot, variant);
    const second = renderSnapshot(secondSnapshot, variant);
    const deterministic = stablePayload(firstSnapshot, first, firstRequests)
      === stablePayload(secondSnapshot, second, secondRequests);
    results.push(caseResult(fixture, variant, hash, firstSnapshot, first, deterministic, firstRequests));
  }
}
const summary = aggregate(results);
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  corpusLicense: corpus.license,
  fixtureCount: corpus.fixtures.length,
  caseCount: results.length,
  categories: [...new Set(results.map((entry) => entry.category))],
  summary,
  cases: results
};
await mkdir(dirname(resolve(options.report)), { recursive: true });
await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (options.check) {
  const gatesPass = summary.logicalMeaningfulTextRecall >= 0.95
    && summary.paintedCellMeaningfulTextRecall >= 0.95
    && summary.linkRecall >= 0.95
    && summary.formControlRecall >= 0.95
    && summary.headingRecall >= 0.95
    && summary.landmarkRecall >= 0.95
    && summary.sourceLinkedActionRecall >= 0.95
    && summary.readingOrderAgreement === 1
    && summary.unexplainedBlankPages.length === 0
    && summary.clippedLogicalText.length === 0
    && summary.clippedPaintedText.length === 0
    && summary.stylesheetRequestContractFailures.length === 0
    && summary.unexpectedDiagnostics.length === 0
    && summary.stylesheetAndResourceFailures.length === 0
    && summary.nondeterministicCases.length === 0
    && summary.layoutTruncations.length === 0
    && summary.displayListTruncations.length === 0
    && summary.cellBufferTruncations.length === 0
    && summary.terminalTruncations.length === 0;
  const structuralGatesPass = summary.boxRelationshipFailures.length === 0
    && summary.tableHeaderRelationshipFailures.length === 0
    && summary.collapsedBorderSegmentFailures.length === 0;
  if (!gatesPass || !structuralGatesPass) throw new Error("Offline compatibility gates failed; inspect the machine-readable report.");
}
