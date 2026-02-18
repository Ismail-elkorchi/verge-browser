import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { URL } from "node:url";

import { parse } from "html-parser";

import { parseCommand } from "../../dist/app/commands.js";
import { cookieHeaderForUrl, mergeSetCookieHeaders, parseSetCookie } from "../../dist/app/cookies.js";
import { fetchPage } from "../../dist/app/fetch-page.js";
import { buildFormSubmissionRequest, extractForms } from "../../dist/app/forms.js";
import { assertAllowedProtocol, isHtmlLikeContentType } from "../../dist/app/security.js";
import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

function parseProfile(argv) {
  const profileArg = argv.find((argument) => argument.startsWith("--profile="));
  if (!profileArg) {
    return "ci";
  }
  const value = profileArg.slice("--profile=".length).trim();
  if (value !== "ci" && value !== "release") {
    throw new Error(`invalid profile: ${value}`);
  }
  return value;
}

async function runPhase20PostAndSetCookieCheck() {
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "phase20=ok; Path=/");
      response.end("<html><body><h1>phase20</h1></body></html>");
      return;
    }
    response.statusCode = 405;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body><h1>method-not-allowed</h1></body></html>");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("server address unavailable");
  }

  const targetUrl = `http://127.0.0.1:${String(address.port)}/submit`;
  try {
    const response = await fetchPage(targetUrl, 15_000, undefined, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      bodyText: "q=alpha"
    });
    return {
      ok: response.status === 200 && response.setCookieHeaders[0] === "phase20=ok; Path=/",
      details: {
        status: response.status,
        setCookieHeaders: response.setCookieHeaders
      }
    };
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function runPhase21CookieStoreCheck() {
  const stateDir = await mkdtemp(join(tmpdir(), "verge-phase21-"));
  const statePath = join(stateDir, "state.json");
  try {
    const store = await BrowserStore.open({ statePath });
    await store.applySetCookieHeaders("https://example.com/app", [
      "sid=abc; Path=/; HttpOnly",
      "prefs=dark; Path=/app"
    ]);
    const cookieHeader = store.cookieHeaderForUrl("https://example.com/app/page");
    const cookies = store.listCookies();
    return {
      ok: cookieHeader === "prefs=dark; sid=abc" && cookies.length === 2,
      details: {
        cookieHeader,
        cookieCount: cookies.length
      }
    };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function runPhase17DiagnosticsCheck() {
  const observed = {
    method: null,
    cookie: null
  };
  const loader = async (requestUrl, requestOptions) => {
    observed.method = requestOptions?.method ?? null;
    observed.cookie = requestOptions?.headers?.cookie ?? null;
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: "<html><head><title>diag</title></head><body><p>ok</p></body></html>",
      setCookieHeaders: ["diag=1; Path=/"],
      fetchedAtIso: "2026-01-01T00:00:00.000Z"
    };
  };
  const session = new BrowserSession({
    loader,
    widthProvider: () => 100
  });

  const snapshot = await session.openWithRequest("https://diag.example/", {
    method: "POST",
    headers: {
      cookie: "seed=1"
    },
    bodyText: "q=diag"
  });

  const allFinite = [
    snapshot.diagnostics.fetchDurationMs,
    snapshot.diagnostics.parseDurationMs,
    snapshot.diagnostics.renderDurationMs,
    snapshot.diagnostics.totalDurationMs
  ].every((value) => Number.isFinite(value) && value >= 0);

  return {
    ok:
      observed.method === "POST"
      && observed.cookie === "seed=1"
      && snapshot.diagnostics.requestMethod === "POST"
      && snapshot.diagnostics.usedCookies === true
      && allFinite,
    details: {
      observed,
      diagnostics: snapshot.diagnostics
    }
  };
}

async function runPhase15RecallCheck() {
  const stateDir = await mkdtemp(join(tmpdir(), "verge-phase15-"));
  const statePath = join(stateDir, "state.json");
  try {
    const store = await BrowserStore.open({ statePath });
    await store.recordIndexDocument("https://example.com/a", "Alpha", "alpha beta gamma");
    await store.recordIndexDocument("https://example.com/b", "Beta", "beta beta delta");
    const results = store.searchIndex("beta");
    return {
      ok: results.length === 2 && results[0]?.url === "https://example.com/b",
      details: {
        resultCount: results.length,
        firstUrl: results[0]?.url ?? null
      }
    };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));

  const parsedCookie = parseSetCookie("sid=abc; Path=/; HttpOnly", "https://example.com/");
  const mergedCookies = mergeSetCookieHeaders([], ["sid=abc; Path=/; HttpOnly"], "https://example.com/");
  const cookieHeader = cookieHeaderForUrl(mergedCookies, "https://example.com/home");
  const phase13 = {
    ok: Boolean(parsedCookie) && mergedCookies.length === 1 && cookieHeader === "sid=abc",
    details: {
      parsedCookie,
      cookieHeader,
      cookieCount: mergedCookies.length
    }
  };

  const formTree = parse(`
    <html><body>
      <form method="get" action="/search"><input name="q" value="alpha" /></form>
      <form method="post" action="/login"><input name="user" value="ismail" /></form>
    </body></html>
  `);
  const forms = extractForms(formTree, "https://example.com/base");
  const getSubmission = buildFormSubmissionRequest(forms[0], { q: "beta" });
  const postSubmission = buildFormSubmissionRequest(forms[1], { user: "agent" });
  const phase14 = {
    ok:
      forms.length === 2
      && getSubmission.requestOptions.method === "GET"
      && getSubmission.url === "https://example.com/search?q=beta"
      && postSubmission.requestOptions.method === "POST"
      && postSubmission.requestOptions.bodyText === "user=agent",
    details: {
      formCount: forms.length,
      getSubmission,
      postSubmission
    }
  };

  const phase15 = await runPhase15RecallCheck();
  const phase16 = {
    ok:
      parseCommand("reader").kind === "reader"
      && parseCommand("download ./snapshot.html").kind === "download"
      && parseCommand("recall alpha").kind === "recall",
    details: {
      readerCommand: parseCommand("reader"),
      downloadCommand: parseCommand("download ./snapshot.html"),
      recallCommand: parseCommand("recall alpha")
    }
  };

  const phase17 = await runPhase17DiagnosticsCheck();

  const phase18 = {
    ok:
      parseCommand("cookie list").kind === "cookie-list"
      && parseCommand("cookie clear").kind === "cookie-clear"
      && parseCommand("recall open 1").kind === "recall-open",
    details: {
      cookieList: parseCommand("cookie list"),
      cookieClear: parseCommand("cookie clear"),
      recallOpen: parseCommand("recall open 1")
    }
  };

  let blockedProtocol = false;
  try {
    assertAllowedProtocol(new URL("javascript:alert(1)"));
  } catch {
    blockedProtocol = true;
  }
  const phase19 = {
    ok: blockedProtocol && isHtmlLikeContentType("image/png") === false && isHtmlLikeContentType("text/html; charset=utf-8") === true,
    details: {
      blockedProtocol,
      imagePngAllowed: isHtmlLikeContentType("image/png"),
      htmlAllowed: isHtmlLikeContentType("text/html; charset=utf-8")
    }
  };

  const phase20 = await runPhase20PostAndSetCookieCheck();
  const phase21 = await runPhase21CookieStoreCheck();

  const streamReport = await readJson(resolve("reports/stream.json"));
  const phase22 = {
    ok: streamReport?.overall?.ok === true,
    details: {
      streamOk: streamReport?.overall?.ok === true
    }
  };

  const agentReport = await readJson(resolve("reports/agent.json"));
  const phase23 = {
    ok: agentReport?.overall?.ok === true,
    details: {
      agentOk: agentReport?.overall?.ok === true
    }
  };

  const benchGovernanceReport = await readJson(resolve("reports/bench-governance.json"));
  const phase24 = {
    ok: benchGovernanceReport?.ok === true,
    details: {
      benchGovernanceOk: benchGovernanceReport?.ok === true,
      benchmarksCompared: benchGovernanceReport?.benchmarksCompared ?? 0
    }
  };

  let phase25;
  if (profile === "release") {
    const releaseIntegrity = await readJson(resolve("reports/release-integrity.json"));
    phase25 = {
      ok: releaseIntegrity?.ok === true,
      details: {
        releaseIntegrityOk: releaseIntegrity?.ok === true
      }
    };
  } else {
    phase25 = {
      ok: true,
      details: {
        releaseIntegrityOk: null,
        skippedInProfile: profile
      }
    };
  }

  const phaseChecks = {
    phase13: phase13,
    phase14: phase14,
    phase15: phase15,
    phase16: phase16,
    phase17: phase17,
    phase18: phase18,
    phase19: phase19,
    phase20: phase20,
    phase21: phase21,
    phase22: phase22,
    phase23: phase23,
    phase24: phase24,
    phase25: phase25
  };

  const phase26 = {
    ok: Object.values(phaseChecks).every((check) => check.ok === true),
    details: {
      failingPhases: Object.entries(phaseChecks).filter(([, check]) => check.ok !== true).map(([phaseName]) => phaseName)
    }
  };

  assert.equal(typeof phase26.ok, "boolean");

  const report = {
    suite: "phase-ladder",
    profile,
    timestamp: new Date().toISOString(),
    checks: {
      ...phaseChecks,
      phase26
    },
    overall: {
      ok: phase26.ok
    }
  };

  const reportPath = resolve("reports/phase-ladder.json");
  await writeJsonReport(reportPath, report);

  if (!report.overall.ok) {
    throw new Error("phase ladder checks failed");
  }

  process.stdout.write(`phase ladder ${profile} ok: ${reportPath}\n`);
}

await main();
