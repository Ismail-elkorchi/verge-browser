import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime } from "@ismail-elkorchi/terminal-ui/tui";
import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";
import {
  browserMediaEnvironment,
  browserRenderPreferences,
  documentScrollRow,
  renderDocumentForViewport,
  scrollToSource
} from "../../dist/ui/document-layout.js";
import { prepareBrowserTui, renderBrowserOnce } from "../../dist/ui/run.js";

function response(requestUrl, html) {
  return {
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html,
    responseFields: new HttpFields([{ name: "content-type", value: "text/html" }]),
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "HTTP_200",
      detailMessage: "200 OK"
    },
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  };
}

const pages = new Map([
  ["https://example.test/", `<title>Index</title><style>.lead{color:#123456;font-style:italic}</style><main id="content">
    <h1>Index</h1><p class="lead"><a href="/next">Next page with a wrapping label</a></p>
    ${Array.from({ length: 30 }, (_, index) => `<p>Paragraph ${index + 1} alpha</p>`).join("")}
    <h2>Forms</h2><form action="/search" method="get" aria-label="Search form">
      <label for="query">Query</label><input id="query" name="q" value="alpha" required>
      <label for="language">Language</label><select id="language" name="lang"><option value="en" selected>English</option><option value="fr">French</option></select>
      <button name="intent" value="search">Search</button>
    </form></main>`],
  ["https://example.test/next", "<title>Next</title><main><h1>Next</h1><p>Second page</p></main>"],
  ["https://example.test/search?q=alphaZ&lang=fr&intent=search", "<title>Results</title><h1>Results</h1><p>Submitted</p>"],
  ["about:newtab", "<title>New Tab</title><h1>New Tab</h1>"]
]);

function loader(requestUrl) {
  const html = pages.get(requestUrl);
  if (html === undefined) throw new Error(`Missing fixture ${requestUrl}`);
  return Promise.resolve(response(requestUrl, html));
}

test("interactive and one-shot rendering share terminal-derived media preferences", () => {
  const preferences = browserRenderPreferences({
    COLORFGBG: "0;15",
    VERGE_REDUCED_MOTION: "reduce",
    VERGE_AMBIGUOUS_WIDTH: "2",
    VERGE_POINTER: "none",
    NO_COLOR: "1"
  });
  const media = browserMediaEnvironment(640, 384, preferences);
  assert.equal(media.prefersColorScheme, "light");
  assert.equal(media.reducedMotion, true);
  assert.equal(preferences.ambiguousWidth, 2);
  assert.equal(preferences.colorDepth, 0);
  assert.equal(media.hover, "none");
  assert.equal(media.pointer, "none");
});

async function preparedFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "verge-structural-tui-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  if (options.workspace !== undefined) await store.saveWorkspace(options.workspace);
  const prepared = await prepareBrowserTui("https://example.test/", {
    store,
    restoreWorkspace: options.workspace !== undefined,
    services: {
      async writeTextFile() {},
      async downloadFile() { throw new Error("not used"); },
      async openExternal() {},
      async openPath() {},
      async close() {},
      ...options.services
    },
    createSession: () => new BrowserSession({
      loader: options.loader ?? loader,
      stylesheetLoader: async () => { throw new Error("unexpected stylesheet"); },
      defaultParseMode: "text"
    })
  });
  const host = createMemoryTerminalHost({ terminalSize: options.terminalSize ?? { columns: 100, rows: 28 } });
  const runtime = createTuiRuntime({ app: prepared.app, host });
  await runtime.start();
  return { runtime, prepared };
}

async function waitUntil(runtime, predicate) {
  const signal = globalThis.AbortSignal.timeout(5_000);
  while (!predicate()) {
    try {
      await runtime.nextChange(signal);
    } catch (error) {
      if (signal.aborted) assert.fail("Timed out waiting for browser state");
      throw error;
    }
  }
}

function key(key, modifiers = {}) {
  return {
    kind: "key",
    key,
    sequence: "",
    modifiers: { shift: false, alt: false, ctrl: false, meta: false, ...modifiers },
    eventType: "press",
    location: "standard"
  };
}

