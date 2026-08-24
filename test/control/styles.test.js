import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { parseHtml } from "../../dist/app/parse-html.js";
import { pageContent } from "../../dist/app/page-content.js";
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

function fields(contentType) {
  return new HttpFields([
    { name: "content-type", value: contentType }
  ]);
}

function rowFor(layout, blockId) {
  return layout.rows.find((row) =>
    row.fragments.some((fragment) => fragment.blockId === blockId)
  );
}

function authoredStyles(row) {
  return row?.styleRuns.map((run) => run.style) ?? [];
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
  assert.equal(content.blocks.some((block) => block.text.includes("Hidden")), true);
  const paragraph = content.blocks.find((block) => block.text === "Hello world");
  assert.ok(paragraph);
  const layout = layoutPageContent(content, 40);
  const row = rowFor(layout, paragraph.id);
  assert.ok(row);
  assert.ok(row.text.startsWith("  "));
  assert.ok(authoredStyles(row).some((style) =>
    style.foreground?.r === 0 && style.foreground.g === 128 && style.foreground.b === 0
  ));
  assert.ok(authoredStyles(row).some((style) => style.bold === true));
  assert.ok(authoredStyles(row).some((style) => style.italic === true));
  assert.equal(layout.rows.some((candidate) =>
    candidate.fragments.some((fragment) =>
      content.blocks.find((block) => block.id === fragment.blockId)?.text.includes("Hidden")
    )
  ), false);
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
  assert.ok(box);
  const layout = layoutPageContent(content, 40);
  const boxRow = rowFor(layout, box.id);
  assert.ok(boxRow?.text.startsWith("      "));
  assert.ok(authoredStyles(boxRow).some((style) =>
    style.background?.r === 0 && style.background.g === 0 && style.background.b === 255
  ));
  assert.equal(content.blocks.some((block) => block.text.includes("Hidden")), true);
  assert.ok(layout.rows.some((row) => row.text.includes("Visible child")));
  const hiddenLink = content.links.find((link) => link.resolvedHref.endsWith("/hidden"));
  assert.ok(hiddenLink);
  assert.equal(layout.actionPlacements.some((placement) => placement.actionId === hiddenLink.id), false);
});

test("browser link styling survives an inherited page color", () => {
  const content = contentFor(`
    <style>p { color: red }</style>
    <p><a href="/next">Link</a></p>
  `);
  const paragraph = content.blocks.find((block) => block.text === "Link");
  assert.ok(paragraph);
  const row = rowFor(layoutPageContent(content, 30), paragraph.id);
  assert.equal(authoredStyles(row).some((style) => style.foreground?.r === 255), false);
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
  const row = rowFor(layout, paragraph.id);
  assert.ok(row);
  assert.ok(authoredStyles(row).some((style) =>
    style.background?.r === 18 && style.background.g === 52 && style.background.b === 86
  ));
  assert.ok((row.fragments[0]?.rowStartCodeUnitIndex ?? 0) > 2);
  assert.ok(row.styleRuns.length > 0);
  assert.ok(layout.actionPlacements[0]?.columnIndex >= (row.fragments[0]?.rowStartCodeUnitIndex ?? 0));
});

test("reader construction ignores author styles while retaining semantic content", () => {
  const html = "<style>p { display: none }</style><p>Reader survives</p>";
  const styled = contentFor(html);
  const reader = contentFor(html, { authorStyles: "ignore" });
  const styledBlock = styled.blocks.find((block) => block.text === "Reader survives");
  assert.ok(styledBlock);
  assert.equal(rowFor(layoutPageContent(styled, 30), styledBlock.id), undefined);
  assert.equal(reader.blocks.some((block) => block.text === "Reader survives"), true);
  assert.equal(reader.stylesheetCount, 0);
});

test("dynamic selectors and media rules use the terminal rendering context", () => {
  const content = contentFor(`
    <style>
      p:hover { color: red }
      :root { --ink: #123456 }
      @media (max-width: 40rem) { p { color: var(--ink) } }
      p { width: 10px; font-size: 12px }
    </style>
    <p>Text</p>
  `);
  assert.equal(content.styleIssues.some((issue) => issue.code === "selector-unknown"), false);
  assert.ok(content.styleIssues.some((issue) => issue.code === "property-unsupported"));
  const paragraph = content.blocks.find((block) => block.text === "Text");
  assert.ok(paragraph);
  const narrow = rowFor(layoutPageContent(content, 60), paragraph.id);
  assert.ok(authoredStyles(narrow).some((style) => style.foreground?.r === 18));
});

