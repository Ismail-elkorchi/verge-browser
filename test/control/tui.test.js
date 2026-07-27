import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as defer } from "node:timers/promises";

import { validateAccessibleSnapshot } from "@ismail-elkorchi/terminal-ui/accessibility";
import { createTerminalHarness } from "@ismail-elkorchi/terminal-ui/testing";
import { createTuiRuntime, runTui } from "@ismail-elkorchi/terminal-ui/tui";

import { BrowserSession } from "../../dist/app/session.js";
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
  const htmlMap = new Map([
    [
      "https://example.test/",
      `<html><head><title>Index</title></head><body><h1>Index</h1><p><a href="/next">Next page</a></p>${Array.from(
        { length: 40 },
        (_, index) => `<p>Paragraph ${String(index + 1)} alpha</p>`
      ).join("")}<form action="/search" method="get"><input name="q" value="alpha"><textarea name="notes">hello</textarea></form></body></html>`
    ],
    [
      "https://example.test/next",
      "<html><head><title>Next</title></head><body><h1>Next</h1><p>Second page</p><a href=\"/\">Back home</a></body></html>"
    ],
    [
      "https://example.test/search?q=alphaZ&notes=hello%0AX",
      "<html><head><title>Results</title></head><body><h1>Results</h1><p>alphaZ</p><p>hello X</p></body></html>"
    ]
  ]);
  const writes = [];
  const prepared = await prepareBrowserTui("https://example.test/", {
    store,
    services: {
      async writeTextFile(path, content) {
        writes.push({ kind: "text", path, content });
      },
      async writeCsvFile(path, rows) {
        writes.push({ kind: "csv", path, rows });
      },
      async openExternal(target) {
        writes.push({ kind: "openExternal", target });
      },
      async editTextExternally(initialText) {
        return `${initialText}\nexternal`;
      }
    },
    createSession: () => new BrowserSession({
      loader: options.loaderFactory?.(htmlMap) ?? createLoader(htmlMap)
    })
  });
  const harness = createTerminalHarness({ terminalSize: { columns: 100, rows: 24 } });
  const suspendedOperations = [];
  const runtime = createTuiRuntime({
    app: prepared.app,
    host: harness.host,
    withTerminalSuspended: async (operation) => {
      suspendedOperations.push("external");
      return operation();
    }
  });
  await runtime.start();
  return { runtime, harness, writes, suspendedOperations };
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
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    eventType: "press",
    location: "standard"
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

test("Verge TUI renders an accessible document and preserves the browse vertical slice", async () => {
  const { runtime } = await fixture();

  assert.equal(runtime.state().documents[0].snapshot.content.title, "Index");
  assert.equal(findRole(runtime.frame().accessibility.root, "document")?.label, "Index");
  assert.equal(validateAccessibleSnapshot(runtime.frame().accessibility).ok, true);

  await runtime.handleInput(textEvent("]"));
  const focusedActionId = runtime.state().documents[0].snapshot.content.actions[0].id;
  assert.equal(runtime.state().documents[0].focusedActionId, focusedActionId);
  await runtime.resize({ columns: 42, rows: 24 });
  assert.equal(runtime.state().documents[0].focusedActionId, focusedActionId);
  await runtime.handleInput(keyEvent("enter"));
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  await runtime.handleInput(textEvent("h"));
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/");
  assert.equal(runtime.state().documents[0].focusedActionId, focusedActionId);
  const initialBlockId = runtime.state().documents[0].scrollAnchor.blockId;
  await runtime.handleInput(keyEvent("arrowDown"));
  assert.notEqual(runtime.state().documents[0].scrollAnchor.blockId, initialBlockId);

  await runtime.handleInput(textEvent("q"));
  assert.equal(runtime.exit().status, "completed");
});

