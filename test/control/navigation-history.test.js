import assert from "node:assert/strict";
import test from "node:test";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { text } from "@ismail-elkorchi/terminal-ui/components";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";
import { estimatedRetainedCost } from "../../dist/memory/retained-cost.js";
import { BrowserSession } from "../../dist/app/session.js";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { navigationSource } from "../../dist/app/http-session-context.js";
import { commitNavigation, currentEntry, emptyHistory, fragmentSnapshot, HISTORY_ENTRY_LIMIT, HISTORY_BYTE_LIMIT, isSameDocumentNavigation, traverseHistory } from "../../dist/app/navigation-history.js";
import { createDocumentState, applyDocumentAction, parseWebDocument, resolveDocumentFragment } from "../../dist/document/index.js";
import { acceptNavigation, activateHistory, emptyRendering, resumeDocument } from "../../dist/ui/navigation-state.js";

const A = "https://example.test/a";
const B = "https://example.test/b";
const html = `<form><input name="text" value="initial"><textarea name="area">initial</textarea></form><details><summary>More</summary>Details</details><a href="/b">B</a><h2 id="first">First</h2><h2 id="last">Last</h2>`;
function response(url, source = html) {
  return { requestUrl: url, finalUrl: url, status: 200, statusText: "OK", contentType: "text/html", html: source,
    responseFields: new HttpFields([]), fetchedAtIso: "2026-01-01T00:00:00Z" };
}
async function fixture() {
  const calls = [];
  const acquisition = new PageAcquisition({ defaultParseMode: "text", loader: async (url, options) => {
    calls.push({ url, source: navigationSource(options ?? {}) }); return response(url);
  }, stylesheetLoader: async () => { throw new Error("unexpected stylesheet"); } });
  const snapshot = await acquisition.acquire(A);
  const navigation = commitNavigation(emptyHistory(), snapshot, "push", { kind: "direct" });
  const document = { kind: "ready", id: "tab", navigationGeneration: 0, documentRevision: 1, stateRevision: 1,
    snapshot, navigation, documentState: createDocumentState(snapshot.document, A), scrollAnchor: { source: snapshot.document.body, rowOffset: 0 },
    scrollOffsets: [], search: null, formEditors: {}, entryViews: {}, liveDocuments: {}, rendering: emptyRendering(),
    loading: false, pendingUrl: null, canGoBack: false, canGoForward: false, error: null };
  return { acquisition, calls, document };
}
function edit(document, value, scroll) {
  const control = document.snapshot.document.controls[0];
  return { ...document, documentState: applyDocumentAction(document.snapshot.document, document.documentState,
    { kind: "set-control-value", target: control.node, value }),
    formEditors: { [control.node]: { kind: "text", state: { text: value, cursor: 2, selection: { anchor: 1, focus: 2 } } } },
    scrollAnchor: { source: document.snapshot.document.body, rowOffset: scroll },
  };
}
function value(document) { return document.documentState.controls.get(document.snapshot.document.controls[0].node).value; }

test("equal URL visits retain distinct entry/document identities and forms, caret, scroll", async () => {
  const f = await fixture();
  try {
    let doc = edit(f.document, "first visit", 20);
    const firstEntry = currentEntry(doc.navigation);
    doc = acceptNavigation(doc, await f.acquisition.acquire(B), "push", { kind: "direct" });
    doc = acceptNavigation(doc, await f.acquisition.acquire(A), "push", { kind: "direct" });
    doc = edit(doc, "second visit", 40);
    assert.notEqual(currentEntry(doc.navigation).id, firstEntry.id);
    assert.notEqual(currentEntry(doc.navigation).documentId, firstEntry.documentId);
    doc = activateHistory(doc, traverseHistory(doc.navigation, "back"));
    doc = activateHistory(doc, traverseHistory(doc.navigation, "back"));
    assert.equal(value(doc), "first visit"); assert.equal(doc.scrollAnchor.rowOffset, 20);
    assert.equal(Object.values(doc.formEditors)[0].state.cursor, 2);
    assert.deepEqual(Object.values(doc.formEditors)[0].state.selection, { anchor: 1, focus: 2 });
    doc = activateHistory(doc, traverseHistory(doc.navigation, "forward"));
    doc = activateHistory(doc, traverseHistory(doc.navigation, "forward"));
    assert.equal(value(doc), "second visit"); assert.equal(doc.scrollAnchor.rowOffset, 40);
    assert.equal(f.calls.length, 3);
  } finally { await f.acquisition.close(); }
});