test("custom properties, responsive grids, logical spacing, and visual clipping compose at layout time", () => {
  const content = contentFor(`
    <style>
      :root {
        --ink: var(--missing, #123456);
        --edge: #654321;
        --cycle-a: var(--cycle-b);
        --cycle-b: var(--cycle-a);
      }
      body { color: var(--ink); background-color: #fdfcf8; }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1ch;
      }
      .card {
        border: 1px solid var(--edge);
        padding-inline: 1ch;
      }
      .fallback { color: var(--cycle-a, #010203); }
      .screen-reader {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      @media (max-width: 30rem) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
    <a class="screen-reader" href="#main">Skip</a>
    <main id="main" class="grid">
      <article class="card"><h2>First</h2><p>Alpha</p></article>
      <article class="card"><h2>Second</h2><p class="fallback">Beta</p></article>
    </main>
  `);
  const first = content.blocks.find((block) => block.text === "First");
  const second = content.blocks.find((block) => block.text === "Second");
  const beta = content.blocks.find((block) => block.text === "Beta");
  const skip = content.links.find((link) => link.label === "Skip");
  assert.ok(first && second && beta && skip);

  const wide = layoutPageContent(content, 80);
  const narrow = layoutPageContent(content, 40);
  assert.strictEqual(layoutPageContent(content, 80), wide);
  assert.equal(
    wide.rows.some((row) => {
      const ids = new Set(row.fragments.map((fragment) => fragment.blockId));
      return ids.has(first.id) && ids.has(second.id);
    }),
    true
  );
  assert.equal(
    narrow.rows.some((row) => {
      const ids = new Set(row.fragments.map((fragment) => fragment.blockId));
      return ids.has(first.id) && ids.has(second.id);
    }),
    false
  );
  assert.equal(wide.actionPlacements.some((placement) => placement.actionId === skip.id), false);
  assert.deepEqual(wide.canvasStyle.background, { r: 253, g: 252, b: 248 });
  assert.ok(authoredStyles(rowFor(wide, beta.id)).some((style) =>
    style.foreground?.r === 1 && style.foreground.g === 2 && style.foreground.b === 3
  ));
  assert.ok(wide.rows.some((row) => row.text.includes("┌") && row.text.includes("┐")));
});

test("linked stylesheet media conditions are evaluated at the current layout width", async () => {
  let stylesheetLoads = 0;
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <link rel="stylesheet" href="/narrow.css" media="screen and (max-width: 50rem)">
        <p>Responsive text</p>
      `,
      responseFields: fields("text/html"),
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
      stylesheetLoads += 1;
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: "text/css",
        responseFields: fields("text/css"),
        bytes: new TextEncoder().encode("p { color: #123456 }")
      };
    },
    defaultParseMode: "text"
  });

  const snapshot = await session.open("https://example.test/start");
  const paragraph = pageContent(snapshot).blocks.find((block) => block.text === "Responsive text");
  assert.ok(paragraph);
  assert.equal(stylesheetLoads, 1);
  assert.ok(authoredStyles(rowFor(layoutPageContent(pageContent(snapshot), 60), paragraph.id)).some((style) =>
    style.foreground?.r === 18 && style.foreground.g === 52 && style.foreground.b === 86
  ));
  assert.equal(authoredStyles(rowFor(layoutPageContent(pageContent(snapshot), 120), paragraph.id)).some((style) =>
    style.foreground?.r === 18 && style.foreground.g === 52 && style.foreground.b === 86
  ), false);
});

test("equivalent CSS diagnostics are aggregated", () => {
  const content = contentFor(`
    <style>
      p { font-size: 10px }
      div { font-size: 10px }
    </style>
    <p>First</p>
    <div>Second</div>
  `);
  const issue = content.styleIssues.find((candidate) =>
    candidate.code === "property-unsupported"
    && candidate.message.includes("font-size")
  );
  assert.equal(issue?.occurrences, 2);
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
      responseFields: fields("text/html"),
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
        responseFields: fields("text/css; charset=utf-8"),
        transportEncodingLabel: "utf-8",
        bytes: new TextEncoder().encode("p { color: red }")
      };
    },
    defaultParseMode: "text"
  });

  const snapshot = await session.open("https://example.test/start");
  assert.deepEqual(requests, [
    "https://cdn.example.test/site/first.css",
    "https://cdn.example.test/site/missing.css"
  ]);
  const paragraph = pageContent(snapshot).blocks.find((block) => block.text === "Styled");
  assert.ok(paragraph);
  assert.ok(authoredStyles(rowFor(layoutPageContent(pageContent(snapshot), 40), paragraph.id)).some((style) =>
    style.foreground?.r === 0 && style.foreground.g === 0 && style.foreground.b === 255
  ));
  assert.ok(pageContent(snapshot).styleIssues.some((issue) =>
    issue.code === "stylesheet-fetch" && issue.message.includes("missing stylesheet")
  ));
  assert.equal(snapshot.diagnostics.stylesheetCount, 2);
  assert.equal(snapshot.diagnostics.styleIssueCount, 1);
});

test("BrowserSession enforces stylesheet count and aggregate byte budgets", async () => {
  const requests = [];
  const requestBudgets = [];
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
      responseFields: fields("text/html"),
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
      requests.push(requestUrl);
      requestBudgets.push(options?.maxContentBytes);
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: "text/css",
        responseFields: fields("text/css"),
        bytes: new TextEncoder().encode("p{}")
      };
    },
    stylesheetPolicy: {
      maxStylesheets: 2,
      maxStylesheetBytes: 3,
      maxTotalStylesheetBytes: 4
    },
    defaultParseMode: "text"
  });

  const snapshot = await session.open("https://example.test/start");
  assert.deepEqual(requests, [
    "https://example.test/one.css",
    "https://example.test/two.css"
  ]);
  assert.deepEqual(requestBudgets, [3, 1]);
  assert.equal(pageContent(snapshot).stylesheetCount, 1);
  assert.equal(
    pageContent(snapshot).styleIssues.filter((issue) => issue.code === "stylesheet-limit").length,
    2
  );
});

test("BrowserSession charges rejected MIME responses to the stylesheet transport budget", async () => {
  const requestBudgets = [];
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <link rel="stylesheet" href="/not-css">
        <link rel="stylesheet" href="/still-bounded.css">
        <p>Budgeted</p>
      `,
      responseFields: fields("text/html"),
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
      requestBudgets.push(options?.maxContentBytes);
      return {
        requestUrl,
        finalUrl: requestUrl,
        contentType: requestUrl.endsWith("not-css") ? "application/octet-stream" : "text/css",
        responseFields: fields("application/octet-stream"),
        bytes: new TextEncoder().encode("abc")
      };
    },
    stylesheetPolicy: {
      maxStylesheetBytes: 3,
      maxTotalStylesheetBytes: 4
    },
    defaultParseMode: "text"
  });

  const snapshot = await session.open("https://example.test/start");
  assert.deepEqual(requestBudgets, [3, 1]);
  assert.equal(pageContent(snapshot).stylesheetCount, 0);
  assert.ok(pageContent(snapshot).styleIssues.some((issue) =>
    issue.code === "stylesheet-fetch" && issue.message.includes("non-CSS")
  ));
  assert.ok(pageContent(snapshot).styleIssues.some((issue) =>
    issue.code === "stylesheet-limit" && issue.sourceUrl.endsWith("still-bounded.css")
  ));
});

