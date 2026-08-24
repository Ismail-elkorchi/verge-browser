/**
 * What it does: inspects Verge's immutable document and semantic indexes.
 * Expected output: prints "inspect-document ok" after checking structure and links.
 * Constraints: requires built verge-browser output only.
 * Run: npm run build && node examples/inspect-document.mjs
 */
import { pathToFileURL } from "node:url";

import { parseWebDocument } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runInspectDocument() {
  const document = parseWebDocument(
    "<article><h1>Docs</h1><p>Immutable structure.</p><a href='/guide'>Guide</a></article>",
    { requestUrl: "https://example.test/", finalUrl: "https://example.test/" }
  );
  assert(document.headings[0]?.text === "Docs", "document should index its heading");
  assert(document.links[0]?.destination === "https://example.test/guide", "document should resolve its link");
  assert(document.body !== null && document.text(document.body).includes("Immutable structure"), "document should retain body text");
  return document;
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
  runInspectDocument();
  console.log("inspect-document ok");
}
