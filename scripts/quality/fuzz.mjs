import { createHash } from "node:crypto";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { renderDocumentViewport } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import {
  cssCoordinate,
  cssLengthFromFixed,
  cssPixels,
  cssPx,
  cssRect
} from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const PROFILES = Object.freeze({
  ci: Object.freeze({ firstSeed: 20260226, caseCount: 128, maxDepth: 5, sectionCount: 8 }),
  release: Object.freeze({ firstSeed: 20260226, caseCount: 512, maxDepth: 6, sectionCount: 10 })
});
const TAGS = Object.freeze([
  "a", "article", "blockquote", "caption", "code", "col", "colgroup", "details", "div", "form", "h1", "h2", "h3",
  "img", "input", "li", "ol", "p", "pre", "section", "span", "summary", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "x-card"
]);
const DISPLAYS = Object.freeze([
  "block", "inline", "contents", "none", "list-item", "table", "table-row",
  "table-cell", "table-row-group", "table-column", "table-column-group", "table-caption", "flex", "grid"
]);
const GRID_TRACK_LISTS = Object.freeze([
  "[start] 40px [middle] minmax(min-content,1fr) [end]",
  "repeat(4,[cell] minmax(8px,1fr) [edge])",
  "repeat(auto-fill,minmax(40px,1fr))",
  "repeat(auto-fit,minmax(63px,1fr))",
  "min-content max-content fit-content(120px) 2fr",
  "[a b c d e f g h i j] 1px [end]",
  "repeat(2,repeat(3,1fr))",
  "repeat(auto-fit,1fr)",
  "minmax(1fr,20px)",
  "9007199254740990px 1fr"
]);
const GRID_PLACEMENTS = Object.freeze([
  "auto", "1", "-1", "2 / -1", "span 2", "slot / span 3",
  "-2 name / span name", "span foo / span foo", "span 2 foo / span 3 bar",
  "4 / 2", "2 / 2", "span 4096", "span 5000", "0", "-1 span"
]);
const GRID_AUTO_FLOWS = Object.freeze([
  "row", "column", "dense", "row dense", "dense row", "column dense", "dense column",
  "row row", "column column", "dense dense", "row column", "row dense column"
]);
const ATTRIBUTES = Object.freeze([
  "aria-label", "class", "colspan", "data-k", "headers", "hidden", "href", "id", "name",
  "rowspan", "scope", "span", "title", "value"
]);
const WORDS = Object.freeze([
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi",
  "chi", "psi", "omega", "界", "é"
]);
const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const CSS_TEXT_MEASURER = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
const TERMINAL_CONTEXT = Object.freeze({
  columns: 80,
  rows: 24,
  cellWidthCssPx: CELL_WIDTH,
  rowHeightCssPx: ROW_HEIGHT,
  colorDepth: 24,
  unicode: true,
  ambiguousWidth: 1,
  cellMeasurer: terminalCellMeasurer()
});

function parseProfile(argv) {
  if (argv.length > 1) throw new Error("usage: node scripts/quality/fuzz.mjs [--profile=ci|release]");
  if (argv[0] === undefined || argv[0] === "--profile=ci") return "ci";
  if (argv[0] === "--profile=release") return "release";
  throw new Error(`unsupported argument: ${argv[0]}`);
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)] ?? values[0];
}

function chance(random, probability) {
  return random() < probability;
}

function randomText(random, minimumWords, maximumWords) {
  const count = minimumWords + Math.floor(random() * (maximumWords - minimumWords + 1));
  return Array.from({ length: count }, () => pick(random, WORDS)).join(" ");
}

