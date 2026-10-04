import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { HttpFields } from "@ismail-elkorchi/http-client";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { layoutElement, renderElementFrame, renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";

import { fetchPage, fetchPageStream, fetchStylesheet } from "../../dist/app/fetch-page.js";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { documentContentBounds } from "../../dist/ui/document-layout.js";
import { prepareBrowserTui, renderBrowserOnce } from "../../dist/ui/run.js";
import { browserView } from "../../dist/ui/view.js";

const url = "https://example.test/boundaries";
const html = '<!doctype html><title>Boundary page</title><p><a href="/target">Target</a></p>';
const terminalSize = { columns: 80, rows: 20 };
function response(requestUrl, payload = { html }) {
  return {
    requestUrl, finalUrl: requestUrl, status: 200, statusText: "OK",
    contentType: "text/html", responseFields: new HttpFields(),
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    networkOutcome: { kind: "ok", finalUrl: requestUrl, status: 200, statusText: "OK", detailCode: "HTTP_200", detailMessage: "200 OK" },
    ...payload,
  };
}
function key(name, modifiers = {}) {
  return { kind: "key", key: name, sequence: "", eventType: "press", location: "standard",
    modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers } };
}
async function input(runtime, event) {
  await runtime.handleInput(event);
  await runtime.flushInput();
}
async function text(runtime, value) {
  await input(runtime, { kind: "text", text: value, paste: false });
}
async function waitUntil(runtime, predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(runtime.diagnostics())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "verge-navigation-boundaries-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const options = {
    store,
    services: {
      async writeTextFile() {}, async downloadFile() { throw new Error("Unexpected download"); },
      async openExternal() {}, async openPath() {}, async close() {},
      ...overrides.services,
    },
    createAcquisition: () => new PageAcquisition({
      loader: async (target) => response(target, { html: overrides.html ?? html }),
      stylesheetLoader: async () => { throw new Error("Unexpected stylesheet"); },
      defaultParseMode: "text",
    }),
  };
  const prepared = await prepareBrowserTui(url, options);
  const runtime = createTuiRuntime({ app: prepared.app, host: createMemoryTerminalHost({ terminalSize: overrides.terminalSize ?? terminalSize }) });
  await runtime.start();
  await waitUntil(runtime, () => ["ready", "failed"].includes(runtime.state().documents[0]?.rendering?.status));
  assert.equal(runtime.state().documents[0]?.rendering?.status, "ready", runtime.state().documents[0]?.rendering?.error ?? "Initial viewport did not render");
  return { runtime, prepared, options, async close() {
    await runtime.dispose(); await prepared.controller.close(); await rm(directory, { recursive: true, force: true });
  } };
}

