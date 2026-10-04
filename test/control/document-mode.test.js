import assert from "node:assert/strict";
import test from "node:test";
import { parseWebDocument, parseWebDocumentBytes, parseWebDocumentStream } from "../../dist/document/index.js";

const context = { requestUrl: "https://example.test/", finalUrl: "https://example.test/" };

test("document snapshots preserve the parser mode for text, bytes, and streams", async () => {
  const fixtures = [
    { html: "<p>No doctype</p>", mode: "quirks" },
    { html: "<!doctype html><p>Standards</p>", mode: "no-quirks" },
    { html: '<!doctype html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><p>Legacy</p>', mode: "quirks" },
    { html: '<!doctype html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><p>Limited</p>', mode: "limited-quirks" },
  ];
  for (const { html, mode } of fixtures) {
    const bytes = new globalThis.TextEncoder().encode(html);
    const stream = new globalThis.ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const documents = [parseWebDocument(html, context), parseWebDocumentBytes(bytes, context), await parseWebDocumentStream(stream, context)];
    for (const document of documents) {
      assert.equal(document.documentMode, mode);
      assert.equal(Object.isFrozen(document), true);
    }
  }
});
