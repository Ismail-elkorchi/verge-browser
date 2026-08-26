import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bidiItemsFromText,
  resolveBidiParagraph,
  resolveBidiText
} from "../../dist/unicode/index.js";

const CHARACTER_FIXTURE = new globalThis.URL("../fixtures/unicode/17.0.0/BidiCharacterTest.txt", import.meta.url);
const TYPE_FIXTURE = new globalThis.URL("../fixtures/unicode/17.0.0/BidiTest.txt", import.meta.url);

function expectedLevels(value) {
  return value.trim().split(/\s+/u).filter(Boolean).map((level) => level === "x" ? null : Number.parseInt(level, 10));
}

function expectedOrder(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/u).map((index) => Number.parseInt(index, 10));
}

test("Unicode 17.0.0 BidiCharacterTest conformance through UAX #9 rule L2", async () => {
  const fixture = await readFile(CHARACTER_FIXTURE, "utf8");
  let cases = 0;
  for (const rawLine of fixture.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.length === 0) continue;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length !== 5) continue;
    const points = (fields[0] ?? "").split(/\s+/u).filter(Boolean).map((point) => Number.parseInt(point, 16));
    const value = String.fromCodePoint(...points);
    const requested = fields[1] === "0" ? "ltr" : fields[1] === "1" ? "rtl" : "auto";
    const paragraph = resolveBidiParagraph(bidiItemsFromText(value, () => null), requested);
    assert.equal(paragraph.baseLevel, Number.parseInt(fields[2] ?? "0", 10), rawLine);
    assert.deepEqual(paragraph.embeddingLevels, expectedLevels(fields[3] ?? ""), rawLine);
    assert.deepEqual(paragraph.visualOrder.itemIndices, expectedOrder(fields[4] ?? ""), rawLine);
    cases += 1;
  }
  assert.ok(cases > 90_000, `expected the complete BidiCharacterTest suite, received ${String(cases)} cases`);
});

test("Unicode 17.0.0 BidiTest property-sequence conformance", async () => {
  const fixture = await readFile(TYPE_FIXTURE, "utf8");
  let levels = [];
  let order = [];
  let cases = 0;
  for (const rawLine of fixture.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.startsWith("@Levels:")) {
      levels = expectedLevels(line.slice("@Levels:".length));
      continue;
    }
    if (line.startsWith("@Reorder:")) {
      order = expectedOrder(line.slice("@Reorder:".length));
      continue;
    }
    if (line.length === 0 || line.startsWith("@")) continue;
    const [classesText, bitsetText] = line.split(";").map((field) => field.trim());
    if (classesText === undefined || bitsetText === undefined) continue;
    const classes = classesText.split(/\s+/u);
    const items = classes.map((bidiClass, logicalIndex) => Object.freeze({
      logicalIndex,
      kind: "structural-control",
      text: "",
      codePoint: null,
      bidiClass,
      sourceStartCodeUnit: logicalIndex,
      sourceEndCodeUnit: logicalIndex,
      identity: null
    }));
    const bitset = Number.parseInt(bitsetText, 16);
    for (const [mask, requested] of [[1, "auto"], [2, "ltr"], [4, "rtl"]]) {
      if ((bitset & mask) === 0) continue;
      const paragraph = resolveBidiParagraph(items, requested);
      assert.deepEqual(paragraph.embeddingLevels, levels, `${rawLine}; direction=${requested}`);
      assert.deepEqual(paragraph.visualOrder.itemIndices, order, `${rawLine}; direction=${requested}`);
      cases += 1;
    }
  }
  assert.ok(cases > 750_000, `expected the complete BidiTest suite, received ${String(cases)} cases`);
});

test("bidi budgets and cancellation return deterministic complete-state prefixes", () => {
  const items = bidiItemsFromText("abc אבג", () => null);
  const full = resolveBidiParagraph(items, "auto");
  const prefix = resolveBidiParagraph(items, "auto", { maxBidiItems: 4 });
  assert.equal(full.outcome.status, "complete");
  assert.deepEqual(prefix.items, items.slice(0, 4));
  assert.equal(prefix.outcome.status, "truncated");
  assert.deepEqual(
    resolveBidiParagraph(
      bidiItemsFromText("\u202b\u202bA\u202c\u202c", () => null),
      "ltr",
      { maxEmbeddingDepth: 1 }
    ).outcome,
    {
      status: "truncated",
      items: 5,
      runs: 1,
      budget: "maxEmbeddingDepth",
      limit: 1
    }
  );
  assert.equal(resolveBidiParagraph(items, "auto", { maxEmbeddingDepth: 126 }).outcome.status, "rejected");
  assert.deepEqual(resolveBidiText("a".repeat(1_000_000), "ltr", {
    maxCodePointsPerParagraph: 3
  }).outcome, {
    status: "truncated",
    items: 3,
    runs: 1,
    budget: "maxCodePointsPerParagraph",
    limit: 3
  });
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.throws(() => resolveBidiParagraph(items, "auto", {}, controller.signal), { name: "AbortError" });
});