function findLayout(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findLayout(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Inject terminal-space regions at the view boundary to isolate UI clipping from CSS layout.
// The runtime still routes real mouse events through the composed browser interaction tree.
test("document focus and mouse regions use the exact visible intersection on every edge", async () => {
  const f = await fixture({ html: html + "<p>Scroll extent</p>".repeat(25) });
  let routed;
  try {
    const initialTarget = f.runtime.state().documents[0].rendering.viewport.focusTargets[0];
    const initialHit = f.runtime.state().documents[0].rendering.viewport.hitRegions[0];
    assert.ok(initialTarget && initialHit);
    for (const scrollRow of [0, 5]) {
      if (scrollRow > 0) {
        await f.runtime.dispatch({ kind: "scrollTo", row: scrollRow });
        await waitUntil(f.runtime, () => {
          const rendering = f.runtime.state().documents[0].rendering;
          return rendering.status === "ready" && rendering.viewport.cellBuffer.windowStartRow + rendering.viewport.cellBuffer.overscanBefore === scrollRow;
        });
      }
      const original = f.runtime.state();
      const document = original.documents[0];
      const viewport = document.rendering.viewport;
      const target = initialTarget;
      const hit = initialHit;
      const tree = layoutElement(browserView(original, { terminalSize }), terminalSize);
      const allocation = findLayout(tree, `browser-${document.id}`);
      assert.ok(allocation);
      const content = documentContentBounds(allocation.bounds);
      const visible = allocation.viewport;
      const top = Math.max(0, visible.row - content.row);
      const bottom = Math.min(content.height, visible.row + visible.height - content.row);
      const right = Math.min(content.width, visible.column + visible.width - content.column);
      const cases = [
        { name: "left", rect: { row: top + 1, column: -3, width: 5, height: 1 }, expected: { row: content.row + top + 1, column: content.column, width: 2, height: 1 } },
        { name: "right", rect: { row: top + 2, column: right - 2, width: 5, height: 1 }, expected: { row: content.row + top + 2, column: content.column + right - 2, width: 2, height: 1 } },
        { name: "top", rect: { row: top - 2, column: 3, width: 2, height: 3 }, expected: { row: content.row + top, column: content.column + 3, width: 2, height: 1 } },
        { name: "bottom", rect: { row: bottom - 1, column: 3, width: 2, height: 3 }, expected: { row: content.row + bottom - 1, column: content.column + 3, width: 2, height: 1 } },
        { name: "off-left", rect: { row: top + 1, column: -4, width: 4, height: 1 }, expected: null },
        { name: "off-right", rect: { row: top + 1, column: right, width: 5, height: 1 }, expected: null },
        { name: "off-top", rect: { row: top - 2, column: 3, width: 2, height: 2 }, expected: null },
        { name: "off-bottom", rect: { row: bottom, column: 3, width: 2, height: 1 }, expected: null },
        { name: "zero-width", rect: { row: top + 1, column: 3, width: 0, height: 1 }, expected: null },
        { name: "zero-height", rect: { row: top + 1, column: 3, width: 2, height: 0 }, expected: null },
      ];
      for (const entry of cases) {
        const state = { ...original, documents: [{ ...document, rendering: { ...document.rendering,
          viewport: { ...viewport, focusTargets: [{ ...target, rects: [entry.rect] }], hitRegions: [{ ...hit, rect: entry.rect }] } } }] };
        const element = browserView(state, { terminalSize });
        const projected = findLayout(layoutElement(element, terminalSize), `browser-${document.id}`);
        const focus = projected.focusTargets.find((region) => region.id === `link:${target.node}`);
        const frame = renderElementFrame(element, terminalSize);
        const hits = (frame.hitTargets ?? []).filter((region) => region.id.includes("activate:link:"));
        assert.equal(focus !== undefined, entry.expected !== null, `${entry.name}: focus visibility`);
        assert.equal(hits.length, entry.expected === null ? 0 : 1, `${entry.name}: hit visibility`);
        if (entry.expected === null) continue;
        assert.deepEqual(focus.bounds, entry.expected, `${entry.name}: focus bounds`);
        assert.deepEqual(hits[0].bounds, entry.expected, `${entry.name}: mouse bounds`);
        const messages = [];
        routed = createTuiRuntime({
          app: defineTui({ id: `boundary-${entry.name}`, init: () => ({ state }), update: (current, message) => { messages.push(message); return { state: current }; }, view: (current, context) => browserView(current, context) }),
          host: createMemoryTerminalHost({ terminalSize }),
        });
        await routed.start();
        const mouse = { kind: "mouse", sequence: "", encoding: "sgr", button: "left", rawCode: 0,
          row: entry.expected.row, column: entry.expected.column, modifiers: { shift: false, alt: false, ctrl: false } };
        await input(routed, { ...mouse, action: "press" });
        await input(routed, { ...mouse, action: "release" });
        assert.ok(messages.some((message) => message.kind === "activateActionAt" && message.actionId === `link:${target.node}`), `${entry.name}: mouse activates clipped link`);
        await routed.dispose(); routed = undefined;
      }
    }
  } finally { await routed?.dispose(); await f.close(); }
});

test("palette filters typed commands before Enter and preserves command arguments", async () => {
  const writes = [];
  const f = await fixture({ services: { async writeTextFile(path, value) { writes.push({ path, value }); } } });
  try {
    for (const query of ["reader", "READ", "read"]) {
      await f.runtime.dispatch({ kind: "openActionPalette" });
      await text(f.runtime, query);
      await input(f.runtime, key("enter"));
      assert.equal(f.runtime.state().overlay?.detailKind, "reader");
      await f.runtime.dispatch({ kind: "dismiss" });
    }
    await f.runtime.dispatch({ kind: "openActionPalette" });
    await text(f.runtime, "save text ./custom-output.txt");
    await input(f.runtime, key("enter"));
    await waitUntil(f.runtime, () => writes.length === 1);
    assert.equal(writes[0].path, "./custom-output.txt");
    assert.match(writes[0].value, /Target/u);
  } finally { await f.close(); }
});

test("palette arrow selection executes the selected filtered command", async () => {
  const writes = [];
  const f = await fixture({ services: { async writeTextFile(path, value) { writes.push({ path, value }); } } });
  try {
    await f.runtime.dispatch({ kind: "openActionPalette" });
    await text(f.runtime, "SAVE");
    assert.equal(f.runtime.state().overlay.state.suggestionView.totalCount, 2);
    await input(f.runtime, key("arrowDown"));
    assert.equal(f.runtime.state().overlay.state.editor.activeId, "save text ./page.txt");
    await input(f.runtime, key("arrowUp"));
    assert.equal(f.runtime.state().overlay.state.editor.activeId, "save page ./page.html");
    await input(f.runtime, key("arrowDown"));
    await input(f.runtime, key("enter"));
    await waitUntil(f.runtime, () => writes.length > 0);
    assert.deepEqual(writes.map((entry) => entry.path), ["./page.txt"]);
    assert.match(writes[0].value, /Target/u);
    assert.doesNotMatch(writes[0].value, /<!doctype/u);
  } finally { await f.close(); }
});

test("palette no-match Enter keeps the query and cannot execute a stale suggestion", async () => {
  const writes = [];
  const f = await fixture({ services: { async writeTextFile(path) { writes.push(path); } } });
  try {
    await f.runtime.dispatch({ kind: "openActionPalette" });
    await text(f.runtime, "save unsupported ./never.txt");
    assert.equal(f.runtime.state().overlay.state.suggestionView.totalCount, 0);
    await input(f.runtime, key("arrowDown"));
    await input(f.runtime, key("enter"));
    assert.equal(f.runtime.state().overlay.kind, "actionPalette");
    assert.equal(f.runtime.state().overlay.state.editor.input.text, "save unsupported ./never.txt");
    assert.ok(f.runtime.state().overlay.validation);
    assert.deepEqual(writes, []);
    assert.equal(f.runtime.state().documents[0].snapshot.finalUrl, url);
  } finally { await f.close(); }
});

test("palette Escape dismisses suggestions without reopening them", async () => {
  const f = await fixture();
  try {
    await f.runtime.dispatch({ kind: "openActionPalette" });
    await text(f.runtime, "read");
    await input(f.runtime, key("escape"));
    assert.equal(f.runtime.state().overlay?.state?.editor.open ?? false, false);
  } finally { await f.close(); }
});

test("decoded custom HTML loaders ignore conflicting transport and meta encoding labels", async () => {
  const decoded = '<!doctype html><meta charset="windows-1252"><title>€ café 😀</title>';
  const session = new BrowserSession({ defaultParseMode: "text", loader: async (target) => response(target, {
    html: decoded, contentType: "text/html; charset=windows-1252", transportEncodingLabel: "windows-1252",
  }) });
  try {
    const snapshot = await session.open(url);
    assert.equal(snapshot.document.title, "€ café 😀");
    assert.equal(snapshot.document.sourceText, decoded);
    assert.equal(snapshot.document.sourceMetadata.inputKind, "text");
  } finally { await session.close(); }
});

test("local raw HTML and CSS preserve exact bytes while injected text readers use UTF-8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verge-local-boundary-"));
  const path = join(directory, "encoded.html");
  const bytes = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), Buffer.from([0x80, 0xe9]), Buffer.from("</title>")]);
  await writeFile(path, bytes);
  const localUrl = pathToFileURL(path).href;
  try {
    const page = await fetchPage(localUrl, 15_000, { maxContentBytes: bytes.byteLength });
    const stream = await fetchPageStream(localUrl, 15_000, { maxContentBytes: bytes.byteLength });
    const sheet = await fetchStylesheet(localUrl, 15_000, { maxContentBytes: bytes.byteLength });
    assert.deepEqual(Buffer.from(page.bytes), bytes);
    assert.deepEqual(Buffer.from(await new globalThis.Response(stream.stream).arrayBuffer()), bytes);
    assert.deepEqual(Buffer.from(sheet.bytes), bytes);
    assert.equal(page.transportEncodingLabel, undefined);
    assert.equal(stream.transportEncodingLabel, undefined);
    assert.equal(sheet.transportEncodingLabel, undefined);
    const decoded = '<meta charset="windows-1252"><title>€ café 😀</title>';
    const reader = async (filePath) => { assert.equal(filePath, path); return decoded; };
    const session = new BrowserSession({ localFileReader: reader });
    try {
      for (const mode of ["text", "stream"]) {
        const snapshot = await session.openWithRequest(localUrl, {}, mode);
        assert.equal(snapshot.document.title, "€ café 😀");
        assert.equal(snapshot.document.sourceText, decoded);
      }
    } finally { await session.close(); }
    const textSheet = await fetchStylesheet(localUrl, 15_000, {}, {}, reader);
    assert.deepEqual(Buffer.from(textSheet.bytes), Buffer.from(decoded));
    assert.equal(textSheet.transportEncodingLabel, "utf-8");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed byte input has identical decoding and parse diagnostics in buffered and stream modes", async () => {
  const bytes = new Uint8Array([...Buffer.from('<!doctype html><meta charset="utf-8"><title>'), 0xc3, 0x28, ...Buffer.from('</title><p>one\0two</p><table>foster')]);
  const session = new BrowserSession({
    loader: async (target) => response(target, { bytes }),
    streamLoader: async (target) => response(target, { stream: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }) }),
  });
  try {
    const buffered = await session.openWithRequest(url, {}, "text");
    const streamed = await session.openWithRequest(url, {}, "stream");
    assert.equal(buffered.document.title, "�(");
    assert.equal(buffered.document.sourceText, streamed.document.sourceText);
    assert.deepEqual(buffered.document.diagnostics, streamed.document.diagnostics);
    assert.deepEqual(buffered.diagnostics.triageIds, streamed.diagnostics.triageIds);
    assert.ok(buffered.diagnostics.parseErrorCount > 0);
  } finally { await session.close(); }
});

