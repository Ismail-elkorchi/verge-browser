import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

test("renderDocumentToTerminal collects links and renders body text", () => {
  const tree = parse(`
    <html>
      <head><title>Sample page</title></head>
      <body>
        <h1>Welcome</h1>
        <p>Open the <a href="/docs">documentation</a> for details.</p>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree,
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
});

test("renderDocumentToTerminal preserves preformatted whitespace", () => {
  const tree = parse(`
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
    tree,
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

test("renderDocumentToTerminal renders markdown-like table rows", () => {
  const tree = parse(`
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
    tree,
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
  const tree = parse(`
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
    tree,
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
  const tree = parse(`
    <html>
      <head><title>Just a moment...</title></head>
      <body>
        <script>window.location.reload()</script>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree,
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
