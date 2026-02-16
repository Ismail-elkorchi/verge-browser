import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchPage, fetchPageStream, readByteStreamToText } from "../../dist/app/fetch-page.js";

test("fetchPage supports about:help without network", async () => {
  const page = await fetchPage("about:help");
  assert.equal(page.status, 200);
  assert.ok(page.html.includes("verge-browser"));
  assert.ok(page.html.includes("stream &lt;url&gt;"));
  assert.ok(page.html.includes("patch set-attr"));
});

test("fetchPage supports file URLs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-browser-"));

  try {
    const htmlPath = join(tempDir, "sample.html");
    await writeFile(htmlPath, "<html><body><h1>Local file</h1></body></html>", "utf8");

    const fileUrl = `file://${htmlPath}`;
    const page = await fetchPage(fileUrl);

    assert.equal(page.status, 200);
    assert.equal(page.finalUrl, fileUrl);
    assert.ok(page.html.includes("Local file"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fetchPageStream supports about:help without network", async () => {
  const page = await fetchPageStream("about:help");
  const html = await readByteStreamToText(page.stream);
  assert.equal(page.status, 200);
  assert.ok(html.includes("verge-browser"));
});

test("fetchPage blocks unsupported redirect protocols", async () => {
  const server = createServer((_, response) => {
    response.statusCode = 302;
    response.setHeader("location", "javascript:alert(1)");
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;

  try {
    await assert.rejects(fetchPage(url), /Blocked unsupported protocol/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage enforces maxContentBytes", async () => {
  const server = createServer((_, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<html><body>${"x".repeat(256)}</body></html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;

  try {
    await assert.rejects(fetchPage(url, 15_000, { maxContentBytes: 64 }), /maxContentBytes/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPageStream enforces maxContentBytes", async () => {
  const server = createServer((_, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<html><body>${"x".repeat(256)}</body></html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;

  try {
    const streamPage = await fetchPageStream(url, 15_000, { maxContentBytes: 64 });
    await assert.rejects(readByteStreamToText(streamPage.stream), /maxContentBytes/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage forwards request options and captures set-cookie headers", async () => {
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "sid=abc; Path=/; HttpOnly");
      response.end("<html><body><h1>posted</h1></body></html>");
      return;
    }
    response.statusCode = 405;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body>method not allowed</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/submit`;

  try {
    const page = await fetchPage(url, 15_000, undefined, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: "sid=seed"
      },
      bodyText: "q=alpha"
    });

    assert.equal(page.status, 200);
    assert.ok(page.html.includes("posted"));
    assert.deepEqual(page.setCookieHeaders, ["sid=abc; Path=/; HttpOnly"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
