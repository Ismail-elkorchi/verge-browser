import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { SelectorResultCache } from "../../dist/presentation/style/selector-cache.js";
import { estimatedRetainedCost } from "../../dist/memory/retained-cost.js";

const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" };
function fixture(css, content = '<p id="t">Target</p>') {
  const document = parseWebDocument(`<!doctype html><style>${css}</style>${content}`, {
    requestUrl: "https://selectors.test/", finalUrl: "https://selectors.test/",
  });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  return { program, document, state, resolve: (budgets, extra = {}) => resolveStyles({ program, state, environment, budgets, ...extra }) };
}
const retained = (count = 0, unknown = 0) => ({ dependencies: new Set(["document-structural"]), result: {
  matches: Array.from({ length: count }, () => ({})), unknown: Array.from({ length: unknown }, () => ({ node: {}, reasons: [{
    code: "pseudo-class", name: "unsupported", span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } },
  }] })), usage: { inputBytes: 0, maxBufferedBytes: 0, tokens: 0, nodes: 0, maxDepth: 0, steps: 1 },
} });

test("selector cache bounds empty, result-heavy and unknown entries without walking referenced nodes", () => {
  const cache = new SelectorResultCache(4096);
  const entry = retained();
  cache.set("one", entry);
  const bytes = cache.bytes;
  assert.ok(bytes >= estimatedRetainedCost([cache]) - 512);
  for (let i = 0; i < 100; i++) cache.set(`empty-${i}`, entry);
  assert.ok(cache.bytes <= 4096);
  assert.equal(cache.get("one"), undefined);
  cache.set("too-large", retained(1000));
  assert.equal(cache.get("too-large"), undefined);
  const node = {};
  Object.defineProperty(node, "mustNotRead", { enumerable: true, get() { throw Error("DOM walk"); } });
  cache.set("reference", { ...entry, result: { ...entry.result, matches: [node] } });
  assert.equal(cache.get("reference").result.matches[0], node);
  cache.resize(1);
  assert.equal(cache.size, 0);
  cache.resize(100_000);
  cache.set("unknown", retained(0, 20));
  assert.ok(cache.bytes >= estimatedRetainedCost([cache]) - 512 - 20 * 64);
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test("many cheap indexed selectors pass actual work admission and reuse completed results", () => {
  const f = fixture(Array.from({ length: 6000 }, (_, i) => `.missing-${i}{color:red}`).join("") + "#t{color:blue}");
  const cold = f.resolve();
  assert.equal(cold.outcome.status, "complete");
  assert.ok(f.program.selectorRuntime.matches.size > 6000);
  const warm = f.resolve({ maxSelectorSteps: 1 });
  assert.equal(warm.outcome.status, "complete");
  assert.deepEqual(warm.style(f.document.elementById("t")), cold.style(f.document.elementById("t")));
  assert.equal(f.program.selectorRuntime.session.usage().steps, 0);
});

test("failed cold rounds discard author prefixes; successful cache history can reduce real work", () => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => `.missing-${i}{color:red}`).join("") + "#t{color:blue}");
  let previous;
  for (let i = 0; i < 3; i++) {
    const failed = f.resolve({ maxSelectorSteps: 100 });
    assert.equal(failed.outcome.fallback, "user-agent-only");
    const keys = [...f.program.selectorRuntime.matches].map(([key]) => key);
    if (previous) assert.deepEqual(keys, previous);
    previous = keys;
    assert.equal(failed.style(f.document.elementById("t")).text.color, null);
  }
  assert.equal(f.resolve().outcome.status, "complete");
  assert.equal(f.resolve({ maxSelectorSteps: 1 }).outcome.status, "complete");
});

test("construction and matching work have independent typed admission", () => {
  const f = fixture("#t{color:red}");
  assert.throws(() => f.resolve({ maxSelectorConstructionSteps: 1 }), {
    name: "StyleSelectorConstructionError", budget: "maxSelectorConstructionSteps", limit: 1,
  });
  assert.equal(f.program.selectorRuntime.session, null);
  assert.equal(f.resolve().outcome.status, "complete");
});