function attributeValue(random, name, index) {
  if (name === "href") {
    return chance(random, 0.2)
      ? `../${pick(random, WORDS)}?case=${String(index)}`
      : `https://example.test/${pick(random, WORDS)}/${String(index)}`;
  }
  if (name === "colspan" || name === "rowspan" || name === "span") {
    return pick(random, ["0", "1", "2", "1000", "65534", "999999999999999999999999", "-4", "invalid"]);
  }
  if (name === "scope") return pick(random, ["row", "col", "rowgroup", "colgroup", "auto", "invalid"]);
  if (name === "headers") return `header-${String(index)} missing-${String(index)}`;
  if (name === "hidden") return "";
  return `${pick(random, WORDS)}-${pick(random, WORDS)}-${String(index)}`;
}

function openingTag(random, tagName, index) {
  const attributes = [];
  const attributeCount = Math.floor(random() * 4);
  for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
    const name = pick(random, ATTRIBUTES);
    const value = attributeValue(random, name, index + attributeIndex);
    attributes.push(value.length === 0 ? name : `${name}="${value}"`);
  }
  if (chance(random, 0.35)) {
    const display = pick(random, DISPLAYS);
    const declarations = [`display:${display}`];
    if (display === "grid") {
      declarations.push(`grid-template-columns:${pick(random, GRID_TRACK_LISTS)}`);
      declarations.push(`grid-template-rows:${pick(random, GRID_TRACK_LISTS)}`);
      declarations.push(`grid-auto-flow:${pick(random, GRID_AUTO_FLOWS)}`);
      declarations.push(`gap:${String(Math.floor(random() * 9))}px`);
    } else if (display === "table") {
      declarations.push(`table-layout:${chance(random, 0.5) ? "auto" : "fixed"}`);
      declarations.push(`border-collapse:${chance(random, 0.5) ? "separate" : "collapse"}`);
      declarations.push(`border-spacing:${String(Math.floor(random() * 9))}px ${String(Math.floor(random() * 9))}px`);
    } else if (chance(random, 0.35)) {
      declarations.push(`grid-column:${pick(random, GRID_PLACEMENTS)}`);
      declarations.push(`grid-row:${pick(random, GRID_PLACEMENTS)}`);
    }
    attributes.push(`style="${declarations.join(";")}"`);
  }
  if (chance(random, 0.08)) attributes.push(`dir="${chance(random, 0.5) ? "rtl" : "ltr"}"`);
  return `<${tagName}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
}

function closingTag(random, tagName) {
  if (chance(random, 0.08)) return `<${tagName}`;
  if (chance(random, 0.08)) return `</${tagName}`;
  return `</${tagName}>`;
}

function generateNode(random, depth, maxDepth, index) {
  if (depth >= maxDepth || chance(random, 0.25)) {
    return chance(random, 0.15) ? `<!-- ${randomText(random, 2, 6)} -->` : randomText(random, 1, 8);
  }
  const tagName = pick(random, TAGS);
  const prefix = openingTag(random, tagName, index);
  if (tagName === "col" || tagName === "img" || tagName === "input") return prefix;
  if (tagName === "pre" || tagName === "code") {
    return `${prefix}${randomText(random, 2, 6)}\n  ${randomText(random, 2, 5)}\n\t${randomText(random, 1, 4)}${closingTag(random, tagName)}`;
  }
  const childCount = 1 + Math.floor(random() * 4);
  const children = Array.from(
    { length: childCount },
    (_, childIndex) => generateNode(random, depth + 1, maxDepth, index + childIndex + 1)
  );
  return `${prefix}${children.join("")}${closingTag(random, tagName)}`;
}

function generateHtml(seed, policy) {
  const random = createRandom(seed);
  const body = Array.from(
    { length: policy.sectionCount },
    (_, index) => generateNode(random, 0, policy.maxDepth, index + 1)
  );
  const doctype = chance(random, 0.9) ? "<!doctype html>" : "";
  const htmlStart = chance(random, 0.12) ? "<html" : "<html>";
  const htmlEnd = chance(random, 0.12) ? "</html" : "</html>";
  return `${doctype}${htmlStart}<head><meta charset="utf-8"><title>${randomText(random, 2, 5)}</title></head><body>${body.join("\n")}</body>${htmlEnd}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function treePayload(tree, root, node, children) {
  const seen = new Set();
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (seen.has(id)) throw new Error(`cycle or duplicate tree identity: ${id}`);
    seen.add(id);
    const value = node(id);
    const childValues = children(id);
    output.push({ id, kind: value.kind, source: value.source, children: childValues.map((child) => child.id) });
    for (let index = childValues.length - 1; index >= 0; index -= 1) pending.push(childValues[index].id);
  }
  return output;
}

