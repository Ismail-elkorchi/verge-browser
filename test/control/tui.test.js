import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as defer } from "node:timers/promises";

import { validateAccessibleSnapshot } from "@ismail-elkorchi/terminal-ui/accessibility";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTerminalHarness } from "@ismail-elkorchi/terminal-ui/testing";
import { createTuiRuntime, runTui } from "@ismail-elkorchi/terminal-ui/tui";

import { BrowserSession } from "../../dist/app/session.js";
import { NetworkFetchError } from "../../dist/app/fetch-page.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";

function createLoader(htmlMap) {
  return async (requestUrl, requestOptions = {}) => {
    const currentUrl = new globalThis.URL(requestUrl);
    const lookupUrl = currentUrl.search ? requestUrl : currentUrl.toString();
    const html = htmlMap.get(lookupUrl);
    if (!html) throw new Error(`Missing fixture for ${lookupUrl}`);
    return {
      requestUrl,
      finalUrl: lookupUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html,
      responseHeaders: { "content-type": "text/html" },
      setCookieHeaders: requestOptions.method === "POST" ? ["sid=next; Path=/; HttpOnly"] : [],
      networkOutcome: {
        kind: "ok",
        finalUrl: lookupUrl,
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      },
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };
}

async function fixture(options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "verge-browser-tui-test-"));
  const store = await BrowserStore.open({ statePath: join(stateDirectory, "state.json") });
  if (options.workspace) await store.saveWorkspace(options.workspace);
  const htmlMap = new Map([
    [
      "https://example.test/",
      `<html><head><title>Index</title></head><body><h1>Index</h1><p><a href="/next">Next page</a></p>${Array.from(
        { length: 40 },
        (_, index) => `<p>Paragraph ${String(index + 1)} alpha</p>`
      ).join("")}<form action="/search" method="get"><label for="query">Query</label><input id="query" name="q" value="alpha" required><label for="secret">Secret</label><input id="secret" type="password" name="secret" value="hidden"><label for="language">Language</label><select id="language" name="lang" required><option value="en" selected>English</option><option value="fr">French</option></select><label for="count">Count</label><input id="count" type="number" name="count" value="2" min="1" max="9" step="1"><textarea name="notes">hello</textarea><button type="submit" name="intent" value="search">Search</button></form></body></html>`
    ],
    [
      "https://example.test/next",
      "<html><head><title>Next</title></head><body><h1>Next</h1><p>Second page</p><a href=\"/\">Back home</a></body></html>"
    ],
    [
      "https://example.test/search?q=alphaZ&secret=hidden&lang=fr&count=3&notes=hello&intent=search",
      "<html><head><title>Results</title></head><body><h1>Results</h1><p>Submitted</p></body></html>"
    ],
    [
      "about:newtab",
      "<html><head><title>New Tab</title></head><body><h1>New Tab</h1></body></html>"
    ]
  ]);
  const writes = [];
  const prepared = await prepareBrowserTui("https://example.test/", {
    store,
    services: {
      async writeTextFile(path, content) {
        writes.push({ kind: "text", path, content });
      },
      async downloadFile(request) {
        writes.push({ kind: "download", url: request.url });
        request.signal?.throwIfAborted();
        return {
          path: join(stateDirectory, "download.bin"),
          fileName: "download.bin",
          receivedBytes: 12,
          totalBytes: 12
        };
      },
      async openExternal(target) {
        writes.push({ kind: "openExternal", target });
      },
      async openPath(path) {
        writes.push({ kind: "openPath", path });
      }
    },
    createSession: () => new BrowserSession({
      loader: options.loaderFactory?.(htmlMap) ?? createLoader(htmlMap)
    }),
    downloadDirectory: stateDirectory,
    restoreWorkspace: options.restoreWorkspace === true
  });
  const harness = createTerminalHarness({ terminalSize: { columns: 120, rows: 30 } });
  const runtime = createTuiRuntime({ app: prepared.app, host: harness.host });
  await runtime.start();
  return { runtime, harness, writes, prepared };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await defer();
  }
  assert.fail("Timed out waiting for the TUI state.");
}

