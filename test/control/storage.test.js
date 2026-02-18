import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
    await store.applySetCookieHeaders("https://example.com/", ["sid=abc; Path=/; HttpOnly"]);
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

    assert.equal(store.latestHistoryUrl(), "https://example.com/blog");
    assert.equal(store.listCookies().length, 1);
    assert.equal(store.cookieHeaderForUrl("https://example.com/path"), "sid=abc");

    const searchResults = store.searchIndex("beta");
    assert.equal(searchResults.length, 2);
    assert.equal(searchResults[0]?.title, "About");

    const statePayload = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(statePayload.version, 2);
    assert.ok(Array.isArray(statePayload.bookmarks));
    assert.ok(Array.isArray(statePayload.history));
    assert.ok(Array.isArray(statePayload.cookies));
    assert.ok(Array.isArray(statePayload.indexDocuments));
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
