import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { PageNetworkClient } from "../../dist/app/fetch-page.js";
import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";

function responseContext(url, setCookies) {
  return {
    requestId: 1,
    attemptIndex: 0,
    url,
    method: "GET",
    statusCode: 200,
    statusMessage: "OK",
    fields: new HttpFields(
      setCookies.map((value) => ({ name: "set-cookie", value }))
    )
  };
}

async function cookieValue(session, url) {
  const prepared = await session.prepareRequest({
    requestId: 2,
    attemptIndex: 0,
    url,
    method: "GET",
    fields: new HttpFields()
  });
  return prepared?.[0]?.value ?? "";
}

async function storeFixture(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return {
    directory,
    store: await BrowserStore.open({
      statePath: join(directory, "state.json")
    })
  };
}

test("browser cookies reject public-suffix domains and persist valid cookies", async () => {
  const current = await storeFixture("verge-cookie-store-");
  try {
    await current.store.httpSession.acceptResponse(
      responseContext("https://evil.com/", [
        "invalid=1; Domain=com; Path=/",
        "host=1; Path=/; HttpOnly"
      ])
    );

    assert.equal(
      await cookieValue(current.store.httpSession, "https://other.com/"),
      ""
    );
    assert.equal(
      await cookieValue(current.store.httpSession, "https://evil.com/next"),
      "host=1"
    );

    const reopened = await BrowserStore.open({
      statePath: join(current.directory, "state.json")
    });
    assert.equal(
      await cookieValue(reopened.httpSession, "https://evil.com/next"),
      "host=1"
    );
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test("redirect hops recalculate cookies and page cookies reach stylesheets immediately", async () => {
  const observed = {
    source: "",
    target: "",
    stylesheet: "",
    link: "",
    reload: ""
  };
  let targetRequests = 0;
  const server = createServer((request, response) => {
    const host = request.headers.host ?? "";
    if (request.url === "/start") {
      observed.source = request.headers.cookie ?? "";
      response.statusCode = 302;
      response.setHeader("set-cookie", "source=private; Path=/");
      response.setHeader(
        "location",
        `http://localhost:${host.split(":").at(-1) ?? ""}/target`
      );
      response.end();
      return;
    }
    if (request.url === "/target") {
      targetRequests += 1;
      if (targetRequests === 1) observed.target = request.headers.cookie ?? "";
      else observed.reload = request.headers.cookie ?? "";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "page=ready; Path=/");
      response.end(`
        <link rel="stylesheet" href="/style.css">
        <a href="/next">Next</a>
        <p>Target</p>
      `);
      return;
    }
    if (request.url === "/style.css") {
      observed.stylesheet = request.headers.cookie ?? "";
      response.setHeader("content-type", "text/css");
      response.end("p { color: green }");
      return;
    }
    if (request.url === "/next") {
      observed.link = request.headers.cookie ?? "";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<p>Next</p>");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const current = await storeFixture("verge-cookie-network-");
  const client = new PageNetworkClient({
    session: current.store.httpSession,
    publicAddressPolicy: "allow-private-and-local"
  });
  const session = new BrowserSession({ networkClient: client });

  try {
    const destinationOrigin = `http://localhost:${String(address.port)}`;
    await current.store.httpSession.acceptResponse(
      responseContext(`${destinationOrigin}/seed`, [
        "destination=correct; Path=/"
      ])
    );

    const snapshot = await session.open(
      `http://127.0.0.1:${String(address.port)}/start`
    );
    assert.equal(snapshot.finalUrl, `${destinationOrigin}/target`);
    assert.equal(snapshot.diagnostics.parseMode, "stream");
    assert.equal(observed.source, "");
    assert.match(observed.target, /(?:^|; )destination=correct(?:;|$)/u);
    assert.doesNotMatch(observed.target, /(?:^|; )source=private(?:;|$)/u);
    assert.match(observed.stylesheet, /(?:^|; )page=ready(?:;|$)/u);
    assert.doesNotMatch(observed.stylesheet, /(?:^|; )source=private(?:;|$)/u);

    await session.openLink(1);
    assert.match(observed.link, /(?:^|; )destination=correct(?:;|$)/u);
    assert.match(observed.link, /(?:^|; )page=ready(?:;|$)/u);

    await session.back();
    await session.reload();
    assert.match(observed.reload, /(?:^|; )page=ready(?:;|$)/u);
  } finally {
    await session.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(current.directory, { recursive: true, force: true });
  }
});