function textEvent(text) {
  return { kind: "text", text, paste: false };
}

function keyEvent(key) {
  return {
    kind: "key",
    key,
    sequence: "",
    modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    eventType: "press",
    location: "standard"
  };
}

function wheelEvent(row, column, deltaRows) {
  return {
    kind: "mouse",
    sequence: "",
    encoding: "sgr",
    action: "wheel",
    button: deltaRows < 0 ? "wheelUp" : "wheelDown",
    row,
    column,
    rawCode: deltaRows < 0 ? 64 : 65,
    modifiers: { shift: false, alt: false, ctrl: false },
    deltaRows,
    deltaColumns: 0
  };
}

function findRole(node, role) {
  if (node.role === role) return node;
  for (const child of node.children ?? []) {
    const found = findRole(child, role);
    if (found) return found;
  }
  return undefined;
}

function findRoleWithLabel(node, role, label) {
  if (node.role === role && node.label === label) return node;
  for (const child of node.children ?? []) {
    const found = findRoleWithLabel(child, role, label);
    if (found) return found;
  }
  return undefined;
}

test("Verge renders a browser shell and preserves navigation, focus, scrolling, and quit", async () => {
  const { runtime } = await fixture();

  assert.equal(runtime.state().documents[0].snapshot.content.title, "Index");
  assert.equal(findRole(runtime.frame().accessibility.root, "document")?.label, "Index");
  assert.equal(findRole(runtime.frame().accessibility.root, "toolbar")?.label, "Browser navigation");
  assert.equal(validateAccessibleSnapshot(runtime.frame().accessibility).ok, true);

  const focusedActionId = runtime.state().documents[0].snapshot.content.actions[0].id;
  for (let attempt = 0; attempt < 20 && !runtime.frame().focusPath?.includes(focusedActionId); attempt += 1) {
    await runtime.handleInput(keyEvent("tab"));
  }
  assert.equal(runtime.frame().focusPath?.includes(focusedActionId), true);
  await runtime.resize({ columns: 72, rows: 24 });
  assert.equal(runtime.frame().focusPath?.includes(focusedActionId), true);
  await runtime.handleInput(keyEvent("enter"));
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  await runtime.dispatch({ kind: "navigate", operation: "back" });
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/");
  assert.equal(runtime.state().documents[0].canGoForward, true);
  const initialBlockId = runtime.state().documents[0].scrollAnchor.blockId;
  const scrollTarget = runtime.frame().hitTargets?.find((target) => target.id.startsWith("scroll:"));
  assert.ok(scrollTarget);
  await runtime.handleInput(wheelEvent(scrollTarget.bounds.row, scrollTarget.bounds.column, 1));
  await runtime.flushInput();
  assert.notEqual(runtime.state().documents[0].scrollAnchor.blockId, initialBlockId);

  await runtime.handleInput(textEvent("q"));
  assert.equal(runtime.exit().status, "completed");
});

test("Verge cancels superseded omnibox navigation and keeps the latest page", async () => {
  let slowNavigationAborted = false;
  const { runtime } = await fixture({
    loaderFactory(htmlMap) {
      const immediateLoader = createLoader(htmlMap);
      return async (requestUrl, requestOptions = {}) => {
        if (requestUrl !== "https://example.test/slow") return immediateLoader(requestUrl, requestOptions);
        return new Promise((_, reject) => {
          requestOptions.signal?.addEventListener("abort", () => {
            slowNavigationAborted = true;
            reject(requestOptions.signal.reason);
          }, { once: true });
        });
      };
    }
  });

  await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/slow" });
  await waitUntil(() => runtime.state().documents[0].loading);
  await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/next" });
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  assert.equal(slowNavigationAborted, true);
  assert.equal(runtime.state().status.tone, "success");
});

