import assert from "node:assert/strict";
import test from "node:test";

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
