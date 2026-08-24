import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { TextDecoder, TextEncoder } from "node:util";

import {
  NetworkFetchError,
  PageNetworkClient,
  closeClientWithStream,
  fetchPage,
  fetchPageStream,
  readByteStreamToText
} from "../../dist/app/fetch-page.js";
import {
  BrowserSession,
  openPageInitiatedNavigation
} from "../../dist/app/session.js";

function localClient() {
  return new PageNetworkClient({
    publicAddressPolicy: "allow-private-and-local"
  });
}

test("fetchPage supports about:help without network", async () => {
  const page = await fetchPage("about:help");
  assert.equal(page.status, 200);
  assert.equal(page.networkOutcome.kind, "ok");
  assert.ok(page.html.includes("verge-browser"));
  assert.ok(page.html.includes("save text &lt;path&gt;"));
  assert.ok(page.html.includes("Ctrl+L"));
});

test("byte-stream text reading releases its reader after a stream failure", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("stream failed"));
    }
  });

  await assert.rejects(readByteStreamToText(stream), /stream failed/u);
  assert.equal(stream.locked, false);
});

test("fetchPage supports file URLs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-browser-"));

  try {
    const htmlPath = join(tempDir, "sample.html");
    await writeFile(htmlPath, "<html><body><h1>Local file</h1></body></html>", "utf8");

    const fileUrl = pathToFileURL(htmlPath).href;
    const page = await fetchPage(fileUrl);

    assert.equal(page.status, 200);
    assert.equal(page.finalUrl, fileUrl);
    assert.equal(page.networkOutcome.kind, "ok");
    assert.ok(page.html.includes("Local file"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local file navigation enforces the transport budget before returning content", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "verge-browser-file-limit-"));
  const htmlPath = join(tempDir, "large.html");
  await writeFile(htmlPath, "x".repeat(4096), "utf8");

  try {
    await assert.rejects(
      fetchPage(pathToFileURL(htmlPath).href, 15_000, { maxContentBytes: 32 }),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "size_limit"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fetchPageStream supports about:help without network", async () => {
  const page = await fetchPageStream("about:help");
  assert.equal(page.networkOutcome.kind, "ok");
  const html = await readByteStreamToText(page.stream);
  assert.equal(page.status, 200);
  assert.ok(html.includes("verge-browser"));
});

test("a failed stream cancellation still destroys its operation-scoped client", async () => {
  let destroyCalls = 0;
  const upstream = new ReadableStream({
    cancel() {
      throw new Error("underlying cancellation failed");
    }
  });
  const stream = closeClientWithStream(upstream, {
    async close() {},
    async destroy() {
      destroyCalls += 1;
    }
  });

  await assert.rejects(stream.cancel("stop"), /underlying cancellation failed/u);
  assert.equal(destroyCalls, 1);
  assert.equal(upstream.locked, false);
});

test("operation-scoped stream completion releases the upstream reader lock", async () => {
  let closeCalls = 0;
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("complete"));
      controller.close();
    }
  });
  const stream = closeClientWithStream(upstream, {
    async close() { closeCalls += 1; },
    async destroy() { throw new Error("unexpected destroy"); }
  });

  assert.equal(await readByteStreamToText(stream), "complete");
  assert.equal(closeCalls, 1);
  assert.equal(upstream.locked, false);
});

