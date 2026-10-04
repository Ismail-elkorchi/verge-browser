import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { BrowserSession } from "../../dist/app/session.js";
import { PageNetworkClient } from "../../dist/app/fetch-page.js";

test("buffered and streaming navigation share HTML encoding detection", async () => {
  const cases = [
    { name: "transport", type: "text/html; charset=windows-1252", bytes: Buffer.concat([Buffer.from("<title>"), Buffer.from([0x80]), Buffer.from("</title><p>caf"), Buffer.from([0xe9]), Buffer.from("</p>")]), title: "€" },
    { name: "meta", type: "text/html", bytes: Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>caf'), Buffer.from([0xe9]), Buffer.from("</title>")]), title: "café" },
    { name: "bom", type: "text/html; charset=windows-1252", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<meta charset="windows-1252"><title>€ café</title>')]), title: "€ café" }
  ];
  const server = createServer((request, response) => {
    const fixture = cases.find((entry) => request.url === `/${entry.name}`);
    response.setHeader("content-type", fixture.type);
    for (const byte of fixture.bytes) response.write(Buffer.from([byte]));
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new PageNetworkClient({ publicAddressPolicy: "allow-private-and-local" });
  const session = new BrowserSession({ networkClient: client });
  try {
    for (const fixture of cases) {
      const url = `http://127.0.0.1:${server.address().port}/${fixture.name}`;
      const buffered = await session.openWithRequest(url, {}, "text");
      const streamed = await session.openWithRequest(url, {}, "stream");
      assert.equal(buffered.document.title, fixture.title);
      assert.equal(streamed.document.title, fixture.title);
      assert.equal(buffered.document.sourceText, streamed.document.sourceText);
      assert.equal(buffered.document.sourceMetadata.inputKind, "bytes");
      assert.equal(streamed.document.sourceMetadata.inputKind, "stream");
      assert.deepEqual({ ...buffered.document.sourceMetadata, inputKind: "stream" }, streamed.document.sourceMetadata);
    }
  } finally {
    await session.close(); await client.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local HTML bytes preserve meta encoding in both navigation modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verge-file-encoding-"));
  const path = join(directory, "encoded.html");
  await writeFile(path, Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>caf'), Buffer.from([0xe9]), Buffer.from("</title>")]));
  const session = new BrowserSession();
  try {
    for (const mode of ["text", "stream"]) {
      const page = await session.openWithRequest(pathToFileURL(path).href, {}, mode);
      assert.equal(page.document.title, "café");
      assert.equal(page.document.sourceMetadata.encoding, "windows-1252");
    }
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});
