import { URL } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime } from "@ismail-elkorchi/terminal-ui/tui";
import { HttpFields } from "@ismail-elkorchi/http-client";

import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import {
  browserMediaEnvironment,
  browserRenderPreferences,
  committedDocumentScrollRow,
  documentScrollRow,
  documentWithScrollRow,
  scrollToSource
} from "../../dist/ui/document-layout.js";
import { prepareBrowserTui, renderBrowserOnce } from "../../dist/ui/run.js";
import { acceptNavigation } from "../../dist/ui/navigation-state.js";
import { updateBrowser } from "../../dist/ui/app.js";
import { controlValues, selectEditor } from "../../dist/ui/form-editors.js";

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
    createAcquisition: () => new PageAcquisition({
      loader: options.loader ?? loader,
      ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
      stylesheetLoader: async () => { throw new Error("unexpected stylesheet"); },
      defaultParseMode: "text"
    })
  });
  const host = createMemoryTerminalHost({ terminalSize: options.terminalSize ?? { columns: 100, rows: 28 } });
  const runtime = createTuiRuntime({ app: prepared.app, host, textPresentation: prepared.textPresentation });
  await runtime.start();
  if (options.waitForRender !== false) {
    await waitUntil(runtime, () => {
      const status = runtime.state().documents[0]?.rendering?.status;
      return status === "ready" || status === "failed";
    });
    const rendering = runtime.state().documents[0]?.rendering;
    assert.equal(rendering?.status, "ready", rendering?.error ?? "The initial viewport did not render.");
  }
  return { runtime, prepared };
}

