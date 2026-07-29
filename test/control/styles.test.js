import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import { parseHtml } from "../../dist/app/parse-html.js";
import {
  buildPageContent,
  documentBaseUrl,
  layoutPageContent
} from "../../dist/app/render.js";
import { BrowserSession } from "../../dist/app/session.js";

function contentFor(html, options = {}) {
  const document = parseHtml(html);
  return buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.test/start",
    finalUrl: "https://example.test/start",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-07-29T00:00:00.000Z",
    ...options
  });
}

test("author CSS resolves cascade, inheritance, inline runs, and hidden content", () => {
  const content = contentFor(`
    <style>
      p { color: #f00; text-align: center; padding: 1ch 2ch; }
      .priority { color: rgb(0 128 0) !important; }
      strong { font-style: italic; }
      .gone { display: none; }
    </style>
    <p class="priority" style="color: blue">Hello <strong>world</strong></p>
    <p class="gone">Hidden</p>
  `);

  assert.equal(content.stylesheetCount, 1);
  assert.equal(content.blocks.some((block) => block.text.includes("Hidden")), false);
  const paragraph = content.blocks.find((block) => block.text === "Hello world");
  assert.ok(paragraph);
  assert.equal(paragraph.style.textAlign, "center");
  assert.equal(paragraph.style.paddingTopRows, 1);
  assert.equal(paragraph.style.paddingRightCells, 2);
  assert.deepEqual(paragraph.textRuns[0]?.style.foreground, { r: 0, g: 128, b: 0 });
  assert.equal(paragraph.textRuns.at(-1)?.style.bold, true);
  assert.equal(paragraph.textRuns.at(-1)?.style.italic, true);
});

test("shorthands follow cascade order and hidden visibility can be restored by descendants", () => {
  const content = contentFor(`
    <style>
      .box {
        padding-left: 1ch;
        padding: 0 0 0 4ch;
        margin: 0 0 0 5ch;
        margin-left: 2ch;
        background-color: red;
        background: blue;
      }
      .hidden { visibility: hidden; }
      .shown { visibility: visible; }
    </style>
    <p class="box">Box</p>
    <p class="hidden">Hidden <span class="shown">Visible child</span></p>
    <a class="hidden" href="/hidden">Hidden link</a>
  `);

  const box = content.blocks.find((block) => block.text === "Box");
  assert.equal(box?.style.paddingLeftCells, 4);
  assert.equal(box?.style.marginLeftCells, 2);
  assert.deepEqual(box?.style.background, { r: 0, g: 0, b: 255 });
  assert.equal(content.blocks.some((block) => block.text.includes("Hidden")), false);
  assert.equal(content.blocks.some((block) => block.text === "Visible child"), true);
  assert.equal(content.links.some((link) => link.resolvedHref.endsWith("/hidden")), false);
});

test("browser link styling survives an inherited page color", () => {
  const content = contentFor(`
    <style>p { color: red }</style>
    <p><a href="/next">Link</a></p>
  `);
  const paragraph = content.blocks.find((block) => block.text === "Link");
  assert.ok(paragraph);
  assert.equal(paragraph.textRuns[0]?.style.foreground, undefined);
});

test("terminal layout retains styled ranges, backgrounds, alignment, and action geometry", () => {
  const content = contentFor(`
    <style>
      p { background-color: #123456; color: white; text-align: right; padding-left: 2ch; }
    </style>
    <p><a href="/wide">文档 link</a></p>
  `);
  const paragraph = content.blocks.find((block) => block.kind === "paragraph");
  assert.ok(paragraph);
  const layout = layoutPageContent(content, 30);
  const row = layout.rows.find((candidate) => candidate.blockId === paragraph.id);
  assert.ok(row);
  assert.deepEqual(row.background, { r: 18, g: 52, b: 86 });
  assert.ok(row.contentStartCodeUnitIndex > 2);
  assert.ok(row.styleRuns.length > 0);
  assert.ok(layout.actionPlacements[0]?.columnIndex >= row.contentStartCodeUnitIndex);
});

test("reader construction ignores author styles while retaining semantic content", () => {
  const html = "<style>p { display: none }</style><p>Reader survives</p>";
  const styled = contentFor(html);
  const reader = contentFor(html, { authorStyles: "ignore" });
  assert.equal(styled.blocks.some((block) => block.text === "Reader survives"), false);
  assert.equal(reader.blocks.some((block) => block.text === "Reader survives"), true);
  assert.equal(reader.stylesheetCount, 0);
});

test("selector and unsupported CSS outcomes remain recoverable diagnostics", () => {
  const content = contentFor(`
    <style>
      p:hover { color: red }
      @media print { p { color: black } }
      p { width: 10px; color: var(--ink) }
    </style>
    <p>Text</p>
  `);
  assert.ok(content.styleIssues.some((issue) => issue.code === "selector-unknown"));
  assert.ok(content.styleIssues.some((issue) => issue.code === "unsupported-at-rule"));
  assert.ok(content.styleIssues.some((issue) => issue.code === "property-unsupported"));
});

