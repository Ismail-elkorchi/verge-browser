import { readFile } from "node:fs/promises";

import type { FetchPageResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

const ABOUT_HELP_HTML = `<!doctype html>
<html>
  <head><title>verge-browser help</title></head>
  <body>
    <h1>verge-browser</h1>
    <p>Deterministic terminal browsing with html-parser.</p>
    <ul>
      <li>help</li>
      <li>view</li>
      <li>links</li>
      <li>open &lt;index|url&gt;</li>
      <li>back</li>
      <li>forward</li>
      <li>reload</li>
      <li>quit</li>
    </ul>
  </body>
</html>`;

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchFileUrl(requestUrl: string): Promise<FetchPageResult> {
  const fileUrl = new URL(requestUrl);
  const filePath = decodeURIComponent(fileUrl.pathname);
  const html = await readFile(filePath, "utf8");

  return {
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html,
    fetchedAtIso: nowIso()
  };
}

export async function fetchPage(requestUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchPageResult> {
  if (requestUrl === "about:help") {
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: ABOUT_HELP_HTML,
      fetchedAtIso: nowIso()
    };
  }

  if (requestUrl.startsWith("file://")) {
    return fetchFileUrl(requestUrl);
  }

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort("fetch timeout");
  }, timeoutMs);

  try {
    const response = await fetch(requestUrl, {
      redirect: "follow",
      signal: abortController.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "verge-browser/0.1 (+terminal; html-parser)"
      }
    });

    const html = await response.text();

    return {
      requestUrl,
      finalUrl: response.url || requestUrl,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      html,
      fetchedAtIso: nowIso()
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Network request timed out after ${String(timeoutMs)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