test("fragment entries share latest live controls and nested offsets but retain entry scroll", async () => {
  const f = await fixture();
  try {
    let doc = edit(f.document, "before", 10);
    const live = currentEntry(doc.navigation).documentId;
    doc = acceptNavigation(doc, fragmentSnapshot(doc.snapshot, `${A}#first`), "push", { kind: "direct" }, live);
    assert.equal(doc.documentState.urlTarget, doc.snapshot.document.elementById("first"));
    doc = { ...edit(doc, "latest", 25), scrollOffsets: [{ node: doc.snapshot.document.body, inline: 0, block: 1024 }] };
    doc = activateHistory(doc, traverseHistory(doc.navigation, "back"));
    assert.equal(value(doc), "latest"); assert.equal(doc.scrollAnchor.rowOffset, 10);
    assert.equal(doc.scrollOffsets[0].block, 1024); assert.equal(doc.documentState.urlTarget, null);
    assert.equal(doc.rendering.pendingReveal, null); assert.equal(f.calls.length, 1);
    assert.equal(Object.keys(doc.liveDocuments).length, 0, "active state has no stale duplicate attachment");
  } finally { await f.acquisition.close(); }
});

test("reload initializes a new live document, branch truncation retires attachments, reopen retains edits", async () => {
  const f = await fixture();
  try {
    let doc = edit(f.document, "keep", 13);
    doc = acceptNavigation(doc, await f.acquisition.acquire(B), "push", { kind: "direct" });
    doc = activateHistory(doc, traverseHistory(doc.navigation, "back"));
    const reopened = resumeDocument(doc);
    assert.equal(value(reopened), "keep"); assert.equal(reopened.scrollAnchor.rowOffset, 13);
    assert.ok(reopened.documentRevision > doc.documentRevision);
    doc = acceptNavigation(doc, await f.acquisition.acquire(A), "push", { kind: "direct" });
    assert.equal(doc.canGoForward, false); assert.equal(doc.navigation.entries.length, 2);
    assert.equal(Object.keys(doc.liveDocuments).length, 1);
    doc = acceptNavigation(doc, await f.acquisition.acquire(A), "replace", { kind: "direct" });
    assert.equal(value(doc), "initial"); assert.deepEqual(doc.formEditors, {});
  } finally { await f.acquisition.close(); }
});

test("public session fragment navigation avoids acquisition and reload keeps checked provenance", async () => {
  const calls = [];
  const session = new BrowserSession({ defaultParseMode: "text", loader: async (url, options) => {
    calls.push({ url, source: navigationSource(options ?? {}) }); return response(url);
  } });
  try {
    const first = await session.open(A);
    const fragment = await session.open(`${A}#first`);
    assert.equal(fragment.document, first.document); assert.equal(calls.length, 1);
    await session.back(); await session.forward(); assert.equal(calls.length, 1);
    await session.openLink(1); await session.reload();
    assert.equal(calls.at(-1).source, `${A}#first`); assert.equal(session.current.finalUrl, B);
    const previous = session.current.document;
    await session.reload(); assert.notEqual(session.current.document, previous);
  } finally { await session.close(); }
  assert.equal(session.current, null); assert.equal(session.canBack(), false);
});