test("aborting after a buffered custom loader resolves preserves the original page", async () => {
  let pendingResolve;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const session = new BrowserSession({ defaultParseMode: "text", loader: async (target) => {
    if (target === url) return response(target);
    startedResolve();
    return new Promise((resolve) => { pendingResolve = resolve; });
  } });
  try {
    const original = await session.open(url);
    const abort = new globalThis.AbortController();
    const reason = new Error("Stop buffered boundary parse");
    const pending = session.openWithRequest(`${url}/aborted`, { signal: abort.signal }, "text");
    await started;
    abort.abort(reason);
    pendingResolve(response(`${url}/aborted`, { bytes: Buffer.from("<title>Wrong committed page</title>") }));
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(session.current, original);
  } finally { await session.close(); }
});

test("one-shot rendering rejects a style-budget incomplete document", async () => {
  const rules = "span:nth-child(odd of :not(.absent)){color:red}";
  const f = await fixture({ html: `<!doctype html><title>Incomplete</title><style>${rules}</style><p>Visible</p>${"<span>item</span>".repeat(2000)}` });
  try {
    assert.match(renderFramePlain(f.runtime.frame()), /rendering incomplete/u);
    await f.runtime.dispatch({ kind: "openDetail", detail: "diagnostics" });
    assert.ok(f.runtime.state().overlay.lines.some((line) => /^Incomplete: style\.maxSelectorSteps=\d+$/u.test(line)));
    assert.ok(f.runtime.state().overlay.lines.includes("Style fallback: user-agent-only"));
    assert.equal(f.runtime.state().documents[0].rendering.summary.styleOutcome.fallback, "user-agent-only");
    await assert.rejects(renderBrowserOnce(url, f.options, terminalSize), /One-shot rendering was incomplete \(style\.maxSelectorSteps=\d+\)/u);
  } finally { await f.close(); }
});