test("BrowserSession loads external stylesheets in document order and records failures", async () => {
  const requests = [];
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <base href="https://cdn.example.test/site/">
        <link rel="stylesheet" href="first.css">
        <link rel="stylesheet" href="missing.css">
        <style>p { color: blue }</style>
        <p>Styled</p>
      `,
      responseHeaders: { "content-type": "text/html" },
      setCookieHeaders: [],
      fetchedAtIso: "2026-07-29T00:00:00.000Z",
      networkOutcome: {
        finalUrl: requestUrl,
        kind: "ok",
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      }
    }),
    stylesheetLoader: async (requestUrl) => {
      requests.push(requestUrl);
      if (requestUrl.endsWith("missing.css")) throw new Error("missing stylesheet");
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: "text/css; charset=utf-8",
        responseHeaders: { "content-type": "text/css; charset=utf-8" },
        transportEncodingLabel: "utf-8",
        bytes: new TextEncoder().encode("p { color: red }")
      };
    }
  });

  const snapshot = await session.open("https://example.test/start");
  assert.deepEqual(requests, [
    "https://cdn.example.test/site/first.css",
    "https://cdn.example.test/site/missing.css"
  ]);
  const paragraph = snapshot.content.blocks.find((block) => block.text === "Styled");
  assert.deepEqual(paragraph?.textRuns[0]?.style.foreground, { r: 0, g: 0, b: 255 });
  assert.ok(snapshot.content.styleIssues.some((issue) =>
    issue.code === "stylesheet-fetch" && issue.message.includes("missing stylesheet")
  ));
  assert.equal(snapshot.diagnostics.stylesheetCount, 2);
  assert.equal(snapshot.diagnostics.styleIssueCount, 1);
});

test("BrowserSession enforces stylesheet count and aggregate byte budgets", async () => {
  const requests = [];
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <link rel="stylesheet" href="/one.css">
        <link rel="stylesheet" href="/two.css">
        <link rel="stylesheet" href="/three.css">
        <p>Budgeted</p>
      `,
      responseHeaders: { "content-type": "text/html" },
      setCookieHeaders: [],
      fetchedAtIso: "2026-07-29T00:00:00.000Z",
      networkOutcome: {
        finalUrl: requestUrl,
        kind: "ok",
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      }
    }),
    stylesheetLoader: async (requestUrl) => {
      requests.push(requestUrl);
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: "text/css",
        responseHeaders: { "content-type": "text/css" },
        bytes: new TextEncoder().encode("p{}")
      };
    },
    stylesheetPolicy: {
      maxStylesheets: 2,
      maxStylesheetBytes: 3,
      maxTotalStylesheetBytes: 4
    }
  });

  const snapshot = await session.open("https://example.test/start");
  assert.deepEqual(requests, [
    "https://example.test/one.css",
    "https://example.test/two.css"
  ]);
  assert.equal(snapshot.content.stylesheetCount, 1);
  assert.equal(
    snapshot.content.styleIssues.filter((issue) => issue.code === "stylesheet-limit").length,
    2
  );
});

test("BrowserSession scopes stylesheet credentials and propagates cancellation", async () => {
  const requests = [];
  const cancellation = Promise.withResolvers();
  let loadCount = 0;
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <link rel="stylesheet" href="/same.css">
        <link rel="stylesheet" href="https://cdn.example.test/cross.css">
        <link rel="stylesheet" href="/pending.css">
        <p>Credentials</p>
      `,
      responseHeaders: { "content-type": "text/html" },
      setCookieHeaders: [],
      fetchedAtIso: "2026-07-29T00:00:00.000Z",
      networkOutcome: {
        finalUrl: requestUrl,
        kind: "ok",
        status: 200,
        statusText: "OK",
        detailCode: "HTTP_200",
        detailMessage: "200 OK"
      }
    }),
    stylesheetLoader: async (requestUrl, options) => {
      requests.push({ requestUrl, headers: options?.headers });
      loadCount += 1;
      if (loadCount === 3) {
        cancellation.resolve();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal.reason), {
            once: true
          });
        });
      }
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: "text/css",
        responseHeaders: { "content-type": "text/css" },
        bytes: new TextEncoder().encode("p{}")
      };
    }
  });
  const controller = new globalThis.AbortController();
  const reason = new Error("navigation replaced");
  const pending = session.openWithRequest("https://example.test/start", {
    signal: controller.signal,
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "x-browser-test": "retained"
    }
  });
  await cancellation.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);

  assert.equal(requests[0]?.headers?.authorization, "Bearer secret");
  assert.equal(requests[0]?.headers?.cookie, "session=secret");
  assert.equal(requests[1]?.headers?.authorization, undefined);
  assert.equal(requests[1]?.headers?.cookie, undefined);
  assert.equal(requests[1]?.headers?.["x-browser-test"], "retained");
});

test("BrowserSession rejects invalid stylesheet budgets", () => {
  for (const value of [NaN, Infinity, -1, 1.5]) {
    assert.throws(
      () => new BrowserSession({ stylesheetPolicy: { maxStylesheets: value } }),
      RangeError
    );
  }
});

test("document base URL is shared by links and forms", () => {
  const document = parseHtml(`
    <base href="/assets/">
    <a href="guide">Guide</a>
    <form action="submit"><input name="value"></form>
  `);
  const baseUrl = documentBaseUrl(document.tree, "https://example.test/docs/page");
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.test/docs/page",
    finalUrl: "https://example.test/docs/page",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-07-29T00:00:00.000Z"
  });
  assert.equal(baseUrl, "https://example.test/assets/");
  assert.equal(content.links[0]?.resolvedHref, "https://example.test/assets/guide");
  const form = content.actions.find((action) => action.kind === "form");
  assert.equal(form?.actionUrl, "https://example.test/assets/submit");
});
