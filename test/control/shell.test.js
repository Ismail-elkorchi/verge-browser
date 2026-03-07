import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { BrowserShell } from "../../dist/ui/shell.js";

class FakeTerminalAdapter {
  constructor() {
    this.columns = 100;
    this.rows = 24;
    this.output = "";
    this.cursor = null;
    this.keypressListener = null;
    this.resizeListener = null;
  }

  getSize() {
    return {
      columns: this.columns,
      rows: this.rows
    };
  }

  clearScreen() {
    this.output = "";
  }

  write(text) {
    this.output = text;
  }

  moveCursor(position) {
    this.cursor = position;
  }

  hideCursor() {}

  showCursor() {}

  setRawMode() {}

  onKeypress(listener) {
    this.keypressListener = listener;
    return () => {
      this.keypressListener = null;
    };
  }

  onResize(listener) {
    this.resizeListener = listener;
    return () => {
      this.resizeListener = null;
    };
  }

  dispose() {}
}

function key(sequence, extra = {}) {
  return {
    sequence,
    ...extra
  };
}

function createLoader(htmlMap) {
  return async (requestUrl, requestOptions = {}) => {
    const currentUrl = new globalThis.URL(requestUrl);
    const lookupUrl = currentUrl.search ? requestUrl : currentUrl.toString();
    const html = htmlMap.get(lookupUrl);
    if (!html) {
      throw new Error(`Missing fixture for ${lookupUrl}`);
    }
    return {
      requestUrl,
      finalUrl: lookupUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html,
      responseHeaders: {
        "content-type": "text/html"
      },
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

async function createShellFixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "verge-browser-shell-test-"));
  const store = await BrowserStore.open({
    statePath: join(stateDirectory, "state.json")
  });
  const adapter = new FakeTerminalAdapter();
  const htmlMap = new Map([
    [
      "https://example.test/",
      "<html><head><title>Index</title></head><body><h1>Index</h1><p><a href=\"/next\">Next page</a></p><form action=\"/search\" method=\"get\"><input name=\"q\" value=\"alpha\"><textarea name=\"notes\">hello</textarea></form></body></html>"
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
  const services = {
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
  };

  const shell = new BrowserShell({
    adapter,
    store,
    services,
    createSession: () => new BrowserSession({
      loader: createLoader(htmlMap),
      widthProvider: () => adapter.getSize().columns
    })
  });

  await shell.runOnce("https://example.test/");

  return {
    shell,
    adapter,
    writes
  };
}

test("BrowserShell opens links directly from browse mode and supports history back", async () => {
  const { shell } = await createShellFixture();

  await shell.handleKeypress("]", key("]"));
  assert.equal(shell.getState().documents[0].focusMode, "link-control");

  await shell.handleKeypress("\r", key("\r", { name: "return" }));
  assert.equal(shell.getState().documents[0].snapshot.finalUrl, "https://example.test/next");

  await shell.handleKeypress("h", key("h"));
  assert.equal(shell.getState().documents[0].snapshot.finalUrl, "https://example.test/");
});

test("BrowserShell opens the links picker and activates the selected item", async () => {
  const { shell } = await createShellFixture();

  await shell.handleKeypress("l", key("l"));
  assert.equal(shell.getState().screen, "picker");
  assert.equal(shell.getState().picker.kind, "links");

  await shell.handleKeypress("\r", key("\r", { name: "return" }));
  assert.equal(shell.getState().screen, "browse");
  assert.equal(shell.getState().documents[0].snapshot.finalUrl, "https://example.test/next");
});

test("BrowserShell keeps form editing in the new editor flow and submits edited values", async () => {
  const { shell } = await createShellFixture();

  await shell.handleKeypress("]", key("]"));
  await shell.handleKeypress("]", key("]"));
  assert.equal(shell.getState().documents[0].linkControlFocus.actionableIndex, 1);

  await shell.handleKeypress("\r", key("\r", { name: "return" }));
  assert.equal(shell.getState().screen, "editor");

  await shell.handleKeypress("\r", key("\r", { name: "return" }));
  await shell.handleKeypress("Z", key("Z", { shift: true }));
  await shell.handleKeypress("", key("\t", { name: "tab" }));
  await shell.handleKeypress("\r", key("\r", { name: "return" }));
  await shell.handleKeypress("X", key("X", { shift: true }));
  await shell.handleKeypress("", key("\u001b", { name: "escape" }));

  assert.equal(shell.getState().screen, "editor");
  assert.equal(shell.getState().editor.mode, "select");

  await shell.handleKeypress("s", key("s"));
  assert.equal(shell.getState().screen, "browse");
  assert.equal(shell.getState().documents[0].snapshot.finalUrl, "https://example.test/search?q=alphaZ&notes=hello%0AX");
});

test("BrowserShell opens the focused link in a new document and can close it", async () => {
  const { shell } = await createShellFixture();

  await shell.handleKeypress("]", key("]"));
  await shell.handleKeypress("t", key("t"));

  assert.equal(shell.getState().documents.length, 2);
  assert.equal(shell.getState().documents[1].snapshot.finalUrl, "https://example.test/next");

  await shell.handleKeypress("x", key("x"));
  assert.equal(shell.getState().documents.length, 1);

  await shell.handleKeypress("u", key("u"));
  assert.equal(shell.getState().documents.length, 2);
  assert.equal(shell.getState().documents[1].snapshot.finalUrl, "https://example.test/next");
});
