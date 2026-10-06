import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

function fixture(html) {
  const document = parseWebDocument(html, { requestUrl: "https://canvas.test/", finalUrl: "https://canvas.test/" });
  const state = createDocumentState(document);
  const store = new RenderArtifactStore();
  store.attach({ documentId: "canvas", documentRevision: 1, stateRevision: 1,
    document, state, resources: embeddedStylesheetSources(document) });
  return { store, document, state };
}
function request(options = {}) {
  const columns = options.columns ?? 24, rows = options.rows ?? 8;
  const rect = cssRect(cssPx(0), cssPx(0), cssPx(columns * 8), cssPx(rows * 16));
  return { documentId: "canvas", documentRevision: 1, viewportRevision: options.revision ?? 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: rows * 16,
      mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: rect, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns, rows, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
      unicode: true, ambiguousWidth: 1, colorDepth: options.colorDepth ?? 24, cellMeasurer: terminalCellMeasurer(),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }) },
    window: { scrollRow: options.scrollRow ?? 0, scrollColumn: options.scrollColumn ?? 0,
      viewportRows: rows, overscanBefore: 1, overscanAfter: 1,
      ...(options.scrollOffsets === undefined ? {} : { scrollOffsets: options.scrollOffsets }) },
    searchQuery: options.searchQuery ?? null };
}
function render(fixture, options) { return fixture.store.renderViewport(request(options)); }
function artifacts(fixture, options) { return fixture.store.analyze(request(options)); }
function background(result, row, column) {
  return result.terminal.cellBuffer.rows.find((entry) => entry.row === row)?.cells
    .find((cell) => cell.column <= column && cell.column + cell.width > column)?.style.background ?? null;
}
const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };

// CSS Backgrounds 3 §2.11: canvas propagation is a paint boundary, not used geometry.
for (const [name, body] of [["empty", ""], ["short", "alpha"], ["floated children", '<div style="float:left">alpha</div>'], ["floated body", '<div>alpha</div>']]) {
  test(`canvas fills the retained window for ${name} without stretching the body`, () => {
    const value = fixture(`<style>body{margin:8px;background:red;${name === "floated body" ? "float:left" : ""}}</style>${body}`);
    try {
      const first = render(value);
      const before = artifacts(value);
      assert.equal(before.documentDisplayList.canvasBackground.source, value.document.body);
      assert.deepEqual(background(first, 7, 23), red);
      assert.equal([...first.displayList.commands].filter((command) => command.id === "terminal-paint:canvas").length, 1);
      assert.ok(!before.documentDisplayList.commands.some((command) => command.kind === "background" && command.documentNode === value.document.body));
      assert.ok(before.documentLayout.scrollExtent.height < cssPx(128));
      const later = render(value, { scrollRow: 20, columns: 40, revision: 2 });
      assert.deepEqual(background(later, 27, 39), red);
      assert.equal(later.terminal.hitTestIndex.regions.some((entry) => entry.command === "terminal-paint:canvas"), false);
    } finally { value.store.dispose(); }
  });
}

test("root canvas wins while the body retains its own ordinary background", () => {
  const value = fixture('<style>html{background:blue}body{background:red;margin:16px;width:32px;height:16px}</style>');
  try {
    const painted = render(value);
    assert.equal(artifacts(value).documentDisplayList.canvasBackground.source, value.document.documentElement);
    assert.deepEqual(background(painted, 7, 23), blue);
    const bodyPaint = [...artifacts(value).documentDisplayList.commands].find((command) => command.kind === "background" && command.documentNode === value.document.body);
    assert.ok(bodyPaint);
    assert.deepEqual(background(painted, Math.floor(bodyPaint.rect.y / cssPx(16)), Math.floor(bodyPaint.rect.x / cssPx(8))), red);
  } finally { value.store.dispose(); }
});