async function waitUntil(runtime, predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const rendering = runtime.state().documents[0]?.rendering;
      assert.fail(`Timed out waiting for browser state (${rendering?.status ?? "missing"}: ${rendering?.error ?? "no error"}); diagnostics=${JSON.stringify(runtime.diagnostics())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("workspace restoration paints placeholders first, loads the active tab first, and isolates failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verge-placeholder-restore-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const urls = ["https://restore.test/zero", "https://restore.test/one", "https://restore.test/active", "https://restore.test/three"];
  await store.saveWorkspace({
    documents: urls.map((url) => ({ url, scrollAnchor: { target: null, rowOffset: 0 } })),
    activeDocumentIndex: 2,
    sidePanel: null,
  });
  const pending = new Map();
  const starts = [];
  let sessions = 0;
  const prepared = await prepareBrowserTui(urls[0], {
    store,
    restoreWorkspace: true,
    services: {
      async writeTextFile() {}, async downloadFile() { throw new Error("not used"); },
      async openExternal() {}, async openPath() {}, async close() {},
    },
    createAcquisition: () => {
      sessions += 1;
      return new PageAcquisition({
        loader: async (requestUrl) => {
          starts.push(requestUrl);
          const operation = deferred();
          pending.set(requestUrl, operation);
          return operation.promise;
        },
        stylesheetLoader: async () => { throw new Error("unexpected stylesheet"); },
        defaultParseMode: "text",
      });
    },
  });
  assert.equal(sessions, 0);
  assert.ok(prepared.state.documents.every((tab) => tab.kind === "restoring"));
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
  const runtime = createTuiRuntime({ app: prepared.app, host, textPresentation: prepared.textPresentation });
  try {
    await runtime.start();
    assert.ok(runtime.frame());
    assert.equal(runtime.state().documents[2].kind, "loading");
    await waitUntil(runtime, () => starts.length === 1);
    assert.deepEqual(starts, [urls[2]]);
    assert.equal(sessions, 1);

    pending.get(urls[2]).resolve(response(urls[2], "<title>Active</title><h1>Active restored tab</h1>"));
    await waitUntil(runtime, () => runtime.state().documents[2].kind === "ready" && starts.length === 3);
    assert.deepEqual(new Set(starts.slice(1)), new Set([urls[0], urls[1]]));
    assert.equal(sessions, 3);

    pending.get(urls[0]).reject(new Error("isolated background failure"));
    pending.get(urls[1]).resolve(response(urls[1], "<title>One</title><p>One</p>"));
    await waitUntil(runtime, () => starts.includes(urls[3]));
    pending.get(urls[3]).resolve(response(urls[3], "<title>Three</title><p>Three</p>"));
    await waitUntil(runtime, () => runtime.state().documents.every((tab) => tab.kind === "ready" || tab.kind === "failed"));
    await waitUntil(runtime, () => runtime.state().documents[2].rendering?.status === "ready");
    assert.equal(runtime.state().documents[0].kind, "failed");
    assert.deepEqual(runtime.state().documents.slice(1).map((tab) => tab.kind), ["ready", "ready", "ready"]);
    assert.match(renderFramePlain(runtime.frame()), /Active restored tab/u);
  } finally {
    for (const operation of pending.values()) operation.resolve(response("https://restore.test/cleanup", "<p>cleanup</p>"));
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("a rendering-worker failure retains the last frame and restarts only after explicit retry", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const current = runtime.state();
    const ready = current.documents[0];
    assert.equal(ready?.kind, "ready");
    const failed = {
      ...current,
      documents: current.documents.map((tab, index) => index === 0 && tab.kind === "ready"
        ? {
            ...tab,
            rendering: { ...tab.rendering, status: "failed", error: "worker stopped" },
          }
        : tab),
    };
    const context = { terminalSize: { columns: 100, rows: 28 } };
    const ignoredScroll = updateBrowser(prepared.controller, failed, { kind: "scroll", rows: 3 }, context);
    assert.equal(ignoredScroll.state.documents[0]?.rendering?.status, "failed");
    assert.equal(ignoredScroll.effects?.some((effect) => effect.id.startsWith("render:")) ?? false, false);

    const retry = updateBrowser(prepared.controller, failed, { kind: "requestActiveViewport" }, context);
    assert.equal(retry.state.documents[0]?.rendering?.status, "rendering");
    assert.equal(retry.effects?.some((effect) => effect.id.startsWith("render:")), true);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("interactive browser renders the cell buffer and preserves link focus across resize", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 72, rows: 24 } });
  try {
    const document = runtime.state().documents[0];
    assert.equal(document.snapshot.document.title, "Index");
    assert.equal(document.rendering.status, "ready");
    assert.match(renderFramePlain(runtime.frame()), /Next page with a wrapping label/u);
    const pendingScroll = documentWithScrollRow(document, documentScrollRow(document) + 3, 20);
    assert.notEqual(documentScrollRow(pendingScroll), documentScrollRow(document));
    assert.equal(committedDocumentScrollRow(pendingScroll), committedDocumentScrollRow(document));
    const metricsBeforeFocus = await prepared.controller.renderingMetrics();
    const renderStateRevisionBeforeFocus = document.stateRevision;
    const linkId = `link:${document.snapshot.document.links[0].node}`;
    for (let count = 0; count < 20 && !runtime.frame().focusPath?.includes(linkId); count += 1) {
      await runtime.handleInput(key("tab"));
    }
    assert.ok(runtime.frame().focusPath?.includes(linkId));
    assert.equal(runtime.state().documents[0].documentState.focus, document.snapshot.document.links[0].node);
    const metricsAfterFocus = await prepared.controller.renderingMetrics();
    assert.equal(runtime.state().documents[0].stateRevision, renderStateRevisionBeforeFocus);
    assert.equal(metricsAfterFocus.viewportRequests, metricsBeforeFocus.viewportRequests);
    assert.equal(
      metricsAfterFocus.stages.find((stage) => stage.stage === "computed-style-resolution")?.invocations,
      metricsBeforeFocus.stages.find((stage) => stage.stage === "computed-style-resolution")?.invocations
    );
    const focusedLinkCells = runtime.frame().cells.filter((cell) =>
      cell.link?.href === "https://example.test/next"
    );
    assert.ok(focusedLinkCells.length > 0);
    assert.ok(focusedLinkCells.every((cell) => cell.style?.inverse !== true));
    await runtime.resize({ columns: 48, rows: 20 });
    assert.ok(runtime.frame().focusPath?.includes(linkId));
    assert.equal(runtime.state().documents[0].documentState.focus, document.snapshot.document.links[0].node);
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
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(query.node));
    assert.ok(runtime.frame().focusPath?.includes(query.node));
    assert.equal(runtime.state().documents[0].documentState.focus, query.node);
    await runtime.handleInput(key("tab"));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(language.node));
    assert.ok(runtime.frame().focusPath?.includes(language.node));
    assert.equal(runtime.state().documents[0].documentState.focus, language.node);
    await runtime.handleInput(key("tab", { shift: true }));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(query.node));
    assert.ok(runtime.frame().focusPath?.includes(query.node));
    assert.equal(runtime.state().documents[0].documentState.focus, query.node);
    assert.ok(runtime.frame().focusPath?.includes(query.node));
    const current = runtime.state().documents[0];
    assert.ok(documentScrollRow(current) > 0);
    assert.match(renderFramePlain(runtime.frame()), /Query/u);
    await runtime.handleInput(key("tab"));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(language.node));
    assert.ok(runtime.frame().focusPath?.includes(language.node));
    await runtime.handleInput(key("tab", { shift: true }));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(query.node));
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
    const anchored = scrollToSource(document, heading.node);
    assert.deepEqual(anchored.rendering.pendingReveal, { node: heading.node, blockAlign: "start" });
    await runtime.dispatch({ kind: "pickerSelect", value: { kind: "outline", index: 0, node: heading.node } });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.pendingReveal === null
      && runtime.state().documents[0].rendering.status === "ready");
    assert.ok(documentScrollRow(runtime.state().documents[0]) > 20);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("sticky and fixed paint does not replace the normal-flow scroll anchor", async () => {
  const page = `<title>Sticky</title><header id="sticky" style="position:sticky;top:0">Header</header>
    ${Array.from({ length: 40 }, (_, index) => `<p>Row ${String(index)}</p>`).join("")}`;
  const { runtime, prepared } = await preparedFixture({ loader: async (requestUrl) => response(requestUrl, page) });
  try {
    const document = runtime.state().documents[0];
    const scrolled = documentWithScrollRow(document, 12, 10);
    assert.notEqual(scrolled.scrollAnchor.source, document.snapshot.document.elementById("sticky"));
    assert.equal(documentScrollRow(scrolled), 12);
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
    await waitUntil(runtime, () => renderFramePlain(runtime.frame()).includes("Secret text"));
    assert.match(renderFramePlain(runtime.frame()), /Secret text/u);
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
      transition: { kind: "edit", operation: { kind: "insert", text: "alpha" } }
    });
    await waitUntil(runtime, () => runtime.state().documents[0].search?.query === "alpha");
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
      transition: { kind: "edit", operation: { kind: "insert", text: query } }
    });
    await waitUntil(runtime, () => runtime.state().documents[0].search?.query === query
      && runtime.state().documents[0].rendering.viewport?.search?.query === query);
    const narrowDocument = runtime.state().documents[0];
    const narrowSearch = narrowDocument.search;
    assert.equal(narrowSearch?.matches.length, 1);
    const matchId = narrowSearch.matches[0].id;
    const narrowSearchResult = narrowDocument.rendering.viewport.search;
    assert.equal(narrowSearchResult.matches[0]?.id, matchId);
    assert.ok(new Set(narrowSearchResult.matches[0].ranges.map((range) => range.row)).size > 1);

    await runtime.resize({ columns: 80, rows: 24 });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.viewport?.cellBuffer.columns === 79);
    const wideDocument = runtime.state().documents[0];
    assert.equal(wideDocument.search?.matches[0]?.id, matchId);
    const wideSearchResult = wideDocument.rendering.viewport.search;
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
    const acquired = await prepared.controller.navigate(stale, "https://example.test/next");
    assert.equal(runtime.state().documents[0].snapshot, initial.snapshot);
    const restored = acceptNavigation(stale, acquired.snapshot, acquired.mode, acquired.provenance);
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
    assert.ok(initial.rendering.summary.focusOrder.some((target) => target.node === query.node));
    await runtime.dispatch({
      kind: "formText",
      controlId: query.node,
      transition: { kind: "edit", operation: { kind: "insert", text: "Z" } }
    });
    await runtime.dispatch({ kind: "formValues", controlId: language.node, values: ["fr"], selectedOptions: [language.options.find((option) => option.value === "fr").node] });
    assert.equal(runtime.state().documents[0].documentState.controls.get(query.node).value, "alphaZ");
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
    assert.ok(initial.rendering.summary.focusOrder.some((target) => target.node === control.node));
    await runtime.dispatch({
      kind: "formText",
      controlId: control.node,
      transition: { kind: "edit", operation: { kind: "insert", text: "Z" } }
    });
    assert.equal(runtime.state().documents[0].documentState.controls.get(control.node).value, "alphaZ");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("ordinary buttons use the native terminal control path without debug prose", async () => {
  const ordinaryButtonLoader = async (requestUrl) => response(
    requestUrl,
    `<title>Button</title><main><button type="button" name="command" value="close">Close menu</button></main>`
  );
  const { runtime, prepared } = await preparedFixture({ loader: ordinaryButtonLoader });
  try {
    const document = runtime.state().documents[0];
    const control = document.snapshot.document.controls[0];
    assert.equal(control.kind, "button");
    assert.match(renderFramePlain(runtime.frame()), /Close menu/u);
    assert.doesNotMatch(renderFramePlain(runtime.frame()), /unsupported-button/u);
    for (let count = 0; count < 20 && !runtime.frame().focusPath?.includes(control.node); count += 1) {
      await runtime.handleInput(key("tab"));
    }
    assert.ok(runtime.frame().focusPath?.includes(control.node));
    assert.equal(
      runtime.state().documents[0].documentState.focus,
      control.node,
      `focus path: ${JSON.stringify(runtime.frame().focusPath)}`
    );
    await runtime.handleInput(key("enter"));
    assert.equal(runtime.state().documents[0].documentState.focus, control.node);
    assert.equal(runtime.state().status?.text, "This button has no native HTML action.");
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("rendering truncation takes precedence over a stale navigation success status", async () => {
  const rules = "span:nth-child(odd of :not(.absent)){color:red}";
  const incompleteLoader = async (requestUrl) => response(
    requestUrl,
    `<title>Incomplete</title><style>${rules}</style><main><p>Visible text</p>${"<span>item</span>".repeat(2000)}</main>`
  );
  const { runtime, prepared } = await preparedFixture({ loader: incompleteLoader });
  try {
    const frame = renderFramePlain(runtime.frame());
    assert.match(frame, /rendering incomplete \(style\.maxSelectorSteps=\d+\)/u);
    assert.doesNotMatch(frame, /Opened Incomplete/u);
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
    createAcquisition: () => new PageAcquisition({ loader, stylesheetLoader: async () => { throw new Error("unexpected"); }, defaultParseMode: "text" })
  };
  const output = await renderBrowserOnce("https://example.test/next", options, { columns: 80, rows: 24 });
  assert.match(output, /Second page/u);
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 80, rows: 24 } });
  try {
    const terminalRender = runtime.state().documents[0].rendering.viewport;
    assert.ok(terminalRender.cellBuffer.rows.some((row) => row.text.includes("Index")));
    assert.match(renderFramePlain(runtime.frame()), /Index/u);
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("browser-global actions and completions are independent of selected placeholder readiness", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const ready = runtime.state().documents[0];
    for (const kind of ["restoring", "loading", "failed"]) {
      const placeholder = { ...prepared.controller.placeholder("https://example.test/pending"), kind };
      const state = { ...runtime.state(), documents: [ready, placeholder], activeDocumentIndex: 1 };
      const focus = updateBrowser(prepared.controller, state, { kind: "focusOmnibox" });
      assert.equal(focus.focus?.elementId, "browser-omnibox", kind);
      const edited = updateBrowser(prepared.controller, focus.state, {
        kind: "omniboxTransition", transition: { kind: "setValue", value: "https://example.test/next" },
      });
      assert.equal(edited.state.omnibox.editor.input.text, "https://example.test/next", kind);
      const submitted = updateBrowser(prepared.controller, edited.state, {
        kind: "omniboxSubmit", value: "https://example.test/next",
      });
      assert.equal(submitted.state.documents[1].requestedUrl, "https://example.test/next", kind);
      const opened = updateBrowser(prepared.controller, state, { kind: "newDocument" });
      assert.equal(opened.state.documents.length, 3, kind);
      assert.equal(updateBrowser(prepared.controller, state, { kind: "quit" }).exit.reason, "quit");
      const payload = { ...ready.rendering.viewport, viewportRevision: ready.rendering.requestedViewportRevision + 1 };
      const rendering = { ...ready, rendering: { ...ready.rendering, status: "rendering", requestedViewportRevision: payload.viewportRevision } };
      const completed = updateBrowser(prepared.controller, { ...state, documents: [rendering, placeholder] }, { kind: "viewportReady", payload });
      assert.equal(completed.state.documents[0].rendering.status, "ready", kind);
      assert.equal(completed.state.documents[0].rendering.viewport, payload);
      const library = updateBrowser(prepared.controller, state, { kind: "downloadsChanged", downloads: [], status: "done" });
      assert.equal(library.state.status.text, "done", kind);
    }
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("rapid placeholder selection keeps a total bound on restoration loads", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    let state = { ...runtime.state(), documents: Array.from({ length: 50 }, (_, index) =>
      prepared.controller.placeholder(`https://example.test/${index}`)), activeDocumentIndex: 0 };
    for (let index = 0; index < 50; index += 1) {
      state = updateBrowser(prepared.controller, state, { kind: "selectDocument", index }).state;
      assert.ok(prepared.controller.restorationMetrics().live <= 3, `selection ${index}`);
    }
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
});

async function settleViewportEffects(controller, state, context) {
  let update = updateBrowser(controller, state, { kind: "requestActiveViewport" }, context);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const effects = (update.effects ?? []).filter((effect) => /^(render|search):/u.test(effect.id));
    if (effects.length === 0) return update.state;
    let next;
    for (const effect of effects) {
      const completion = await effect.run({ signal: new globalThis.AbortController().signal });
      assert.equal(completion.kind, "message");
      next = updateBrowser(controller, update.state, completion.message, context);
      update = next;
    }
  }
  assert.fail("viewport effects did not converge");
}

