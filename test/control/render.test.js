import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "@ismail-elkorchi/html-parser";
import { measureTextCells } from "@ismail-elkorchi/terminal-ui/text";

import {
  buildPageContent,
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
  assert.ok(joined.includes("| ----"));
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

  assert.ok(renderedPage.lines.some((line) => line.includes("[Form 1")));
  assert.equal(renderedPage.actionables.length, 1);
  assert.deepEqual(renderedPage.actionables[0], {
    kind: "form",
    id: renderedPage.actionables[0].id,
    blockId: renderedPage.actionables[0].blockId,
    index: 1,
    label: "Form 1 GET https://example.com/search",
    method: "get",
    actionUrl: "https://example.com/search",
    fieldCount: 2,
    textOffset: 0,
    lineIndex: 2
  });
});