test("same-document classification retains all URL components and explicit request options", () => {
  assert.equal(isSameDocumentNavigation(A, `${A}#`), true);
  for (const target of [A, `${A}?q=1#x`, "https://other.test/a#x", "https://user@example.test/a#x", `${A}/#x`]) {
    assert.equal(isSameDocumentNavigation(A, target), false, target);
  }
  for (const options of [{ bodyText: "" }, { headers: {} }, { method: "POST" }]) {
    assert.equal(isSameDocumentNavigation(A, `${A}#x`, options), false);
  }
});

test("history entry cap retires oldest entries without a refetch tombstone", async () => {
  const f = await fixture();
  try {
    let history = f.document.navigation;
    for (let index = 0; index < HISTORY_ENTRY_LIMIT + 5; index += 1) history = commitNavigation(history,
      fragmentSnapshot(f.document.snapshot, `${A}#${index}`), "push", { kind: "direct" }, "live-1");
    assert.equal(history.entries.length, HISTORY_ENTRY_LIMIT); assert.equal(history.index, HISTORY_ENTRY_LIMIT - 1);
    assert.equal(history.entries.some((entry) => entry.id === "entry-1"), false);
    const oversized = commitNavigation(emptyHistory(), f.document.snapshot, "push", { kind: "direct" }, "oversized", new Map([["oversized", HISTORY_BYTE_LIMIT + 1]]));
    assert.equal(oversized.entries.length, 1, "active-page admission is not an arbitrary history byte limit");
    const retired = commitNavigation(oversized, f.document.snapshot, "push", { kind: "direct" }, undefined, new Map([["oversized", HISTORY_BYTE_LIMIT + 1]]));
    assert.equal(retired.entries.length, 1, "oversized inactive ownership is retired on departure");
    assert.equal(currentEntry(retired).id, "entry-2");
  } finally { await f.acquisition.close(); }
});

test("fragment resolver prefers raw IDs then names, decodes malformed UTF-8 tolerantly, distinguishes none/top", () => {
  const document = parseWebDocument(`<a name="same"></a><h2 id="same"></h2><h2 id="a%20b"></h2><h2 id="a b"></h2><a name="legacy"></a><div name="not-anchor"></div><h2 id="�%oops"></h2>`, { requestUrl: A, finalUrl: A });
  assert.deepEqual(resolveDocumentFragment(document, `${A}#same`), { kind: "node", node: document.elementById("same") });
  assert.deepEqual(resolveDocumentFragment(document, `${A}#a%20b`), { kind: "node", node: document.elementById("a%20b") });
  assert.equal(resolveDocumentFragment(document, `${A}#legacy`).kind, "node");
  assert.equal(resolveDocumentFragment(document, `${A}#not-anchor`).kind, "none");
  assert.deepEqual(resolveDocumentFragment(document, `${A}#%FF%oops`), { kind: "node", node: document.elementById("�%oops") });
  assert.equal(resolveDocumentFragment(document, A).kind, "none");
  assert.equal(resolveDocumentFragment(document, `${A}#`).kind, "top");
  assert.equal(resolveDocumentFragment(document, `${A}#ToP`).kind, "top");
});

test("host write rejection leaves accepted navigation and persistence untouched", async () => {
  const f = await fixture();
  const snapshot = await f.acquisition.acquire(B);
  let persisted = 0;
  const app = defineTui({ id: "history-acceptance", init: () => ({ state: f.document }),
    update: (document) => ({ state: acceptNavigation(document, snapshot, "push", { kind: "direct" }),
      effects: [{ id: "persist", run: () => { persisted += 1; return Promise.resolve({ kind: "none" }); } }] }),
    view: (document) => text({ content: document.snapshot.finalUrl }),
  });
  const host = createMemoryTerminalHost();
  const runtime = createTuiRuntime({ app, host });
  await runtime.start();
  const write = host.write.bind(host);
  host.write = () => Promise.reject(new Error("rejected host write"));
  try {
    await runtime.dispatch({ kind: "go" }).catch(() => undefined);
    assert.equal(runtime.state().navigation, f.document.navigation);
    assert.equal(runtime.state().snapshot.finalUrl, A); assert.equal(persisted, 0);
  } finally { host.write = write; await runtime.dispose(); await f.acquisition.close(); }
});