test("late logical search matches refresh anchors on resize before next-match navigation", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const wide = { terminalSize: { columns: 100, rows: 28 } };
    let state = { ...runtime.state(), findBar: { input: { text: "Paragraph", cursor: 9 } } };
    state = await settleViewportEffects(prepared.controller, state, wide);
    const document = state.documents[0];
    assert.ok(document.search.matches.length >= 29);
    const previous = document.search;
    const late = { ...document, search: { ...previous, activeMatchIndex: 27 } };
    const narrow = { terminalSize: { columns: 18, rows: 28 } };
    const resized = updateBrowser(prepared.controller, { ...state, documents: [late] }, { kind: "terminalResized" }, narrow);
    assert.equal(resized.state.documents[0].search.anchors.size, 0);
    const next = updateBrowser(prepared.controller, resized.state, { kind: "moveSearch", direction: "next" }, narrow);
    assert.equal(next.state.documents[0].search.activeMatchIndex, 28);
    state = await settleViewportEffects(prepared.controller, { ...next.state, documents: next.state.documents.map((tab) => ({
      ...tab, rendering: { ...tab.rendering, requestKey: null },
    })) }, narrow);
    const updated = state.documents[0].search;
    assert.deepEqual(updated.matches.map((match) => match.id), previous.matches.map((match) => match.id));
    assert.equal(updated.layoutRevision, state.documents[0].rendering.viewport.layoutRevision);
    assert.notEqual(updated.anchors.get(updated.matches[28].id), previous.anchors.get(previous.matches[28].id));
    assert.equal(updated.activeMatchIndex, 28);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("search completion requires document, state, query, generation, and layout identities", async () => {
  const { runtime, prepared } = await preparedFixture();
  try {
    const original = runtime.state().documents[0];
    const document = { ...original, stateRevision: 2, rendering: { ...original.rendering,
      searchRequestGeneration: 2, pendingSearch: { query: "alpha", requestGeneration: 2, stateRevision: 2 } } };
    const state = { ...runtime.state(), findBar: { input: { text: "alpha", cursor: 5 } }, documents: [document] };
    const completion = { kind: "searchReady", documentId: document.id, documentRevision: document.documentRevision,
      stateRevision: 2, requestGeneration: 2, layoutRevision: document.rendering.viewport.layoutRevision,
      query: "alpha", matches: [{ id: "logical", sources: [] }], anchors: [["logical", 3]], truncated: false };
    for (const invalid of [{ stateRevision: 1 }, { requestGeneration: 1 }, { query: "older" }, { documentRevision: 0 }, { layoutRevision: "older" }]) {
      const ignored = updateBrowser(prepared.controller, state, { ...completion, ...invalid });
      assert.equal(ignored.state.documents[0].search, null);
    }
    const closed = updateBrowser(prepared.controller, state, { kind: "closeFind" });
    assert.equal(closed.state.documents[0].rendering.pendingSearch, null);
    assert.ok(closed.state.documents[0].rendering.searchRequestGeneration > completion.requestGeneration);
    const obsolete = updateBrowser(prepared.controller, closed.state, completion);
    assert.equal(obsolete.state.documents[0].search, null);
    const placeholder = prepared.controller.placeholder("https://example.test/pending");
    const routed = updateBrowser(prepared.controller, { ...state, documents: [document, placeholder], activeDocumentIndex: 1 }, completion);
    assert.equal(routed.state.documents[0].search.matches[0].id, "logical");
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("unresolved initial navigation can be replaced through the omnibox", async () => {
  const initial = deferred();
  const started = deferred();
  const { runtime, prepared } = await preparedFixture({ waitForRender: false,
    loader: (url) => {
      if (url.endsWith("/next")) return Promise.resolve(response(url, "<title>Replacement</title><p>replacement page</p>"));
      started.resolve();
      return initial.promise;
    } });
  try {
    await started.promise;
    await runtime.dispatch({ kind: "focusOmnibox" });
    await runtime.dispatch({ kind: "omniboxTransition", transition: { kind: "setValue", value: "https://example.test/next" } });
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/next" });
    await waitUntil(runtime, () => runtime.state().documents[0]?.rendering?.status === "ready");
    assert.equal(runtime.state().documents[0].snapshot.finalUrl, "https://example.test/next");
    initial.resolve(response("https://example.test/", "<p>obsolete initial page</p>"));
  } finally { initial.resolve(response("https://example.test/", "<p>cleanup</p>")); await runtime.dispose(); await prepared.controller.close(); }
});

test("failed initial navigation permits help, retry, and a new navigable tab", async () => {
  let attempts = 0;
  const { runtime, prepared } = await preparedFixture({ waitForRender: false, loader: (url) => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("initial failure")) : Promise.resolve(response(url, "<p>recovered</p>"));
  } });
  try {
    await waitUntil(runtime, () => runtime.state().documents[0].kind === "failed");
    await runtime.dispatch({ kind: "openActionPalette" });
    await runtime.dispatch({ kind: "actionPaletteSubmit", value: "help" });
    assert.equal(runtime.state().overlay?.detailKind, "help");
    await runtime.dispatch({ kind: "dismiss" });
    await runtime.dispatch({ kind: "navigate", operation: "reload" });
    await waitUntil(runtime, () => runtime.state().documents[0]?.rendering?.status === "ready");
    await runtime.dispatch({ kind: "newDocument", target: "https://example.test/new" });
    await waitUntil(runtime, () => runtime.state().documents[1]?.rendering?.status === "ready");
    assert.equal(runtime.state().documents[1].snapshot.finalUrl, "https://example.test/new");
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("navigation completion routes to ready A while placeholder B owns selection", async () => {
  const navigation = deferred();
  const background = deferred();
  const { runtime, prepared } = await preparedFixture({ loader: (url) => url.endsWith("/next") ? navigation.promise
    : url.endsWith("/pending") ? background.promise : loader(url) });
  try {
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/next" });
    await runtime.dispatch({ kind: "newDocument", target: "https://example.test/pending" });
    assert.equal(runtime.state().activeDocumentIndex, 1);
    navigation.resolve(response("https://example.test/next", "<p>completed in inactive A</p>"));
    await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl.endsWith("/next"));
    assert.equal(runtime.state().documents[1].kind, "loading");
    await runtime.dispatch({ kind: "selectDocument", index: 0 });
    await waitUntil(runtime, () => runtime.state().documents[0]?.rendering?.status === "ready");
  } finally {
    navigation.resolve(response("https://example.test/next", "<p>cleanup</p>"));
    background.resolve(response("https://example.test/pending", "<p>cleanup</p>"));
    await runtime.dispose(); await prepared.controller.close();
  }
});


test("obsolete navigation failures cannot stop a replacement navigation", async () => {
  const failed = deferred();
  const { runtime, prepared } = await preparedFixture({ loader: (url) => url.endsWith("/failed") ? failed.promise : loader(url) });
  try {
    const first = updateBrowser(prepared.controller, runtime.state(), { kind: "omniboxSubmit", value: "https://example.test/failed" });
    const effect = first.effects.find((entry) => entry.id.startsWith("navigation:"));
    const pending = effect.run({ signal: new globalThis.AbortController().signal });
    const second = updateBrowser(prepared.controller, first.state, { kind: "omniboxSubmit", value: "https://example.test/next" });
    failed.reject(new Error("obsolete failure"));
    const completion = await pending;
    assert.equal(completion.message.kind, "navigationFailed");
    const ignored = updateBrowser(prepared.controller, second.state, completion.message);
    assert.equal(ignored.state.documents[0].loading, true);
    assert.equal(ignored.state.documents[0].pendingUrl, "https://example.test/next");
    assert.equal(ignored.state.documents[0].error, null);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});


test("control text changes and closing then reopening the same query reject pending logical search", async () => {
  const { runtime, prepared } = await preparedFixture();
  const pending = deferred();
  const update = (state, message) => updateBrowser(prepared.controller, state, message, { terminalSize: { columns: 100, rows: 29 } });
  try {
    const document = runtime.state().documents[0];
    const control = document.snapshot.document.controls.find((entry) => entry.name === "q");
    prepared.controller.searchDocument = () => pending.promise;
    const opened = update({ ...runtime.state(), findBar: { input: { text: "alpha", cursor: 5 } } }, { kind: "requestActiveViewport" });
    const searchEffect = opened.effects.find((entry) => entry.id.startsWith("search:"));
    const completion = searchEffect.run({ signal: new globalThis.AbortController().signal });
    const changed = update(opened.state, { kind: "formText", controlId: control.node,
      transition: { kind: "edit", operation: { kind: "insert", text: "replacement" } } });
    assert.ok(changed.state.documents[0].stateRevision > document.stateRevision);
    pending.resolve({ documentRevision: document.documentRevision, stateRevision: document.stateRevision,
      requestGeneration: opened.state.documents[0].rendering.searchRequestGeneration,
      layoutRevision: document.rendering.viewport.layoutRevision, query: "alpha", matches: [{ id: "old", sources: [] }], anchors: [["old", 0]], truncated: false });
    const delivered = await completion;
    assert.equal(update(changed.state, delivered.message).state.documents[0].search, null);
    const closed = update(opened.state, { kind: "closeFind" });
    const reopened = update({ ...closed.state, findBar: { input: { text: "alpha", cursor: 5 } } }, { kind: "requestActiveViewport" });
    assert.ok(reopened.state.documents[0].rendering.searchRequestGeneration > opened.state.documents[0].rendering.searchRequestGeneration);
    assert.equal(update(reopened.state, delivered.message).state.documents[0].search, null);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});


test("restoration completion preserves an omnibox edit made during loading", async () => {
  const navigation = deferred();
  const started = deferred();
  const { runtime, prepared } = await preparedFixture({ waitForRender: false, loader: () => {
    started.resolve(); return navigation.promise;
  } });
  try {
    await started.promise;
    await runtime.dispatch({ kind: "focusOmnibox" });
    await runtime.dispatch({ kind: "omniboxTransition", transition: { kind: "setValue", value: "unfinished replacement" } });
    navigation.resolve(response("https://example.test/", "<p>initial completion</p>"));
    await waitUntil(runtime, () => runtime.state().documents[0]?.rendering?.status === "ready");
    assert.equal(runtime.state().omnibox.editor.input.text, "unfinished replacement");
    assert.equal(runtime.state().omniboxDirty, true);
  } finally { navigation.resolve(response("https://example.test/", "<p>cleanup</p>")); await runtime.dispose(); await prepared.controller.close(); }
});

test("HTML editors share initialization, retain edits, and reset to document defaults", async () => {
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url, `<title>Editors</title>
    <form><input name="quantity" type="number" value="2" min="0" max="8" step="2">
    <textarea name="notes">initial</textarea>
    <select name="choice"><option value="same">First</option><option value="same" selected>Second</option><option disabled>Unavailable</option><option value="last">Last</option></select>
    <select name="many" multiple><option value="a" selected>A</option><option value="b">B</option></select>
    <button type="reset">Reset</button></form>`) });
  try {
    const initial = runtime.state().documents[0];
    const form = initial.snapshot.document.forms[0];
    const quantity = form.controls.find((control) => control.name === "quantity");
    const notes = form.controls.find((control) => control.name === "notes");
    const choice = form.controls.find((control) => control.name === "choice");
    const many = form.controls.find((control) => control.name === "many");
    const select = selectEditor(initial, choice);
    assert.equal(selectEditor(initial, choice).collection, select.collection);
    assert.equal(selectEditor(initial, choice).optionsView, select.optionsView);
    assert.equal(select.optionsView.entryAt(1).value.node, choice.options[1].node);
    await runtime.dispatch({ kind: "formNumber", controlId: quantity.node, transition: { kind: "step", direction: "increment" } });
    await runtime.dispatch({ kind: "formArea", controlId: notes.node, transition: { kind: "edit", operation: { kind: "insert", text: "X" } } });
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: choice.node, transition: { kind: "open" } });
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: choice.node, transition: { kind: "moveActive", delta: 1 } });
    assert.equal(runtime.state().documents[0].formEditors[choice.node].state.interaction.activeId, `${choice.node}:3`);
    const beforeDisabledCommit = runtime.state().documents[0].documentState.controls.get(choice.node);
    await runtime.dispatch({ kind: "formComboboxCommit", controlId: choice.node, event: { kind: "commit", id: `${choice.node}:2` } });
    assert.equal(runtime.state().documents[0].documentState.controls.get(choice.node), beforeDisabledCommit);
    await runtime.dispatch({ kind: "formComboboxCommit", controlId: choice.node, event: { kind: "commit", id: `${choice.node}:0` } });
    await runtime.dispatch({ kind: "formCheckboxGroup", controlId: many.node, transition: { kind: "toggleSelection", id: `${many.node}:1` } });
    const edited = runtime.state().documents[0];
    assert.equal(edited.formEditors[choice.node].collection, select.collection);
    assert.equal(edited.formEditors[choice.node].optionsView, select.optionsView);
    assert.equal(edited.documentState.controls.get(quantity.node).value, "4");
    assert.equal(edited.documentState.controls.get(notes.node).value.includes("X"), true);
    assert.deepEqual(edited.documentState.controls.get(choice.node).selected, [choice.options[0].node]);
    assert.deepEqual(controlValues(edited, many), ["a", "b"]);
    await runtime.resize({ columns: 80, rows: 24 });
    assert.equal(runtime.state().documents[0].formEditors[quantity.node].state.input.text, "4");
    assert.equal(runtime.state().documents[0].formEditors[choice.node].collection, select.collection);
    assert.equal(runtime.state().documents[0].formEditors[choice.node].optionsView, select.optionsView);
    await runtime.dispatch({ kind: "resetForm", formId: form.node });
    const reset = runtime.state().documents[0];
    assert.deepEqual(reset.formEditors, {});
    assert.equal(reset.documentState.controls.get(quantity.node).value, "2");
    assert.equal(reset.documentState.controls.get(notes.node).value, "initial");
    assert.deepEqual(reset.documentState.controls.get(choice.node).selected, [choice.options[1].node]);
    const resetSelect = selectEditor(reset, choice);
    assert.equal(resetSelect.collection, select.collection);
    assert.equal(resetSelect.optionsView, select.optionsView);
    assert.equal(resetSelect.state.interaction.selection.selectedId, `${choice.node}:1`);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("disabled HTML controls retain callbacks without becoming focusable", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 100, rows: 60 }, loader: async (url) => response(url, `<title>Disabled</title><main>
    <input disabled value="text"><input disabled type="number" value="2"><textarea disabled>notes</textarea>
    <select disabled><option>A</option></select><input disabled type="checkbox"><button disabled>Disabled button</button>
    <button type="button">Enabled button</button></main>`) });
  try {
    const document = runtime.state().documents[0];
    const disabled = document.snapshot.document.controls.filter((control) => control.disabled);
    const enabled = document.snapshot.document.controls.find((control) => !control.disabled);
    await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(enabled.node));
    for (let count = 0; count < 20; count += 1) {
      await runtime.handleInput(key("tab"));
      assert.ok(disabled.every((control) => !runtime.frame().focusPath?.includes(control.node)));
      if (runtime.frame().focusPath?.includes(enabled.node)) break;
    }
    assert.ok(runtime.frame().focusPath?.includes(enabled.node));
    await runtime.handleInput(key("enter"));
    assert.equal(runtime.state().status?.text, "This button has no native HTML action.");
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("page geometry is identical for live and one-shot rendering with find and library chrome", async () => {
  const { browserPageSize } = await import("../../dist/ui/document-layout.js");
  assert.deepEqual(browserPageSize({ sidePanel: "history", findBar: {} }, { columns: 110, rows: 30 }), { columns: 68, rows: 26 });
  assert.deepEqual(browserPageSize({ sidePanel: null, findBar: null }, { columns: 110, rows: 30 }), { columns: 109, rows: 27 });
  assert.deepEqual(browserPageSize({ sidePanel: null, findBar: null }, { columns: 1, rows: 1 }), { columns: 1, rows: 1 });
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 110, rows: 30 } });
  try {
    await runtime.dispatch({ kind: "toggleSidePanel", panel: "history" });
    await runtime.dispatch({ kind: "openFind" });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.status === "ready");
    assert.equal(runtime.state().documents[0].rendering.viewport.cellBuffer.columns, 68);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("picker preparation is replaced, cancelled on close, and fenced across reopen", async () => {
  const { runtime, prepared } = await preparedFixture();
  const originalEntries = prepared.controller.pickerEntries;
  prepared.controller.pickerEntries = () => Array.from({ length: 4096 }, (_, index) => ({
    id: String(index), label: `needle ${index}`, value: { kind: "link", index }, disabled: index === 0
  }));
  try {
    const initial = updateBrowser(prepared.controller, runtime.state(), { kind: "openPicker", picker: "links" });
    // Empty retained-source queries need no scan. A nonempty query exercises cooperative cancellation.
    const opened = updateBrowser(prepared.controller, initial.state, { kind: "pickerTransition", transition: { kind: "setQuery", query: { text: "needle", mode: "contains" } } });
    assert.equal(opened.state.pickerQuery.pending, true);
    const oldEffect = opened.effects.find(effect => effect.id === "browser-picker-query");
    const entered = deferred();
    const gate = deferred();
    const oldController = new globalThis.AbortController();
    const oldResult = oldEffect.run({ signal: oldController.signal, clock: {
      now: () => Date.now(), sleep: async () => { entered.resolve(); await gate.promise; }
    } });
    await entered.promise;
    const edited = updateBrowser(prepared.controller, opened.state, { kind: "pickerTransition", transition: { kind: "setQuery", query: { text: "needle 1", mode: "contains" } } });
    assert.equal(edited.state.pickerQuery.revision, opened.state.pickerQuery.revision + 1);
    assert.equal(edited.effects.find(effect => effect.id === "browser-picker-query").concurrency, "replace");
    const closed = updateBrowser(prepared.controller, edited.state, { kind: "dismiss" });
    assert.ok(closed.cancel.some((request) => request.kind === "effect" && request.id === "browser-picker-query"));
    assert.equal(closed.state.pickerQuery.result, null);
    const reopened = updateBrowser(prepared.controller, closed.state, { kind: "openPicker", picker: "links" });
    gate.resolve();
    const stale = await oldResult;
    const ignored = updateBrowser(prepared.controller, reopened.state, stale.message);
    assert.equal(ignored.state.pickerQuery, reopened.state.pickerQuery);
    const current = reopened.effects.find(effect => effect.id === "browser-picker-query");
    const completion = await current.run({ signal: new globalThis.AbortController().signal, clock: { now: () => Date.now(), sleep: async () => {} } });
    const ready = updateBrowser(prepared.controller, reopened.state, completion.message);
    assert.equal(ready.state.pickerQuery.pending, false);
    assert.equal(ready.state.pickerQuery.result.searchPickerIndex, ready.state.overlay.index);
    assert.equal(ready.state.pickerQuery.result.count, 4096);
    assert.equal(ready.state.pickerQuery.result.entryAt(0).disabled, true);
    assert.equal(ready.state.overlay.state.editor.activeId, "1");
  } finally {
    prepared.controller.pickerEntries = originalEntries;
    await runtime.dispose();
    await prepared.controller.close();
  }
});