test("cancellation after successful author queries rolls back newly staged results", () => {
  const f = fixture("#t{color:red}.absent{color:blue}");
  // Warm only the UA; the failed author round cannot retain its partial results.
  f.resolve({ maxSelectorSteps: 1 });
  const before = [...f.program.selectorRuntime.matches];
  const controller = new globalThis.AbortController();
  assert.throws(() => f.resolve(undefined, { signal: controller.signal, instrumentation: {
    record(stage) { if (stage === "selector-matching") controller.abort(); },
  } }), { name: "AbortError" });
  assert.deepEqual([...f.program.selectorRuntime.matches], before);
  assert.equal(f.resolve().outcome.status, "complete");
});

test("tiny result cache causes recomputation under the same actual work bound", () => {
  const f = fixture("#t{color:red}");
  assert.equal(f.resolve({ maxSelectorCacheBytes: 1 }).outcome.status, "complete");
  assert.equal(f.program.selectorRuntime.matches.size, 0);
  const failed = f.resolve({ maxSelectorCacheBytes: 1, maxSelectorSteps: 1 });
  assert.equal(failed.outcome.fallback, "user-agent-only");
});

test("late cancellation during value computation cannot commit a successful selector prefix", () => {
  const f = fixture("#t{--tone:red;color:var(--tone)}");
  f.resolve({ maxSelectorSteps: 1 });
  const before = [...f.program.selectorRuntime.matches];
  const controller = new globalThis.AbortController();
  assert.throws(() => f.resolve(undefined, { signal: controller.signal, instrumentation: {
    record(stage) { if (stage === "custom-property-substitution") controller.abort(); },
  } }), { name: "AbortError" });
  assert.deepEqual([...f.program.selectorRuntime.matches], before);
  assert.equal(f.resolve().outcome.status, "complete");
});

test("failed media activation preserves previously committed valid selector results", () => {
  const f = fixture("#t{color:red}@media(width > 900px){.missing{color:blue}#t:hover{color:green}}");
  const cold = f.resolve();
  const before = [...f.program.selectorRuntime.matches];
  const failed = f.resolve({ maxSelectorSteps: 1 }, { environment: { ...environment, viewportWidthCssPx: 1000 } });
  assert.equal(failed.outcome.fallback, "user-agent-only");
  assert.deepEqual([...f.program.selectorRuntime.matches], before);
  assert.deepEqual(cold.style(f.document.elementById("t")).text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(f.resolve({ maxSelectorSteps: 1 }).outcome.status, "complete");
});


test("aborted dynamic evaluation cannot reuse a snapshot from a different completed state", () => {
  const f = fixture("p:focus{color:red}p:hover{background:blue}", "<p id=a>A</p><p id=b>B</p>");
  const a = f.document.elementById("a");
  const b = f.document.elementById("b");
  const initial = f.resolve(undefined, { state: { ...f.state, focus: a } });
  const next = { ...f.state, focus: b };
  const controller = new globalThis.AbortController();
  assert.throws(() => f.resolve(undefined, { state: next, signal: controller.signal, instrumentation: {
    record(stage) { if (stage === "selector-matching") controller.abort(); },
  } }), { name: "AbortError" });
  assert.equal(f.program.selectorRuntime.computedSnapshot, null);
  const state = { ...next, hover: b };
  const recovered = f.resolve(undefined, { state });
  f.program.selectorRuntime.clear();
  const cold = f.resolve(undefined, { state });
  assert.deepEqual(recovered.style(a), cold.style(a));
  assert.deepEqual(recovered.style(b), cold.style(b));
  assert.deepEqual(initial.style(a).text.color, { r: 255, g: 0, b: 0, a: 1 });
});
