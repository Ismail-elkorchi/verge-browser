import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { estimatedRetainedCost, RetainedCostAccounting } from "../../dist/memory/retained-cost.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";

const environment = Object.freeze({
  viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine",
});

function setup(html, options = {}) {
  const document = parseWebDocument(`<!doctype html>${html}`, {
    requestUrl: "https://diagnostics.test/", finalUrl: "https://diagnostics.test/",
  });
  const state = createDocumentState(document);
  const compile = () => compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document), ...options });
  const program = compile();
  const resolve = (nextState = state, budgets) => resolveStyles({ program, state: nextState, environment, budgets });
  const cold = (nextState, budgets) => resolveStyles({ program: compile(), state: nextState, environment, budgets });
  return { document, program, state, resolve, cold };
}

function assertDiagnostics(actual, expected) {
  assert.equal(actual.outcome.status, "complete");
  assert.deepEqual(actual.diagnostics, expected.diagnostics);
  assert.equal(actual.omittedDiagnosticCount, expected.omittedDiagnosticCount);
}

test("unrelated dynamic changes retain diagnostics with the reused computed style", () => {
  const result = setup(`<style>
    #bad{color:var(--missing);transform:rotate(45deg)}
    #hover:hover{color:red}
  </style><p id=bad>Bad</p><p id=hover>Hover</p>`);
  const bad = result.document.elementById("bad");
  const hover = result.document.elementById("hover");
  const initial = result.resolve();
  assert.deepEqual(initial.diagnostics.map(({ code, occurrences }) => ({ code, occurrences })), [
    { code: "property-invalid", occurrences: 1 }, { code: "value-unsupported", occurrences: 1 },
  ]);
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? hover : null };
    const next = result.resolve(state);
    assert.equal(next.style(bad), initial.style(bad));
    assertDiagnostics(next, initial);
  }
});

test("recomputed nodes replace shared diagnostic occurrences instead of accumulating them", () => {
  const result = setup(`<style>
    .bad{color:var(--missing);transform:rotate(45deg)}
    #hover:hover{color:red;transform:none}
  </style><p id=first class=bad>First</p><p id=hover class=bad>Hover</p><p class=bad>Last</p>`);
  const first = result.document.elementById("first");
  const hover = result.document.elementById("hover");
  const initial = result.resolve();
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? hover : null };
    const next = result.resolve(state);
    assert.equal(next.style(first), initial.style(first));
    assert.deepEqual(next.diagnostics.map((diagnostic) => diagnostic.occurrences), index % 2 === 0 ? [2, 2] : [3, 3]);
    assertDiagnostics(next, result.cold(state));
  }
  assert.deepEqual(initial.diagnostics.map((diagnostic) => diagnostic.occurrences), [3, 3]);
});

test("retained pseudo diagnostics survive while removed pseudos lose their contributions", () => {
  const result = setup(`<style>
    #bad::after{content:"after";color:var(--missing);transform:rotate(45deg)}
    #hover:hover::before{content:"before";color:var(--missing);transform:rotate(45deg)}
    #hover:hover::marker{color:var(--missing)}
  </style><p id=bad>Bad</p><p id=hover>Hover</p>`);
  const bad = result.document.elementById("bad");
  const hover = result.document.elementById("hover");
  const initial = result.resolve();
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? hover : null };
    const next = result.resolve(state);
    assert.equal(next.pseudo(bad, "after"), initial.pseudo(bad, "after"));
    assert.equal(next.pseudo(hover, "before") === null, index % 2 !== 0);
    assert.equal(next.pseudo(hover, "marker") === null, index % 2 !== 0);
    assertDiagnostics(next, result.cold(state));
  }
});

test("bounded replay counts repeated admitted identities after omitted node diagnostics", () => {
  const result = setup(`<style>
    .bad{transform:rotate(45deg)}
    #second{color:var(--missing)}
    #hover:hover{color:red}
  </style><p class=bad>First</p><p id=second class=bad>Second</p><p id=hover>Hover</p>`);
  const budgets = { maxDiagnostics: 1 };
  const initial = result.resolve(result.state, budgets);
  assert.equal(initial.diagnostics.length, 1);
  assert.equal(initial.diagnostics[0].code, "value-unsupported");
  assert.equal(initial.diagnostics[0].occurrences, 2);
  assert.equal(initial.omittedDiagnosticCount, 1);
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? result.document.elementById("hover") : null };
    assertDiagnostics(result.resolve(state, budgets), initial);
  }
});