test("native controls retain layout allocations, selected labels, and separated radio boxes", async () => {
  const html = `<title>Native geometry</title><style>select{width:160px}textarea{width:160px} .gap{height:48px}</style>
    <form><label for="choice">Language</label><select id="choice" name="choice"><option value="42">First</option><option value="42" selected>Visible label</option></select>
    <textarea name="notes" rows="3" cols="20">one\ntwo\nthree</textarea>
    <p><label><input type="radio" name="r" value="a" checked>Alpha</label></p>
    <div class="gap">Between radio controls</div>
    <p><label><input type="radio" name="r" value="b">Beta</label></p><input name="empty" size="8"></form>`;
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 80, rows: 35 }, loader: async (url) => response(url, html) });
  try {
    const document = runtime.state().documents[0];
    const controls = document.snapshot.document.controls;
    const choice = controls.find((control) => control.name === "choice");
    const notes = controls.find((control) => control.name === "notes");
    const radios = controls.filter((control) => control.kind === "radio");
    const empty = controls.find((control) => control.name === "empty");
    const geometries = document.rendering.viewport.controls;
    assert.equal(geometries.find((entry) => entry.node === notes.node).allocation.height, 3);
    assert.equal(geometries.find((entry) => entry.node === empty.node).allocation.width, 8);
    const first = geometries.find((entry) => entry.node === radios[0].node).allocation;
    const second = geometries.find((entry) => entry.node === radios[1].node).allocation;
    assert.ok(second.row > first.row + first.height + 1);
    const frame = renderFramePlain(runtime.frame());
    assert.equal(frame.split("Language").length - 1, 1);
    assert.ok(frame.includes("Visible label"), frame);
    assert.ok(frame.includes("one") && frame.includes("two") && frame.includes("three"), frame);
    assert.ok(frame.includes("Between radio controls"), frame);
    assert.match(frame, /◉|\(\*\)/u);
    assert.match(frame, /○|\( \)/u);
    assert.equal(frame.split("Alpha").length - 1, 1);
    assert.equal(frame.split("Beta").length - 1, 1);
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: choice.node, transition: { kind: "open" } });
    await runtime.dispatch({ kind: "formComboboxCommit", controlId: choice.node, event: { kind: "commit", id: `${choice.node}:0` } });
    await waitUntil(runtime, () => renderFramePlain(runtime.frame()).includes("First"));
    assert.deepEqual(controlValues(runtime.state().documents[0], choice), ["42"]);
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: choice.node, transition: { kind: "open" } });
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: choice.node, transition: { kind: "dismiss", reason: "escape" } });
    assert.deepEqual(runtime.state().documents[0].documentState.controls.get(choice.node).selected, [choice.options[0].node]);
    await runtime.dispatch({ kind: "formValues", controlId: radios[0].node, values: ["a"], focusTarget: radios[0].node });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(radios[0].node));
    await runtime.handleInput(key("arrowDown"));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(radios[1].node));
    assert.deepEqual(controlValues(runtime.state().documents[0], radios[1]), ["b"]);
    assert.deepEqual(controlValues(runtime.state().documents[0], radios[0]), []);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("partly clipped textarea keeps full editor geometry and caret through resize", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 80, rows: 24 }, loader: async (url) => response(url,
    `<title>Clipped editor</title><style>body{margin:0}.clip{height:32px;overflow:hidden}textarea{width:160px;height:64px}</style><div class="clip"><textarea name="notes">first\nsecond\nthird</textarea></div>`) });
  try {
    const initial = runtime.state().documents[0];
    const area = initial.snapshot.document.controls[0];
    const geometry = initial.rendering.viewport.controls.find((entry) => entry.node === area.node);
    assert.equal(geometry.allocation.height, 4);
    assert.equal(geometry.visible.height, 2);
    await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(area.node));
    await runtime.handleInput(key("end"));
    await runtime.handleInput({ kind: "text", text: "X", paste: false });
    const edited = runtime.state().documents[0].formEditors[area.node].state;
    const accepted = runtime.state().documents[0].documentState.controls.get(area.node).value;
    assert.ok(accepted.includes("X"));
    await runtime.resize({ columns: 48, rows: 24 });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.status === "ready");
    assert.equal(runtime.state().documents[0].formEditors[area.node].state, edited);
    assert.ok(runtime.frame().focusPath?.includes(area.node));
    await runtime.handleInput({ kind: "text", text: "Y", paste: false });
    assert.ok(runtime.state().documents[0].documentState.controls.get(area.node).value.includes("XY"));
    const resized = runtime.state().documents[0].rendering.viewport.controls.find((entry) => entry.node === area.node);
    assert.equal(resized.allocation.height, 4);
    assert.equal(resized.visible.height, 2);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("one-shot native forms display labels and multiline values at terminal widths", async () => {
  for (const columns of [80, 120, 160]) {
    const directory = await mkdtemp(join(tmpdir(), "verge-once-forms-"));
    const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
    const output = await renderBrowserOnce("https://example.test/", {
      store,
      services: { async close() {} },
      createAcquisition: () => new PageAcquisition({
        loader: async (url) => response(url, `<title>Form</title><style>select{width:160px}textarea{display:block}</style><label for="s">Language</label><select id="s"><option value="42">Visible option</option></select><textarea rows="3">first\nsecond\nthird</textarea>`),
        defaultParseMode: "text"
      })
    }, { columns, rows: 24 });
    assert.equal(output.split("Language").length - 1, 1);
    assert.ok(output.includes("Visible option"), output);
    assert.ok(output.includes("first") && output.includes("second") && output.includes("third"), output);
  }
});