test("network clients allow direct local navigation but block local subresources", async () => {
  const server = createServer((_, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<p>local</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${String(address.port)}/`;
  const client = new PageNetworkClient();

  try {
    await assert.rejects(
      client.fetchPage(url),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "network_block"
    );
    await assert.rejects(
      client.fetchStylesheet(url),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "network_block"
    );
    const page = await client.navigatePage(url);
    assert.equal(page.status, 200);
    assert.match(page.html, /local/u);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("BrowserSession does not grant private-network access to links or forms", async () => {
  let privateRequests = 0;
  const privateServer = createServer((_, response) => {
    privateRequests += 1;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<p>private service</p>");
  });
  await new Promise((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
  const privateAddress = privateServer.address();
  assert.ok(privateAddress && typeof privateAddress === "object");
  const privateUrl = `http://127.0.0.1:${String(privateAddress.port)}/private`;

  const sourceServer = createServer((_, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<a href="${privateUrl}">Private</a>`);
  });
  await new Promise((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const sourceAddress = sourceServer.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  const sourceUrl = `http://127.0.0.1:${String(sourceAddress.port)}/`;
  const session = new BrowserSession();

  try {
    await session.open(sourceUrl);
    await assert.rejects(
      session.openLink(1),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "network_block"
    );
    await assert.rejects(
      openPageInitiatedNavigation(session, sourceUrl, privateUrl, {
        method: "POST",
        bodyText: "action=delete"
      }),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "network_block"
    );
    assert.equal(privateRequests, 0);

    const explicit = await session.open(privateUrl);
    assert.match(explicit.document.text(explicit.document.body), /private service/u);
    assert.equal(privateRequests, 1);
  } finally {
    await session.destroy();
    await new Promise((resolve) => sourceServer.close(resolve));
    await new Promise((resolve) => privateServer.close(resolve));
  }
});

test("stylesheet HTTP errors cancel their response bodies before client shutdown", async () => {
  const server = createServer((_, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "text/css");
    response.write("body { color: red }");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = localClient();

  try {
    await assert.rejects(
      client.fetchStylesheet(`http://127.0.0.1:${String(address.port)}/missing.css`),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "http_error"
    );
    await Promise.race([
      client.close(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("HTTP client retained the rejected stylesheet body")),
        1_000
      ))
    ]);
  } finally {
    await client.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("BrowserSession streams transport bytes through HTML encoding detection", async () => {
  const server = createServer((_, response) => {
    response.setHeader(
      "content-type",
      "text/html; charset=windows-1252"
    );
    response.end(Buffer.from([
      ...Buffer.from("<title>"),
      0x80,
      ...Buffer.from("</title><p>encoded</p>")
    ]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = localClient();
  const session = new BrowserSession({ networkClient: client });

  try {
    const snapshot = await session.open(
      `http://127.0.0.1:${String(address.port)}/`
    );
    assert.equal(snapshot.document.title, "€");
    assert.equal(snapshot.document.sourceMetadata.encoding, "windows-1252");
    assert.equal(snapshot.document.sourceMetadata.encodingSource, "transport");
  } finally {
    await session.close();
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetch helpers reject invalid runtime configuration before network activity", async () => {
  assert.throws(
    () => new PageNetworkClient({ publicAddressPolicy: "unknown" }),
    /publicAddressPolicy/u
  );
  assert.throws(
    () => new PageNetworkClient({
      transport: {
        networkSafety: {
          allowLocalhost: true
        }
      }
    }),
    /transport\.networkSafety/u
  );
  await assert.rejects(
    fetchPage("about:help", 0),
    /timeoutMs must be a positive safe integer/u
  );
  await assert.rejects(
    fetchPage("about:help", 15_000, { maxRequestRetries: -1 }),
    /maxRequestRetries must be a non-negative safe integer/u
  );
  await assert.rejects(
    fetchPage("about:help", 15_000, { unexpected: true }),
    /Unknown security policy option: unexpected/u
  );
  await assert.rejects(
    fetchPage("about:help", 15_000, undefined, {
      method: "GET",
      bodyText: "not permitted"
    }),
    /GET requests cannot contain bodyText/u
  );
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
  const client = localClient();

  try {
    await assert.rejects(
      client.fetchPage(url),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "unsupported_protocol"
    );
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage does not forward credentials across redirect origins", async () => {
  let redirectedHeaders;
  const destination = createServer((request, response) => {
    redirectedHeaders = request.headers;
    response.statusCode = 200;
    response.setHeader("content-type", "text/html");
    response.end("<p>redirected</p>");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const destinationAddress = destination.address();
  if (!destinationAddress || typeof destinationAddress === "string") {
    throw new Error("destination address unavailable");
  }
  const source = createServer((_, response) => {
    response.statusCode = 302;
    response.setHeader(
      "location",
      `http://127.0.0.1:${String(destinationAddress.port)}/result`
    );
    response.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceAddress = source.address();
  if (!sourceAddress || typeof sourceAddress === "string") {
    throw new Error("source address unavailable");
  }
  const client = localClient();

  try {
    await client.fetchPage(`http://127.0.0.1:${String(sourceAddress.port)}/start`, 15_000, undefined, {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-browser-test": "retained"
      }
    });
    assert.equal(redirectedHeaders?.authorization, undefined);
    assert.equal(redirectedHeaders?.cookie, undefined);
    assert.equal(redirectedHeaders?.["x-browser-test"], "retained");
  } finally {
    await client.close();
    await Promise.all([
      new Promise((resolve) => source.close(resolve)),
      new Promise((resolve) => destination.close(resolve))
    ]);
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
  const client = localClient();

  try {
    await assert.rejects(
      client.fetchPage(url, 15_000, { maxContentBytes: 64 }),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "size_limit"
    );
  } finally {
    await client.close();
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
  const client = localClient();

  try {
    const streamPage = await client.fetchPageStream(url, 15_000, { maxContentBytes: 64 });
    await assert.rejects(readByteStreamToText(streamPage.stream), /maxContentBytes/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchStylesheet preserves transport bytes and encoding evidence", async () => {
  const css = "@charset \"windows-1252\";p{color:red}";
  const server = createServer((_, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/css; charset=windows-1252");
    response.end(css);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const client = localClient();
  try {
    const result = await client.fetchStylesheet(`http://127.0.0.1:${String(address.port)}/site.css`);
    assert.equal(new TextDecoder().decode(result.bytes), css);
    assert.equal(result.transportEncodingLabel, "windows-1252");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchStylesheet rejects invalid media types and oversized payloads", async () => {
  const server = createServer((request, response) => {
    response.statusCode = 200;
    if (request.url === "/wrong") {
      response.setHeader("content-type", "text/html");
      response.end("<p>not CSS</p>");
      return;
    }
    response.setHeader("content-type", "text/css");
    response.end("p{}".padEnd(128, " "));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const base = `http://127.0.0.1:${String(address.port)}`;
  const client = localClient();
  try {
    await assert.rejects(
      client.fetchStylesheet(`${base}/wrong`),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "content_type_block"
    );
    await assert.rejects(
      client.fetchStylesheet(`${base}/large`, 15_000, { maxContentBytes: 32 }),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "size_limit"
    );
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage classifies timeout deterministically", async () => {
  const server = createServer((_, response) => {
    setTimeout(() => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<html><body>slow</body></html>");
    }, 200);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;
  const client = localClient();

  try {
    await assert.rejects(
      client.fetchPage(url, 10),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "timeout"
    );
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage stops a pending request when the caller aborts", async () => {
  const server = createServer((_, response) => {
    setTimeout(() => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<html><body>late</body></html>");
    }, 200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const controller = new globalThis.AbortController();
  const reason = new Error("navigation replaced");
  const client = localClient();
  const pending = client.fetchPage(
    `http://127.0.0.1:${String(address.port)}/`,
    15_000,
    undefined,
    { signal: controller.signal }
  );
  controller.abort(reason);
  try {
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage marks HTTP failures as http_error while returning body", async () => {
  const server = createServer((_, response) => {
    response.statusCode = 403;
    response.statusMessage = "Forbidden";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body><h1>blocked</h1></body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;
  const client = localClient();

  try {
    const page = await client.fetchPage(url);
    assert.equal(page.status, 403);
    assert.equal(page.networkOutcome.kind, "http_error");
    assert.ok(page.html.includes("blocked"));
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("PageNetworkClient reuses connections across requests", async () => {
  let connectionCount = 0;
  const server = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<p>reused</p>");
  });
  server.on("connection", () => {
    connectionCount += 1;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const client = localClient();
  const url = `http://127.0.0.1:${String(address.port)}/`;
  try {
    for (let index = 0; index < 8; index += 1) {
      await client.fetchPage(url);
    }
    assert.equal(connectionCount <= 4, true);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage preserves repeated response fields", async () => {
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", [
        "sid=abc; Path=/; HttpOnly",
        "theme=dark; Path=/"
      ]);
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
  const client = localClient();

  try {
    const page = await client.fetchPage(url, 15_000, undefined, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: "sid=seed"
      },
      bodyText: "q=alpha"
    });

    assert.equal(page.status, 200);
    assert.equal(page.networkOutcome.kind, "ok");
    assert.ok(page.html.includes("posted"));
    assert.deepEqual(page.responseFields.all("set-cookie"), [
      "sid=abc; Path=/; HttpOnly",
      "theme=dark; Path=/"
    ]);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
