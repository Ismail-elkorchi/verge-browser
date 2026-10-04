import assert from "node:assert/strict";
import test from "node:test";
import { HttpClientError, NodeHttpClient } from "@ismail-elkorchi/http-client";
import { NetworkFetchError, PageNetworkClient } from "../../dist/app/fetch-page.js";

async function injectedFailure(t, error, inspect) {
  t.mock.method(NodeHttpClient.prototype, "fetch", async () => ({ kind: "failure", error, redirects: [] }));
  const client = new PageNetworkClient();
  try {
    await assert.rejects(client.fetchPage("https://diagnostic.test/", 1000, { maxRequestRetries: 0 }), (failure) => {
      assert.ok(failure instanceof NetworkFetchError);
      assert.equal(failure.cause, error);
      inspect(failure);
      return true;
    });
  } finally { await client.close(); }
}

test("network failures retain causes but surface only bounded known transport codes", async (t) => {
  const cause = new AggregateError([new Error("secret header"), Object.assign(new Error("secret body"), { code: "ECONNREFUSED" })], "private request data");
  const error = new HttpClientError("NETWORK_FAILURE", "private message", "https://diagnostic.test/", new Error("private wrapper", { cause }));
  await injectedFailure(t, error, (failure) => {
    assert.equal(failure.networkOutcome.kind, "transport");
    assert.equal(failure.networkOutcome.detailCode, "NETWORK_FAILURE");
    assert.match(failure.message, /NETWORK_FAILURE.*ECONNREFUSED/u);
    assert.doesNotMatch(failure.message, /private|secret/u);
  });
});

test("foreign cyclic causes and getters cannot expand network diagnostics", async (t) => {
  let getterCalls = 0;
  const cause = { code: "PASSWORD=secret" };
  cause.cause = cause;
  Object.defineProperty(cause, "errors", { get() { getterCalls++; throw new Error("must not inspect"); } });
  const error = new HttpClientError("NETWORK_FAILURE", "private message", "https://diagnostic.test/", cause);
  await injectedFailure(t, error, (failure) => {
    assert.equal(failure.message, "transport [NETWORK_FAILURE]: The network request failed.");
    assert.equal(getterCalls, 0);
  });
});

test("aggregate transport diagnostics read array data properties without invoking length or entry getters", async (t) => {
  let getterCalls = 0;
  const entries = [undefined, { code: "ECONNRESET" }];
  Object.defineProperty(entries, "0", { get() { getterCalls++; throw new Error("must not inspect"); } });
  const errors = new Proxy(entries, {
    get() { getterCalls++; throw new Error("must not read array properties"); },
  });
  const error = new HttpClientError("NETWORK_FAILURE", "private message", "https://diagnostic.test/", { errors });
  await injectedFailure(t, error, (failure) => {
    assert.match(failure.message, /ECONNRESET/u);
    assert.equal(getterCalls, 0);
  });
});

for (const [code, kind] of [["DNS_ERROR", "dns"], ["TLS_ERROR", "tls"], ["TOTAL_TIMEOUT", "timeout"]]) {
  test(`${code} retains its classification and safe public code`, async (t) => {
    const error = new HttpClientError(code, "Classified failure", "https://diagnostic.test/", new Error("private cause"));
    await injectedFailure(t, error, (failure) => {
      assert.equal(failure.networkOutcome.kind, kind);
      assert.equal(failure.networkOutcome.detailCode, code);
      assert.ok(failure.message.includes(`[${code}]`));
      assert.doesNotMatch(failure.message, /private/u);
    });
  });
}

test("network UI summary is bounded without discarding the structured outcome", () => {
  const outcome = { kind: "transport", finalUrl: "https://diagnostic.test/", status: null, statusText: null,
    detailCode: "NETWORK_FAILURE\u001b[31m", detailMessage: "a\n".repeat(1000) };
  const failure = new NetworkFetchError(outcome);
  assert.equal(failure.networkOutcome, outcome);
  assert.ok(failure.message.length < 410);
  assert.doesNotMatch(failure.message, /\p{Cc}/u);
});
