import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HttpFields } from "@ismail-elkorchi/http-client";

import { PageNetworkClient } from "../../dist/app/fetch-page.js";
import {
  BrowserSession,
  openPageInitiatedNavigation
} from "../../dist/app/session.js";
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

test("insecure responses cannot seed cookies for a later secure origin", async () => {
  const current = await storeFixture("verge-cookie-secure-origin-");
  try {
    await current.store.httpSession.acceptResponse(
      responseContext("http://example.test/", [
        "secureInjected=secret; Path=/; Secure",
        "plain=accepted; Path=/"
      ])
    );

    assert.equal(
      await cookieValue(current.store.httpSession, "https://example.test/"),
      "plain=accepted"
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

test("cross-origin stylesheet redirects neither receive nor mutate browser cookies", async () => {
  const observed = { initial: "", redirected: "" };
  const server = createServer((request, response) => {
    const port = (request.headers.host ?? "").split(":").at(-1) ?? "";
    if (request.url === "/page") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "page=same-origin; Path=/");
      response.end('<link rel="stylesheet" href="/style-start"><p>Page</p>');
      return;
    }
    if (request.url === "/style-start") {
      observed.initial = request.headers.cookie ?? "";
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${port}/cross.css`);
      response.end();
      return;
    }
    if (request.url === "/cross.css") {
      observed.redirected = request.headers.cookie ?? "";
      response.setHeader("content-type", "text/css");
      response.setHeader("set-cookie", "thirdparty=blocked; Path=/");
      response.end("p { color: green }");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const current = await storeFixture("verge-cookie-cross-origin-");
  const crossOrigin = `http://127.0.0.1:${String(address.port)}`;
  const documentOrigin = `http://localhost:${String(address.port)}`;
  await current.store.httpSession.acceptResponse(
    responseContext(`${crossOrigin}/seed`, ["destination=private; Path=/"])
  );
  const client = new PageNetworkClient({
    session: current.store.httpSession,
    publicAddressPolicy: "allow-private-and-local"
  });
  const session = new BrowserSession({ networkClient: client });

  try {
    await session.open(`${documentOrigin}/page`);
    assert.match(observed.initial, /(?:^|; )page=same-origin(?:;|$)/u);
    assert.equal(observed.redirected, "");
    const crossCookies = await cookieValue(current.store.httpSession, `${crossOrigin}/after`);
    assert.match(crossCookies, /(?:^|; )destination=private(?:;|$)/u);
    assert.doesNotMatch(crossCookies, /thirdparty/u);
  } finally {
    await session.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(current.directory, { recursive: true, force: true });
  }
});

test("page-initiated requests enforce SameSite cookies while direct navigation remains explicit", async () => {
  const observed = [];
  let targetUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/source") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<a href="${targetUrl}">Cross-site target</a>`);
      return;
    }
    if (request.url === "/target") {
      observed.push({
        method: request.method,
        cookie: request.headers.cookie ?? ""
      });
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<p>Target</p>");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  targetUrl = `http://127.0.0.1:${String(address.port)}/target`;
  const sourceUrl = `http://localhost:${String(address.port)}/source`;
  const current = await storeFixture("verge-cookie-samesite-");
  await current.store.httpSession.acceptResponse(
    responseContext(targetUrl, [
      "strictCookie=one; Path=/; SameSite=Strict",
      "laxCookie=two; Path=/; SameSite=Lax",
      "defaultCookie=three; Path=/",
      "insecureNone=four; Path=/; SameSite=None"
    ])
  );
  const client = new PageNetworkClient({
    session: current.store.httpSession,
    publicAddressPolicy: "allow-private-and-local"
  });
  const session = new BrowserSession({ networkClient: client });

  try {
    await session.open(sourceUrl);
    await session.openLink(1);
    assert.match(observed[0]?.cookie ?? "", /(?:^|; )laxCookie=two(?:;|$)/u);
    assert.match(observed[0]?.cookie ?? "", /(?:^|; )defaultCookie=three(?:;|$)/u);
    assert.doesNotMatch(observed[0]?.cookie ?? "", /strictCookie/u);

    await openPageInitiatedNavigation(session, sourceUrl, targetUrl, {
      method: "POST",
      bodyText: "action=submit"
    });
    assert.equal(observed[1]?.method, "POST");
    assert.doesNotMatch(
      observed[1]?.cookie ?? "",
      /strictCookie|laxCookie|defaultCookie|insecureNone/u
    );

    await session.open(targetUrl);
    assert.match(observed[2]?.cookie ?? "", /(?:^|; )strictCookie=one(?:;|$)/u);
    assert.match(observed[2]?.cookie ?? "", /(?:^|; )laxCookie=two(?:;|$)/u);
    assert.match(observed[2]?.cookie ?? "", /(?:^|; )defaultCookie=three(?:;|$)/u);
    assert.doesNotMatch(observed[2]?.cookie ?? "", /insecureNone/u);
  } finally {
    await session.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(current.directory, { recursive: true, force: true });
  }
});

test("browser cookie persistence evicts old entries before the profile can grow without bound", async () => {
  const current = await storeFixture("verge-cookie-limit-");
  try {
    await current.store.httpSession.acceptResponse(
      responseContext("https://cookies.example/", Array.from(
        { length: 1005 },
        (_, index) => `cookie${String(index)}=value; Path=/`
      ))
    );
    assert.equal(current.store.listCookies().length, 1000);
    assert.equal(current.store.listCookies().some((cookie) => cookie.name === "cookie0"), false);
    assert.equal(current.store.listCookies().some((cookie) => cookie.name === "cookie1004"), true);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});