test("interactive browser renders the cell buffer and preserves link focus across resize", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 72, rows: 24 } });
  try {
    const document = runtime.state().documents[0];
    assert.equal(document.snapshot.document.title, "Index");
    assert.equal(renderDocumentForViewport(document, 71, 21), renderDocumentForViewport(document, 71, 21));
    assert.match(renderFramePlain(runtime.frame()), /Next page with a wrapping label/u);
    const linkId = `link:${document.snapshot.document.links[0].node}`;
    for (let count = 0; count < 20 && !runtime.frame().focusPath?.includes(linkId); count += 1) {
      await runtime.handleInput(key("tab"));
    }
    assert.ok(runtime.frame().focusPath?.includes(linkId));
    await runtime.resize({ columns: 48, rows: 20 });
    assert.ok(runtime.frame().focusPath?.includes(linkId));
    await runtime.handleInput(key("enter"));
    await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");
    assert.equal(runtime.state().documents[0].snapshot.document.title, "Next");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("terminal control focus reveals offscreen fragment geometry through the page viewport", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 72, rows: 24 } });
  try {
    const query = runtime.state().documents[0].snapshot.document.controls
      .find((control) => control.name === "q");
    const language = runtime.state().documents[0].snapshot.document.controls
      .find((control) => control.name === "lang");
    assert.ok(query && language);
    const linkId = `link:${runtime.state().documents[0].snapshot.document.links[0].node}`;
    for (let count = 0; count < 20 && !runtime.frame().focusPath?.includes(linkId); count += 1) {
      await runtime.handleInput(key("tab"));
    }
    assert.ok(runtime.frame().focusPath?.includes(linkId));
    await runtime.handleInput(key("arrowDown"));
    assert.ok(runtime.frame().focusPath?.includes(query.node));
    const current = runtime.state().documents[0];
    const layout = renderDocumentForViewport(current, 71, 21).terminal;
    assert.ok(documentScrollRow(current, layout) > 0);
    assert.match(renderFramePlain(runtime.frame()), /Query/u);
    await runtime.handleInput(key("tab"));
    assert.ok(runtime.frame().focusPath?.includes(language.node));
    await runtime.handleInput(key("tab", { shift: true }));
    assert.ok(runtime.frame().focusPath?.includes(query.node));
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("outline document nodes resolve through layout-fragment geometry", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const document = runtime.state().documents[0];
    const heading = document.snapshot.document.headings.find((entry) => entry.text === "Forms");
    assert.ok(heading);
    const layout = renderDocumentForViewport(document, 79, 24).terminal;
    const anchored = scrollToSource(document, heading.node);
    assert.ok(documentScrollRow(anchored, layout) > 20);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("summary activation updates document state and reveals details through the same pipeline", async () => {
  const detailsLoader = async (requestUrl) => response(
    requestUrl,
    `<title>Disclosure</title><details><summary>More</summary><p>Secret text</p></details>`
  );
  const { runtime, prepared } = await preparedFixture({ loader: detailsLoader });
  try {
    const initial = runtime.state().documents[0];
    const disclosure = initial.snapshot.document.disclosures[0];
    assert.ok(disclosure);
    assert.equal(initial.documentState.open.has(disclosure.node), false);
    await runtime.dispatch({ kind: "activateActionAt", actionId: `disclosure:${disclosure.node}` });
    const opened = runtime.state().documents[0];
    assert.equal(opened.documentState.open.has(disclosure.node), true);
    assert.match(renderDocumentForViewport(opened, 80).terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /Secret text/u);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("remote documents cannot cross the local-resource boundary through external opening", async () => {
  const opened = [];
  const { runtime, prepared } = await preparedFixture({
    services: { async openExternal(target) { opened.push(target); } }
  });
  try {
    await assert.rejects(
      prepared.controller.openExternal("https://example.test/", "file:///etc/passwd", "page-initiated")
    );
    await assert.rejects(
      prepared.controller.openExternal("https://example.test/", "http://127.0.0.1/private", "page-initiated")
    );
    assert.deepEqual(opened, []);
    await prepared.controller.openExternal("https://example.test/", "https://8.8.8.8/", "page-initiated");
    await prepared.controller.openExternal("http://127.0.0.1/private", "http://127.0.0.1/private", "direct");
    await prepared.controller.openExternal("file:///tmp/page.html", "file:///tmp/page.html", "direct");
    assert.deepEqual(opened, ["https://8.8.8.8/", "http://127.0.0.1/private", "file:///tmp/page.html"]);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("find and scrolling preserve layout-fragment and document-node identities", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const before = runtime.state().documents[0].scrollAnchor;
    await runtime.dispatch({ kind: "scroll", rows: 12 });
    assert.notDeepEqual(runtime.state().documents[0].scrollAnchor, before);
    assert.ok(runtime.state().documents[0].scrollAnchor.source === null
      || runtime.state().documents[0].scrollAnchor.source.startsWith("node:"));
    await prepared.controller.saveWorkspace(runtime.state());
    assert.deepEqual(prepared.controller.workspace()?.documents[0]?.scrollAnchor.target, {
      kind: "element-id",
      value: "content"
    });
    await runtime.dispatch({ kind: "openFind" });
    await runtime.dispatch({
      kind: "findAction",
      action: { kind: "edit", operation: { kind: "insert", text: "alpha" } }
    });
    const search = runtime.state().documents[0].search;
    assert.ok(search?.matches.length > 1);
    assert.ok(search.matches.every((match) => match.sources.every((source) => source !== null)));
    await runtime.dispatch({ kind: "moveSearch", direction: "next" });
    assert.equal(runtime.state().documents[0].search.activeMatchIndex, 1);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("interactive find keeps one logical match while resize reprojects its highlight slices", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 24, rows: 20 } });
  try {
    const query = "page with a wrapping label";
    await runtime.dispatch({ kind: "openFind" });
    await runtime.dispatch({
      kind: "findAction",
      action: { kind: "edit", operation: { kind: "insert", text: query } }
    });
    const narrowDocument = runtime.state().documents[0];
    const narrowSearch = narrowDocument.search;
    assert.equal(narrowSearch?.matches.length, 1);
    const matchId = narrowSearch.matches[0].id;
    const narrowSearchResult = renderDocumentForViewport(narrowDocument, 23, 16).terminal.search(query);
    assert.equal(narrowSearchResult.matches[0]?.id, matchId);
    assert.ok(new Set(narrowSearchResult.matches[0].ranges.map((range) => range.row)).size > 1);

    await runtime.resize({ columns: 80, rows: 24 });
    const wideDocument = runtime.state().documents[0];
    assert.equal(wideDocument.search?.matches[0]?.id, matchId);
    const wideSearchResult = renderDocumentForViewport(wideDocument, 79, 20).terminal.search(query);
    assert.equal(wideSearchResult.matches[0]?.id, matchId);
    assert.equal(new Set(wideSearchResult.matches[0].ranges.map((range) => range.row)).size, 1);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("workspace restoration resolves durable scroll targets into the new snapshot", async () => {
  const { runtime, prepared } = await preparedFixture({
    workspace: {
      documents: [{
        url: "https://example.test/",
        scrollAnchor: { target: { kind: "element-id", value: "content" }, rowOffset: 2 }
      }],
      activeDocumentIndex: 0,
      sidePanel: null
    }
  });
  try {
    const document = runtime.state().documents[0];
    assert.equal(document.scrollAnchor.source, document.snapshot.document.elementById("content"));
    assert.equal(document.scrollAnchor.rowOffset, 2);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("a new snapshot never reuses an opaque scroll reference from stale UI state", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const initial = runtime.state().documents[0];
    const stale = {
      ...initial,
      scrollAnchor: { source: initial.snapshot.document.headings[0].node, rowOffset: 7 }
    };
    await prepared.controller.navigate(stale, "https://example.test/next");
    const restored = prepared.controller.restoreDocument(stale);
    assert.equal(restored.snapshot.finalUrl, "https://example.test/next");
    assert.equal(restored.scrollAnchor.source, restored.snapshot.document.body);
    assert.equal(restored.scrollAnchor.rowOffset, 0);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("terminal-ui form controls update document state and submit through semantic form metadata", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const initial = runtime.state().documents[0];
    const form = initial.snapshot.document.forms[0];
    const query = form.controls.find((control) => control.name === "q");
    const language = form.controls.find((control) => control.name === "lang");
    const submit = form.controls.find((control) => control.kind === "submit");
    assert.ok(renderDocumentForViewport(initial, 80).terminal.focusMap.targets.some((target) => target.node === query.node));
    await runtime.dispatch({
      kind: "formText",
      controlId: query.node,
      action: { kind: "edit", operation: { kind: "insert", text: "Z" } }
    });
    await runtime.dispatch({ kind: "formValues", controlId: language.node, values: ["fr"] });
    assert.equal(runtime.state().documents[0].documentState.controls.get(query.node).values[0], "alphaZ");
    await runtime.dispatch({ kind: "submitForm", formId: form.node, submitterId: submit.node });
    await waitUntil(runtime, () => runtime.state().documents[0].snapshot.document.title === "Results");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("form controls update atomic layout fragments and preserve ordinary form descendants", async () => {
  const formLoader = async (requestUrl) => response(
    requestUrl,
    `<title>Form content</title><main><form action="/submit">
      <p>Profile prose remains visible. <a href="/privacy">Privacy details</a></p>
      <label for="name">Name</label><input id="name" name="name" value="Ada">
      <button>Continue</button>
    </form></main>`
  );
  const { runtime, prepared } = await preparedFixture({ loader: formLoader });
  try {
    const frame = renderFramePlain(runtime.frame());
    assert.match(frame, /Profile prose remains visible/u);
    assert.match(frame, /Privacy details/u);
    const link = runtime.state().documents[0].snapshot.document.links[0];
    assert.ok(link);
    const linkId = `link:${link.node}`;
    for (let count = 0; count < 12 && !runtime.frame().focusPath?.includes(linkId); count += 1) {
      await runtime.handleInput(key("tab"));
    }
    assert.ok(runtime.frame().focusPath?.includes(linkId));
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("standalone controls use the same terminal-ui editing path without inventing a form", async () => {
  const standaloneLoader = async (requestUrl) => response(
    requestUrl,
    `<title>Standalone</title><main><label for="query">Query</label><input id="query" value="alpha"></main>`
  );
  const { runtime, prepared } = await preparedFixture({ loader: standaloneLoader });
  try {
    const initial = runtime.state().documents[0];
    const control = initial.snapshot.document.controls[0];
    assert.ok(control);
    assert.equal(control.form, null);
    assert.ok(renderDocumentForViewport(initial, 80).terminal.focusMap.targets.some((target) => target.node === control.node));
    await runtime.dispatch({
      kind: "formText",
      controlId: control.node,
      action: { kind: "edit", operation: { kind: "insert", text: "Z" } }
    });
    assert.equal(runtime.state().documents[0].documentState.controls.get(control.node).values[0], "alphaZ");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("closing an in-flight tab prevents stale navigation from mutating a reopened document", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const delayedLoader = async (requestUrl) => {
    if (requestUrl === "https://example.test/slow") {
      await delayed;
      return response(requestUrl, "<title>Slow</title><h1>Slow result</h1>");
    }
    return loader(requestUrl);
  };
  const { runtime, prepared } = await preparedFixture({ loader: delayedLoader });
  try {
    await runtime.dispatch({ kind: "newDocument", target: "about:newtab" });
    await waitUntil(runtime, () => runtime.state().documents.length === 2);
    await runtime.dispatch({ kind: "selectDocument", index: 0 });
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/slow" });
    await runtime.dispatch({ kind: "closeDocument" });
    await runtime.dispatch({ kind: "reopenDocument" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reopened = runtime.state().documents.at(-1);
    assert.equal(reopened.snapshot.document.title, "Index");
    assert.equal(reopened.snapshot.finalUrl, "https://example.test/");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("one-shot output and the interactive view consume the same cell-buffer rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verge-once-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const services = {
    async writeTextFile() {}, async downloadFile() { throw new Error("not used"); },
    async openExternal() {}, async openPath() {}, async close() {}
  };
  const options = {
    store,
    services,
    createSession: () => new BrowserSession({ loader, stylesheetLoader: async () => { throw new Error("unexpected"); }, defaultParseMode: "text" })
  };
  const output = await renderBrowserOnce("https://example.test/next", options, { columns: 80, rows: 24 });
  assert.match(output, /Second page/u);
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 80, rows: 24 } });
  try {
    const terminalRender = renderDocumentForViewport(runtime.state().documents[0], 79).terminal;
    assert.ok(terminalRender.cellBuffer.rows.some((row) => row.text.includes("Index")));
    assert.match(renderFramePlain(runtime.frame()), /Index/u);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});