for (const css of ['html{display:none}', 'body{display:none}', 'html{contain:paint}', 'body{contain:paint}']) {
  test(`canvas body propagation is disabled by ${css}`, () => {
    const value = fixture(`<style>body{background:red;margin:16px;height:16px}${css}</style>alpha`);
    try { assert.equal(artifacts(value).documentDisplayList.canvasBackground, null); }
    finally { value.store.dispose(); }
  });
}

test("display contents body still supplies the canvas and translucent paint composites once", () => {
  for (const extra of ["", "display:contents", "transform:translate(40px,40px);overflow:hidden"]) {
    const value = fixture(`<style>body{margin:0;background:rgba(255,0,0,.5);${extra}}</style>alpha`);
    try {
      const painted = render(value);
      assert.deepEqual(background(painted, 0, 0), { ...red, a: 0.5 });
      assert.deepEqual(background(painted, 7, 23), { ...red, a: 0.5 });
    } finally { value.store.dispose(); }
  }
});

test("canvas is budgeted and monochrome keeps its ordinary typed outcomes", () => {
  const zero = fixture('<style>body{background:red}</style>alpha');
  try {
    const painted = render(zero, { budgets: { maxDisplayListCommands: 0 } });
    assert.equal(painted.displayList.outcome.status, "truncated");
    assert.equal(painted.displayList.commands.length, 0);
  } finally { zero.store.dispose(); }
  const monochrome = fixture('<style>body{background:red}</style>alpha');
  try { assert.equal(background(render(monochrome, { colorDepth: 0 }), 7, 23), null); }
  finally { monochrome.store.dispose(); }
});

for (const owner of ["html", "body"]) {
  test(`${owner} current canvas paint matches fresh rendering while retaining geometry and search`, () => {
    const html = `<style>body{margin:0}${owner}{background:red}${owner}:focus{background:blue}</style><p>alpha</p>`;
    const retained = fixture(html), fresh = fixture(html);
    try {
      render(retained, { searchQuery: "alpha" });
      const before = artifacts(retained);
      for (const value of [retained, fresh]) value.store.updateState({ documentId: "canvas", documentRevision: 1,
        stateRevision: 2, state: { ...value.state, focus: owner === "html" ? value.document.documentElement : value.document.body }, changed: new Set(["focus"]) });
      const changed = render(retained, { revision: 2, searchQuery: "alpha" });
      const expected = render(fresh, { revision: 2, searchQuery: "alpha" });
      const after = artifacts(retained);
      assert.equal(after.documentLayout, before.documentLayout);
      assert.equal(after.documentGeometry, before.documentGeometry);
      assert.equal(after.textSearchIndex, before.textSearchIndex);
      assert.deepEqual(changed.terminal.cellBuffer, expected.terminal.cellBuffer);
      assert.deepEqual(background(changed, 7, 23), blue);
    } finally { retained.store.dispose(); fresh.store.dispose(); }
  });
}

for (const origin of [0, 1, 4, 7, 8, 12]) {
  test(`native radio owns text-origin cells at fractional CSS origin ${origin}`, () => {
    const value = fixture(`<style>body{margin:0;margin-left:${origin}px;line-height:1.5}</style><input type=radio checked><label>Package names only</label>`);
    try {
      const painted = render(value);
      const control = painted.terminal.controls[0];
      const label = painted.terminal.cellBuffer.rows.flatMap((row) => row.cells).find((cell) => cell.text === "P");
      assert.ok(control && label);
      assert.equal(control.allocation.column + control.allocation.width, label.column);
      assert.equal(control.allocation.height, 1);
      const node = value.document.controls[0];
      const measured = terminalCssControlMeasurer().measure(node, value.document, value.state);
      assert.equal(control.content.width, measured.width);
    } finally { value.store.dispose(); }
  });
}

