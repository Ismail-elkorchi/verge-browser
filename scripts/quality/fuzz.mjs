import { createHash } from "node:crypto";

import { parse } from "@ismail-elkorchi/html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

const PROFILES = Object.freeze({
  ci: Object.freeze({
    firstSeed: 20260226,
    caseCount: 128,
    maxDepth: 5,
    sectionCount: 8
  }),
  release: Object.freeze({
    firstSeed: 20260226,
    caseCount: 512,
    maxDepth: 6,
    sectionCount: 10
  })
});

const TAGS = Object.freeze([
  "a",
  "article",
  "blockquote",
  "code",
  "details",
  "div",
  "form",
  "h1",
  "h2",
  "h3",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "span",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul"
]);

const ATTRIBUTES = Object.freeze([
  "aria-label",
  "class",
  "data-k",
  "hidden",
  "href",
  "id",
  "name",
  "title",
  "value"
]);

const WORDS = Object.freeze([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "omicron",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "chi",
  "psi",
  "omega"
]);

function parseProfile(argv) {
  if (argv.length > 1) {
    throw new Error("usage: node scripts/quality/fuzz.mjs [--profile=ci|release]");
  }

  const profileArgument = argv[0];
  if (profileArgument === undefined) {
    return "ci";
  }
  if (profileArgument === "--profile=ci") {
    return "ci";
  }
  if (profileArgument === "--profile=release") {
    return "release";
  }
  throw new Error(`unsupported argument: ${profileArgument}`);
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
  const wordCount =
    minimumWords + Math.floor(random() * (maximumWords - minimumWords + 1));
  return Array.from({ length: wordCount }, () => pick(random, WORDS)).join(" ");
}

function attributeValue(random, attributeName, index) {
  if (attributeName === "href") {
    return chance(random, 0.2)
      ? `../${pick(random, WORDS)}?case=${String(index)}`
      : `https://example.test/${pick(random, WORDS)}/${String(index)}`;
  }
  if (attributeName === "hidden") {
    return "";
  }
  return `${pick(random, WORDS)}-${pick(random, WORDS)}-${String(index)}`;
}

function openingTag(random, tagName, index) {
  const attributes = [];
  const attributeCount = Math.floor(random() * 4);
  for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
    const attributeName = pick(random, ATTRIBUTES);
    const value = attributeValue(random, attributeName, index + attributeIndex);
    attributes.push(value.length === 0 ? attributeName : `${attributeName}="${value}"`);
  }
  return `<${tagName}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
}

function closingTag(random, tagName) {
  if (chance(random, 0.08)) {
    return `<${tagName}`;
  }
  if (chance(random, 0.08)) {
    return `</${tagName}`;
  }
  return `</${tagName}>`;
}

function generateNode(random, depth, maxDepth, index) {
  if (depth >= maxDepth || chance(random, 0.25)) {
    return chance(random, 0.15)
      ? `<!-- ${randomText(random, 2, 6)} -->`
      : randomText(random, 1, 8);
  }

  const tagName = pick(random, TAGS);
  const prefix = openingTag(random, tagName, index);
  if (tagName === "img" || tagName === "input") {
    return prefix;
  }
  if (tagName === "pre" || tagName === "code") {
    return `${prefix}${randomText(random, 2, 6)}\n  ${randomText(random, 2, 5)}\n\t${randomText(random, 1, 4)}${closingTag(random, tagName)}`;
  }

  const childCount = 1 + Math.floor(random() * 4);
  const children = Array.from(
    { length: childCount },
    (_, childIndex) =>
      generateNode(random, depth + 1, maxDepth, index + childIndex + 1)
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

function evaluate(html) {
  const document = parse(html, {
    captureSpans: false,
    trace: "none"
  });
  const rendered = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://fuzz.example/",
    finalUrl: "https://fuzz.example/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  return {
    parseErrorIds: document.tree.errors.map((error) => error.parseErrorId),
    rendered
  };
}

const profile = parseProfile(process.argv.slice(2));
const policy = PROFILES[profile];
const failures = [];

for (let index = 0; index < policy.caseCount; index += 1) {
  const seed = policy.firstSeed + index;
  const html = generateHtml(seed, policy);

  try {
    const first = evaluate(html);
    const second = evaluate(html);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      failures.push({
        seed,
        htmlSha256: sha256(html),
        reason: "non-deterministic parse or render output"
      });
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
    process.stderr.write(
      `fuzz failure: seed=${String(failure.seed)} sha256=${failure.htmlSha256} ${failure.reason}\n`
    );
  }
  throw new Error(`${String(failures.length)} deterministic fuzz case(s) failed`);
}

process.stdout.write(
  `fuzz ${profile} ok: ${String(policy.caseCount)} crash-free deterministic cases\n`
);
