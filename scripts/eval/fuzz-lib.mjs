import { createHash } from "node:crypto";

import { parse, visibleText } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

const TAGS = [
  "div",
  "p",
  "span",
  "a",
  "ul",
  "li",
  "section",
  "article",
  "pre",
  "code",
  "table",
  "tr",
  "td",
  "th",
  "blockquote",
  "h1",
  "h2",
  "h3"
];
const ATTRS = ["id", "class", "title", "lang", "data-k", "data-v", "href", "aria-label", "hidden"];
const WORDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rng, values) {
  const index = Math.floor(rng() * values.length);
  return values[index] ?? values[0];
}

function maybe(rng, probability) {
  return rng() < probability;
}

function randomWord(rng) {
  return pick(rng, WORDS);
}

function randomText(rng, minWords, maxWords) {
  const count = minWords + Math.floor(rng() * (maxWords - minWords + 1));
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push(randomWord(rng));
  }
  return chunks.join(" ");
}

function randomAttrValue(rng, attrName, index) {
  if (attrName === "href") {
    return `https://example.test/${randomWord(rng)}/${String(index)}`;
  }
  if (attrName === "hidden") {
    return maybe(rng, 0.5) ? "" : "hidden";
  }
  return `${randomWord(rng)}-${randomWord(rng)}-${String(index)}`;
}

function openTag(rng, tagName, index) {
  const attrs = [];
  const attrCount = Math.floor(rng() * 4);
  for (let attrIndex = 0; attrIndex < attrCount; attrIndex += 1) {
    const attrName = pick(rng, ATTRS);
    const attrValue = randomAttrValue(rng, attrName, index + attrIndex);
    if (attrName === "hidden" && attrValue.length === 0) {
      attrs.push("hidden");
      continue;
    }
    attrs.push(`${attrName}="${attrValue}"`);
  }
  const attrSuffix = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<${tagName}${attrSuffix}>`;
}

function maybeMalformedSuffix(rng, tagName) {
  if (maybe(rng, 0.08)) {
    return `<${tagName}`;
  }
  if (maybe(rng, 0.08)) {
    return `</${tagName}`;
  }
  return `</${tagName}>`;
}

function generateNode(rng, depth, maxDepth, idBase) {
  if (depth >= maxDepth || maybe(rng, 0.25)) {
    if (maybe(rng, 0.15)) {
      return `<!-- ${randomText(rng, 2, 6)} -->`;
    }
    return randomText(rng, 1, 8);
  }

  const tagName = pick(rng, TAGS);
  const childCount = 1 + Math.floor(rng() * 4);
  const children = [];
  for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
    children.push(generateNode(rng, depth + 1, maxDepth, idBase + childIndex + 1));
  }

  const prefix = openTag(rng, tagName, idBase);
  const suffix = maybeMalformedSuffix(rng, tagName);

  if (tagName === "pre" || tagName === "code") {
    const preLines = [randomText(rng, 2, 6), `  ${randomText(rng, 2, 5)}`, `\t${randomText(rng, 1, 4)}`];
    return `${prefix}${preLines.join("\n")}${suffix}`;
  }

  return `${prefix}${children.join("")}${suffix}`;
}

export function generateFuzzHtml(seed, options = {}) {
  const rng = createRng(seed);
  const maxDepth = options.maxDepth ?? 5;
  const sectionCount = options.sectionCount ?? 8;
  const body = [];
  for (let index = 0; index < sectionCount; index += 1) {
    body.push(generateNode(rng, 0, maxDepth, index + 1));
  }
  const maybeDoctype = maybe(rng, 0.9) ? "<!doctype html>" : "";
  const maybeBrokenStart = maybe(rng, 0.12) ? "<html" : "<html>";
  const maybeBrokenEnd = maybe(rng, 0.12) ? "</html" : "</html>";
  return `${maybeDoctype}\n${maybeBrokenStart}<head><meta charset="utf-8"><title>${randomText(rng, 2, 5)}</title></head><body>${body.join("\n")}</body>${maybeBrokenEnd}`;
}

export function evaluateFuzzCase(caseEntry) {
  const tree = parse(caseEntry.html, {
    trace: false,
    captureSpans: false
  });

  const rendered = renderDocumentToTerminal({
    tree,
    requestUrl: "https://fuzz.example/",
    finalUrl: "https://fuzz.example/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const visible = visibleText(tree, {
    trim: true,
    skipHiddenSubtrees: false,
    includeControlValues: true,
    includeAccessibleNameFallback: false
  });

  return {
    caseId: caseEntry.caseId,
    seed: caseEntry.seed,
    htmlSha256: sha256(caseEntry.html),
    parseErrorCount: Array.isArray(tree.parseErrors) ? tree.parseErrors.length : 0,
    visibleTextSha256: sha256(visible),
    renderSha256: sha256(rendered.lines.join("\n")),
    lineCount: rendered.lines.length,
    linkCount: rendered.links.length
  };
}
