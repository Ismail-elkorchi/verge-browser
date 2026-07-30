import assert from "node:assert/strict";
import { readdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as defer } from "node:timers/promises";

import { HttpClientError } from "@ismail-elkorchi/http-client";

import { createNodeBrowserServices } from "../../dist/runtime/node-browser-services.js";

async function fixture() {
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
    if (request.url === "/slow") {
      response.write("started");
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
  const services = createNodeBrowserServices();
  try {
    const first = await services.downloadFile({
      url: `${current.url}/named`,
      directory: current.directory,
      maxBytes: 100
    });
    const second = await services.downloadFile({
      url: `${current.url}/named`,
      directory: current.directory,
      maxBytes: 100
    });

    assert.equal(first.fileName, "report.txt");
    assert.equal(second.fileName, "report (1).txt");
    assert.equal(await readFile(first.path, "utf8"), "report");
  } finally {
    await services.close();
    await current.close();
  }
});

test("Node downloads remove partial files after size rejection and abort", async () => {
  const current = await fixture();
  const services = createNodeBrowserServices();
  try {
    await assert.rejects(
      services.downloadFile({
        url: `${current.url}/oversize`,
        directory: current.directory,
        maxBytes: 4
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