test("effect admission rejection cannot publish candidate history", async () => {
  const f = await fixture();
  const snapshot = await f.acquisition.acquire(B);
  let ran = 0;
  const app = defineTui({ id: "history-effect-admission", init: () => ({ state: f.document }),
    update: (document) => ({ state: acceptNavigation(document, snapshot, "push", { kind: "direct" }),
      effects: ["one", "two"].map((id) => ({ id, run: () => { ran += 1; return Promise.resolve({ kind: "none" }); } })) }),
    view: (document) => text({ content: document.snapshot.finalUrl }),
  });
  const runtime = createTuiRuntime({ app, host: createMemoryTerminalHost(), effectPolicy: {
    maxOwned: 1, maxActive: 1, maxActivePerId: 1, maxQueued: 1, maxQueuedPerId: 1, replacementGracePeriodMs: 1,
  } });
  try {
    await runtime.start();
    await runtime.dispatch({ kind: "go" }).catch(() => undefined);
    assert.equal(runtime.state().navigation, f.document.navigation); assert.equal(ran, 0);
  } finally { await runtime.dispose(); await f.acquisition.close(); }
});

test("a same-URL nonfragment visit and explicit resource options acquire new documents", async () => {
  let calls = 0;
  const session = new BrowserSession({ defaultParseMode: "text", loader: async (url) => { calls += 1; return response(url); } });
  try {
    const a = await session.open(A);
    const again = await session.open(A); assert.notEqual(a.document, again.document);
    await session.openWithRequest(`${A}#first`, { headers: {} });
    await session.openWithRequest(`${A}#first`, { method: "POST", bodyText: "x=1" });
    assert.equal(calls, 4);
    const same = await session.open(`${A}#last`);
    assert.equal(calls, 4);
    await session.reload(); assert.equal(calls, 5); assert.notEqual(session.current.document, same.document);
    assert.equal(session.current.diagnostics.requestMethod, "GET", "reload does not silently replay a POST");
  } finally { await session.close(); }
});

test("fragment URL and provenance metadata consume the history byte budget without charging a shared DOM repeatedly", async () => {
  const f = await fixture();
  try {
    let history = f.document.navigation;
    for (let index = 0; index < 40; index += 1) {
      const target = `${A}#${index}${"x".repeat(1_000_000)}`;
      history = commitNavigation(history, fragmentSnapshot(f.document.snapshot, target), "push",
        { kind: "page-initiated", sourceUrl: currentEntry(history).snapshot.finalUrl }, "live-1");
    }
    assert.ok(history.entries.length < 40, "same-document entries retire under the metadata budget");
    const strings = new Set(history.entries.flatMap((entry) => [entry.snapshot.requestUrl, entry.snapshot.finalUrl, entry.provenance.sourceUrl]));
    assert.ok([...strings].reduce((sum, value) => sum + (value?.length ?? 0) * 2, 0) <= HISTORY_BYTE_LIMIT);
    assert.ok(estimatedRetainedCost([history]) <= HISTORY_BYTE_LIMIT + estimatedRetainedCost([f.document.snapshot]));
    assert.equal(currentEntry(history).snapshot.finalUrl.startsWith(`${A}#39`), true);
    assert.equal(currentEntry(history).snapshot.document, f.document.snapshot.document);
  } finally { await f.acquisition.close(); }
});