function evaluate(html) {
  const document = parseWebDocument(html, {
    requestUrl: "https://fuzz.example/",
    finalUrl: "https://fuzz.example/"
  });
  const viewportWidth = cssLengthFromFixed(TERMINAL_CONTEXT.columns * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(TERMINAL_CONTEXT.rows * ROW_HEIGHT);
  const rendered = renderDocumentViewport({
    document,
    state: createDocumentState(document),
    resources: embeddedStylesheetSources(document),
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
    terminalContext: TERMINAL_CONTEXT,
    window: { scrollRow: 0, viewportRows: TERMINAL_CONTEXT.rows, overscanBefore: 0, overscanAfter: 0 }
  });
  const artifacts = rendered.artifacts;
  const terminal = rendered.viewport.terminal;
  const formatting = treePayload(
    artifacts.boxTree,
    artifacts.boxTree.root,
    (id) => artifacts.boxTree.node(id),
    (id) => artifacts.boxTree.children(id)
  );
  const layoutFragments = treePayload(
    artifacts.documentLayout,
    artifacts.documentLayout.root,
    (id) => artifacts.documentLayout.fragment(id),
    (id) => artifacts.documentLayout.children(id)
  );
  return {
    diagnostics: document.diagnostics.map(({ id }) => id),
    title: document.title,
    links: document.links.map(({ node, destination }) => ({ node, destination })),
    styleOutcome: artifacts.computedStyles.outcome,
    formattingOutcome: artifacts.boxTree.outcome,
    layoutOutcome: artifacts.documentLayout.outcome,
    displayListOutcome: artifacts.documentDisplayList.outcome,
    cellBufferOutcome: terminal.cellBuffer.outcome,
    formatting,
    layoutFragments,
    rows: terminal.cellBuffer.rows.map((row) => row.text),
    actions: terminal.focusMap.targets.map(({ node, action }) => ({ node, action }))
  };
}

const TABLE_ADVERSARIAL_CASES = Object.freeze([
  `<table><tr><td colspan="999999999999999999999999" rowspan="999999999999999999999999">bounded</td></tr></table>`,
  `<table><tbody><tr><td rowspan="0">remaining group</td><td>one</td></tr><tr><td>two</td></tr></tbody>
    <tbody><tr><td>next group</td></tr></tbody></table>`,
  `<div style="display:table"><span style="display:table-cell">orphan cell</span>
    <span style="display:table-row-group"><span style="display:table-cell">anonymous row</span></span></div>`,
  `<table style="border-collapse:collapse"><tr><td colspan="3" style="border:8px solid red">wide</td></tr>
    <tr><td style="border:1px solid blue">a</td><td style="border:hidden">b</td><td style="border:4px solid green">c</td></tr></table>`,
  `<table style="table-layout:fixed;width:9007199254740990px"><col span="1000" style="width:9007199254740990px">
    <tr><td>fixed extreme</td></tr></table>`,
  `<table style="width:calc(100% - 1px)"><tr><td style="width:calc(50% - 2px)">percentage</td>
    <td style="min-width:min(25%,20px)">dependent</td></tr></table>`,
  `${"<table><caption>nested</caption><tr><td>".repeat(12)}deep${"</td></tr></table>".repeat(12)}`,
  `<table>${Array.from({ length: 50 }, (_, index) => `<caption style="caption-side:${index % 2 === 0 ? "top" : "bottom"}">caption ${String(index)}</caption>`).join("")}
    <tr><td>many captions</td></tr></table>`,
  `<table>${Array.from({ length: 20 }, (_, row) => `<tr>${Array.from({ length: 10 }, (_, column) =>
    `<td colspan="${String(1 + (row + column) % 4)}" rowspan="${String(1 + (row * column) % 3)}">${String(row)}:${String(column)}</td>`).join("")}</tr>`).join("")}</table>`,
  `<table style="border-spacing:8px"><col><col style="visibility:collapse"><col><tbody>
    <tr><td>left</td><td>collapsed</td><td>right</td></tr><tr style="visibility:collapse"><td>hidden row</td></tr></tbody></table>`,
  `<table><tr><th id="root" abbr="R">root</th><th id="branch" headers="root">branch</th>
    <th id="cycle-a" headers="cycle-b">a</th><th id="cycle-b" headers="cycle-a">b</th></tr>
    <tr><td headers="branch root branch">explicit graph</td><th headers="branch">header target</th></tr></table>`,
  `<table><tr>${Array.from({ length: 100 }, (_, column) => `<th id="column-${String(column)}" scope="col">${String(column)}</th>`).join("")}</tr>
    ${Array.from({ length: 100 }, (_, row) => `<tr><th scope="row">${String(row)}</th><td colspan="99">automatic ${String(row)}</td></tr>`).join("")}</table>`,
  `<table style="width:calc(100% - 1px)"><colgroup span="128" style="width:min(75%,900px)"></colgroup>
    <colgroup><col span="64" style="width:calc(1% + 1px)"></colgroup><tr><td colspan="192">groups</td></tr></table>`,
  `<table><tfoot><tr><td>displayed last</td></tr></tfoot><tbody><tr><td>body</td></tr></tbody>
    <thead><tr><th>displayed first</th></tr></thead><thead><tr><th>ordinary header group</th></tr></thead></table>`,
  `<table style="border-collapse:collapse;border:7px solid red"></table>`,
  `<table dir="rtl" style="border-collapse:collapse;border:3px solid black"><colgroup style="border:3px solid red"><col><col></colgroup>
    <tbody style="border:3px solid blue"><tr style="border:3px solid green"><td style="border:3px solid purple">right</td><td style="border:3px solid orange">left</td></tr></tbody></table>`
]);

const profileName = parseProfile(process.argv.slice(2));
const policy = PROFILES[profileName];
const failures = [];
for (let index = 0; index < policy.caseCount; index += 1) {
  const seed = policy.firstSeed + index;
  const html = generateHtml(seed, policy);
  try {
    if (JSON.stringify(evaluate(html)) !== JSON.stringify(evaluate(html))) {
      failures.push({ seed, htmlSha256: sha256(html), reason: "non-deterministic pipeline output" });
    }
  } catch (error) {
    failures.push({
      seed,
      htmlSha256: sha256(html),
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}
for (const [index, html] of TABLE_ADVERSARIAL_CASES.entries()) {
  try {
    if (JSON.stringify(evaluate(html)) !== JSON.stringify(evaluate(html))) {
      failures.push({ seed: `table-${String(index)}`, htmlSha256: sha256(html), reason: "non-deterministic table pipeline output" });
    }
  } catch (error) {
    failures.push({
      seed: `table-${String(index)}`,
      htmlSha256: sha256(html),
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`fuzz failure: seed=${String(failure.seed)} sha256=${failure.htmlSha256} ${failure.reason}\n`);
  }
  throw new Error(`${String(failures.length)} deterministic fuzz case(s) failed`);
}
process.stdout.write(`fuzz ${profileName} ok: ${String(policy.caseCount + TABLE_ADVERSARIAL_CASES.length)} crash-free deterministic structural pipeline cases\n`);
