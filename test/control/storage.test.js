import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { promisify } from "node:util";

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
        scrollAnchor: { target: { kind: "element-id", value: "content" }, rowOffset: 2, columnOffset: -17 }
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

const terminalSettingPath = (statePath, condition) => `${statePath}.terminal-${condition}.json`;
const kittySetting = { context: "context:kitty:direct:v1", condition: "kitty-force-ltr" };
const konsoleSetting = { context: "context:konsole:direct:v1", condition: "konsole-bidi-disabled" };

test("terminal setting assertions are explicit, exact-context, private and removable by condition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const store = await BrowserStore.open({ statePath });
  assert.deepEqual(store.terminalSettings(), []);
  assert.throws(() => { store.terminalSettings().push(kittySetting); }, TypeError);
  const remote = { ...kittySetting, context: "context:kitty:ssh:v1" };
  await store.rememberTerminalSetting(kittySetting);
  await store.rememberTerminalSetting(remote);
  assert.deepEqual(store.terminalSettings(), [remote]);
  await store.rememberTerminalSetting(konsoleSetting);
  await store.rememberTerminalSetting(kittySetting);
  assert.deepEqual(store.terminalSettings(), [kittySetting, konsoleSetting]);
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  await store.recordHistory("about:newtab", "New tab");
  await store.flush();
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, "utf8")), "terminalSettings"), false);
  const reopened = await BrowserStore.open({ statePath });
  assert.deepEqual(reopened.terminalSettings(), [kittySetting, konsoleSetting]);
  assert.throws(() => { reopened.terminalSettings()[0].context = "other"; }, TypeError);
  assert.throws(() => { reopened.terminalSettings().push(kittySetting); }, TypeError);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    for (const setting of [kittySetting, konsoleSetting]) {
      assert.equal((await stat(terminalSettingPath(statePath, setting.condition))).mode & 0o777, 0o600);
    }
  }
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.throws(() => { reopened.terminalSettings().push(kittySetting); }, TypeError);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.deepEqual(reopened.terminalSettings(), [kittySetting, konsoleSetting]);
  await BrowserStore.forgetTerminalSetting(konsoleSetting.condition, { statePath });
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), []);
});

test("terminal setting storage rejects malformed and oversized contexts without broadening context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const invalid = [null, {}, [], { context: "", condition: "kitty-force-ltr" },
    { context: "x".repeat(4097), condition: "kitty-force-ltr" },
    { context: "exact-context", condition: "trust-all" },
    { context: 7, condition: "kitty-force-ltr" }];
  const store = await BrowserStore.open({ statePath });
  await store.rememberTerminalSetting(konsoleSetting);
  for (const entry of invalid) {
    await assert.rejects(store.rememberTerminalSetting(entry), { message: "Invalid terminal setting assertion." });
    await writeFile(terminalSettingPath(statePath, kittySetting.condition), JSON.stringify(entry));
    assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
  }
  for (const condition of ["", "trust-all", "../state", undefined, null, 7]) {
    await assert.rejects(BrowserStore.forgetTerminalSetting(condition, { statePath }), { message: "Invalid terminal setting condition." });
  }
  for (const content of ["{ bad json", "", JSON.stringify(konsoleSetting), JSON.stringify([kittySetting])]) {
    await writeFile(terminalSettingPath(statePath, kittySetting.condition), content);
    assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
  }
  await writeFile(terminalSettingPath(statePath, kittySetting.condition), JSON.stringify({
    ...kittySetting, unexpected: "ignored", sessionAccepted: true
  }));
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [kittySetting, konsoleSetting]);
  assert.deepEqual(store.terminalSettings(), [konsoleSetting]);
});

