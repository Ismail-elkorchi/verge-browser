import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { classifyNetworkFailure, fetchPage } from "../../dist/app/fetch-page.js";

import { writeJsonReport } from "./render-eval-lib.mjs";

const REQUIRED_KINDS = [
  "ok",
  "http_error",
  "timeout",
  "dns",
  "tls",
  "redirect_limit",
  "content_type_block",
  "size_limit",
  "unsupported_protocol",
  "unknown"
];

function createHtmlBody(bytes) {
  return `<!doctype html><html><body>${"x".repeat(bytes)}</body></html>`;
}

function startFixtureServer() {
  const server = createServer((request, response) => {
    const requestPath = request.url ?? "/";

    if (requestPath === "/ok") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>ok</body></html>");
      return;
    }

    if (requestPath === "/http-error") {
      response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>forbidden</body></html>");
      return;
    }

    if (requestPath === "/redirect-loop") {
      response.writeHead(302, {
        "content-type": "text/html; charset=utf-8",
        location: "/redirect-loop"
      });
      response.end("<!doctype html><html><body>redirect</body></html>");
      return;
    }

    if (requestPath === "/non-html") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
      return;
    }

    if (requestPath === "/large") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(createHtmlBody(8_192));
      return;
    }

    if (requestPath === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>slow</body></html>");
      }, 250);
      return;
    }

    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>not found</body></html>");
  });
  return server;
}

function normalizeErrorMessage(value) {
  return value.replaceAll(/\d+/g, "<num>").slice(0, 200);
}

function ensureError(value) {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

async function evaluateCase(input) {
  try {
    const result = await input.run();
    const outcome = "networkOutcome" in result ? result.networkOutcome : classifyNetworkFailure(new Error("missing network outcome"), input.url);
    return {
      id: input.id,
      expectedKind: input.expectedKind,
      actualKind: outcome.kind,
      ok: outcome.kind === input.expectedKind,
      detailCode: outcome.detailCode ?? null,
      detailMessage: normalizeErrorMessage(outcome.detailMessage)
    };
  } catch (error) {
    const normalizedError = ensureError(error);
    const outcome = classifyNetworkFailure(normalizedError, input.url);
    return {
      id: input.id,
      expectedKind: input.expectedKind,
      actualKind: outcome.kind,
      ok: outcome.kind === input.expectedKind,
      detailCode: outcome.detailCode ?? null,
      detailMessage: normalizeErrorMessage(outcome.detailMessage)
    };
  }
}

function syntheticError(message, detailCode) {
  const error = new Error(message);
  if (detailCode) {
    Object.defineProperty(error, "cause", {
      value: { code: detailCode },
      enumerable: false
    });
  }
  return error;
}

function buildReplayError(spec) {
  const cause = spec && typeof spec === "object" && "cause" in spec ? buildReplayError(spec.cause) : undefined;
  const hasMessage = typeof spec?.message === "string";
  const hasName = typeof spec?.name === "string";
  const hasCode = typeof spec?.code === "string";
  if (!hasMessage && !hasName && hasCode && cause === undefined) {
    return { code: spec.code };
  }
  const error = new Error(hasMessage ? spec.message : "network replay error", cause !== undefined ? { cause } : undefined);
  if (hasName) {
    error.name = spec.name;
  }
  if (hasCode) {
    Object.defineProperty(error, "code", {
      value: spec.code,
      enumerable: true
    });
  }
  return error;
}

async function main() {
  const server = startFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose an address");
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const cases = [
    {
      id: "ok-http",
      expectedKind: "ok",
      url: `${baseUrl}/ok`,
      run: async () => fetchPage(`${baseUrl}/ok`)
    },
    {
      id: "http-error",
      expectedKind: "http_error",
      url: `${baseUrl}/http-error`,
      run: async () => fetchPage(`${baseUrl}/http-error`)
    },
    {
      id: "timeout",
      expectedKind: "timeout",
      url: `${baseUrl}/slow`,
      run: async () => fetchPage(`${baseUrl}/slow`, 50)
    },
    {
      id: "redirect-limit",
      expectedKind: "redirect_limit",
      url: `${baseUrl}/redirect-loop`,
      run: async () => fetchPage(`${baseUrl}/redirect-loop`, undefined, { maxRedirects: 0 })
    },
    {
      id: "content-type-block",
      expectedKind: "content_type_block",
      url: `${baseUrl}/non-html`,
      run: async () => fetchPage(`${baseUrl}/non-html`)
    },
    {
      id: "size-limit",
      expectedKind: "size_limit",
      url: `${baseUrl}/large`,
      run: async () => fetchPage(`${baseUrl}/large`, undefined, { maxContentBytes: 128 })
    },
    {
      id: "unsupported-protocol",
      expectedKind: "unsupported_protocol",
      url: "ftp://example.test/file.html",
      run: async () => fetchPage("ftp://example.test/file.html")
    },
    {
      id: "dns-synthetic",
      expectedKind: "dns",
      url: "https://dns.invalid/",
      run: async () => {
        throw syntheticError("getaddrinfo ENOTFOUND dns.invalid", "ENOTFOUND");
      }
    },
    {
      id: "tls-synthetic",
      expectedKind: "tls",
      url: "https://tls.invalid/",
      run: async () => {
        throw syntheticError("TLS certificate rejected", "ERR_TLS_CERT_ALTNAME_INVALID");
      }
    },
    {
      id: "unknown-synthetic",
      expectedKind: "unknown",
      url: "https://unknown.invalid/",
      run: async () => {
        throw syntheticError("opaque network failure", null);
      }
    }
  ];

  const replayFixtureSource = await readFile("test/fixtures/network-replay/failure-cases.json", "utf8");
  const replayFixtures = JSON.parse(replayFixtureSource);
  const replayCases = replayFixtures.map((fixture) => ({
    id: `replay-${fixture.id}`,
    expectedKind: fixture.expected.kind,
    url: fixture.finalUrl,
    run: async () => {
      throw buildReplayError(fixture.error);
    }
  }));

  let records;
  try {
    records = await Promise.all([...cases, ...replayCases].map((entry) => evaluateCase(entry)));
  } finally {
    server.close();
  }

  const presentKinds = [...new Set(records.map((record) => record.actualKind))].sort((left, right) => left.localeCompare(right));
  const missingKinds = REQUIRED_KINDS.filter((kind) => !presentKinds.includes(kind));

  const report = {
    suite: "network-outcomes",
    timestamp: new Date().toISOString(),
    requiredKinds: REQUIRED_KINDS,
    coverage: {
      presentKinds,
      missingKinds
    },
    replayFixtureCount: replayCases.length,
    cases: records,
    overall: {
      ok: records.every((record) => record.ok) && missingKinds.length === 0 && replayCases.length > 0
    }
  };

  const reportPath = resolve("reports/network-outcomes.json");
  await writeJsonReport(reportPath, report);

  if (!report.overall.ok) {
    const failedCases = records
      .filter((record) => !record.ok)
      .map((record) => `${record.id}:${record.expectedKind}->${record.actualKind}`);
    throw new Error(`network outcomes report failed: ${failedCases.join(", ")} missingKinds=${missingKinds.join(",")}`);
  }

  process.stdout.write(`network outcomes report ok: ${reportPath}\n`);
}

await main();