test("pointer wheel targets a nested scroll owner without scrolling the page", async () => {
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url,
    `<title>Nested scroll</title><style>body{margin:0}.port{height:48px;width:240px;overflow:auto}p{margin:0;height:16px}</style><div id="port" class="port">${Array.from({length:12},(_,i)=>`<p>Nested line ${i}</p>`).join("")}</div><p>Outside</p>`) });
  try {
    const initial = runtime.state().documents[0];
    const port = initial.rendering.viewport.scrollPorts.find((entry) => entry.node === initial.snapshot.document.elementById("port"));
    assert.ok(port);
    await runtime.handleInput({ kind: "mouse", sequence: "", encoding: "sgr", action: "wheel", button: "wheelDown",
      row: 3 + port.rect.row, column: 2 + port.rect.column, rawCode: 65,
      modifiers: {shift:false,alt:false,ctrl:false}, deltaRows:1, deltaColumns:0 });
    await waitUntil(runtime, () => runtime.state().documents[0].scrollOffsets.some((entry) => entry.node === port.node && entry.block > 0));
    assert.equal(documentScrollRow(runtime.state().documents[0]), 0);
    assert.equal(runtime.state().documents[0].scrollOffsets.find((entry) => entry.node === port.node).block, 3 * initial.rendering.viewport.cellBlock);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("radio keyboard navigation reveals a separated offscreen peer", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: {columns:80,rows:20}, loader: async (url) => response(url,
    `<title>Radio reveal</title><input type="radio" name="r" value="a" checked><div style="height:640px">Gap</div><input type="radio" name="r" value="b">`) });
  try {
    const controls = runtime.state().documents[0].snapshot.document.controls;
    await runtime.dispatch({ kind: "formValues", controlId: controls[0].node, values:["a"], focusTarget: controls[0].node });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(controls[0].node));
    await runtime.handleInput(key("arrowDown"));
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(controls[1].node));
    assert.ok(documentScrollRow(runtime.state().documents[0]) > 0);
    assert.deepEqual(controlValues(runtime.state().documents[0], controls[1]), ["b"]);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("duplicate URL entries restore independent live forms and scroll without refetching history", async () => {
  let loads = 0;
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
    loads += 1; return response(url, pages.get("https://example.test/"));
  } });
  const ready = () => runtime.state().documents[0].rendering.status === "ready";
  try {
    let current = runtime.state().documents[0];
    const control = current.snapshot.document.controls.find((entry) => entry.name === "q");
    await runtime.dispatch({ kind: "formText", controlId: control.node, transition: { kind: "edit", operation: { kind: "insert", text: "FIRST" } } });
    await waitUntil(runtime, ready);
    await runtime.dispatch({ kind: "scrollTo", row: 20 }); await waitUntil(runtime, ready);
    const first = runtime.state().documents[0];
    const firstScroll = documentScrollRow(first);
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/next" });
    await waitUntil(runtime, () => ready() && runtime.state().documents[0].snapshot.finalUrl.endsWith("/next"));
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/" });
    await waitUntil(runtime, () => ready() && runtime.state().documents[0].snapshot.finalUrl === "https://example.test/");
    current = runtime.state().documents[0];
    const secondControl = current.snapshot.document.controls.find((entry) => entry.name === "q");
    await runtime.dispatch({ kind: "formText", controlId: secondControl.node, transition: { kind: "edit", operation: { kind: "insert", text: "SECOND" } } });
    await waitUntil(runtime, ready);
    await runtime.dispatch({ kind: "navigate", operation: "back" }); await waitUntil(runtime, ready);
    await runtime.dispatch({ kind: "navigate", operation: "back" }); await waitUntil(runtime, ready);
    current = runtime.state().documents[0];
    assert.equal(current.snapshot.document, first.snapshot.document);
    assert.equal(current.documentState.controls.get(control.node).value, "alphaFIRST");
    assert.equal(current.formEditors[control.node].state.cursor, "alphaFIRST".length);
    assert.equal(documentScrollRow(current), firstScroll);
    await runtime.dispatch({ kind: "navigate", operation: "forward" }); await waitUntil(runtime, ready);
    await runtime.dispatch({ kind: "navigate", operation: "forward" }); await waitUntil(runtime, ready);
    current = runtime.state().documents[0];
    assert.equal(current.documentState.controls.get(secondControl.node).value, "alphaSECOND");
    assert.equal(loads, 3);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("fragment navigation uses accepted target geometry and shares latest live form edits", async () => {
  let loads = 0;
  const source = `<style>:target { color: inherit }</style><input name="edit" value="live"><a href="#target">Jump</a>${"<p>Paragraph</p>".repeat(35)}<h2 id="target">Target</h2>${"<p>After</p>".repeat(30)}`;
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => { loads += 1; return response(url, source); } });
  const ready = () => runtime.state().documents[0].rendering.status === "ready";
  try {
    const first = runtime.state().documents[0];
    const coldMetrics = await prepared.controller.renderingMetrics();
    const control = first.snapshot.document.controls[0];
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/#target" });
    await waitUntil(runtime, () => ready() && runtime.state().documents[0].rendering.pendingReveal === null);
    let current = runtime.state().documents[0];
    assert.equal(current.snapshot.document, first.snapshot.document);
    assert.equal(current.documentState.urlTarget, first.snapshot.document.elementById("target"));
    assert.ok(documentScrollRow(current) > 20);
    await runtime.dispatch({ kind: "formText", controlId: control.node, transition: { kind: "edit", operation: { kind: "insert", text: "LATEST" } } });
    await waitUntil(runtime, ready);
    await runtime.dispatch({ kind: "navigate", operation: "back" }); await waitUntil(runtime, ready);
    current = runtime.state().documents[0];
    assert.equal(current.snapshot.finalUrl, "https://example.test/");
    assert.equal(current.documentState.controls.get(control.node).value, "liveLATEST");
    assert.equal(current.documentState.urlTarget, null); assert.equal(documentScrollRow(current), 0);
    await runtime.dispatch({ kind: "navigate", operation: "forward" }); await waitUntil(runtime, ready);
    current = runtime.state().documents[0];
    assert.equal(current.snapshot.document, first.snapshot.document);
    assert.ok(current.documentRevision > first.documentRevision);
    assert.ok(documentScrollRow(current) > 20);
    assert.equal(current.rendering.previousViewport, null);
    const warmMetrics = await prepared.controller.renderingMetrics();
    for (const stage of ["attachment-serialization", "document-hydration", "stylesheet-hydration", "stylesheet-syntax-parsing", "stylesheet-program-compilation"]) {
      const count = (metrics) => metrics.stages.find((entry) => entry.stage === stage)?.invocations ?? 0;
      assert.equal(count(warmMetrics), count(coldMetrics), `${stage} must not repeat for warm fragment/Back/Forward`);
    }
    assert.equal(warmMetrics.attachedDocuments, 1);
    assert.equal(loads, 1);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("native select popup overlays a later textarea inside document and control viewports", async () => {
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url,
    `<title>Popup layer</title><style>select,textarea{display:block;width:160px}</style><select name="language"><option value="en">English</option><option value="fr">French</option></select><textarea rows="3">draft</textarea>`) });
  try {
    const select = runtime.state().documents[0].snapshot.document.controls[0];
    await runtime.dispatch({ kind: "formComboboxTransition", controlId: select.node, transition:{kind:"open"} });
    const frame = renderFramePlain(runtime.frame());
    assert.ok(frame.includes("English") && frame.includes("French"), frame);
    assert.equal(frame.includes("draft"), false, frame);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("Stop keeps the accepted entry and edits made during acquisition after a late response", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { runtime, prepared } = await preparedFixture({ loader: async (url, options) => {
    calls.push({ url, method: options?.method ?? "GET" });
    if (url.endsWith("/slow")) await delayed;
    return response(url, pages.get("https://example.test/"));
  } });
  try {
    const initial = runtime.state().documents[0];
    const control = initial.snapshot.document.controls.find((entry) => entry.name === "q");
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/slow" });
    await waitUntil(runtime, () => calls.some((call) => call.url.endsWith("/slow")));
    await runtime.dispatch({ kind: "formText", controlId: control.node, transition: { kind: "edit", operation: { kind: "insert", text: "KEPT" } } });
    await runtime.dispatch({ kind: "navigate", operation: "stop" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    let current = runtime.state().documents[0];
    assert.equal(current.snapshot, initial.snapshot); assert.equal(current.navigation.entries.length, 1);
    assert.equal(current.loading, false); assert.equal(current.documentState.controls.get(control.node).value, "alphaKEPT");
    await runtime.dispatch({ kind: "navigate", operation: "reload" });
    await waitUntil(runtime, () => runtime.state().documents[0].snapshot !== initial.snapshot && !runtime.state().documents[0].loading);
    current = runtime.state().documents[0];
    assert.equal(current.snapshot.finalUrl, initial.snapshot.finalUrl); assert.equal(current.navigation.entries.length, 1);
    assert.equal(calls.at(-1).method, "GET");
  } finally { release(); await runtime.dispose(); await prepared.controller.close(); }
});

test("partly clipped select popup escapes crop and preserves pointer, keyboard, and dismissal behavior", async () => {
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url,
    `<title>Partial select</title><style>body{margin:0}.clip{width:80px;overflow:hidden}select{display:block;width:160px}</style><div class="clip"><select aria-label="Language" name="language"><option value="en">English</option><option value="fr">French</option></select></div>`) });
  try {
    const initial = runtime.state().documents[0];
    const select = initial.snapshot.document.controls[0];
    const geometry = initial.rendering.viewport.controls.find((entry) => entry.node === select.node);
    assert.equal(geometry.allocation.width, 20);
    assert.equal(geometry.visible.width, 10);
    assert.equal(select.label, "Language");
    await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(select.node));
    await runtime.handleInput(key("enter"));
    assert.equal(runtime.state().documents[0].formEditors[select.node].state.open, true);
    assert.ok(renderFramePlain(runtime.frame()).includes("French"));
    assert.ok(JSON.stringify(runtime.frame().accessibility).includes("Language"));
    const french = runtime.frame().hitTargets.find((target) => target.id === `${select.node}:popup:list:option:${select.node}:1`);
    const trigger = runtime.frame().hitTargets.find((target) => target.id === `${select.node}:trigger`);
    assert.ok(french.bounds.row >= trigger.bounds.row + trigger.bounds.height);
    const click = async (row, column) => {
      for (const action of ["press", "release"]) await runtime.handleInput({ kind: "mouse", sequence: "", encoding: "sgr", action, button: "left",
        row, column, rawCode: 0, modifiers: {shift:false,alt:false,ctrl:false} });
    };
    await click(french.bounds.row, french.bounds.column);
    assert.equal(runtime.state().documents[0].formEditors[select.node].state.interaction.activeId, `${select.node}:1`);
    await click(french.bounds.row, french.bounds.column);
    assert.deepEqual(controlValues(runtime.state().documents[0], select), ["fr"]);
    assert.equal(runtime.state().documents[0].formEditors[select.node].state.open, false);
    await runtime.handleInput(key("enter"));
    await click(20, 50);
    assert.equal(runtime.state().documents[0].formEditors[select.node].state.open, false);
    await runtime.handleInput(key("enter"));
    await runtime.handleInput(key("arrowUp"));
    await runtime.handleInput(key("enter"));
    assert.deepEqual(controlValues(runtime.state().documents[0], select), ["en"]);
    await runtime.handleInput(key("enter"));
    await runtime.handleInput(key("arrowDown"));
    await runtime.handleInput(key("enter"));
    assert.deepEqual(controlValues(runtime.state().documents[0], select), ["fr"]);
    assert.ok(renderFramePlain(runtime.frame()).includes("French"));
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("root horizontal window projects native controls, links, and pointer targets once", async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns:80,rows:24 }, loader: async (url) => response(url,
    `<title>Root pan</title><style>body{margin:0;width:2000px}input{position:absolute;left:800px;top:0;width:80px}a{position:absolute;left:880px;top:32px;width:160px}</style><input name="edit" value="alpha"><a href="/next">Target link</a>`) });
  try {
    await runtime.dispatch({kind:"scroll",rows:0,columns:100});
    await waitUntil(runtime,()=>runtime.state().documents[0].rendering.viewport.cellBuffer.windowStartColumn===100);
    const document = runtime.state().documents[0];
    const control = document.snapshot.document.controls[0];
    const geometry = document.rendering.viewport.controls.find((entry)=>entry.node===control.node);
    assert.equal(geometry.allocation.column,100);
    const frame=runtime.frame();
    assert.ok(renderFramePlain(frame).includes("alpha"));
    assert.ok(renderFramePlain(frame).includes("Target link"));
    const editor=frame.hitTargets.find((target)=>target.id===`${control.node}:text`);
    assert.equal(editor.bounds.column,1);
    const link=frame.hitTargets.find((target)=>target.id.startsWith("activate:link:"));
    assert.equal(link.bounds.column,11);
    for(const action of ["press","release"]) await runtime.handleInput({kind:"mouse",sequence:"",encoding:"sgr",action,button:"left",row:editor.bounds.row,column:editor.bounds.column,rawCode:0,modifiers:{shift:false,alt:false,ctrl:false}});
    await runtime.handleInput({kind:"text",text:"Z",paste:false});
    assert.ok(runtime.state().documents[0].documentState.controls.get(control.node).value.includes("Z"));
    await runtime.handleInput({kind:"mouse",sequence:"",encoding:"sgr",action:"wheel",button:"wheelRight",row:10,column:50,rawCode:67,modifiers:{shift:false,alt:false,ctrl:false},deltaRows:0,deltaColumns:1});
    await waitUntil(runtime,()=>runtime.state().documents[0].rendering.viewport.cellBuffer.windowStartColumn===103);
    await runtime.dispatch({kind:"movePageFocus",direction:"next",currentActionId:`control:${control.node}`});
    await waitUntil(runtime,()=>runtime.frame().focusPath?.at(-1)?.startsWith("link:"));
    await runtime.handleInput(key("arrowLeft"));
    await waitUntil(runtime,()=>runtime.state().documents[0].rendering.viewport.cellBuffer.windowStartColumn===102);
    assert.ok(runtime.state().documents[0].documentState.controls.get(control.node).value.includes("Z"));
  } finally {await runtime.dispose();await prepared.controller.close();}
});