test("bounded replay admits previously omitted diagnostics without reevaluating retained nodes", () => {
  const result = setup(`<style>
    #hover{color:var(--missing)}#hover:hover{color:red}
    #bad{transform:rotate(45deg);line-break:strict}
  </style><p id=hover>Hover</p><p id=bad>Bad</p>`);
  const budgets = { maxDiagnostics: 1 };
  const bad = result.document.elementById("bad");
  const initial = result.resolve(result.state, budgets);
  assert.equal(initial.diagnostics[0].code, "property-invalid");
  assert.equal(initial.omittedDiagnosticCount, 2);
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? result.document.elementById("hover") : null };
    const next = result.resolve(state, budgets);
    assert.equal(next.style(bad), initial.style(bad));
    assert.equal(next.diagnostics.length, 1);
    assert.equal(next.omittedDiagnosticCount, index % 2 === 0 ? 1 : 2);
    assertDiagnostics(next, result.cold(state, budgets));
  }
});

test("changing the diagnostic cap preserves retained style contributions", () => {
  const result = setup(`<style>
    #bad{color:var(--missing);transform:rotate(45deg);line-break:strict}
    #hover:hover{color:red}
  </style><p id=bad>Bad</p><p id=hover>Hover</p>`);
  const bad = result.document.elementById("bad");
  const initial = result.resolve(result.state, { maxDiagnostics: 1 });
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? result.document.elementById("hover") : null };
    const budgets = { maxDiagnostics: index % 3 + 1 };
    const next = result.resolve(state, budgets);
    assert.equal(next.style(bad), initial.style(bad));
    assert.equal(next.diagnostics.length, budgets.maxDiagnostics);
    assert.equal(next.omittedDiagnosticCount, 3 - budgets.maxDiagnostics);
    assertDiagnostics(next, result.cold(state, budgets));
  }
});

test("compile, candidate and computed omissions are counted once through repeated changes", () => {
  const result = setup(`<style>
    .bad{unknown-property:1;color:var(--missing);transform:rotate(45deg)}
    #hover:hover{color:red;transform:none}
  </style><p id=bad class=bad>Bad</p><p id=hover class=bad>Hover</p>`, {
    budgets: { maxDiagnostics: 1 },
    initialDiagnostics: [
      { code: "stylesheet-parse", sourceUrl: "first", detail: "first", occurrences: 3 },
      { code: "stylesheet-parse", sourceUrl: "omitted", detail: "omitted", occurrences: 5 },
    ],
    initialOmittedDiagnosticCount: 7,
  });
  const budgets = { maxDiagnostics: 1 };
  result.resolve(result.state, budgets);
  for (let index = 0; index < 12; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? result.document.elementById("hover") : null };
    const next = result.resolve(state, budgets);
    assert.equal(next.diagnostics.length, 1);
    assert.equal(next.diagnostics[0].occurrences, 3);
    assert.equal(next.omittedDiagnosticCount, index % 2 === 0 ? 15 : 17);
    assertDiagnostics(next, result.cold(state, budgets));
  }
});

test("many unique and repeated invalid values remain bounded and match fresh evaluation", () => {
  const rules = Array.from({ length: 160 }, (_, index) => `.bad${index}{transform:rotate(${index + 1}deg)}`).join("");
  const nodes = Array.from({ length: 320 }, (_, index) => `<p class=bad${index % 160}>Bad ${index}</p>`);
  const result = setup(`<style>${rules}#hover:hover>.bad0,#hover:hover>.bad1,#hover:hover>.bad2{transform:none}</style><div id=hover>${nodes.slice(0, 3).join("")}</div>${nodes.slice(3).join("")}`);
  const budgets = { maxDiagnostics: 3 };
  const initial = result.resolve(result.state, budgets);
  assert.deepEqual(initial.diagnostics.map((diagnostic) => diagnostic.occurrences), [2, 2, 2]);
  assert.equal(initial.omittedDiagnosticCount, 314);
  for (let index = 0; index < 6; index += 1) {
    const state = { ...result.state, hover: index % 2 === 0 ? result.document.elementById("hover") : null };
    const next = result.resolve(state, budgets);
    assert.equal(next.diagnostics.length, 3);
    assertDiagnostics(next, result.cold(state, budgets));
  }
});

