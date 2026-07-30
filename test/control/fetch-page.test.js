import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextDecoder } from "node:util";

import {
  NetworkFetchError,
  PageNetworkClient,
  fetchPage,
  fetchPageStream,
  fetchStylesheet,
  readByteStreamToText
} from "../../dist/app/fetch-page.js";

test("fetchPage supports about:help without network", async () => {
  const page = await fetchPage("about:help");
  assert.equal(page.status, 200);
  assert.equal(page.networkOutcome.kind, "ok");
  assert.ok(page.html.includes("verge-browser"));
  assert.ok(page.html.includes("save text &lt;path&gt;"));
  assert.ok(page.html.includes("Ctrl+L"));
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
    assert.equal(page.networkOutcome.kind, "ok");
    assert.ok(page.html.includes("Local file"));
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

test("fetch helpers reject invalid runtime configuration before network activity", async () => {
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

  try {
    await assert.rejects(
      fetchPage(url),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "unsupported_protocol"
    );
  } finally {
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

  try {
    await fetchPage(`http://127.0.0.1:${String(sourceAddress.port)}/start`, 15_000, undefined, {
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

  try {
    await assert.rejects(
      fetchPage(url, 15_000, { maxContentBytes: 64 }),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "size_limit"
    );
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
  try {
    const result = await fetchStylesheet(`http://127.0.0.1:${String(address.port)}/site.css`);
    assert.equal(new TextDecoder().decode(result.bytes), css);
    assert.equal(result.transportEncodingLabel, "windows-1252");
  } finally {
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
  try {
    await assert.rejects(
      fetchStylesheet(`${base}/wrong`),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "content_type_block"
    );
    await assert.rejects(
      fetchStylesheet(`${base}/large`, 15_000, { maxContentBytes: 32 }),
      (error) => error instanceof NetworkFetchError
        && error.networkOutcome.kind === "size_limit"
    );
  } finally {
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

  try {
    await assert.rejects(
      fetchPage(url, 10),
      (error) => error instanceof NetworkFetchError && error.networkOutcome.kind === "timeout"
    );
  } finally {
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
  const pending = fetchPage(
    `http://127.0.0.1:${String(address.port)}/`,
    15_000,
    undefined,
    { signal: controller.signal }
  );
  controller.abort(reason);
  try {
    await assert.rejects(pending, (error) => error === reason);
  } finally {
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

  try {
    const page = await fetchPage(url);
    assert.equal(page.status, 403);
    assert.equal(page.networkOutcome.kind, "http_error");
    assert.ok(page.html.includes("blocked"));
  } finally {
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
  const client = new PageNetworkClient();
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

test("fetchPage forwards request options and captures set-cookie headers", async () => {
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
    assert.equal(page.networkOutcome.kind, "ok");
    assert.ok(page.html.includes("posted"));
    assert.deepEqual(page.setCookieHeaders, [
      "sid=abc; Path=/; HttpOnly",
      "theme=dark; Path=/"
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