test("negative RTL root window projects native editor source columns without clamping", async () => {
  const {runtime,prepared}=await preparedFixture({terminalSize:{columns:80,rows:24},loader:async url=>response(url,
    `<html dir="rtl"><title>RTL pan</title><style>body{margin:0}input{position:absolute;left:-640px;top:0;width:80px}</style><input name="edit" value="alpha"></html>`)});
  try {
    const origin=runtime.state().documents[0].rendering.viewport.minScrollColumn;
    assert.equal(origin,-80);
    await runtime.dispatch({kind:"scroll",rows:0,columns:origin});
    await waitUntil(runtime,()=>runtime.state().documents[0].rendering.viewport.cellBuffer.windowStartColumn===origin);
    const document=runtime.state().documents[0];
    const control=document.snapshot.document.controls[0];
    assert.equal(document.rendering.viewport.controls.find(entry=>entry.node===control.node).allocation.column,origin);
    assert.equal(runtime.frame().hitTargets.find(target=>target.id===`${control.node}:text`).bounds.column,1);
    assert.ok(renderFramePlain(runtime.frame()).includes("alpha"));
  } finally {await runtime.dispose();await prepared.controller.close();}
});

test("native editor focus and caret survive becoming fully visible after resize", async () => {
  const {runtime,prepared}=await preparedFixture({terminalSize:{columns:48,rows:24},loader:async url=>response(url,
    `<title>Editor resize</title><style>body{margin:0}input{width:640px}</style><input name="edit" value="alpha">`)});
  try {
    const control=runtime.state().documents[0].snapshot.document.controls[0];
    await runtime.dispatch({kind:"movePageFocus",direction:"next",currentActionId:""});
    await waitUntil(runtime,()=>runtime.frame().focusPath?.includes(control.node));
    await runtime.handleInput({kind:"text",text:"X",paste:false});
    const editor=runtime.state().documents[0].formEditors[control.node];
    const before=runtime.state().documents[0].rendering.viewport.controls.find(entry=>entry.node===control.node);
    assert.ok(before.visible.width<before.allocation.width);
    await runtime.resize({columns:100,rows:24});
    await waitUntil(runtime,()=>runtime.state().documents[0].rendering.status==="ready");
    const after=runtime.state().documents[0].rendering.viewport.controls.find(entry=>entry.node===control.node);
    assert.equal(after.visible.width,after.allocation.width);
    assert.equal(runtime.state().documents[0].formEditors[control.node],editor);
    assert.ok(runtime.frame().focusPath?.includes(control.node));
    await runtime.handleInput({kind:"text",text:"Y",paste:false});
    assert.equal(runtime.state().documents[0].documentState.controls.get(control.node).value,"alphaXY");
  } finally {await runtime.dispose();await prepared.controller.close();}
});

