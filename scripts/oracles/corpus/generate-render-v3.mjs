import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const WIDTHS = [60, 80, 100, 120];
const CASE_COUNT = 1200;
const OUTPUT_PATH = resolve("scripts/oracles/corpus/render-v3.json");
const TAGS = [
  "tokenizer/entities",
  "adoption-agency",
  "tables/foster-parenting",
  "foreign-content",
  "templates",
  "optional-tags",
  "comments/doctype",
  "scripting-flag"
];

const WORDS = [
  "atlas", "binary", "cache", "delta", "engine", "frame", "graph", "hash", "index", "jitter",
  "kernel", "latency", "matrix", "node", "offset", "parser", "queue", "render", "signal", "token",
  "update", "vector", "window", "xhtml", "yield", "zone", "anchor", "buffer", "cursor", "decode",
  "encode", "fixture", "gateway", "header", "inline", "join", "layout", "markup", "native", "outline",
  "packet", "query", "router", "stream", "trace", "upload", "verify", "worker", "xml", "zindex"
];

function hashSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pickWord(rng) {
  const index = Math.floor(rng() * WORDS.length);
  return WORDS[index] ?? WORDS[0];
}

function phrase(rng, count) {
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(pickWord(rng));
  }
  return parts.join(" ");
}

function createBodyByTag(tag, caseId, rng) {
  const heading = `<h2>${phrase(rng, 3)} ${caseId}</h2>`;
  const paragraph = `<p>${phrase(rng, 10)} <a href="https://example.test/${caseId}">${phrase(rng, 2)}</a></p>`;

  if (tag === "tokenizer/entities") {
    return [
      heading,
      `<p>Entities &amp; &lt; &gt; &quot; and &#169; ${phrase(rng, 4)}</p>`,
      paragraph
    ].join("\n");
  }

  if (tag === "adoption-agency") {
    return [
      heading,
      `<p><b><i>${phrase(rng, 4)}</b> ${phrase(rng, 4)}</i> ${phrase(rng, 3)}</p>`,
      paragraph
    ].join("\n");
  }

  if (tag === "tables/foster-parenting") {
    return [
      heading,
      `<table><tr><th>${pickWord(rng)}</th><th>${pickWord(rng)}</th></tr><tr><td>${phrase(rng, 2)}</td><td>${phrase(rng, 2)}</td></tr></table>`,
      `<p>${phrase(rng, 6)}</p>`,
      paragraph
    ].join("\n");
  }

  if (tag === "foreign-content") {
    return [
      heading,
      `<svg width="10" height="10"><title>${phrase(rng, 2)}</title><text x="1" y="8">${pickWord(rng)}</text></svg>`,
      `<math><mi>${pickWord(rng)}</mi><mo>+</mo><mi>${pickWord(rng)}</mi></math>`,
      paragraph
    ].join("\n");
  }

  if (tag === "templates") {
    return [
      heading,
      `<template><p>${phrase(rng, 5)}</p></template>`,
      `<p>${phrase(rng, 6)}</p>`,
      paragraph
    ].join("\n");
  }

  if (tag === "optional-tags") {
    return [
      heading,
      `<ul><li>${phrase(rng, 3)}<li>${phrase(rng, 3)}<li>${phrase(rng, 3)}</ul>`,
      `<p>${phrase(rng, 6)}</p>`,
      paragraph
    ].join("\n");
  }

  if (tag === "comments/doctype") {
    return [
      "<!-- deterministic-comment -->",
      heading,
      `<p>${phrase(rng, 7)}</p>`,
      paragraph
    ].join("\n");
  }

  return [
    heading,
    `<p>${phrase(rng, 6)} <script>document.write("skip")</script> ${phrase(rng, 4)}</p>`,
    `<noscript>${phrase(rng, 5)}</noscript>`,
    paragraph
  ].join("\n");
}

function createHtmlCase(caseIndex) {
  const caseId = `render-v3-${String(caseIndex + 1).padStart(4, "0")}`;
  const tag = TAGS[caseIndex % TAGS.length] ?? TAGS[0];
  const rng = createRng(caseIndex + 1);
  const title = `${tag} ${phrase(rng, 2)} ${caseId}`;
  const includePre = caseIndex % 3 === 0;
  const includeTable = caseIndex % 5 === 0;
  const includeNestedList = caseIndex % 7 === 0;

  const bodyParts = [createBodyByTag(tag, caseId, rng)];

  if (includePre) {
    const preText = `${phrase(rng, 4)}\n  ${phrase(rng, 4)}\n\t${pickWord(rng)} ${pickWord(rng)}`;
    bodyParts.push(`<pre>${preText}</pre>`);
  }

  if (includeTable) {
    bodyParts.push(
      `<table><tbody><tr><td>${pickWord(rng)}</td><td>${pickWord(rng)}</td></tr><tr><td>${pickWord(rng)}</td><td>${pickWord(rng)}</td></tr></tbody></table>`
    );
  }

  if (includeNestedList) {
    bodyParts.push(`<ol><li>${phrase(rng, 3)}<ul><li>${phrase(rng, 2)}</li><li>${phrase(rng, 2)}</li></ul></li></ol>`);
  }

  bodyParts.push(`<p id="${caseId}">${phrase(rng, 8)} <a href="/ref/${caseId}">${phrase(rng, 2)}</a></p>`);

  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    `<meta charset="utf-8">`,
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    ...bodyParts,
    "</body>",
    "</html>"
  ].join("\n");

  return {
    id: caseId,
    tags: [tag],
    widths: WIDTHS,
    html,
    sha256: hashSha256(html)
  };
}

async function main() {
  const cases = [];
  for (let index = 0; index < CASE_COUNT; index += 1) {
    cases.push(createHtmlCase(index));
  }

  const payload = {
    suite: "render-v3",
    version: 3,
    generatedAtIso: new Date().toISOString(),
    widths: WIDTHS,
    cases
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${OUTPUT_PATH} with ${String(cases.length)} cases\n`);
}

await main();
