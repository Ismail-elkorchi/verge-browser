import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { parse } from "html-parser";

import { CorpusRecorder } from "../../dist/app/realworld.js";

function buildSnapshot(html, finalUrl = "https://example.com/page") {
  return {
    requestUrl: finalUrl,
    finalUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    responseHeaders: {},
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    setCookieHeaders: [],
    tree: parse(html),
    rendered: {
      title: "sample",
      displayUrl: finalUrl,
      statusLine: "200 OK",
      lines: [],
      links: [],
      parseErrorCount: 0,
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    },
    sourceHtml: html,
    diagnostics: {
      parseMode: "text",
      sourceBytes: html.length,
      parseErrorCount: 0,
      traceEventCount: 0,
      traceKinds: [],
      requestMethod: "GET",
      fetchDurationMs: 1,
      parseDurationMs: 1,
      renderDurationMs: 1,
      totalDurationMs: 3,
      usedCookies: false,
      networkOutcome: {
        kind: "ok",
        finalUrl,
        status: 200,
        statusText: "OK",
        detailCode: null,
        detailMessage: "ok"
      },
      triageIds: []
    }
  };
}

async function readNdjson(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("CorpusRecorder blocks unsupported stylesheet schemes without fetch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-realworld-scheme-"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new globalThis.Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    };

    const recorder = new CorpusRecorder({ baseDir: tempDir });
    const html = "<html><body><link rel='stylesheet' href='file:///tmp/blocked.css'></body></html>";
    await recorder.recordNavigation(buildSnapshot(html));

    assert.equal(fetchCalls, 0);
    const cssRecords = await readNdjson(resolve(tempDir, "manifests/css.ndjson"));
    const linked = cssRecords.find((record) => record.kind === "linked");
    assert.equal(linked?.skipReason, "blocked-url-scheme:file:");
    assert.equal(linked?.sha256, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CorpusRecorder blocks cross-host linked stylesheets deterministically", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-realworld-host-"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new globalThis.Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    };

    const recorder = new CorpusRecorder({ baseDir: tempDir });
    const html = "<html><body><link rel='stylesheet' href='https://evil.example/style.css'></body></html>";
    await recorder.recordNavigation(buildSnapshot(html, "https://safe.example/page"));

    assert.equal(fetchCalls, 0);
    const cssRecords = await readNdjson(resolve(tempDir, "manifests/css.ndjson"));
    const linked = cssRecords.find((record) => record.kind === "linked");
    assert.equal(linked?.skipReason, "blocked-url-host:evil.example");
    assert.equal(linked?.sha256, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CorpusRecorder emits stable request-error and caches allowed same-host CSS", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-realworld-fetch-"));
  const originalFetch = globalThis.fetch;

  try {
    let mode = "fail";
    globalThis.fetch = async () => {
      if (mode === "fail") {
        throw new Error("network down");
      }
      return new globalThis.Response("body { color: red; }", { status: 200, headers: { "content-type": "text/css" } });
    };

    const recorder = new CorpusRecorder({ baseDir: tempDir });
    const html = "<html><body><link rel='stylesheet' href='/ok.css'></body></html>";
    await recorder.recordNavigation(buildSnapshot(html, "https://example.com/page"));
    const failedRecords = await readNdjson(resolve(tempDir, "manifests/css.ndjson"));
    const failedLinked = failedRecords.find((record) => record.kind === "linked");
    assert.equal(failedLinked?.skipReason, "request-error");
    assert.equal(failedLinked?.sha256, null);

    mode = "ok";
    await recorder.recordNavigation(buildSnapshot(html, "https://example.com/other"));
    const records = await readNdjson(resolve(tempDir, "manifests/css.ndjson"));
    const successfulLinked = records.find((record) => record.kind === "linked" && record.sha256);
    assert.ok(successfulLinked?.sha256);

    const cssFiles = await readdir(resolve(tempDir, "cache/css"));
    assert.ok(cssFiles.some((name) => name.endsWith(".css")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});