test("native allocation uses CSS content, preserving authored padding, border and dimensions", () => {
  const value = fixture('<style>body{margin:0}input{width:80px;height:48px;padding:8px;border:8px solid red;box-sizing:content-box}</style><input value=alpha>');
  try {
    const control = render(value).terminal.controls[0];
    assert.equal(control.outer.width, cssPx(112));
    assert.equal(control.content.width, cssPx(80));
    assert.equal(control.content.height, cssPx(48));
    assert.equal(control.allocation.column, 2);
    assert.equal(control.allocation.row, 2, "the native 16px line is centered within the 48px CSS content box");
    assert.equal(control.allocation.width, 10);
    assert.equal(control.allocation.height, 1);
  } finally { value.store.dispose(); }
});

test("native colors are paired with the same current background-only viewport", () => {
  const html = '<style>body{margin:0;background:white;color:#222}select:focus{background:#ffffcb}</style><select id=s><option>stable</option></select>';
  const retained = fixture(html), fresh = fixture(html);
  try {
    const initial = render(retained).terminal.controls[0];
    assert.deepEqual(initial.style.foreground, { r: 34, g: 34, b: 34, a: 1 });
    assert.equal(initial.style.background, null, "native paint inherits each underlying cell");
    assert.deepEqual(background(render(retained), initial.visible.row, initial.visible.column), { r: 255, g: 255, b: 255, a: 1 });
    for (const value of [retained, fresh]) value.store.updateState({ documentId: "canvas", documentRevision: 1, stateRevision: 2,
      state: { ...value.state, focus: value.document.elementById("s") }, changed: new Set(["focus"]) });
    const changed = render(retained, { revision: 2 }), expected = render(fresh, { revision: 2 });
    assert.deepEqual(changed.terminal.controls, expected.terminal.controls);
    assert.equal(changed.stateRevision, 2);
    assert.equal(changed.terminal.controls[0].style.background, null);
    const focused = changed.terminal.controls[0];
    assert.deepEqual(background(changed, focused.visible.row, focused.visible.column), { r: 255, g: 255, b: 203, a: 1 });
    assert.ok(changed.displayList.commands.some((command) => command.kind === "background"
      && command.layoutFragment === focused.layoutFragment && command.style.background?.b === 203));
  } finally { retained.store.dispose(); fresh.store.dispose(); }
});

test("transparent native control retains varying underlying cell backgrounds", () => {
  const value = fixture('<style>html,body{margin:0}.left,.right,input{position:absolute;top:0;height:16px}'
    + '.left{left:0;width:40px;background:red}.right{left:40px;width:40px;background:blue}'
    + 'input{left:0;width:80px;border:0;padding:0;background:transparent}</style>'
    + '<div class=left></div><div class=right></div><input value=alpha>');
  try {
    const painted = render(value), control = painted.terminal.controls[0];
    assert.equal(control.style.background, null);
    assert.deepEqual(background(painted, control.visible.row, 0), red);
    assert.deepEqual(background(painted, control.visible.row, 9), blue);
  } finally { value.store.dispose(); }
});

test("clipped native controls preserve allocation while writable cells remain viewport-bounded", () => {
  const value = fixture('<style>body{margin:0}.scroller{width:80px;height:32px;overflow:auto}input{width:8000000px;height:16px}</style><div class=scroller id=scroller><input value="界alpha"></div>');
  try {
    const initial = render(value).terminal.controls[0];
    assert.ok(initial.allocation.width > 100000);
    assert.ok(initial.visible.width <= 10);
    const scrolled = render(value, { revision: 2, scrollOffsets: [{ node: value.document.elementById("scroller"), inline: cssPx(32), block: cssPx(0) }] }).terminal.controls[0];
    assert.equal(scrolled.allocation.width, initial.allocation.width);
    assert.equal(scrolled.allocation.column, initial.allocation.column - 4);
    assert.equal(scrolled.visible.column, 0);
    assert.ok(scrolled.visible.width <= 10);
  } finally { value.store.dispose(); }
});

