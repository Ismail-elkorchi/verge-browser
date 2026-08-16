import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDiagnosticOccurrenceReporter,
  diagnostic
} from "@ismail-elkorchi/terminal-ui";
import { decodeAccessibleSnapshot } from "@ismail-elkorchi/terminal-ui/accessibility";
import {
  activeSearchPickerEntry,
  commandInputPresentation,
  searchPickerPresentation
} from "@ismail-elkorchi/terminal-ui/behavior";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTerminalHarness } from "@ismail-elkorchi/terminal-ui/testing";
import { measureTextCells } from "@ismail-elkorchi/terminal-ui/text";
import { createTuiRuntime, runTui } from "@ismail-elkorchi/terminal-ui/tui";
import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserSession } from "../../dist/app/session.js";
import { NetworkFetchError } from "../../dist/app/fetch-page.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { browserTuiFailureMessage, prepareBrowserTui } from "../../dist/ui/run.js";

function createLoader(htmlMap) {
  return async (requestUrl) => {
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
      responseFields: new HttpFields([
        { name: "content-type", value: "text/html" }
      ]),
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
      `<html><head><title>Index</title><style>.authored { color: #123456; background-color: #f0e0d0; font-style: italic; }</style></head><body><h1>Index</h1><p><a href="/next">Next page</a></p>${Array.from(
        { length: 40 },
        (_, index) => `<p${index === 0 ? ' class="authored"' : ""}>Paragraph ${String(index + 1)} alpha</p>`
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
  const prepared = await prepareBrowserTui(options.initialUrl ?? "https://example.test/", {
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
      },
      async close() {
      }
    },
    createSession: () => new BrowserSession({
      loader: options.loaderFactory?.(htmlMap) ?? createLoader(htmlMap),
      defaultParseMode: "text"
    }),
    downloadDirectory: stateDirectory,
    restoreWorkspace: options.restoreWorkspace === true
  });
  const host = createMemoryTerminalHost({
    terminalSize: options.terminalSize ?? { columns: 120, rows: 30 }
  });
  const runtime = createTuiRuntime({ app: prepared.app, host });
  await runtime.start();
  return { runtime, writes, prepared, store };
}

async function waitUntil(runtime, predicate) {
  const signal = globalThis.AbortSignal.timeout(5_000);
  while (!predicate()) {
    try {
      await runtime.nextChange(signal);
    } catch (error) {
      if (signal.aborted) assert.fail("Timed out waiting for the TUI state.");
      throw error;
    }
  }
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

function pointerEvent(action, row, column) {
  return {
    kind: "mouse",
    sequence: "",
    encoding: "sgr",
    action,
    button: "left",
    row,
    column,
    rawCode: action === "drag" ? 32 : 0,
    modifiers: { shift: false, alt: false, ctrl: false }
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
  assert.equal(
    findRoleWithLabel(runtime.frame().accessibility.root, "button", "Bookmark current page")?.pressed,
    false
  );
  assert.equal(findRoleWithLabel(runtime.frame().accessibility.root, "button", "←")?.disabled, true);
  assert.equal(runtime.frame().hitTargets?.some((target) => target.id === "browser-back:control"), false);
  assert.equal(decodeAccessibleSnapshot(runtime.frame().accessibility).status, "success");

  const focusedActionId = runtime.state().documents[0].snapshot.content.actions[0].id;
  for (let attempt = 0; attempt < 20 && !runtime.frame().focusPath?.includes(focusedActionId); attempt += 1) {
    await runtime.handleInput(keyEvent("tab"));
  }
  assert.equal(runtime.frame().focusPath?.includes(focusedActionId), true);
  await runtime.resize({ columns: 72, rows: 24 });
  assert.equal(runtime.frame().focusPath?.includes(focusedActionId), true);
  await runtime.handleInput(keyEvent("enter"));
  await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  await runtime.dispatch({ kind: "navigate", operation: "back" });
  await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/");
  assert.equal(runtime.state().documents[0].canGoForward, true);
  const initialBlockId = runtime.state().documents[0].scrollAnchor.blockId;
  const scrollTarget = runtime.frame().hitTargets?.find((target) =>
    target.id.startsWith("browser-viewport-") && target.id.endsWith(":scroll:content")
  );
  assert.ok(scrollTarget);
  await runtime.handleInput(wheelEvent(scrollTarget.bounds.row, scrollTarget.bounds.column, 1));
  await runtime.flushInput();
  assert.notEqual(runtime.state().documents[0].scrollAnchor.blockId, initialBlockId);
  const anchorAfterWheel = runtime.state().documents[0].scrollAnchor;
  const thumb = runtime.frame().hitTargets?.find((target) =>
    target.id.startsWith("browser-viewport-") && target.id.endsWith(":scrollbar:vertical:thumb")
  );
  const track = runtime.frame().hitTargets?.find((target) =>
    target.id.startsWith("browser-viewport-") && target.id.endsWith(":scrollbar:vertical:track")
  );
  assert.ok(thumb);
  assert.ok(track);
  await runtime.handleInput(pointerEvent("press", thumb.bounds.row, thumb.bounds.column));
  await runtime.handleInput(pointerEvent(
    "drag",
    track.bounds.row + track.bounds.height - 1,
    track.bounds.column
  ));
  await runtime.handleInput(pointerEvent(
    "release",
    track.bounds.row + track.bounds.height - 1,
    track.bounds.column
  ));
  assert.notDeepEqual(runtime.state().documents[0].scrollAnchor, anchorAfterWheel);
  assert.equal(runtime.diagnostics().some((item) =>
    item.diagnostic.severity === "error" || item.diagnostic.severity === "fatal"
  ), false);

  await runtime.handleInput(textEvent("q"));
  assert.equal(runtime.exit().status, "completed");
});

test("Tab traversal reveals links beyond the document viewport", async () => {
  const target = "https://many-links.test/";
  const links = Array.from(
    { length: 18 },
    (_value, index) => `<p><a href="/link-${String(index + 1)}">Link ${String(index + 1)}</a></p>`
  ).join("");
  const pages = new Map([[
    target,
    `<html><head><title>Many links</title></head><body>${links}</body></html>`
  ]]);
  const { runtime } = await fixture({
    initialUrl: target,
    terminalSize: { columns: 50, rows: 8 },
    loaderFactory: () => createLoader(pages)
  });
  const document = runtime.state().documents[0];
  const lastLink = document.snapshot.content.links.at(-1);
  assert.ok(lastLink);
  const initialAnchor = document.scrollAnchor;

  for (let attempt = 0; attempt < 40 && !runtime.frame().focusPath?.includes(lastLink.id); attempt += 1) {
    await runtime.handleInput(keyEvent("tab"));
  }

  assert.equal(runtime.frame().focusPath?.includes(lastLink.id), true);
  assert.notDeepEqual(runtime.state().documents[0].scrollAnchor, initialAnchor);
  assert.equal(
    findRoleWithLabel(runtime.frame().accessibility.root, "link", "Link 18")?.focused,
    true
  );
});

test("omnibox deduplication keeps a matching representation of a shared URL", async () => {
  const { runtime, prepared, store } = await fixture();
  await store.addBookmark("https://example.test/next", "Needle destination");

  const suggestions = prepared.controller.omniboxSuggestions(
    "needle",
    runtime.state().documents[0]
  );

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].value, "https://example.test/next");
  assert.equal(suggestions[0].label, "Needle destination");
});

test("inline forms use their CSS block placement instead of page-wide bounds", async () => {
  const target = "https://form-layout.test/";
  const pages = new Map([[
    target,
    `<html><head><title>Placed form</title><style>
      .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 2ch; }
      form { width: 20ch; margin-inline: auto; }
    </style></head><body><div class="grid"><article><p>Article</p></article>
      <form><label for="query">Query</label><input id="query" name="q"></form>
    </div></body></html>`
  ]]);
  const { runtime, prepared } = await fixture({
    initialUrl: target,
    terminalSize: { columns: 100, rows: 12 },
    loaderFactory: () => createLoader(pages)
  });
  const document = runtime.state().documents[0];
  const control = prepared.controller.forms(document)[0]?.controls.find((candidate) => candidate.name === "q");
  assert.ok(control);
  const targetBounds = runtime.frame().hitTargets?.find((candidate) => candidate.id === `${control.id}:text`)?.bounds;

  assert.ok(targetBounds);
  assert.ok(targetBounds.column > 50);
  assert.equal(targetBounds.width, 20);
});

test("browser chrome and document geometry remain readable from narrow to wide terminals", async () => {
  const { runtime } = await fixture({ terminalSize: { columns: 240, rows: 40 } });
  const wideFrame = runtime.frame();
  const wideText = renderFramePlain(wideFrame);
  const backText = wideFrame.cells
    .filter((cell) => cell.source?.elementId === "browser-back")
    .toSorted((left, right) => left.row - right.row || left.column - right.column)
    .map((cell) => cell.text)
    .join("");
  const linkCells = wideFrame.cells.filter((cell) => cell.link?.href === "https://example.test/next");

  assert.match(backText, /^\s*←\s*$/u);
  assert.ok(wideFrame.cells.some((cell) => cell.source?.elementId === "browser-omnibox"));
  assert.doesNotMatch(wideText, /Ctrl\+L/u);
  assert.doesNotMatch(wideText, /^#+\s+Index$/mu);
  assert.ok(linkCells.length > 0);
  assert.ok(linkCells.every((cell) => cell.column >= 50 && cell.column <= 189));
  assert.ok(linkCells.every((cell) =>
    cell.style?.underline === true
    && cell.style.fg?.kind === "theme"
    && cell.style.fg.token === "link.foreground"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.text === "I"
    && cell.style?.bold === true
    && cell.style.fg?.kind === "theme"
    && cell.style.fg.token === "accent.primary"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.text === "P"
    && cell.style?.fg?.kind === "rgb"
    && cell.style.fg.r === 18
    && cell.style.fg.g === 52
    && cell.style.fg.b === 86
    && cell.style?.bg?.kind === "rgb"
    && cell.style.bg.r === 240
    && cell.style.bg.g === 224
    && cell.style.bg.b === 208
    && cell.style.italic === true
  ));
  const proseRow = wideFrame.cells.find((cell) =>
    cell.text === "P" && cell.column >= 50 && cell.link === undefined
  )?.row;
  assert.ok(proseRow);
  assert.ok(wideFrame.cells
    .filter((cell) => cell.row === proseRow && cell.link === undefined)
    .every((cell) => cell.style?.inverse !== true));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId?.startsWith("browser-viewport-")
    && cell.source.partType === "thumb"
  ));
  const toolbarRows = new Set(wideFrame.cells
    .filter((cell) => cell.source?.elementId?.startsWith("browser-"))
    .filter((cell) => ["browser-back", "browser-forward", "browser-reload", "browser-new-tab", "browser-bookmark", "browser-library", "browser-menu"].includes(cell.source.elementId))
    .map((cell) => cell.row));
  const tabRows = new Set(wideFrame.cells
    .filter((cell) => cell.source?.elementId === "browser-tabs")
    .map((cell) => cell.row));
  const toolbarSurfaceRows = new Set(wideFrame.cells
    .filter((cell) =>
      cell.source?.elementId === "browser-toolbar-surface"
      && cell.source.partName === "background"
    )
    .map((cell) => cell.row));
  const omniboxText = wideFrame.cells
    .filter((cell) => cell.source?.elementId === "browser-omnibox")
    .toSorted((left, right) => left.row - right.row || left.column - right.column)
    .map((cell) => cell.text)
    .join("");
  const omniboxRows = new Set(wideFrame.cells
    .filter((cell) => cell.source?.elementId === "browser-omnibox")
    .map((cell) => cell.row));

  assert.equal(toolbarRows.size, 1);
  assert.equal(tabRows.size, 1);
  assert.equal(toolbarSurfaceRows.size, 1);
  assert.equal(omniboxRows.size, 1);
  assert.equal(Math.min(...toolbarSurfaceRows), Math.max(...tabRows) + 1);
  assert.equal([...toolbarRows][0], [...omniboxRows][0]);
  assert.equal([...omniboxRows][0], [...toolbarSurfaceRows][0]);
  assert.doesNotMatch(omniboxText, /›/u);
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-tabs"
    && cell.source.partName === "header.background"
    && cell.style?.bg?.token === "surface.background"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-tabs"
    && cell.source.itemId === runtime.state().documents[0].id
    && cell.style?.bg?.token === "surface.raised.background"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-toolbar-surface"
    && cell.style?.bg?.token === "surface.bar.background"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-omnibox"
    && cell.style?.bg?.token === "control.background"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId?.startsWith("browser-page-surface-")
    && cell.style?.bg?.token === "surface.background"
  ));
  assert.ok(wideFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-status"
    && cell.style?.bg?.token === "surface.bar.background"
  ));

  await runtime.dispatch({ kind: "toggleSidePanel", panel: "history" });
  const panelFrame = runtime.frame();
  assert.ok(panelFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-content-with-panel"
    && cell.source.partName === "divider"
  ));
  assert.ok(panelFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-side-panel"
    && cell.style?.bg?.token === "surface.inset.background"
  ));
  assert.ok(panelFrame.cells.some((cell) =>
    cell.source?.elementId === "panel-history"
    && cell.style?.bg?.token === "control.primary.background"
  ));
  assert.ok(panelFrame.cells.some((cell) =>
    cell.source?.elementId === "browser-library"
    && cell.style?.bg?.token === "control.primary.background"
  ));
  assert.match(renderFramePlain(panelFrame), /Index · example\.test/u);
  const panelBackground = panelFrame.cells.filter((cell) =>
    cell.source?.elementId === "browser-side-panel"
    && cell.source.partName === "background"
  );
  assert.ok(panelBackground.length > 0);
  const panelRows = panelBackground.map((cell) => cell.row);
  const panelColumns = panelBackground.map((cell) => cell.column);
  const panelBounds = {
    top: Math.min(...panelRows),
    bottom: Math.max(...panelRows),
    left: Math.min(...panelColumns),
    right: Math.max(...panelColumns)
  };
  assert.equal(panelFrame.cells.some((cell) =>
    cell.source?.cellRole === "border"
    && cell.row >= panelBounds.top
    && cell.row <= panelBounds.bottom
    && cell.column >= panelBounds.left
    && cell.column <= panelBounds.right
  ), false);

  for (const columns of [40, 80, 120, 240]) {
    await runtime.resize({ columns, rows: 40 });
    const frame = runtime.frame();
    assert.equal(decodeAccessibleSnapshot(frame.accessibility).status, "success");
    assert.ok(frame.cells.every((cell) => cell.column + cell.width - 1 <= columns));
    assert.ok(renderFramePlain(frame).split("\n").every((line) => measureTextCells(line).cells <= columns));
    if (columns < 96) {
      assert.equal(frame.cells.some((cell) => cell.source?.elementId === "browser-library"), false);
    }
  }
});

test("browser and link actions use anchored menus instead of modal button grids", async () => {
  const { runtime, writes } = await fixture();

  await runtime.dispatch({ kind: "browserMenuTransition", transition: { kind: "open" } });
  assert.equal(runtime.state().overlay?.kind, "browserMenu");
  assert.match(renderFramePlain(runtime.frame()), /History/u);
  assert.equal(findRoleWithLabel(runtime.frame().accessibility.root, "dialog", "Browser menu"), undefined);

  await runtime.dispatch({
    kind: "browserMenuActivate",
    event: { kind: "activate", id: "history" }
  });
  assert.equal(runtime.state().overlay, null);
  assert.equal(runtime.state().sidePanel, "history");

  const link = runtime.state().documents[0].snapshot.content.links[0];
  const linkTarget = runtime.frame().hitTargets?.find((target) =>
    target.id.startsWith(`activate:${link.id}:`)
  );
  assert.ok(linkTarget);
  await runtime.handleInput({
    kind: "mouse",
    sequence: "",
    encoding: "sgr",
    action: "press",
    button: "right",
    row: linkTarget.bounds.row,
    column: linkTarget.bounds.column,
    rawCode: 2,
    modifiers: { shift: false, alt: false, ctrl: false }
  });
  assert.equal(runtime.state().overlay?.kind, "linkMenu");
  assert.ok(findRoleWithLabel(runtime.frame().accessibility.root, "menu", "Link"));
  assert.equal(findRoleWithLabel(runtime.frame().accessibility.root, "dialog", "Link"), undefined);

  await runtime.dispatch({
    kind: "linkMenuActivate",
    event: { kind: "activate", id: "external" }
  });
  await waitUntil(runtime, () => writes.some((entry) =>
    entry.kind === "openExternal" && entry.target === link.resolvedHref
  ));
  assert.equal(runtime.state().overlay, null);
});

test("browser pickers retain stable selection identity and activate generic values", async () => {
  const { runtime } = await fixture();

  await runtime.dispatch({ kind: "openPicker", picker: "links" });
  const overlay = runtime.state().overlay;
  assert.equal(overlay?.kind, "picker");
  const presentation = searchPickerPresentation(overlay.state);
  const active = activeSearchPickerEntry({
    searchPickerIndex: overlay.index,
    presentation
  });
  assert.ok(active);
  assert.equal(presentation.activeId, active.id);

  await runtime.dispatch({
    kind: "pickerAccept",
    event: { kind: "accept", id: active.id }
  });
  await waitUntil(
    runtime,
    () => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next"
  );
});

test("browser runtime errors retain the terminal diagnostic cause", () => {
  const occurrence = createDiagnosticOccurrenceReporter("browser-test").report(diagnostic(
    "TUI_RUN_FAILED",
    "TUI run failed before completion.",
    {
      cause: {
        name: "RangeError",
        message: "Custom composite child 0 returned bounds outside its parent."
      },
      hint: "Inspect the renderer extension bounds."
    }
  ));
  const message = browserTuiFailureMessage([occurrence]);

  assert.equal(
    message,
    "TUI run failed before completion. Custom composite child 0 returned bounds outside its parent. Inspect the renderer extension bounds."
  );
});

test("new-tab content stays compact and centered on a large terminal", async () => {
  const { runtime } = await fixture({
    initialUrl: "about:newtab",
    terminalSize: { columns: 240, rows: 60 }
  });
  const frame = runtime.frame();
  const title = frame.cells.find((cell) => cell.source?.elementId === "new-tab-title");
  const hint = frame.cells.find((cell) => cell.source?.elementId === "new-tab-hint");

  assert.ok(title);
  assert.ok(hint);
  assert.ok(hint.row - title.row <= 2);
  assert.ok(title.column > 70 && title.column < 170);
  assert.equal(frame.cells.some((cell) => cell.source?.elementId === "browser-help"), false);
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
  await waitUntil(runtime, () => runtime.state().documents[0].loading);
  await runtime.dispatch({ kind: "omniboxSubmit", value: "https://example.test/next" });
  await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl === "https://example.test/next");

  assert.equal(slowNavigationAborted, true);
  assert.equal(runtime.state().status.tone, "success");
});

test("Verge supports exact find, adaptive library panels, and inline semantic forms", async () => {
  const { runtime, prepared } = await fixture();

  await runtime.dispatch({ kind: "focusOmnibox" });
  assert.equal(commandInputPresentation(runtime.state().omnibox).value, "https://example.test/");
  await runtime.dispatch({
    kind: "omniboxTransition",
    transition: { kind: "setValue", value: "Next" }
  });
  const nextSuggestion = runtime.state().omnibox.suggestions.records.find(
    (entry) => entry.value.text === "https://example.test/next"
  );
  assert.ok(nextSuggestion);
  await runtime.dispatch({
    kind: "omniboxTransition",
    transition: { kind: "setActiveSuggestion", id: nextSuggestion.id }
  });
  await runtime.dispatch({
    kind: "omniboxTransition",
    transition: { kind: "acceptSuggestion" }
  });
  assert.equal(
    commandInputPresentation(runtime.state().omnibox).value,
    "https://example.test/next"
  );
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
    kind: "formComboboxTransition",
    controlId: language.id,
    transition: { kind: "open" }
  });
  await runtime.dispatch({
    kind: "formComboboxCommit",
    controlId: language.id,
    event: { kind: "commit", id: `${language.id}:1` }
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
  const languageNode = findRoleWithLabel(runtime.frame().accessibility.root, "combobox", "Language");
  assert.ok(languageNode);
  assert.equal(languageNode.required, true);
  assert.ok(findRoleWithLabel(runtime.frame().accessibility.root, "spinbutton", count.id));
  await runtime.dispatch({ kind: "submitForm", formId: form.id, submitterId: form.controls.find((control) => control.kind === "submit").id });
  await waitUntil(runtime, () => runtime.state().documents[0].snapshot.finalUrl.includes("/search?"));
  assert.equal(runtime.state().documents[0].snapshot.content.title, "Results");
});

test("Verge supports new tabs, restored tabs, bookmarks, downloads, exports, and external opening", async () => {
  const { runtime, writes } = await fixture();

  await runtime.dispatch({ kind: "toggleBookmark" });
  await waitUntil(runtime, () => runtime.state().bookmarks.length === 1);

  await runtime.dispatch({ kind: "newDocument", target: "https://example.test/next" });
  await waitUntil(runtime, () => runtime.state().documents.length === 2);
  assert.equal(runtime.state().documents[1].snapshot.finalUrl, "https://example.test/next");
  await runtime.dispatch({ kind: "closeDocument" });
  assert.equal(runtime.state().documents.length, 1);
  await runtime.dispatch({ kind: "reopenDocument" });
  assert.equal(runtime.state().documents.length, 2);

  await runtime.dispatch({ kind: "download", target: "https://example.test/archive.bin" });
  await waitUntil(runtime, () => runtime.state().downloads[0]?.status === "completed");
  assert.ok(writes.some((entry) => entry.kind === "download"));

  await runtime.dispatch({ kind: "openActionPalette" });
  await runtime.dispatch({ kind: "actionPaletteSubmit", value: "save text page.txt" });
  await waitUntil(runtime, () => writes.some((entry) => entry.kind === "text"));
  await runtime.dispatch({ kind: "openActionPalette" });
  await runtime.dispatch({ kind: "actionPaletteSubmit", value: "open-external" });
  await waitUntil(runtime, () => writes.some((entry) => entry.kind === "openExternal"));

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
  await waitUntil(runtime, () => runtime.state().documents[0]?.snapshot.finalUrl === "about:newtab");
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
  await waitUntil(runtime, () => runtime.state().overlay?.kind === "downloadPrompt");
  assert.equal(runtime.state().documents[0].snapshot.content.title, "Index");
  assert.match(renderFramePlain(runtime.frame()), /Download resource\?/u);
  const dialogRows = new Set(runtime.frame().cells
    .filter((cell) => cell.source?.elementId === "download-prompt:surface")
    .map((cell) => cell.row));
  const backdropCell = runtime.frame().cells.find((cell) =>
    cell.source?.elementId?.startsWith("browser-page-surface-")
  );
  assert.ok(dialogRows.size > 0 && dialogRows.size < 9);
  assert.deepEqual(backdropCell?.style?.bg, { kind: "theme", token: "surface.backdrop" });
  assert.equal(backdropCell?.style?.dim, true);
  assert.equal(backdropCell?.link, undefined);

  await runtime.dispatch({ kind: "download", target: archiveUrl });
  await waitUntil(runtime, () => runtime.state().downloads[0]?.status === "completed");
  assert.ok(writes.some((entry) => entry.kind === "download" && entry.url === archiveUrl));
});

test("runTui owns the terminal lifecycle and exits through the app binding", async () => {
  const { runtime, prepared } = await fixture();
  await runtime.dispose();
  const harness = createTerminalHarness({ terminalSize: { columns: 100, rows: 24 } });
  const running = runTui(prepared.app, harness.host);
  await harness.input("q");
  const exit = await running;

  assert.equal(exit.status, "completed");
  assert.equal(exit.reason, "quit");
  assert.ok(harness.frames().length > 0);
  assert.equal(harness.restores().length, 1);
});