test("same-source preparation displays the unchanged accepted viewport until its new activation commits", async () => {
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url,
    `<p>Previous display stays visible</p>${"<p>Between</p>".repeat(25)}<h2 id="target">New target</h2>`) });
  const renderViewport = prepared.controller.renderViewport.bind(prepared.controller);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  prepared.controller.renderViewport = async (...args) => { await gate; return renderViewport(...args); };
  try {
    const accepted = runtime.state().documents[0].rendering.viewport;
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/#target" });
    const pending = runtime.state().documents[0];
    assert.ok(pending.documentRevision > accepted.documentRevision);
    assert.equal(pending.rendering.viewport, null);
    assert.equal(pending.rendering.previousViewport, accepted);
    assert.ok(renderFramePlain(runtime.frame()).includes("Previous display stays visible"));
    assert.ok(renderFramePlain(runtime.frame()).includes(`1/${accepted.cellBuffer.documentRowCount}`),
      "pending position describes the displayed viewport rather than inventing a one-row document");
    assert.equal(renderFramePlain(runtime.frame()).includes("Rendering page…"), false);
    await runtime.dispatch({ kind: "viewportReady", payload: accepted });
    assert.equal(runtime.state().documents[0].rendering.previousViewport, accepted);
    assert.equal(runtime.state().documents[0].rendering.viewport, null, "previous activation cannot satisfy the new request");
    release();
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.status === "ready");
    const current = runtime.state().documents[0];
    assert.equal(current.rendering.previousViewport, null);
    assert.equal(current.rendering.viewport.documentRevision, current.documentRevision);
    assert.ok(documentScrollRow(current) > 10);
  } finally { release(); prepared.controller.renderViewport = renderViewport; await runtime.dispose(); await prepared.controller.close(); }
});

test("indented citation fragment, Back, Forward, and search retain the unpanned root viewport", async () => {
  const source = `<style>html,body,p,ol{margin:0}ol{padding-left:64px}li{height:32px}:target{background:#e8eeff}</style><p>layout</p><div style="width:1600px;height:16px">WIDE</div><div style="height:640px">TOP</div><ol><li id=citation>Retrieved reference</li></ol><div style="height:1600px">END</div>`;
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => response(url, source) });
  const current = () => runtime.state().documents[0];
  const ready = () => current().rendering.status === "ready" && !current().loading && current().rendering.pendingReveal === null;
  const assertUnpanned = () => {
    assert.equal(current().scrollColumn, 0);
    assert.equal(current().rendering.viewport.scrollColumn, 0);
    assert.equal(current().rendering.viewport.cellBuffer.windowStartColumn, 0);
  };
  try {
    assertUnpanned();
    await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/#citation" });
    await waitUntil(runtime, ready);
    const citationRow = documentScrollRow(current());
    assert.ok(citationRow > 30);
    assertUnpanned();
    assert.match(renderFramePlain(runtime.frame()), /Retrieved reference/);
    await runtime.dispatch({ kind: "navigate", operation: "back" });
    await waitUntil(runtime, ready);
    assert.equal(documentScrollRow(current()), 0);
    assertUnpanned();
    await runtime.dispatch({ kind: "navigate", operation: "forward" });
    await waitUntil(runtime, ready);
    assert.equal(documentScrollRow(current()), citationRow);
    assertUnpanned();
    await runtime.dispatch({ kind: "openFind" });
    await runtime.dispatch({ kind: "findAction", transition: { kind: "edit", operation: { kind: "insert", text: "layout" } } });
    await waitUntil(runtime, () => ready() && current().search?.query === "layout"
      && current().rendering.viewport.search?.matches.length === 1);
    assert.equal(documentScrollRow(current()), 0);
    assertUnpanned();
    assert.match(renderFramePlain(runtime.frame()), /layout/);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

for (const [type, readOnly, hasButton] of [
  ["text", false, true], ["search", false, false], ["password", false, true],
  ["number", false, true], ["text", true, true], ["number", true, false]
]) {
  test(`Enter submits current ${readOnly ? "readonly " : ""}${type} through the shared form path`, async () => {
    const requests = [];
    const html = `<form action=/implicit><input id=q type=${type} name=q value=${type === "number" ? "1" : "alpha"} ${readOnly ? "readonly" : ""}>
      ${hasButton ? '<button name=intent value=enter formaction=/override>Search</button>' : ""}</form>`;
    const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
      if (url === "https://example.test/") return response(url, html);
      requests.push(url);
      return response(url, "<title>Implicit result</title><p>Submitted</p>");
    } });
    try {
      const control = runtime.state().documents[0].snapshot.document.control(
        runtime.state().documents[0].snapshot.document.elementById("q"));
      await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
      await waitUntil(runtime, () => runtime.frame().focusPath?.includes(control.node));
      if (!readOnly) {
        await runtime.handleInput(key("end"));
        await runtime.handleInput({ kind: "text", text: type === "number" ? "2" : "Z", paste: false });
      }
      await runtime.handleInput(key("enter"));
      await waitUntil(runtime, () => runtime.state().documents[0].snapshot.document.title === "Implicit result");
      const value = type === "number" ? (readOnly ? "1" : "12") : (readOnly ? "alpha" : "alphaZ");
      assert.deepEqual(requests, [`https://example.test/${hasButton ? "override" : "implicit"}?q=${value}${hasButton ? "&intent=enter" : ""}`]);
    } finally { await runtime.dispose(); await prepared.controller.close(); }
  });
}