test("retained ownership aggregates fixed-property contributions and shares descriptors", () => {
  const declarations = "margin:var(--missing);".repeat(2000);
  const result = setup(`<style>.bad{${declarations}color:var(--missing);transform:rotate(45deg)}</style>${'<p class=bad>Bad</p>'.repeat(200)}`);
  const styles = result.resolve(result.state, { maxDiagnostics: 1 });
  const contributions = styles.retainedComputedDiagnostics();
  assert.equal(contributions.size, 200);
  const descriptors = new Set();
  for (const values of contributions.values()) {
    assert.equal(Object.isFrozen(values), true);
    assert.equal(values.length, 3, "only winning property evaluations contribute, regardless of declaration count");
    for (const contribution of values) {
      assert.equal(Object.isFrozen(contribution), true);
      assert.equal(Object.isFrozen(contribution.descriptor), true);
      descriptors.add(contribution.descriptor);
    }
    assert.equal(values.find(({ descriptor }) => descriptor.detail.endsWith("in margin.")).occurrences, 4);
  }
  assert.equal(descriptors.size, 3, "all nodes share the same immutable diagnostic descriptors");
  assert.equal(styles.diagnostics.length, 1);
  assert.equal(styles.diagnostics[0].occurrences, 200);
  assert.equal(styles.omittedDiagnosticCount, 1000);
  assert.equal(estimatedRetainedCost([styles, contributions]), estimatedRetainedCost([styles]),
    "the style owner accounts for every retained contribution, including omitted diagnostics");
});

test("repeated replacement and removal retain only current diagnostic ownership", () => {
  const result = setup(`<style>
    #hover{--angle:45deg}#hover:hover{--angle:90deg}#hover:focus{--angle:0deg}
    .bad{transform:rotate(var(--angle))}#hover:focus .bad{transform:none}
  </style><div id=hover>${'<p class=bad>Bad</p>'.repeat(80)}</div>`);
  const hover = result.document.elementById("hover");
  const accounting = new RetainedCostAccounting();
  const costs = new Map();
  result.resolve(result.state, { maxDiagnostics: 1 });
  for (let index = 0; index < 24; index += 1) {
    const phase = index % 3;
    const state = { ...result.state, hover: phase === 0 ? hover : null, focus: phase === 2 ? hover : null };
    const next = result.resolve(state, { maxDiagnostics: 1 });
    const contributions = next.retainedComputedDiagnostics();
    const descriptors = new Set([...contributions.values()].flat().map(({ descriptor }) => descriptor));
    assert.equal(contributions.size, phase === 2 ? 0 : 80);
    assert.equal(descriptors.size, phase === 2 ? 0 : 1);
    if (phase !== 2) assert.match([...descriptors][0].detail, phase === 0 ? /90deg/u : /45deg/u);
    const recounted = estimatedRetainedCost([next]);
    assert.equal(estimatedRetainedCost([next, contributions]), recounted);
    assert.ok(accounting.total([accounting.immutable(next)]) >= recounted);
    accounting.endBatch();
    if (costs.has(phase)) assert.equal(recounted, costs.get(phase), "retired states cannot grow current ownership");
    else costs.set(phase, recounted);
  }
});

test("cancellation during retained diagnostic replay does not publish a partial snapshot", () => {
  const result = setup('<style>#bad{color:var(--missing);transform:rotate(45deg)}</style><p id=bad>Bad</p>');
  result.resolve();
  let checkpoints = 0;
  const initial = resolveStyles({
    program: result.program, state: { ...result.state, hover: result.document.elementById("bad") }, environment,
    signal: { throwIfAborted() { checkpoints += 1; } },
  });
  assert.ok(checkpoints > result.program.elementNodes.length);
  const abort = new Error("cancelled retained diagnostic replay");
  let checks = 0;
  assert.throws(() => resolveStyles({
    program: result.program, state: result.state, environment,
    signal: { throwIfAborted() {
      if (++checks === checkpoints) throw abort;
    } },
  }), abort);
  assert.equal(result.program.selectorRuntime.computedSnapshot, initial);
  assertDiagnostics(result.resolve(result.state), initial);
});

