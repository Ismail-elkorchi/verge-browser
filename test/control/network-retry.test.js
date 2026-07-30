import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchPage, NetworkFetchError } from "../../dist/app/fetch-page.js";

test("fetchPage retries transient GET failures once by default", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body>ok</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  try {
    const page = await fetchPage(
      `http://127.0.0.1:${String(address.port)}/`,
      15_000,
      { maxRequestRetries: 1, retryDelayMs: 0 }
    );
    assert.equal(page.networkOutcome.kind, "ok");
    assert.equal(attempts, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchPage does not retry transient POST failures", async () => {
  let attempts = 0;
  const server = createServer((request) => {
    attempts += 1;
    request.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  try {
    await assert.rejects(
      fetchPage(`http://127.0.0.1:${String(address.port)}/`, 15_000, {
        maxRequestRetries: 3,
        retryDelayMs: 0
      }, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        bodyText: "a=1"
      }),
      (error) => {
        if (!(error instanceof NetworkFetchError)) {
          return false;
        }
        return (
          error.networkOutcome.kind === "unknown"
          && error.networkOutcome.detailCode === "NETWORK_FAILURE"
        );
      }
    );
    assert.equal(attempts, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