test("native auto select reserves its widest option including disabled captions without changing selected identity", () => {
  const value = fixture('<select><option selected>Short</option><option disabled>Longest unavailable caption</option><option>Last</option></select>');
  try {
    const result = render(value);
    const control = value.document.controls[0];
    assert.ok(result.terminal.controls[0].allocation.width >= "Longest unavailable caption".length + 2);
    assert.deepEqual(value.state.controls.get(control.node).selected, [control.options[0].node]);
  } finally { value.store.dispose(); }
});

test("RTL and wide neighboring text keep independent native ownership", () => {
  for (const direction of ["ltr", "rtl"]) {
    const value = fixture(`<style>body{margin:4px;direction:${direction}}</style><input type=radio checked><label>界 Alpha</label>`);
    try {
      const result = render(value);
      const control = result.terminal.controls[0];
      const wide = result.terminal.cellBuffer.rows.flatMap((row) => row.cells).find((cell) => cell.text === "界");
      assert.ok(control && wide);
      assert.ok(wide.column + wide.width <= control.visible.column || wide.column >= control.visible.column + control.visible.width);
    } finally { value.store.dispose(); }
  }
});

function descendantFragments(layout) {
  const result = [], pending = [layout.root];
  while (pending.length) { const fragment = layout.fragment(pending.pop()); result.push(fragment); pending.push(...fragment.children); }
  return result;
}

for (const tag of ['<input value="مرحبا 123">', '<select><option>مرحبا 123</option></select>', '<button>مرحبا 123</button>']) {
  for (const edges of ['margin:8px', 'margin:4px 8px 12px;padding:4px 8px;border:2px solid', 'margin:8px;vertical-align:middle']) {
    test(`atomic control baseline and line height include its CSS edges: ${tag.split('>')[0]}, ${edges}`, () => {
      const value = fixture(`<style>body{margin:8px}input,select,button{${edges}}</style><label>Query ${tag}</label><br><span>Next line</span>`);
      try {
        const result = render(value, { columns: 80, rows: 20 }), layout = artifacts(value, { columns: 80, rows: 20 }).documentLayout;
        const fragments = descendantFragments(layout);
        const label = fragments.find((fragment) => fragment.kind === 'text' && fragment.text === 'Query ');
        const next = fragments.find((fragment) => fragment.kind === 'text' && fragment.text === 'Next line');
        const control = fragments.find((fragment) => fragment.kind === 'control');
        const line = layout.lineBoxes.find((entry) => entry.fragments.includes(control.id));
        assert.ok(label && next && control && line);
        if (!edges.includes('middle')) {
          assert.equal(control.contentRect.y + cssPx(12), label.contentRect.y + label.baseline);
          assert.equal(control.borderRect.y + control.baseline, line.baseline);
        }
        assert.ok(line.rect.height >= control.marginRect.height);
        assert.ok(next.contentRect.y >= control.marginRect.y + control.marginRect.height);
        assert.equal(result.terminal.controls[0].allocation.row, Math.floor(control.contentRect.y / cssPx(16)));
      } finally { value.store.dispose(); }
    });
  }
}

test('scrolling multiline controls synthesize a margin-edge baseline without losing their full allocation', () => {
  const value = fixture('<style>body{margin:8px}textarea{margin:8px;width:240px;height:96px}</style><label>Editor <textarea>first\nsecond</textarea></label><br><span>After</span>');
  try {
    const result = render(value, { columns: 80, rows: 20 }), layout = artifacts(value, { columns: 80, rows: 20 }).documentLayout, fragments = descendantFragments(layout);
    const label = fragments.find((fragment) => fragment.kind === 'text' && fragment.text === 'Editor ');
    const control = fragments.find((fragment) => fragment.kind === 'control');
    assert.equal(control.marginRect.y + control.marginRect.height, label.contentRect.y + label.baseline);
    assert.equal(control.borderRect.y + control.baseline, label.contentRect.y + label.baseline);
    assert.equal(result.terminal.controls[0].allocation.height, 6);
  } finally { value.store.dispose(); }
});