test("BrowserSession blocks local stylesheet reads initiated by remote documents", async () => {
  const requested = [];
  const session = new BrowserSession({
    loader: async (requestUrl) => ({
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: `
        <base href="file:///private/">
        <link rel="stylesheet" href="secrets.css">
        <link rel="stylesheet" href="file:///etc/passwd">
        <p>Remote page</p>
      `,
      responseFields: fields("text/html"),
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
      requested.push(requestUrl);
      throw new Error("local stylesheet loader must not run");
    },
    defaultParseMode: "text"
  });

  const snapshot = await session.open("https://attacker.example/");

  assert.deepEqual(requested, []);
  assert.equal(
    pageContent(snapshot).styleIssues.filter((issue) =>
      issue.code === "stylesheet-fetch"
      && issue.message.includes("Blocked page-initiated stylesheet protocol: file:")
    ).length,
    2
  );
});

test("BrowserSession isolates stylesheet requests and propagates cancellation", async () => {
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
      responseFields: fields("text/html"),
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
        responseFields: fields("text/css"),
        bytes: new TextEncoder().encode("p{}")
      };
    },
    defaultParseMode: "text"
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

  assert.equal(requests[0]?.headers?.authorization, undefined);
  assert.equal(requests[0]?.headers?.cookie, undefined);
  assert.equal(requests[0]?.headers?.["x-browser-test"], undefined);
  assert.equal(requests[1]?.headers?.authorization, undefined);
  assert.equal(requests[1]?.headers?.cookie, undefined);
  assert.equal(requests[1]?.headers?.["x-browser-test"], undefined);
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

test("author selector work and responsive layout caches stay bounded", () => {
  const elements = Array.from(
    { length: 700 },
    (_, index) => `<p class="item-${String(index)}">Item ${String(index)}</p>`
  ).join("");
  const selectors = Array.from(
    { length: 1_200 },
    (_, index) => `.missing-${String(index)} { color: red }`
  ).join("\n");
  const content = contentFor(`<style>${selectors}</style>${elements}`);

  assert.ok(content.styleIssues.some((issue) =>
    issue.code === "stylesheet-limit"
    && issue.message.includes("selector evaluation")
  ));

  const cacheContent = contentFor("<p>Cache</p>");
  const first = layoutPageContent(cacheContent, 10);
  for (let width = 11; width <= 43; width += 1) {
    layoutPageContent(cacheContent, width);
  }
  const recent = layoutPageContent(cacheContent, 43);
  assert.strictEqual(layoutPageContent(cacheContent, 43), recent);
  assert.notStrictEqual(layoutPageContent(cacheContent, 10), first);
});

test("embedded stylesheet count is bounded even when every stylesheet is invalid", () => {
  const content = contentFor(`
    <html><head>
      ${Array.from({ length: 80 }, () => "<style>}</style>").join("")}
    </head><body><p>Still visible</p></body></html>
  `);
  const limit = content.styleIssues.find((issue) =>
    issue.code === "stylesheet-limit"
    && issue.message.includes("count exceeded")
  );
  assert.equal(limit?.occurrences, 16);
  assert.ok(content.blocks.some((block) => block.text === "Still visible"));
});