for (const budget of ["maxSelectorQueries", "maxSelectorSteps"]) {
  test(`typed ${budget} fallback survives diagnostic truncation and later recovery`, () => {
    const result = setup('<style>#t{color:red}.other{color:blue}</style><p id=t style="background:green">Target</p>', {
      budgets: { maxDiagnostics: 1 },
      initialDiagnostics: [{ code: "stylesheet-parse", sourceUrl: "earlier", detail: "Already reported", occurrences: 1 }],
    });
    const target = result.document.elementById("t");
    const failed = result.resolve(result.state, { maxDiagnostics: 1, [budget]: 1 });
    assert.equal(failed.outcome.status, "truncated");
    assert.equal(failed.outcome.budget, budget);
    assert.equal(failed.outcome.fallback, "user-agent-only");
    assert.equal(failed.diagnostics.length, 1);
    assert.equal(failed.diagnostics[0].detail, "Already reported");
    assert.equal(failed.omittedDiagnosticCount, 1);
    assert.equal(failed.style(target).text.color, null);
    assert.equal(failed.style(target).text.background, null);
    const recovered = result.resolve();
    assert.equal(recovered.outcome.status, "complete");
    assert.deepEqual(recovered.style(target).text.color, { r: 255, g: 0, b: 0, a: 1 });
    assert.deepEqual(recovered.style(target).text.background, { r: 0, g: 128, b: 0, a: 1 });
    assert.equal(failed.outcome.fallback, "user-agent-only", "a later evaluation cannot change the earlier outcome");
  });
}

test("source truncation retains admitted author rules without claiming a user-agent-only fallback", () => {
  const budgets = { maxDiagnostics: 1, maxStylesheetSources: 1 };
  const result = setup('<style>#t{color:red}</style><style>#t{color:blue}</style><p id=t>Target</p>', {
    budgets,
    initialDiagnostics: [{
      code: "stylesheet-limit", sourceUrl: "earlier-resource", detail: "Earlier resource fallback=user-agent-only.", occurrences: 1,
    }],
  });
  const styles = result.resolve(result.state, budgets);
  assert.equal(styles.outcome.status, "truncated");
  assert.equal(styles.outcome.budget, "maxStylesheetSources");
  assert.equal(styles.outcome.fallback, null);
  assert.deepEqual(styles.style(result.document.elementById("t")).text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(styles.diagnostics.length, 1);
  assert.equal(styles.omittedDiagnosticCount, 1);
});

test("selector fallback is explicit even when an earlier source budget owns the truncation label", () => {
  const budgets = { maxDiagnostics: 1, maxStylesheetSources: 1, maxSelectorQueries: 1 };
  const result = setup('<style>#t{color:red}.other{color:blue}</style><style>p{color:green}</style><p id=t>Target</p>', {
    budgets,
    initialDiagnostics: [{ code: "stylesheet-parse", sourceUrl: "earlier", detail: "Already reported", occurrences: 1 }],
  });
  const failed = result.resolve(result.state, budgets);
  assert.equal(failed.outcome.status, "truncated");
  assert.equal(failed.outcome.budget, "maxStylesheetSources");
  assert.equal(failed.outcome.fallback, "user-agent-only");
  assert.equal(failed.style(result.document.elementById("t")).text.color, null);
  assert.equal(failed.diagnostics.length, 1);
  assert.equal(failed.omittedDiagnosticCount, 2);
  const recovered = result.resolve(result.state, { maxDiagnostics: 1, maxStylesheetSources: 1 });
  assert.equal(recovered.outcome.status, "truncated");
  assert.equal(recovered.outcome.fallback, null);
  assert.deepEqual(recovered.style(result.document.elementById("t")).text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(failed.outcome.fallback, "user-agent-only");
});