test("root inline offset belongs to each history entry and survives reopen", async()=>{
  const f=await fixture();
  try {
    let doc={...f.document,scrollColumn:47};
    doc=acceptNavigation(doc,await f.acquisition.acquire(B),"push",{kind:"direct"});
    assert.equal(doc.scrollColumn,0);
    doc={...doc,scrollColumn:-20};
    doc=activateHistory(doc,traverseHistory(doc.navigation,"back"));
    assert.equal(doc.scrollColumn,47);
    assert.equal(resumeDocument(doc).scrollColumn,47);
    doc=activateHistory(doc,traverseHistory(doc.navigation,"forward"));
    assert.equal(doc.scrollColumn,-20);
  } finally {await f.acquisition.close();}
});

test("same-source activations retain an explicitly previous display without rewriting accepted revisions", async () => {
  const f = await fixture();
  try {
    const viewport = Object.freeze({ documentId: f.document.id, documentRevision: 1, stateRevision: 1, viewportRevision: 7 });
    let document = { ...f.document, rendering: { ...emptyRendering(), status: "ready", viewport,
      summary: { identity: "accepted" }, committedViewportRevision: 7 } };
    const live = currentEntry(document.navigation).documentId;
    document = acceptNavigation(document, fragmentSnapshot(document.snapshot, `${A}#first`), "push", { kind: "direct" }, live);
    assert.equal(document.documentRevision, 2);
    assert.equal(document.rendering.viewport, null);
    assert.equal(document.rendering.summary, null);
    assert.equal(document.rendering.previousViewport, viewport);
    assert.equal(document.rendering.previousViewport.documentRevision, 1);
    assert.equal(document.rendering.previousViewport.viewportRevision, 7);
    document = activateHistory(document, traverseHistory(document.navigation, "back"));
    assert.equal(document.documentRevision, 3);
    assert.equal(document.rendering.previousViewport, viewport, "rapid activation preserves only the last accepted display");
    assert.equal(resumeDocument(document).rendering.previousViewport, viewport);
    document = acceptNavigation(document, await f.acquisition.acquire(A), "push", { kind: "direct" });
    assert.equal(document.rendering.previousViewport, null, "equal URLs with new sources do not inherit a display");
  } finally { await f.acquisition.close(); }
});

for (const failure of ["write", "effect admission"]) {
  test(`rejected same-source ${failure} leaves accepted activation and its display untouched`, async () => {
    const f = await fixture();
    const viewport = Object.freeze({ documentRevision: 1, stateRevision: 1, viewportRevision: 1 });
    const accepted = { ...f.document, rendering: { ...emptyRendering(), status: "ready", viewport } };
    const live = currentEntry(accepted.navigation).documentId;
    let preparations = 0;
    const app = defineTui({ id: `same-source-${failure}`, init: () => ({ state: accepted }),
      update: (document) => ({ state: acceptNavigation(document, fragmentSnapshot(document.snapshot, `${A}#first`), "push", { kind: "direct" }, live),
        effects: ["prepare", ...(failure === "effect admission" ? ["persist"] : [])].map((id) => ({ id,
          run: () => { preparations += 1; return Promise.resolve({ kind: "none" }); } })) }),
      view: (document) => text({ content: document.snapshot.finalUrl }),
    });
    const host = createMemoryTerminalHost();
    const runtime = createTuiRuntime({ app, host, ...(failure === "effect admission" ? { effectPolicy: {
      maxOwned: 1, maxActive: 1, maxActivePerId: 1, maxQueued: 1, maxQueuedPerId: 1, replacementGracePeriodMs: 1,
    } } : {}) });
    await runtime.start();
    const write = host.write.bind(host);
    if (failure === "write") host.write = () => Promise.reject(new Error("rejected same-source write"));
    try {
      await runtime.dispatch({ kind: "go" }).catch(() => undefined);
      assert.equal(runtime.state(), accepted);
      assert.equal(runtime.state().documentRevision, 1);
      assert.equal(runtime.state().rendering.viewport, viewport);
      assert.equal(runtime.state().rendering.previousViewport, null);
      assert.equal(preparations, 0);
    } finally { host.write = write; await runtime.dispose(); await f.acquisition.close(); }
  });
}