test("terminal setting retention is one current context per condition, with bounded record bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-bounded-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const store = await BrowserStore.open({ statePath });
  await store.rememberTerminalSetting(konsoleSetting);
  for (let index = 0; index < 40; index += 1) {
    const setting = { ...kittySetting, context: `context-${index}` };
    await store.rememberTerminalSetting(setting);
    assert.deepEqual(store.terminalSettings(), [setting, konsoleSetting]);
  }
  // JSON escaping can use six bytes per code unit; the complete valid context still fits.
  const largest = { ...kittySetting, context: "\u0000".repeat(4096) };
  await store.rememberTerminalSetting(largest);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [largest, konsoleSetting]);
  assert.deepEqual((await readdir(directory)).sort(), [
    "state.json.terminal-kitty-force-ltr.json", "state.json.terminal-konsole-bidi-disabled.json"
  ]);
  assert.ok((await stat(terminalSettingPath(statePath, kittySetting.condition))).size <= 32 * 1024);
  await writeFile(terminalSettingPath(statePath, kittySetting.condition), " ".repeat(32 * 1024 + 1));
  await assert.rejects(BrowserStore.open({ statePath }), {
    message: `Terminal setting exceeds the 32768-byte safety limit: ${terminalSettingPath(statePath, kittySetting.condition)}`
  });
});

test("legacy inline terminal assertions are ignored and removed by browsing saves", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ terminalSettings: [kittySetting, konsoleSetting] }));
  const store = await BrowserStore.open({ statePath });
  assert.deepEqual(store.terminalSettings(), []);
  await store.rememberTerminalSetting(kittySetting);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  // Even before the legacy state is rewritten, it cannot resurrect a removed sidecar.
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), []);
  await store.recordHistory("about:newtab", "New tab");
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, "utf8")), "terminalSettings"), false);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), []);
});

test("stale browsing stores cannot erase, revert, or resurrect explicit terminal settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const beforeRemember = await BrowserStore.open({ statePath });
  const admin = await BrowserStore.open({ statePath });
  await admin.rememberTerminalSetting(kittySetting);
  await admin.rememberTerminalSetting(konsoleSetting);
  const beforeForget = await BrowserStore.open({ statePath });
  const replacement = { ...kittySetting, context: "context:kitty:replacement:v1" };
  await admin.rememberTerminalSetting(replacement);
  const unchangedBytes = await readFile(terminalSettingPath(statePath, kittySetting.condition), "utf8");
  await beforeRemember.recordHistory("https://example.test/before-remember", "Before remember");
  await beforeForget.recordHistory("https://example.test/before-forget", "Before forget");
  assert.equal(await readFile(terminalSettingPath(statePath, kittySetting.condition), "utf8"), unchangedBytes);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [replacement, konsoleSetting]);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  await beforeForget.recordHistory("https://example.test/after-forget", "After forget");
  await beforeForget.saveWorkspace({ documents: [], activeDocumentIndex: 0, sidePanel: null });
  await beforeForget.httpSession.acceptResponse({
    requestId: 1, attemptIndex: 0, url: "https://example.test/", method: "GET", statusCode: 200,
    statusMessage: "OK", fields: new HttpFields([{ name: "set-cookie", value: "sid=abc; Path=/" }])
  });
  await beforeForget.flush();
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
  await assert.rejects(readFile(terminalSettingPath(statePath, kittySetting.condition)), { code: "ENOENT" });
});

test("independent stores preserve concurrent mutations of different terminal conditions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const kittyStore = await BrowserStore.open({ statePath });
  const konsoleStore = await BrowserStore.open({ statePath });
  const browsingStore = await BrowserStore.open({ statePath });
  await Promise.all([
    kittyStore.rememberTerminalSetting(kittySetting),
    konsoleStore.rememberTerminalSetting(konsoleSetting),
    browsingStore.recordHistory("about:newtab", "New tab")
  ]);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [kittySetting, konsoleSetting]);
  const replacement = { ...konsoleSetting, context: "context:konsole:replacement:v1" };
  await Promise.all([
    BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath }),
    konsoleStore.rememberTerminalSetting(replacement),
    browsingStore.recordHistory("about:newtab", "New tab")
  ]);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [replacement]);
});