test("Verge TUI cancels superseded navigation and keeps the latest page", async () => {
  let slowNavigationAborted = false;
  const { runtime } = await fixture({
    loaderFactory(htmlMap) {
      const immediateLoader = createLoader(htmlMap);
      return async (requestUrl, requestOptions = {}) => {
        if (requestUrl !== "https://example.test/slow") {
          return immediateLoader(requestUrl, requestOptions);
        }
        return new Promise((_, reject) => {
          requestOptions.signal?.addEventListener("abort", () => {
            slowNavigationAborted = true;
            reject(requestOptions.signal.reason);
          }, { once: true });
        });
      };
    }
  });

  await runtime.dispatch({ kind: "openPalette", mode: "location" });
  await runtime.dispatch({ kind: "paletteSubmit", value: "https://example.test/slow" });
  await waitUntil(() => runtime.state().documents[0].loading);
  await runtime.dispatch({ kind: "openPalette", mode: "location" });
  await runtime.dispatch({ kind: "paletteSubmit", value: "https://example.test/next" });
  await waitUntil(() => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  assert.equal(slowNavigationAborted, true);
  assert.equal(runtime.state().status.tone, "success");
});

test("Verge TUI exposes palettes, pickers, tabs, details, and form editing", async () => {
  const { runtime, suspendedOperations } = await fixture();

  for (const picker of ["documents", "links", "history", "forms", "outline"]) {
    await runtime.dispatch({ kind: "openPicker", picker });
    assert.equal(runtime.state().overlay.kind, "picker");
    assert.equal(runtime.state().overlay.pickerKind, picker);
    await runtime.dispatch({ kind: "dismiss" });
  }

  for (const detail of ["help", "diagnostics", "reader", "cookies"]) {
    await runtime.dispatch({ kind: "openDetail", detail });
    assert.equal(runtime.state().overlay.kind, "detail");
    assert.equal(runtime.state().overlay.detailKind, detail);
    await runtime.dispatch({ kind: "dismiss" });
  }

  await runtime.dispatch({ kind: "openPalette", mode: "search" });
  await runtime.dispatch({ kind: "paletteSubmit", value: "Paragraph" });
  assert.equal(runtime.state().documents[0].search.query, "Paragraph");

  await runtime.dispatch({ kind: "openPicker", picker: "forms" });
  await runtime.dispatch({ kind: "pickerSelect", value: { kind: "form", index: 1 } });
  assert.equal(runtime.state().overlay.kind, "form");
  await runtime.dispatch({
    kind: "formField",
    fieldIndex: 0,
    control: "singleLine",
    action: { kind: "edit", operation: { kind: "insert", text: "Z" } }
  });
  assert.equal(runtime.state().overlay.fields[0].input.state.text, "alphaZ");
  await runtime.dispatch({ kind: "editFormFieldExternal", fieldIndex: 0 });
  await waitUntil(() => runtime.state().overlay?.kind === "form"
    && runtime.state().overlay.fields[0].input.state.text.endsWith("\nexternal"));
  assert.equal(suspendedOperations.length, 1);
  await runtime.dispatch({ kind: "discardForm" });
  assert.equal(runtime.state().overlay, null);
});

test("Verge TUI preserves document tabs, bookmarks, exports, external opening, and quit", async () => {
  const { runtime, writes } = await fixture();

  await runtime.dispatch({ kind: "bookmark" });
  await waitUntil(() => runtime.state().status?.text.startsWith("Saved bookmark:"));

  await runtime.dispatch({ kind: "moveAction", delta: 1 });
  await runtime.dispatch({ kind: "newDocument" });
  await waitUntil(() => runtime.state().documents.length === 2);
  assert.equal(runtime.state().documents[1].snapshot.finalUrl, "https://example.test/next");
  await runtime.dispatch({ kind: "closeDocument" });
  assert.equal(runtime.state().documents.length, 1);
  await runtime.dispatch({ kind: "reopenDocument" });
  assert.equal(runtime.state().documents.length, 2);

  await runtime.dispatch({ kind: "openPalette", mode: "action" });
  await runtime.dispatch({ kind: "paletteSubmit", value: "save text page.txt" });
  await waitUntil(() => writes.some((entry) => entry.kind === "text"));
  await runtime.dispatch({ kind: "openPalette", mode: "action" });
  await runtime.dispatch({ kind: "paletteSubmit", value: "open-external" });
  await waitUntil(() => writes.some((entry) => entry.kind === "openExternal"));

  await runtime.dispatch({ kind: "quit" });
  assert.equal(runtime.exit().status, "completed");
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
