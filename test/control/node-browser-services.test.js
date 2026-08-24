import assert from "node:assert/strict";
import { readdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as defer } from "node:timers/promises";

import { HttpClientError, HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserCookieSession } from "../../dist/app/cookie-session.js";
import {
  createNodeBrowserServices,
  externalOpenCommand
} from "../../dist/runtime/node-browser-services.js";

const session = {
  async prepareRequest() {
    return undefined;
  },
  async acceptResponse() {
  }
};

test("Windows external opening does not cross a command-shell boundary", () => {
  const target = "https://example.test/?value=one&calc.exe";
  const command = externalOpenCommand(target, "win32");

  assert.equal(command.command, "explorer.exe");
  assert.deepEqual(command.args, [target]);
  assert.notEqual(command.command.toLowerCase(), "cmd");
});

async function fixture() {
  const observed = { cookie: "" };
  const server = createServer((request, response) => {
    if (request.url === "/named") {
      response.setHeader("content-disposition", "attachment; filename=\"../../report.txt\"");
      response.end("report");
      return;
    }
    if (request.url === "/oversize") {
      response.write("1234");
      response.end("5678");
      return;
    }
    if (request.url === "/reserved") {
      response.setHeader("content-disposition", 'attachment; filename="CON.txt"');
      response.end("portable");
      return;
    }
    if (request.url === "/slow") {
      response.write("started");
      return;
    }
    if (request.url === "/stalled-fields") {
      return;
    }
    if (request.url === "/cookie-download") {
      observed.cookie = request.headers.cookie ?? "";
      response.end("cookie download");
      return;
    }
    response.end("data");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "verge-downloads-"));
  return {
    directory,
    observed,
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("Node downloads sanitize names and choose collision-free destinations", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices({
    downloadAddressPolicy: "allow-private-and-local"
  });
  try {
    const first = await services.downloadFile({
      url: `${current.url}/named`,
      directory: current.directory,
      maxBytes: 100,
      session
    });
    const second = await services.downloadFile({
      url: `${current.url}/named`,
      directory: current.directory,
      maxBytes: 100,
      session
    });

    assert.equal(first.fileName, "report.txt");
    assert.equal(second.fileName, "report (1).txt");
    assert.equal(await readFile(first.path, "utf8"), "report");

    const reserved = await services.downloadFile({
      url: `${current.url}/reserved`,
      directory: current.directory,
      maxBytes: 100,
      session
    });
    assert.equal(reserved.fileName, "_CON.txt");
  } finally {
    await services.close();
    await current.close();
  }
});

test("Node downloads remove partial files after size rejection and abort", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices({
    downloadAddressPolicy: "allow-private-and-local"
  });
  try {
    await assert.rejects(
      services.downloadFile({
        url: `${current.url}/oversize`,
        directory: current.directory,
        maxBytes: 4,
        session
      }),
      (error) => (
        error instanceof HttpClientError
        && error.code === "WIRE_RESPONSE_TOO_LARGE"
      )
    );

    const controller = new globalThis.AbortController();
    const pending = services.downloadFile({
      url: `${current.url}/slow`,
      directory: current.directory,
      maxBytes: 100,
      session,
      signal: controller.signal
    });
    await defer();
    controller.abort();
    await assert.rejects(pending);

    assert.deepEqual(await readdir(current.directory), []);
  } finally {
    await services.close();
    await current.close();
  }
});

test("Node downloads reject private-network targets by default", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices();
  try {
    await assert.rejects(
      services.downloadFile({
        url: `${current.url}/named`,
        directory: current.directory,
        maxBytes: 100,
        session
      }),
      (error) => (
        error instanceof HttpClientError
        && error.code === "NETWORK_SAFETY_REJECTED"
      )
    );
  } finally {
    await services.close();
    await current.close();
  }
});

test("Node downloads time out stalled response fields and bodies", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices({
    downloadAddressPolicy: "allow-private-and-local",
    downloadResponseTimeoutMs: 30
  });
  try {
    await assert.rejects(
      services.downloadFile({
        url: `${current.url}/stalled-fields`,
        directory: current.directory,
        maxBytes: 100,
        session
      }),
      (error) => (
        error instanceof HttpClientError
        && error.code === "RESPONSE_FIELDS_TIMEOUT"
      )
    );
    await assert.rejects(
      services.downloadFile({
        url: `${current.url}/slow`,
        directory: current.directory,
        maxBytes: 100,
        session
      }),
      (error) => (
        error instanceof HttpClientError
        && error.code === "RESPONSE_BODY_TIMEOUT"
      )
    );
    assert.deepEqual(await readdir(current.directory), []);
  } finally {
    await services.close();
    await current.close();
  }
});

test("Node downloads enforce the initiating page's SameSite cookie context", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices({
    downloadAddressPolicy: "allow-private-and-local"
  });
  const cookies = new BrowserCookieSession(null, async () => undefined);
  const target = `${current.url}/cookie-download`;
  await cookies.acceptResponse({
    requestId: 1,
    attemptIndex: 0,
    url: target,
    method: "GET",
    statusCode: 200,
    statusMessage: "OK",
    fields: new HttpFields([
      { name: "set-cookie", value: "strictCookie=one; Path=/; SameSite=Strict" },
      { name: "set-cookie", value: "laxCookie=two; Path=/; SameSite=Lax" }
    ])
  });
  try {
    await services.downloadFile({
      url: target,
      sourceUrl: target.replace("127.0.0.1", "localhost"),
      directory: current.directory,
      maxBytes: 100,
      session: cookies
    });
    assert.match(current.observed.cookie, /(?:^|; )laxCookie=two(?:;|$)/u);
    assert.doesNotMatch(current.observed.cookie, /strictCookie/u);
  } finally {
    await services.close();
    await current.close();
  }
});