test("static condition revocation removes the current context without changing open snapshots", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const older = await BrowserStore.open({ statePath });
  await older.rememberTerminalSetting(kittySetting);
  const newer = await BrowserStore.open({ statePath });
  const replacement = { ...kittySetting, context: "context:kitty:newer:v1" };
  await newer.rememberTerminalSetting(replacement);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), []);
  await newer.rememberTerminalSetting(replacement);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [replacement]);
  assert.deepEqual(older.terminalSettings(), [kittySetting]);
  assert.equal(Object.hasOwn(BrowserStore.prototype, "forgetTerminalSetting"), false);
  await Promise.all([
    older.rememberTerminalSetting(kittySetting),
    older.rememberTerminalSetting(replacement)
  ]);
  await older.flush();
  assert.deepEqual(older.terminalSettings(), [replacement]);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [replacement]);
});

test("a separate running browser process cannot resurrect an administrator's revocation", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-process-"));
  const statePath = join(directory, "state.json");
  const storageUrl = new URL("../../dist/app/storage.js", import.meta.url).href;
  const setup = await BrowserStore.open({ statePath });
  await setup.rememberTerminalSetting(kittySetting);
  await setup.rememberTerminalSetting(konsoleSetting);
  const browser = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { BrowserStore } from ${JSON.stringify(storageUrl)};
    const store = await BrowserStore.open({ statePath: ${JSON.stringify(statePath)} });
    process.send({ phase: "opened", settings: store.terminalSettings() });
    process.once("message", async () => {
      try {
        await store.recordHistory("https://example.test/stale-process", "Stale browser");
        await store.flush();
        process.send({ phase: "saved" });
      } catch (error) {
        process.send({ phase: "failed", message: error.message });
        process.exitCode = 1;
      } finally {
        process.disconnect();
      }
    });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  browser.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = once(browser, "close");
  t.after(async () => {
    if (browser.exitCode === null) browser.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual((await once(browser, "message"))[0], {
    phase: "opened", settings: [kittySetting, konsoleSetting]
  });
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { BrowserStore } from ${JSON.stringify(storageUrl)};
    await BrowserStore.forgetTerminalSetting("kitty-force-ltr", { statePath: ${JSON.stringify(statePath)} });
  `]);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
  const saved = once(browser, "message");
  browser.send("save");
  assert.deepEqual((await saved)[0], { phase: "saved" });
  assert.equal((await closed)[0], 0, stderr);
  const reopened = await BrowserStore.open({ statePath });
  assert.deepEqual(reopened.terminalSettings(), [konsoleSetting]);
  assert.equal(reopened.listHistory()[0].url, "https://example.test/stale-process");
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, "utf8")), "terminalSettings"), false);
});

test("terminal sidecar reads tighten private permissions", {
  skip: process.platform === "win32" ? "Windows relies on the profile directory ACL" : false
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-permissions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  await writeFile(settingPath, JSON.stringify(kittySetting), { mode: 0o666 });
  await chmod(settingPath, 0o666);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [kittySetting]);
  assert.equal((await stat(settingPath)).mode & 0o777, 0o600);
});

test("terminal sidecars reject symlink reads while explicit mutations never follow targets", {
  skip: process.platform === "win32" ? "Windows symlink creation requires additional privileges" : false
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  const targetPath = join(directory, "target.json");
  const content = JSON.stringify(konsoleSetting);
  const store = await BrowserStore.open({ statePath });
  await writeFile(targetPath, content);
  await chmod(targetPath, 0o644);
  await symlink(targetPath, settingPath);
  await assert.rejects(BrowserStore.open({ statePath }), {
    message: `Terminal setting path must be a regular file: ${settingPath}`
  });
  assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.equal(await readFile(targetPath, "utf8"), content);
  await assert.rejects(readFile(settingPath), { code: "ENOENT" });
  await symlink(targetPath, settingPath);
  await store.rememberTerminalSetting(kittySetting);
  assert.equal(await readFile(targetPath, "utf8"), content);
  assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(settingPath, "utf8")), kittySetting);
  assert.equal((await stat(settingPath)).mode & 0o777, 0o600);
});

test("terminal mutations surface filesystem errors, preserve the other condition, and recover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const store = await BrowserStore.open({ statePath });
  await store.rememberTerminalSetting(konsoleSetting);
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  await mkdir(settingPath);
  await writeFile(join(settingPath, "keep.txt"), "must survive");
  await assert.rejects(BrowserStore.open({ statePath }), /Terminal setting path must be a regular file/u);
  // unlink/rename on a directory must not be mistaken for an absent assertion.
  const directoryError = (error) => ["EISDIR", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code);
  await assert.rejects(BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath }), directoryError);
  await assert.rejects(store.rememberTerminalSetting(kittySetting), directoryError);
  assert.equal((await stat(settingPath)).isDirectory(), true);
  assert.equal(await readFile(join(settingPath, "keep.txt"), "utf8"), "must survive");
  assert.deepEqual(store.terminalSettings(), [konsoleSetting]);
  assert.deepEqual(JSON.parse(await readFile(terminalSettingPath(statePath, konsoleSetting.condition), "utf8")), konsoleSetting);
  assert.equal((await readdir(directory)).some((name) => name.includes(".tmp-")), false);
  await rm(settingPath, { recursive: true });
  await store.rememberTerminalSetting(kittySetting);
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [kittySetting, konsoleSetting]);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), [konsoleSetting]);
});


test("static condition revocation recovers malformed and oversized assertions without opening state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  const otherPath = terminalSettingPath(statePath, konsoleSetting.condition);
  for (const content of ["{ bad json", " ".repeat(32 * 1024 + 1)]) {
    await writeFile(settingPath, content);
    if (content.length > 32 * 1024) {
      await assert.rejects(BrowserStore.open({ statePath }), /32768-byte safety limit/u);
    }
    await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
    await assert.rejects(readFile(settingPath), { code: "ENOENT" });
    assert.deepEqual((await BrowserStore.open({ statePath })).terminalSettings(), []);
  }
  // Recovery remains available when both unrelated browsing state and the other assertion
  // would make normal startup fail. Neither unrelated path is read or replaced.
  await mkdir(statePath);
  const unrelatedContent = " ".repeat(32 * 1024 + 1);
  await writeFile(otherPath, unrelatedContent);
  await writeFile(settingPath, JSON.stringify(kittySetting));
  await assert.rejects(BrowserStore.open({ statePath }), /Browser state path must be a regular file/u);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  await assert.rejects(readFile(settingPath), { code: "ENOENT" });
  assert.equal((await stat(statePath)).isDirectory(), true);
  assert.equal(await readFile(otherPath, "utf8"), unrelatedContent);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  assert.equal(await readFile(otherPath, "utf8"), unrelatedContent);
});

test("static condition revocation does not follow invalid unrelated symlinks", {
  skip: process.platform === "win32" ? "Windows symlink creation requires additional privileges" : false
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-recovery-symlinks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  const otherPath = terminalSettingPath(statePath, konsoleSetting.condition);
  const targetPath = join(directory, "target.json");
  const content = "{ unrelated invalid data";
  await writeFile(targetPath, content);
  await chmod(targetPath, 0o644);
  for (const path of [statePath, settingPath, otherPath]) await symlink(targetPath, path);
  await assert.rejects(BrowserStore.open({ statePath }), /Browser state path must be a regular file/u);
  await BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath });
  await assert.rejects(readFile(settingPath), { code: "ENOENT" });
  assert.equal(await readFile(statePath, "utf8"), content);
  assert.equal(await readFile(otherPath, "utf8"), content);
  assert.equal(await readFile(targetPath, "utf8"), content);
  assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
});

test("static condition revocation refuses an insecure caller-owned directory", {
  skip: process.platform === "win32" ? "Windows relies on directory ACLs rather than POSIX modes" : false
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-settings-recovery-permissions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const settingPath = terminalSettingPath(statePath, kittySetting.condition);
  const content = JSON.stringify(kittySetting);
  await writeFile(settingPath, content);
  await chmod(directory, 0o777);
  await assert.rejects(BrowserStore.forgetTerminalSetting(kittySetting.condition, { statePath }),
    /directory permissions must exclude group and other users/u);
  assert.equal(await readFile(settingPath, "utf8"), content);
  assert.equal((await stat(directory)).mode & 0o777, 0o777);
});
