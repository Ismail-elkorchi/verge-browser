import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "@ismail-elkorchi/html-parser";
import { measureTextCells } from "@ismail-elkorchi/terminal-ui/text";

import {
  buildPageContent,
  documentContentColumns,
  layoutPageContent,
  renderDocumentToTerminal
} from "../../dist/app/render.js";

test("renderDocumentToTerminal collects links and renders body text", () => {
  const document = parse(`
    <html>
      <head><title>Sample page</title></head>
      <body>
        <h1>Welcome</h1>
        <p>Open the <a href="/docs">documentation</a> for details.</p>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 100
  });

  assert.equal(renderedPage.title, "Sample page");
  assert.equal(renderedPage.links.length, 1);
  assert.equal(renderedPage.links[0].resolvedHref, "https://example.com/docs");
  assert.ok(renderedPage.lines.some((line) => line.includes("Welcome")));
  assert.ok(renderedPage.lines.some((line) => line.includes("[1]")));
  assert.equal(
    renderedPage.lines.find((line) => line.includes("Open the")),
    "Open the documentation for details."
  );
});

test("semantic content keeps stable actions while terminal layout responds to width", () => {
  const document = parse(`
    <html><head><title>Responsive</title></head><body>
      <h1>Responsive page</h1>
      <p>A long paragraph before <a href="/target">the stable link target</a> and after it.</p>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const narrow = layoutPageContent(content, 24);
  const wide = layoutPageContent(content, 80);

  assert.equal(content.actions.length, 1);
  assert.equal(narrow.actionPlacements[0].actionId, content.actions[0].id);
  assert.equal(wide.actionPlacements[0].actionId, content.actions[0].id);
  assert.ok(narrow.rows.length > wide.rows.length);
});

test("semantic layout accepts content returned by a custom builder", () => {
  const content = {
    title: "Custom page",
    displayUrl: "https://example.test/custom",
    statusLine: "200 OK",
    blocks: [{
      id: "custom:block",
      kind: "paragraph",
      text: "A custom builder can still use the public layout function."
    }],
    links: [{
      id: "custom:link",
      blockId: "custom:block",
      kind: "link",
      index: 1,
      label: "public layout",
      href: "/layout",
      resolvedHref: "https://example.test/layout",
      textOffset: 35
    }],
    actions: [{
      id: "custom:link",
      blockId: "custom:block",
      kind: "link",
      index: 1,
      label: "public layout",
      href: "/layout",
      resolvedHref: "https://example.test/layout",
      textOffset: 35
    }],
    styleIssues: [],
    stylesheetCount: 0,
    parseErrorCount: 0,
    fetchedAtIso: "2026-07-29T00:00:00.000Z"
  };

  const layout = layoutPageContent(content, 24);
  assert.ok(layout.rows.length > 1);
  assert.ok(layout.actionPlacements.some((placement) => placement.actionId === "custom:link"));
});

test("semantic layout keeps link geometry with line breaks and table cells", () => {
  const document = parse(`
    <html><body>
      <p>first line<br><a href="/after-break">after break</a></p>
      <table><tr><td>Label</td><td><a href="/table-link">table link</a></td></tr></table>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const layout = layoutPageContent(content, 80);
  const afterBreak = content.links.find((link) => link.resolvedHref.endsWith("/after-break"));
  const tableLink = content.links.find((link) => link.resolvedHref.endsWith("/table-link"));

  assert.equal(content.links.length, 2);
  assert.equal(
    layout.actionPlacements.find((placement) => placement.actionId === afterBreak.id).rowIndex,
    1
  );
  assert.equal(
    layout.rows[layout.actionPlacements.find((placement) => placement.actionId === tableLink.id).rowIndex].text,
    "| Label | table link |"
  );
});

test("semantic layout wraps Unicode and long links by terminal cells", () => {
  const document = parse(`
    <html><body>
      <h1>Unicode page</h1>
      <p>漢字🙂 e\u0301 <a href="/long">abcdefghijklmnopqrstuvwx</a></p>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const layout = layoutPageContent(content, 10);
  const placements = layout.actionPlacements.filter(
    (placement) => placement.actionId === content.links[0].id
  );

  assert.ok(layout.rows.every((row) => measureTextCells(row.text).cells <= 10));
  assert.ok(placements.length >= 3);
  assert.ok(placements.every((placement) =>
    placement.columnIndex >= 0
    && placement.width > 0
    && placement.columnIndex + placement.width <= layout.columns
  ));
});

test("renderDocumentToTerminal preserves preformatted whitespace", () => {
  const document = parse(`
    <html>
      <head><title>Pre sample</title></head>
      <body>
        <pre>alpha
  beta
\tgamma</pre>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/pre",
    finalUrl: "https://example.com/pre",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 60
  });

  const joined = renderedPage.lines.join("\n");
  assert.ok(joined.includes("alpha\n  beta\n\tgamma"));
});

test("renderDocumentToTerminal collapses inline tabs without regex backtracking", () => {
  const repeatedTabs = "\t".repeat(20_000);
  const document = parse(`
    <html>
      <head><title>Inline spacing</title></head>
      <body>
        <p>alpha${repeatedTabs}<br>${repeatedTabs}beta</p>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/inline-spacing",
    finalUrl: "https://example.com/inline-spacing",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  assert.deepEqual(renderedPage.lines.slice(0, 2), ["alpha", "beta"]);
});

test("renderDocumentToTerminal renders markdown-like table rows", () => {
  const document = parse(`
    <html>
      <head><title>Table sample</title></head>
      <body>
        <table>
          <tr><th>Name</th><th>Role</th></tr>
          <tr><td>Amina</td><td>Lead</td></tr>
          <tr><td>Ilyas</td><td>QA</td></tr>
        </table>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/table",
    finalUrl: "https://example.com/table",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const joined = renderedPage.lines.join("\n");
  assert.ok(joined.includes("| Name"));
  assert.ok(joined.includes("| ────"));
  assert.ok(joined.includes("Amina"));
});

test("renderDocumentToTerminal renders nested list indentation", () => {
  const document = parse(`
    <html>
      <head><title>List sample</title></head>
      <body>
        <ul>
          <li>alpha <ul><li>beta</li></ul></li>
        </ul>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/list",
    finalUrl: "https://example.com/list",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const joined = renderedPage.lines.join("\n");
  assert.ok(joined.includes("- alpha"));
  assert.ok(joined.includes("  - beta"));
});

test("semantic content preserves definition terms and descriptions", () => {
  const document = parse(`
    <!doctype html><html><body>
      <dl>
        <dt>Terminal cell</dt>
        <dd>A character-sized drawing position.</dd>
        <dt>Viewport</dt>
        <dd>A clipped scrolling region with a visible window.</dd>
      </dl>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/glossary",
    finalUrl: "https://example.com/glossary",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const layout = layoutPageContent(content, 80);

  assert.deepEqual(
    content.blocks.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: "definitionTerm", text: "Terminal cell" },
      { kind: "definitionDescription", text: "A character-sized drawing position." },
      { kind: "definitionTerm", text: "Viewport" },
      { kind: "definitionDescription", text: "A clipped scrolling region with a visible window." }
    ]
  );
  assert.deepEqual(
    layout.rows.map((row) => row.text),
    [
      "Terminal cell",
      "  A character-sized drawing position.",
      "Viewport",
      "  A clipped scrolling region with a visible window."
    ]
  );
});

test("document prose stays within a readable measure on wide terminals", () => {
  assert.equal(documentContentColumns(39), 39);
  assert.equal(documentContentColumns(80), 76);
  assert.equal(documentContentColumns(240), 140);
});

test("renderDocumentToTerminal reports anti-bot challenge pages", () => {
  const document = parse(`
    <html>
      <head><title>Just a moment...</title></head>
      <body>
        <script>window.location.reload()</script>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://blocked.example",
    finalUrl: "https://blocked.example",
    status: 403,
    statusText: "Forbidden",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 100
  });

  const joined = renderedPage.lines.join("\n");
  assert.ok(joined.includes("Blocked by anti-bot challenge."));
  assert.ok(joined.includes("cannot be rendered in CLI mode"));
});

test("renderDocumentToTerminal includes noscript fallback content", () => {
  const document = parse(`
    <html>
      <head><title>Noscript sample</title></head>
      <body>
        <p>visible text</p>
        <noscript>fallback text for non-script clients</noscript>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/noscript",
    finalUrl: "https://example.com/noscript",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const joined = renderedPage.lines.join("\n");
  assert.ok(joined.includes("visible text"));
  assert.ok(joined.includes("fallback text for non-script clients"));
});

test("renderDocumentToTerminal exposes forms as stable visible actions", () => {
  const document = parse(`
    <html>
      <head><title>Form sample</title></head>
      <body>
        <h1>Search</h1>
        <form action="/search" method="get">
          <input name="q" value="alpha">
          <textarea name="notes">hello</textarea>
        </form>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.com/form",
    finalUrl: "https://example.com/form",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  assert.ok(renderedPage.lines.some((line) => line === "Form 1"));
  assert.equal(renderedPage.actionables.length, 1);
  assert.deepEqual(renderedPage.actionables[0], {
    kind: "form",
    id: renderedPage.actionables[0].id,
    blockId: renderedPage.actionables[0].blockId,
    index: 1,
    label: "Form 1",
    method: "get",
    actionUrl: "https://example.com/search",
    fieldCount: 2,
    textOffset: 0,
    lineIndex: 1
  });
});

test("page layout retains CSS geometry for replaced semantic blocks", () => {
  const document = parse(`
    <html>
      <head>
        <style>
          .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 2ch; }
          form { width: 20ch; margin-inline: auto; }
        </style>
      </head>
      <body>
        <div class="grid">
          <article><p>Article content</p></article>
          <form action="/search"><input name="q"></form>
        </div>
      </body>
    </html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const layout = layoutPageContent(content, 80);
  const formBlock = content.blocks.find((block) => block.kind === "form");
  const placement = layout.blockPlacements.find((candidate) => candidate.blockId === formBlock?.id);

  assert.ok(placement);
  assert.equal(placement.width, 20);
  assert.ok(placement.columnIndex >= 49);
  assert.equal(placement.height, 4);
});

test("semantic content follows HTML visibility, landmarks, and disclosure state", () => {
  const document = parse(`
    <html><body>
      <header><p>Site identity</p></header>
      <main>
        <p hidden>hidden attribute</p>
        <p aria-hidden="true">aria hidden</p>
        <dialog>closed dialog</dialog>
        <details><summary>Collapsed summary</summary><p>collapsed details</p></details>
        <details open><summary>Expanded summary</summary><p>expanded details</p></details>
        <img src="/diagram.png" alt="Architecture diagram">
        <img src="/decoration.png" alt="">
      </main>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const joined = content.blocks.map((block) => block.text).join("\n");

  assert.doesNotMatch(joined, /hidden attribute|aria hidden|closed dialog|collapsed details/u);
  assert.match(joined, /Collapsed summary|Expanded summary|expanded details|▧ Architecture diagram/u);
  assert.doesNotMatch(joined, /decoration/u);
  assert.equal(content.blocks.find((block) => block.text === "Site identity")?.region, "banner");
  assert.ok(content.blocks.filter((block) => block.region === "main").length >= 4);
});

test("semantic navigation deduplicates equivalent link sets", () => {
  const document = parse(`
    <html><body>
      <nav aria-label="compact"><a href="/blog">Blog</a><a href="/about">About</a></nav>
      <nav aria-label="expanded"><p>Explore</p><a href="/about">About us</a><a href="/blog">News</a></nav>
      <main><h1>Page</h1><p>Body</p></main>
    </body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(content.links.length, 2);
  assert.equal(content.blocks.filter((block) => block.region === "navigation").length, 2);
});

test("layout uses structural spacing instead of blank rows after every block", () => {
  const document = parse(`
    <html><body><main>
      <h1>Title</h1>
      <p>Introduction</p>
      <ul><li>One</li><li>Two</li><li>Three</li></ul>
      <table><tr><td>A</td></tr><tr><td>B</td></tr></table>
    </main></body></html>
  `);
  const content = buildPageContent({
    tree: document.tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const layout = layoutPageContent(content, 80);

  assert.ok(layout.rows.filter((row) => row.text === "").length < content.blocks.length);
  assert.deepEqual(
    layout.rows
      .filter((row) => row.fragments.some((fragment) =>
        content.blocks.find((block) => block.id === fragment.blockId)?.kind !== "notice"
      ) && row.text !== "")
      .map((row) => row.text),
    ["Title", "Introduction", "- One", "- Two", "- Three", "| A |", "| B |"]
  );
});

test("large forms with unique radio groups avoid quadratic rendering work", {
  timeout: 10_000
}, () => {
  const controlCount = 30_000;
  const document = parse(`<form>${Array.from(
    { length: controlCount },
    (_, index) => `<input type="radio" name="group-${String(index)}">`
  ).join("")}</form>`);

  const rendered = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.test/large-form",
    finalUrl: "https://example.test/large-form",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  assert.equal(rendered.actionables[0]?.kind, "form");
  assert.equal(rendered.actionables[0]?.fieldCount, 2_000);
});