test("Verge supports exact find, adaptive library panels, and inline semantic forms", async () => {
  const { runtime, prepared } = await fixture();

  await runtime.dispatch({ kind: "focusOmnibox" });
  assert.equal(runtime.state().omnibox.input.text, "https://example.test/");
  await runtime.dispatch({
    kind: "omniboxAction",
    action: { kind: "setValue", value: "Next" }
  });
  assert.ok(runtime.state().omnibox.suggestions.some((entry) => entry.value === "https://example.test/next"));
  await runtime.dispatch({ kind: "cancelOmnibox" });

  await runtime.dispatch({ kind: "openFind" });
  await runtime.dispatch({
    kind: "findAction",
    action: { kind: "edit", operation: { kind: "insert", text: "Paragraph" } }
  });
  assert.equal(runtime.state().documents[0].search.matches.length, 40);
  assert.ok(runtime.state().documents[0].search.matches.every((match) => match.endCodeUnitIndexExclusive > match.startCodeUnitIndex));
  await runtime.dispatch({ kind: "moveSearch", direction: "next" });
  assert.equal(runtime.state().documents[0].search.activeMatchIndex, 1);

  for (const panel of ["history", "bookmarks", "downloads"]) {
    await runtime.dispatch({ kind: "toggleSidePanel", panel });
    assert.equal(runtime.state().sidePanel, panel);
  }

  const document = runtime.state().documents[0];
  const form = prepared.controller.forms(document)[0];
  const query = form.controls.find((control) => control.name === "q");
  const password = form.controls.find((control) => control.name === "secret");
  const language = form.controls.find((control) => control.name === "lang");
  const count = form.controls.find((control) => control.name === "count");
  assert.equal(query.kind, "text");
  assert.equal(password.kind, "text");
  assert.equal(language.kind, "select");
  assert.equal(count.kind, "text");
  assert.equal(count.inputType, "number");
  await runtime.dispatch({ kind: "formValues", controlId: query.id, values: [] });
  await runtime.dispatch({ kind: "submitForm", formId: form.id });
  assert.equal(runtime.state().documents[0].snapshot.content.title, "Index");
  assert.match(runtime.state().status?.text ?? "", /required/u);
  await runtime.dispatch({ kind: "resetForm", formId: form.id });
  await runtime.dispatch({
    kind: "formText",
    controlId: query.id,
    action: { kind: "edit", operation: { kind: "insert", text: "Z" } }
  });
  await runtime.dispatch({
    kind: "formSelect",
    controlId: language.id,
    action: { kind: "open" }
  });
  await runtime.dispatch({
    kind: "formSelect",
    controlId: language.id,
    action: { kind: "commit", id: `${language.id}:1` }
  });
  await runtime.dispatch({
    kind: "formNumber",
    controlId: count.id,
    action: { kind: "step", direction: "increment" }
  });
  assert.equal(runtime.state().documents[0].formValues[query.id][0], "alphaZ");
  assert.deepEqual(runtime.state().documents[0].formValues[language.id], ["fr"]);
  assert.deepEqual(runtime.state().documents[0].formValues[count.id], ["3"]);
  assert.doesNotMatch(renderFramePlain(runtime.frame()), /hidden/u);
  await runtime.dispatch({ kind: "scrollBottom" });
  assert.ok(findRoleWithLabel(runtime.frame().accessibility.root, "combobox", "Language *"));
  assert.ok(findRoleWithLabel(runtime.frame().accessibility.root, "spinbutton", count.id));
  await runtime.dispatch({ kind: "submitForm", formId: form.id, submitterId: form.controls.find((control) => control.kind === "submit").id });
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl.includes("/search?"));
  assert.equal(runtime.state().documents[0].snapshot.content.title, "Results");
});