test("diagnostics show each stylesheet load issue once and count only omitted unique entries", async () => {
  const links = Array.from({ length: 30 }, (_, index) => `<link rel="stylesheet" href="/missing-${index}.css">`).join("");
  const f = await fixture({ html: `<!doctype html><title>Diagnostic ownership</title>${links}<p>Visible</p>` });
  try {
    const document = f.runtime.state().documents[0];
    assert.equal(document.snapshot.styleDiagnostics.length, 30);
    assert.equal(document.rendering.summary.styleDiagnostics.length, 30);
    await f.runtime.dispatch({ kind: "openDetail", detail: "diagnostics" });
    const lines = f.runtime.state().overlay.lines;
    const issues = lines.filter((line) => line.startsWith("CSS "));
    assert.equal(issues.length, 24);
    assert.equal(new Set(issues).size, 24);
    assert.ok(lines.includes("Additional CSS diagnostics omitted: 6"), lines.join("\n"));
  } finally { await f.close(); }
});

test("retained control children remain inside their document allocation while resizing", async () => {
  const f = await fixture({ terminalSize: { columns: 120, rows: 30 }, html: `<!doctype html><title>Controls</title>
    <p>Visible page</p><div style="position:absolute;left:760px;top:64px;width:200px">
    <input aria-label="Query" value="retained"><textarea aria-label="Notes">notes</textarea><button>Submit</button></div>` });
  try {
    for (const columns of [80, 120, 40, 120]) {
      await f.runtime.resize({ columns, rows: 30 });
      const state = f.runtime.state();
      const tree = layoutElement(browserView(state, { terminalSize: { columns, rows: 30 } }), { columns, rows: 30 });
      const parent = findLayout(tree, `browser-${state.documents[0].id}`);
      assert.ok(parent);
      for (const child of parent.children) {
        assert.ok(child.bounds.column >= parent.bounds.column);
        assert.ok(child.bounds.column + child.bounds.width <= parent.bounds.column + parent.bounds.width);
        assert.ok(child.bounds.row >= parent.bounds.row);
        assert.ok(child.bounds.row + child.bounds.height <= parent.bounds.row + parent.bounds.height);
      }
      await waitUntil(f.runtime, () => f.runtime.state().documents[0].rendering.status === "ready");
      assert.match(renderFramePlain(f.runtime.frame()), /Visible page/u);
    }
  } finally { await f.close(); }
});

