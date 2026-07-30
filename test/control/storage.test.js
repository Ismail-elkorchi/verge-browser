import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserStore } from "../../dist/app/storage.js";

test("BrowserStore persists bookmarks and history", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-"));
  const statePath = join(tempDir, "state.json");

  try {
    const store = await BrowserStore.open({ statePath, historyLimit: 3 });

    await store.addBookmark("https://example.com/", "Example");
    await store.addBookmark("https://example.com/docs", "Docs");
    await store.addBookmark("https://example.com/", "Example Updated");

    await store.recordHistory("https://example.com/", "Example");
    await store.recordHistory("https://example.com/docs", "Docs");
    await store.recordHistory("https://example.com/about", "About");
    await store.recordHistory("https://example.com/blog", "Blog");
    await store.httpSession.acceptResponse({
      requestId: 1,
      attemptIndex: 0,
      url: "https://example.com/",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      fields: new HttpFields([
        { name: "set-cookie", value: "sid=abc; Path=/; HttpOnly" }
      ])
    });
    await store.recordIndexDocument("https://example.com/docs", "Docs", "alpha beta gamma");
    await store.recordIndexDocument("https://example.com/about", "About", "beta delta");

    const bookmarkNames = store.listBookmarks().map((bookmark) => bookmark.name);
    assert.deepEqual(bookmarkNames, ["Example Updated", "Docs"]);

    const historyUrls = store.listHistory().map((entry) => entry.url);
    assert.deepEqual(historyUrls, [
      "https://example.com/blog",
      "https://example.com/about",
      "https://example.com/docs"
    ]);

    assert.equal(store.listCookies().length, 1);
    const prepared = await store.httpSession.prepareRequest({
      requestId: 2,
      attemptIndex: 0,
      url: "https://example.com/path",
      method: "GET",
      fields: new HttpFields()
    });
    assert.deepEqual(prepared, [{ name: "cookie", value: "sid=abc" }]);

    const searchResults = store.searchIndex("beta");
    assert.equal(searchResults.length, 2);
    assert.equal(searchResults[0]?.title, "About");

    const statePayload = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(Array.isArray(statePayload.bookmarks));
    assert.ok(Array.isArray(statePayload.history));
    assert.ok(Array.isArray(statePayload.cookieJar.cookies));
    assert.ok(Array.isArray(statePayload.indexDocuments));

    const reopened = await BrowserStore.open({ statePath });
    assert.equal(reopened.listCookies()[0]?.name, "sid");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore recovers from corrupted JSON state file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-corrupt-"));
  const statePath = join(tempDir, "state.json");

  try {
    await writeFile(statePath, "{ bad json", "utf8");

    const store = await BrowserStore.open({ statePath, historyLimit: 2 });
    assert.deepEqual(store.listBookmarks(), []);
    assert.deepEqual(store.listHistory(), []);

    await store.recordHistory("https://example.com/", "Example");
    const payload = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(payload.history[0].url, "https://example.com/");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore serializes concurrent history, workspace, and download writes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-concurrent-"));
  const statePath = join(tempDir, "state.json");

  try {
    const store = await BrowserStore.open({ statePath });
    const download = {
      id: "download-1",
      url: "https://example.com/archive.zip",
      fileName: "archive.zip",
      destinationPath: null,
      status: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      startedAtIso: "2026-01-01T00:00:00.000Z",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    };
    const workspace = {
      documents: [{
        url: "https://example.com/",
        scrollAnchor: { blockId: "block:1", rowOffset: 2 }
      }],
      activeDocumentIndex: 0,
      sidePanel: "downloads"
    };

    await Promise.all([
      store.recordHistory("https://example.com/", "Example"),
      store.saveWorkspace(workspace),
      store.upsertDownload(download)
    ]);

    const reopened = await BrowserStore.open({ statePath });
    assert.deepEqual(reopened.workspace(), workspace);
    assert.equal(reopened.listHistory()[0]?.url, "https://example.com/");
    assert.equal(reopened.listDownloads()[0]?.status, "interrupted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