test("Verge supports new tabs, restored tabs, bookmarks, downloads, exports, and external opening", async () => {
  const { runtime, writes } = await fixture();

  await runtime.dispatch({ kind: "toggleBookmark" });
  await waitUntil(() => runtime.state().bookmarks.length === 1);

  await runtime.dispatch({ kind: "newDocument", target: "https://example.test/next" });
  await waitUntil(() => runtime.state().documents.length === 2);
  assert.equal(runtime.state().documents[1].snapshot.finalUrl, "https://example.test/next");
  await runtime.dispatch({ kind: "closeDocument" });
  assert.equal(runtime.state().documents.length, 1);
  await runtime.dispatch({ kind: "reopenDocument" });
  assert.equal(runtime.state().documents.length, 2);

  await runtime.dispatch({ kind: "download", target: "https://example.test/archive.bin" });
  await waitUntil(() => runtime.state().downloads[0]?.status === "completed");
  assert.ok(writes.some((entry) => entry.kind === "download"));

  await runtime.dispatch({ kind: "openActionPalette" });
  await runtime.dispatch({ kind: "actionPaletteSubmit", value: "save text page.txt" });
  await waitUntil(() => writes.some((entry) => entry.kind === "text"));
  await runtime.dispatch({ kind: "openActionPalette" });
  await runtime.dispatch({ kind: "actionPaletteSubmit", value: "open-external" });
  await waitUntil(() => writes.some((entry) => entry.kind === "openExternal"));

  await runtime.dispatch({ kind: "quit" });
  assert.equal(runtime.exit().status, "completed");
});

test("Verge restores persisted tabs, selection, and library panel", async () => {
  const { runtime } = await fixture({
    restoreWorkspace: true,
    workspace: {
      documents: [
        { url: "https://example.test/", scrollAnchor: { blockId: "missing", rowOffset: 0 } },
        { url: "https://example.test/next", scrollAnchor: { blockId: "missing", rowOffset: 0 } }
      ],
      activeDocumentIndex: 1,
      sidePanel: "bookmarks"
    }
  });

  assert.deepEqual(
    runtime.state().documents.map((document) => document.snapshot.finalUrl),
    ["https://example.test/", "https://example.test/next"]
  );
  assert.equal(runtime.state().activeDocumentIndex, 1);
  assert.equal(runtime.state().sidePanel, "bookmarks");
});

test("closing the final tab replaces it with the new-tab dashboard", async () => {
  const { runtime } = await fixture();
  await runtime.dispatch({ kind: "closeDocument" });
  await waitUntil(() => runtime.state().documents[0]?.snapshot.finalUrl === "about:newtab");
  assert.equal(runtime.state().documents.length, 1);
  assert.match(renderFramePlain(runtime.frame()), /New Tab/u);
});

test("non-HTML navigation offers a download instead of replacing the page", async () => {
  const archiveUrl = "https://example.test/archive.zip";
  const { runtime, writes } = await fixture({
    loaderFactory(htmlMap) {
      const htmlLoader = createLoader(htmlMap);
      return async (requestUrl, requestOptions) => {
        if (requestUrl !== archiveUrl) return htmlLoader(requestUrl, requestOptions);
        throw new NetworkFetchError({
          kind: "content_type_block",
          finalUrl: archiveUrl,
          status: 200,
          statusText: "OK",
          detailCode: "CONTENT_TYPE_BLOCK",
          detailMessage: "Blocked non-HTML content-type: application/zip"
        });
      };
    }
  });

  await runtime.dispatch({ kind: "omniboxSubmit", value: archiveUrl });
  await waitUntil(() => runtime.state().overlay?.kind === "downloadPrompt");
  assert.equal(runtime.state().documents[0].snapshot.content.title, "Index");
  assert.match(renderFramePlain(runtime.frame()), /Download resource\?/u);

  await runtime.dispatch({ kind: "download", target: archiveUrl });
  await waitUntil(() => runtime.state().downloads[0]?.status === "completed");
  assert.ok(writes.some((entry) => entry.kind === "download" && entry.url === archiveUrl));
});

test("runTui owns the terminal lifecycle and exits through the app binding", async () => {
  const { runtime } = await fixture();
  const app = runtime.app;
  await runtime.dispose();
  const harness = createTerminalHarness({ terminalSize: { columns: 100, rows: 24 } });
  const running = runTui(app, harness.host);
  await waitUntil(() => harness.frames().length > 0);
  await harness.input("q");
  const exit = await running;

  assert.equal(exit.status, "completed");
  assert.equal(exit.reason, "quit");
  assert.equal(harness.restores().length, 1);
});