test("focused retained editor survives a fully clipped resize while the new viewport is pending", async () => {
  const f = await fixture({ terminalSize: {columns:120,rows:30}, html: `<title>Pending resize</title><style>body{margin:0}input{position:absolute;left:760px;top:64px;width:160px}</style><input aria-label="Query" value="retained">` });
  let release;
  try {
    const control=f.runtime.state().documents[0].snapshot.document.controls[0];
    await f.runtime.dispatch({kind:"movePageFocus",direction:"next",currentActionId:""});
    await waitUntil(f.runtime,()=>f.runtime.frame().focusPath?.includes(control.node));
    await text(f.runtime,"X");
    await waitUntil(f.runtime,()=>f.runtime.state().documents[0].rendering.status==="ready");
    const editor=f.runtime.state().documents[0].formEditors[control.node];
    const blocked=new Promise(resolve=>{release=resolve;});
    const render=f.prepared.controller.renderViewport.bind(f.prepared.controller);
    f.prepared.controller.renderViewport=async(...args)=>{await blocked;return render(...args);};
    await f.runtime.resize({columns:80,rows:30});
    assert.equal(f.runtime.state().documents[0].rendering.status,"rendering");
    assert.equal(f.runtime.state().documents[0].formEditors[control.node],editor);
    assert.equal(f.runtime.state().documents[0].rendering.pendingFocus?.node,control.node);
    await f.runtime.resize({columns:60,rows:30});
    assert.equal(f.runtime.state().documents[0].rendering.pendingFocus?.node,control.node);
    assert.equal(f.runtime.diagnostics().length,0);
    assert.equal(renderFramePlain(f.runtime.frame()).includes("retainedX"),false);
    assert.ok(f.runtime.frame().focusPath?.includes(control.node));
    await text(f.runtime,"Z");
    const pendingEditor=f.runtime.state().documents[0].formEditors[control.node];
    assert.equal(f.runtime.state().documents[0].documentState.controls.get(control.node).value,"retainedXZ");
    assert.equal(f.runtime.state().omnibox.editor.input.text,url);
    release();
    await waitUntil(f.runtime,()=>f.runtime.state().documents[0].rendering.status==="ready");
    assert.equal(f.runtime.state().documents[0].formEditors[control.node],pendingEditor);
    assert.ok(f.runtime.frame().focusPath?.includes(control.node));
    await text(f.runtime,"Y");
    assert.equal(f.runtime.state().documents[0].documentState.controls.get(control.node).value,"retainedXZY");
  } finally {release?.();await f.close();}
});

