import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyNetworkFailure, fetchPage, NetworkFetchError } from "../../dist/app/fetch-page.js";

function buildCause(value) {
  if (!value || typeof value !== "object") {
    return value ?? null;
  }

  const spec = value;
  const cause = "cause" in spec ? buildCause(spec.cause) : undefined;
  const hasMessage = typeof spec.message === "string";
  const hasName = typeof spec.name === "string";
  const hasCode = typeof spec.code === "string";

  if (!hasMessage && !hasName && hasCode && cause === undefined) {
    return { code: spec.code };
  }

  const error = new Error(hasMessage ? spec.message : "network replay error", cause !== undefined ? { cause } : undefined);
  if (hasName) {
    error.name = spec.name;
  }
  if (hasCode) {
    Object.defineProperty(error, "code", {
      value: spec.code,
      enumerable: true
    });
  }
  return error;
}

test("classifyNetworkFailure matches replay fixture outcomes", async () => {
  const fixtureSource = await readFile("test/fixtures/network-replay/failure-cases.json", "utf8");
  const fixtures = JSON.parse(fixtureSource);

  for (const fixture of fixtures) {
    const replayError = buildCause(fixture.error);
    const outcome = classifyNetworkFailure(replayError, fixture.finalUrl);

    assert.equal(
      outcome.kind,
      fixture.expected.kind,
      `${fixture.id}: expected kind ${fixture.expected.kind} got ${outcome.kind}`
    );
    assert.equal(
      outcome.detailCode,
      fixture.expected.detailCode,
      `${fixture.id}: expected detailCode ${fixture.expected.detailCode} got ${outcome.detailCode}`
    );
  }
});

test("fetchPage retries transient GET failures once by default", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  try {
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      return new globalThis.Response("<html><body>ok</body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    };

    const page = await fetchPage("https://retry.example/", 15_000, { maxRequestRetries: 1, retryDelayMs: 0 });
    assert.equal(page.networkOutcome.kind, "ok");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchPage does not retry transient POST failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  try {
    globalThis.fetch = async () => {
      attempts += 1;
      throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
    };

    await assert.rejects(
      fetchPage("https://retry.example/post", 15_000, { maxRequestRetries: 3, retryDelayMs: 0 }, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        bodyText: "a=1"
      }),
      (error) => {
        if (!(error instanceof NetworkFetchError)) {
          return false;
        }
        return error.networkOutcome.kind === "unknown" && error.networkOutcome.detailCode === "ECONNRESET";
      }
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