test("implicit submission uses the same required validation and submitter exemption", async () => {
  for (const exemption of ["", "novalidate", "formnovalidate"]) {
    const requests = [];
    const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
      if (url === "https://example.test/") return response(url,
        `<form action=/implicit ${exemption === "novalidate" ? exemption : ""}><input id=q name=q required>
          <button ${exemption === "formnovalidate" ? exemption : ""}>Search</button></form>`);
      requests.push(url);
      return response(url, "<title>Implicit result</title>");
    } });
    try {
      const control = runtime.state().documents[0].snapshot.document.controls[0];
      await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
      await waitUntil(runtime, () => runtime.frame().focusPath?.includes(control.node));
      await runtime.handleInput(key("enter"));
      if (exemption === "") {
        assert.match(runtime.state().status.text, /required/u);
        assert.deepEqual(requests, []);
      } else {
        await waitUntil(runtime, () => runtime.state().documents[0].snapshot.document.title === "Implicit result");
        assert.deepEqual(requests, ["https://example.test/implicit?q="]);
      }
    } finally { await runtime.dispose(); await prepared.controller.close(); }
  }
});

test("implicit Enter does not skip disabled defaults or multiple blocking fields", async () => {
  for (const tail of ["<button disabled>First</button><button>Second</button>", "<input disabled>", "<input readonly>", "<input type=date>"]) {
    const requests = [];
    const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
      requests.push(url);
      return response(url, `<form action=/implicit><input id=q name=q value=alpha>${tail}</form>`);
    } });
    try {
      const document = runtime.state().documents[0];
      const control = document.snapshot.document.control(document.snapshot.document.elementById("q"));
      await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
      await waitUntil(runtime, () => runtime.frame().focusPath?.includes(control.node));
      await runtime.handleInput(key("enter"));
      assert.deepEqual(requests, ["https://example.test/"]);
      assert.equal(runtime.state().documents[0].loading, false);
      assert.notEqual(runtime.state().status?.tone, "error");
    } finally { await runtime.dispose(); await prepared.controller.close(); }
  }
});

test("implicit Enter reports an unsupported default image submitter without choosing a later button", async () => {
  const requests = [];
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
    requests.push(url);
    return response(url, '<form><input id=q name=q><input type=image><button>Later</button></form>');
  } });
  try {
    const control = runtime.state().documents[0].snapshot.document.controls[0];
    await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(control.node));
    await runtime.handleInput(key("enter"));
    assert.match(runtime.state().status.text, /default image submitter/u);
    assert.deepEqual(requests, ["https://example.test/"]);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test("Arabic document and native form use one visual-cell contract while edits and submission stay logical", async () => {
  const requests = [];
  const { runtime, prepared } = await preparedFixture({ loader: async (url) => {
    if (url === "https://example.test/") return response(url,
      '<style>body{margin:0;background:white;color:black}</style><p dir=rtl>مرحبا</p><form action=/arabic><input id=q name=q value="مرحبا 123"><button>Send</button></form>');
    requests.push(url);
    return response(url, '<title>Arabic result</title>');
  } });
  try {
    const initial = runtime.state().documents[0];
    const control = initial.snapshot.document.control(initial.snapshot.document.elementById("q"));
    assert.ok(renderFramePlain(runtime.frame()).includes("123 ابحرم"));
    assert.equal(initial.documentState.controls.get(control.node).value, "مرحبا 123");
    const target = runtime.frame().hitTargets.find((entry) => entry.id === `${control.node}:text`);
    assert.ok(target);
    const digit = runtime.frame().cells.find((cell) => cell.row === target.bounds.row
      && cell.column >= target.bounds.column && cell.column < target.bounds.column + target.bounds.width && cell.text === "1");
    assert.ok(digit);
    for (const action of ["press", "release"]) await runtime.handleInput({ kind: "mouse", sequence: "", encoding: "sgr",
      action, button: "left", row: digit.row, column: digit.column, rawCode: 0, modifiers: { shift: false, alt: false, ctrl: false } });
    await runtime.handleInput({ kind: "text", text: "X", paste: false });
    assert.equal(runtime.state().documents[0].documentState.controls.get(control.node).value, "مرحبا X123");
    await runtime.resize({ columns: 70, rows: 28 });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.status === "ready");
    assert.equal(runtime.state().documents[0].documentState.controls.get(control.node).value, "مرحبا X123");
    await runtime.handleInput(key("enter"));
    await waitUntil(runtime, () => runtime.state().documents[0].snapshot.document.title === "Arabic result");
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).searchParams.get("q"), "مرحبا X123");
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test('wide viewport respects author centering, responsive media and actual panel width', async () => {
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 240, rows: 24 }, loader: async (url) => response(url,
    '<style>body{margin:0}main{width:160px;margin-inline:auto}#responsive{display:none}'
    + '@media(min-width:1700px){#responsive{display:block}}</style><main>CENTERED_BY_AUTHOR</main><p id=responsive>WIDE_MEDIA</p>') });
  try {
    const current = () => runtime.state().documents[0];
    assert.equal(current().rendering.viewport.cellBuffer.columns, 239);
    assert.match(renderFramePlain(runtime.frame()), /WIDE_MEDIA/u);
    const position = () => renderFramePlain(runtime.frame()).split('\n').find((line) => line.includes('CENTERED_BY_AUTHOR')).indexOf('CENTERED_BY_AUTHOR');
    assert.equal(position(), Math.floor((239 - 20) / 2));
    await runtime.dispatch({ kind: 'toggleSidePanel', panel: 'history' });
    await waitUntil(runtime, () => current().rendering.status === 'ready');
    assert.equal(current().rendering.viewport.cellBuffer.columns, 198);
    assert.doesNotMatch(renderFramePlain(runtime.frame()), /WIDE_MEDIA/u);
    assert.equal(position(), (198 - 20) / 2);
    await runtime.resize({ columns: 180, rows: 24 });
    await waitUntil(runtime, () => current().rendering.status === 'ready');
    assert.equal(current().rendering.viewport.cellBuffer.columns, 138);
    assert.equal(position(), (138 - 20) / 2);
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});

test('wide tab switches retain only the selected image fallback and its hit location', async () => {
  const names = ['ALPHA', 'BETA', 'GAMMA'];
  const { runtime, prepared } = await preparedFixture({ terminalSize: { columns: 240, rows: 24 },
    imageLoader: async () => { throw new Error('Fixture image download unavailable'); },
    loader: async (url) => {
      const index = url.endsWith('/beta') ? 1 : url.endsWith('/gamma') ? 2 : 0;
      return response(url, `<title>${names[index]}</title><style>body{margin:0}p{margin:0}img{position:absolute;left:${index === 0 ? 640 : 32}px;top:32px;width:160px;height:64px}</style>`
        + (index === 2 ? '' : `<a href=/target><img src=/${index}.png alt=${names[index]}_IMG></a>`)
        + `<p>${names[index]} body</p>`);
    } });
  const current = () => runtime.state().documents[runtime.state().activeDocumentIndex];
  const ready = () => current().kind === 'ready' && current().rendering.status === 'ready' && !current().loading
    && current().rendering.viewport?.stateRevision === current().stateRevision
    && (current().snapshot.images ?? []).every((image) => image.status === 'failed');
  const assertSelected = (index) => {
    const frame = runtime.frame();
    const body = renderFramePlain(frame).split('\n').slice(2, -1).join('\n');
    assert.ok(body.includes(`${names[index]} body`));
    for (const [other, name] of names.entries()) {
      assert.equal(body.includes(`${name}_IMG`), other === index && index !== 2);
      if (other !== index) assert.equal(body.includes(`${name} body`), false);
    }
    const targets = frame.hitTargets.filter((entry) => entry.id === 'image');
    assert.equal(targets.length, index === 2 ? 0 : 1);
    if (index !== 2) {
      const target = targets[0];
      assert.equal(target.bounds.column, index === 0 ? 81 : 5);
      const lines = renderFramePlain(frame).split('\n');
      assert.equal(lines[target.bounds.row - 1].indexOf(`${names[index]}_IMG`) + 1, target.bounds.column);
      assert.equal(body.split(`${names[index]}_IMG`).length - 1, 1);
    }
  };
  try {
    await waitUntil(runtime, ready);
    assertSelected(0);
    for (const target of ['https://example.test/beta', 'https://example.test/gamma']) {
      await runtime.dispatch({ kind: 'newDocument', target });
      await waitUntil(runtime, ready);
      assertSelected(runtime.state().activeDocumentIndex);
    }
    for (const index of [0, 1, 2, 0, 2, 1, 0]) {
      await runtime.dispatch({ kind: 'selectDocument', index });
      assertSelected(index);
      await waitUntil(runtime, ready);
      assertSelected(index);
    }
  } finally { await runtime.dispose(); await prepared.controller.close(); }
});