test("fully clipped retained select suppresses its open portal during pending resize", async () => {
  const f=await fixture({terminalSize:{columns:120,rows:30},html:`<title>Portal resize</title><style>body{margin:0}select{position:absolute;left:760px;top:64px;width:160px}</style><select aria-label="Language"><option value="en">English</option><option value="fr">French</option></select>`});
  let release;
  try {
    const control=f.runtime.state().documents[0].snapshot.document.controls[0];
    await f.runtime.dispatch({kind:"movePageFocus",direction:"next",currentActionId:""});
    await waitUntil(f.runtime,()=>f.runtime.frame().focusPath?.includes(control.node));
    await input(f.runtime,key("enter"));
    await waitUntil(f.runtime,()=>f.runtime.state().documents[0].rendering.status==="ready");
    assert.ok(renderFramePlain(f.runtime.frame()).includes("French"));
    const editor=f.runtime.state().documents[0].formEditors[control.node];
    const blocked=new Promise(resolve=>{release=resolve;});
    const render=f.prepared.controller.renderViewport.bind(f.prepared.controller);
    f.prepared.controller.renderViewport=async(...args)=>{await blocked;return render(...args);};
    await f.runtime.resize({columns:80,rows:30});
    assert.equal(f.runtime.state().documents[0].rendering.status,"rendering");
    assert.equal(f.runtime.diagnostics().length,0);
    assert.equal(f.runtime.state().documents[0].formEditors[control.node],editor);
    assert.equal(f.runtime.state().documents[0].rendering.pendingFocus?.node,control.node);
    assert.equal(renderFramePlain(f.runtime.frame()).includes("French"),false);
    assert.ok(!f.runtime.frame().hitTargets.some(target=>target.id.startsWith(`${control.node}:popup:`)));
    release();
    await waitUntil(f.runtime,()=>f.runtime.state().documents[0].rendering.status==="ready");
    assert.ok(f.runtime.frame().focusPath?.includes(control.node));
    assert.equal(f.runtime.state().documents[0].formEditors[control.node],editor);
    assert.deepEqual(f.runtime.state().documents[0].documentState.controls.get(control.node).selected,[control.options[0].node]);
  } finally {release?.();await f.close();}
});
