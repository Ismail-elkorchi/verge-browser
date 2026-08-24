import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserStore, readBrowserStateFile } from "../../dist/app/storage.js";

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
        scrollAnchor: { target: { kind: "element-id", value: "content" }, rowOffset: 2 }
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

test("BrowserStore restricts persisted browsing data and cookie permissions", {
  skip: process.platform === "win32" ? "Windows relies on the profile directory ACL" : false
}, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-permissions-"));
  const stateDirectory = join(tempDir, "verge-browser");
  const statePath = join(stateDirectory, "state.json");

  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o777 });
    await writeFile(statePath, "{}\n", { encoding: "utf8", mode: 0o666 });
    await chmod(stateDirectory, 0o777);
    await chmod(statePath, 0o666);

    const store = await BrowserStore.open({ statePath });
    await store.httpSession.acceptResponse({
      requestId: 1,
      attemptIndex: 0,
      url: "https://example.test/",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      fields: new HttpFields([
        { name: "set-cookie", value: "session=secret; Path=/; HttpOnly" }
      ])
    });

    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore rejects an insecure caller-owned state directory without changing it", {
  skip: process.platform === "win32" ? "Windows relies on directory ACLs rather than POSIX modes" : false
}, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-insecure-parent-"));
  const stateDirectory = join(tempDir, "shared-profile");
  const statePath = join(stateDirectory, "state.json");

  try {
    await mkdir(stateDirectory, { mode: 0o777 });
    await chmod(stateDirectory, 0o777);
    await assert.rejects(
      BrowserStore.open({ statePath }),
      /directory permissions must exclude group and other users/u
    );
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o777);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore bounds remote page text and restored workspace size", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-bounds-"));
  const statePath = join(tempDir, "state.json");

  try {
    const store = await BrowserStore.open({ statePath, indexLimit: Number.POSITIVE_INFINITY });
    await store.recordIndexDocument(
      "https://example.test/large",
      "Large",
      `needle ${"x".repeat(80 * 1024)} tail-marker`
    );
    await store.saveWorkspace({
      documents: Array.from({ length: 75 }, (_, index) => ({
        url: `https://example.test/${String(index)}`,
        scrollAnchor: { target: null, rowOffset: 0 }
      })),
      activeDocumentIndex: 74,
      sidePanel: null
    });

    const payload = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(payload.indexDocuments[0].text.length, 16 * 1024);
    assert.equal(payload.indexDocuments[0].text.includes("tail-marker"), false);
    assert.equal(payload.workspace.documents.length, 50);
    assert.equal(payload.workspace.activeDocumentIndex, 49);
    assert.equal(store.searchIndex("needle needle")[0]?.score, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore canonicalizes attacker-controlled persisted collections before replacement", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-canonical-"));
  const statePath = join(tempDir, "state.json");
  const oversized = "x".repeat(20 * 1024);
  const download = (index) => ({
    id: `download-${String(index)}`,
    url: `https://example.test/${oversized}`,
    fileName: oversized,
    destinationPath: `/tmp/${oversized}`,
    status: "completed",
    receivedBytes: 1,
    totalBytes: 1,
    error: oversized,
    startedAtIso: `2026-01-01T00:00:00.000Z${oversized}`,
    updatedAtIso: `2026-01-01T00:00:00.000Z${oversized}`,
    unexpected: oversized
  });

  try {
    await writeFile(statePath, JSON.stringify({
      bookmarks: [],
      history: [],
      indexDocuments: [],
      downloads: Array.from({ length: 205 }, (_, index) => download(index)),
      workspace: {
        documents: [{
          url: "https://example.test/",
          scrollAnchor: {
            target: { kind: "element-id", value: oversized.slice(0, 512) },
            rowOffset: Number.MAX_SAFE_INTEGER
          }
        }],
        activeDocumentIndex: 0,
        sidePanel: null
      },
      cookieJar: {
        version: "tough-cookie@6.0.2",
        storeType: "MemoryCookieStore",
        rejectPublicSuffixes: true,
        enableLooseMode: false,
        allowSpecialUseDomain: true,
        prefixSecurity: "silent",
        unexpected: oversized,
        cookies: [{
          key: "sid",
          value: "secret",
          domain: "example.test",
          path: "/",
          hostOnly: true,
          creation: "2026-01-01T00:00:00.000Z",
          lastAccessed: "2026-01-01T00:00:00.000Z"
        }, {
          key: "unsafe-none",
          value: "secret",
          domain: "example.test",
          path: "/",
          hostOnly: true,
          sameSite: "none",
          creation: "2026-01-01T00:00:00.000Z",
          lastAccessed: "2026-01-01T00:00:00.000Z"
        }]
      }
    }), "utf8");

    const store = await BrowserStore.open({ statePath });
    assert.equal(store.listDownloads().length, 200);
    assert.equal(store.workspace()?.documents[0]?.scrollAnchor.target.value.length, 512);
    assert.equal(store.workspace()?.documents[0]?.scrollAnchor.rowOffset, 10_000_000);
    assert.equal(store.listCookies().length, 1);

    await store.recordHistory("https://example.test/", "Example", oversized);
    const replaced = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(replaced.downloads.length, 200);
    assert.ok(replaced.downloads.every((entry) => entry.url.length <= 8 * 1024));
    assert.ok(replaced.downloads.every((entry) => entry.destinationPath.length <= 16 * 1024));
    assert.ok(replaced.downloads.every((entry) => entry.error.length <= 2048));
    assert.ok(replaced.downloads.every((entry) => !Object.hasOwn(entry, "unexpected")));
    assert.equal(replaced.history[0].excerpt.length, 220);
    assert.equal(Object.hasOwn(replaced.cookieJar, "unexpected"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BrowserStore refuses a symlink in place of the credential-bearing state file", {
  skip: process.platform === "win32" ? "Windows symlink creation requires additional privileges" : false
}, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-symlink-"));
  const stateDirectory = join(tempDir, "profile");
  const statePath = join(stateDirectory, "state.json");
  const targetPath = join(tempDir, "target.json");

  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(targetPath, "{}\n", "utf8");
    await symlink(targetPath, statePath);
    await assert.rejects(
      BrowserStore.open({ statePath }),
      /state path must be a regular file/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("state loading reads the same file handle that passed validation", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-store-race-"));
  const statePath = join(tempDir, "state.json");
  const originalPath = join(tempDir, "original.json");
  const replacementPath = join(tempDir, "replacement.json");

  try {
    await writeFile(statePath, '{"marker":"original"}\n', "utf8");
    await writeFile(replacementPath, '{"marker":"replacement"}\n', "utf8");
    const loaded = await readBrowserStateFile(statePath, async () => {
      await rename(statePath, originalPath);
      await rename(replacementPath, statePath);
    });

    assert.equal(JSON.parse(loaded).marker, "original");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).marker, "replacement");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
