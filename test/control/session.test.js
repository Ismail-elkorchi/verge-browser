import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";

import { findAllByTagName } from "html-parser";

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

test("BrowserSession supports open, back, and forward", async () => {
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const session = new BrowserSession({
    loader,
    widthProvider: () => 100
  });

  await session.open("https://a.example/");
  await session.open("https://b.example/");

  assert.equal(session.current?.finalUrl, "https://b.example/");
  assert.equal(session.canBack(), true);

  await session.back();
  assert.equal(session.current?.finalUrl, "https://a.example/");
  assert.equal(session.canForward(), true);

  await session.forward();
  assert.equal(session.current?.finalUrl, "https://b.example/");
});

test("BrowserSession openStream parses from byte stream", async () => {
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const streamLoader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    stream: streamFromString(htmlMap.get(requestUrl) ?? "<html><body>missing</body></html>"),
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const session = new BrowserSession({
    loader,
    streamLoader,
    widthProvider: () => 100
  });

  const snapshot = await session.openStream("https://a.example/");
  assert.equal(snapshot.diagnostics.parseMode, "stream");
  assert.equal(snapshot.rendered.title, "A");
  assert.ok(snapshot.sourceHtml?.includes("<title>A</title>"));
});

test("BrowserSession applyEdits mutates current snapshot deterministically", async () => {
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: "<html><head><title>T</title></head><body><p>Hello</p></body></html>",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  const session = new BrowserSession({
    loader,
    widthProvider: () => 100
  });

  await session.open("https://patch.example/");
  const currentTree = session.current?.tree;
  assert.ok(currentTree);

  const paragraphNode = currentTree ? [...findAllByTagName(currentTree, "p")][0] : undefined;
  assert.ok(paragraphNode && paragraphNode.kind === "element");
  const paragraphTextNode = paragraphNode.children.find((child) => child.kind === "text");
  assert.ok(paragraphTextNode && paragraphTextNode.kind === "text");

  const patched = session.applyEdits([
    {
      kind: "replaceText",
      target: paragraphTextNode.id,
      value: "Updated"
    }
  ]);

  assert.ok(patched.sourceHtml?.includes("Updated"));
  assert.ok(patched.rendered.lines.join("\n").includes("Updated"));
});

test("BrowserSession openWithRequest records method and cookie diagnostics", async () => {
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
      setCookieHeaders: ["sid=next; Path=/; HttpOnly"],
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };

  const session = new BrowserSession({
    loader,
    widthProvider: () => 100
  });

  const snapshot = await session.openWithRequest("https://submit.example/", {
    method: "POST",
    headers: {
      cookie: "sid=seed",
      "content-type": "application/x-www-form-urlencoded"
    },
    bodyText: "q=alpha"
  });

  assert.equal(capturedRequestOptions?.method, "POST");
  assert.equal(capturedRequestOptions?.headers?.cookie, "sid=seed");
  assert.equal(snapshot.diagnostics.requestMethod, "POST");
  assert.equal(snapshot.diagnostics.usedCookies, true);
  assert.equal(snapshot.setCookieHeaders[0], "sid=next; Path=/; HttpOnly");
});
