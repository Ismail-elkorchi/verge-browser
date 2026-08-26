import { createHash } from "node:crypto";

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

const PROFILES = Object.freeze({
  ci: Object.freeze({ firstSeed: 20260226, caseCount: 128, maxDepth: 5, sectionCount: 8 }),
  release: Object.freeze({ firstSeed: 20260226, caseCount: 512, maxDepth: 6, sectionCount: 10 })
});
const TAGS = Object.freeze([
  "a", "article", "blockquote", "code", "details", "div", "form", "h1", "h2", "h3",
  "img", "input", "li", "ol", "p", "pre", "section", "span", "summary", "table",
  "tbody", "td", "th", "tr", "ul", "x-card"
]);
const DISPLAYS = Object.freeze([
  "block", "inline", "contents", "none", "list-item", "table", "table-row",
  "table-cell", "flex", "grid"
]);
const ATTRIBUTES = Object.freeze(["aria-label", "class", "data-k", "hidden", "href", "id", "name", "title", "value"]);
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
  if (chance(random, 0.25)) attributes.push(`style="display:${pick(random, DISPLAYS)}"`);
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
  if (tagName === "img" || tagName === "input") return prefix;
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
  const renderPipeline = renderDocument({
    document,
    state: createDocumentState(document),
    resources: [],
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
    terminalContext: TERMINAL_CONTEXT
  });
  const formatting = treePayload(
    renderPipeline.formatting,
    renderPipeline.formatting.root,
    (id) => renderPipeline.formatting.node(id),
    (id) => renderPipeline.formatting.children(id)
  );
  const layoutFragments = treePayload(
    renderPipeline.layout,
    renderPipeline.layout.root,
    (id) => renderPipeline.layout.fragment(id),
    (id) => renderPipeline.layout.children(id)
  );
  return {
    diagnostics: document.diagnostics.map(({ id }) => id),
    title: document.title,
    links: document.links.map(({ node, destination }) => ({ node, destination })),
    styleOutcome: renderPipeline.styles.outcome,
    formattingOutcome: renderPipeline.formatting.outcome,
    layoutOutcome: renderPipeline.layout.outcome,
    displayListOutcome: renderPipeline.displayList.outcome,
    cellBufferOutcome: renderPipeline.terminal.cellBuffer.outcome,
    formatting,
    layoutFragments,
    rows: renderPipeline.terminal.cellBuffer.rows.map((row) => row.text),
    actions: renderPipeline.terminal.focusMap.targets.map(({ node, action }) => ({ node, action }))
  };
}

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
if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`fuzz failure: seed=${String(failure.seed)} sha256=${failure.htmlSha256} ${failure.reason}\n`);
  }
  throw new Error(`${String(failures.length)} deterministic fuzz case(s) failed`);
}
process.stdout.write(`fuzz ${profileName} ok: ${String(policy.caseCount)} crash-free deterministic structural pipeline cases\n`);
