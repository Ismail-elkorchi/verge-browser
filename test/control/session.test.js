import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";

import { findAllByTagName } from "@ismail-elkorchi/html-parser";
import { HttpFields } from "@ismail-elkorchi/http-client";

import { BrowserSession } from "../../dist/app/session.js";

const htmlMap = new Map([
  [
    "https://a.example/",
    "<html><head><title>A</title></head><body><a href=\"https://b.example/\">B</a></body></html>"
  ],
  [
    "https://b.example/",
    "<html><head><title>B</title></head><body><p>Page B</p></body></html>"
  ]
]);

function streamFromString(value) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function htmlFields() {
  return new HttpFields([
    { name: "content-type", value: "text/html" }
  ]);
}

test("BrowserSession supports open, back, and forward", async () => {
  let loadCount = 0;
  const loader = async (requestUrl) => {
    loadCount += 1;
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>",
      responseFields: htmlFields(),
      networkOutcome: {
        kind: "ok",
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      },
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };

  const session = new BrowserSession({ loader, defaultParseMode: "text" });

  await session.open("https://a.example/");
  await session.open("https://b.example/");

  assert.equal(session.current?.finalUrl, "https://b.example/");
  assert.equal(session.canBack(), true);

  await session.back();
  assert.equal(session.current?.finalUrl, "https://a.example/");
  assert.equal(session.canForward(), true);
  assert.equal(loadCount, 2);

  await session.forward();
  assert.equal(session.current?.finalUrl, "https://b.example/");
  assert.equal(loadCount, 2);
});

test("BrowserSession openStream parses from byte stream", async () => {
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>",
    responseFields: htmlFields(),
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "HTTP_200",
      detailMessage: "200 OK"
    },
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const streamLoader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    stream: streamFromString(htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>"),
    responseFields: htmlFields(),
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "HTTP_200",
      detailMessage: "200 OK"
    },
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const session = new BrowserSession({ loader, streamLoader });

  const snapshot = await session.openStream("https://a.example/");
  assert.equal(snapshot.diagnostics.parseMode, "stream");
  assert.equal(snapshot.diagnostics.networkOutcome.kind, "ok");
  assert.ok(snapshot.diagnostics.triageIds.some((entry) => entry.startsWith("NET:OK:HTTP_200")));
  assert.ok(snapshot.diagnostics.triageIds.some((entry) => entry.startsWith("PARSE:")));
  assert.equal(snapshot.rendered.title, "A");
  assert.ok(snapshot.document.sourceText?.includes("<title>A</title>"));
});

test("BrowserSession applyEdits mutates current snapshot deterministically", async () => {
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: "<html><head><title>T</title></head><body><p>Hello</p></body></html>",
    responseFields: htmlFields(),
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "HTTP_200",
      detailMessage: "200 OK"
    },
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const session = new BrowserSession({ loader, defaultParseMode: "text" });

  await session.open("https://patch.example/");
  const currentTree = session.current?.document.tree;
  assert.ok(currentTree);

  const paragraphNode = currentTree ? [...findAllByTagName(currentTree, "p")][0] : undefined;
  assert.ok(paragraphNode && paragraphNode.kind === "element");
  const paragraphTextNode = paragraphNode.children.find((child) => child.kind === "text");
  assert.ok(paragraphTextNode && paragraphTextNode.kind === "text");

  const patched = await session.applyEdits([
    {
      kind: "replaceText",
      target: paragraphTextNode.id,
      value: "Updated"
    }
  ]);

  assert.ok(patched.document.sourceText?.includes("Updated"));
  assert.ok(patched.rendered.lines.some((line) => line.includes("Updated")));
});

test("BrowserSession openWithRequest records the request method", async () => {
  let capturedRequestOptions = null;
  const loader = async (requestUrl, requestOptions) => {
    capturedRequestOptions = requestOptions ?? null;
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: "<html><head><title>Submit</title></head><body><p>ok</p></body></html>",
      responseFields: htmlFields(),
      networkOutcome: {
        kind: "ok",
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      },
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };

  const session = new BrowserSession({ loader, defaultParseMode: "text" });

  const snapshot = await session.openWithRequest("https://submit.example/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    bodyText: "q=alpha"
  });

  assert.equal(capturedRequestOptions?.method, "POST");
  assert.equal(snapshot.diagnostics.requestMethod, "POST");
  assert.equal(snapshot.diagnostics.networkOutcome.kind, "ok");
  assert.ok(snapshot.diagnostics.triageIds.some((entry) => entry.startsWith("NET:OK:HTTP_200")));
  assert.ok(snapshot.diagnostics.triageIds.some((entry) => entry.startsWith("PARSE:")));
});

test("BrowserSession cancels a loaded stream when navigation aborts before parsing", async () => {
  const abortController = new globalThis.AbortController();
  let cancelReason;
  const stream = new ReadableStream({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  const streamLoader = async (requestUrl) => {
    abortController.abort(new Error("navigation stopped"));
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      stream,
      responseFields: htmlFields(),
      networkOutcome: {
        kind: "ok",
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      },
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };
  const session = new BrowserSession({
    loader: async () => assert.fail("text loader should not run"),
    streamLoader,
    stylesheetLoader: async () => assert.fail("stylesheet loader should not run")
  });

  await assert.rejects(
    session.open("https://stream.example/", abortController.signal),
    /navigation stopped/u
  );
  assert.match(String(cancelReason), /navigation stopped/u);
});

test("remote pages cannot turn a file base URL into a local link navigation", async () => {
  let loadCount = 0;
  const session = new BrowserSession({
    defaultParseMode: "text",
    loader: async (requestUrl) => {
      loadCount += 1;
      return {
        requestUrl,
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        contentType: "text/html",
        html: '<base href="file:///private/"><a href="secret.txt">Open report</a>',
        responseFields: htmlFields(),
        networkOutcome: {
          kind: "ok",
          finalUrl: requestUrl,
          status: 200,
          statusText: "OK",
          detailCode: "HTTP_200",
          detailMessage: "200 OK"
        },
        fetchedAtIso: "2026-01-01T00:00:00.000Z"
      };
    }
  });
  await session.open("https://remote.example/");

  await assert.rejects(session.openLink(1), /page-initiated local-file/u);
  assert.equal(loadCount, 1);
});
