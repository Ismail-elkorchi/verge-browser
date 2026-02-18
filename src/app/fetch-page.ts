import { readFile } from "node:fs/promises";

import { formatHelpText } from "./commands.js";
import { DEFAULT_SECURITY_POLICY, assertAllowedProtocol, isHtmlLikeContentType, type SecurityPolicyOptions } from "./security.js";
import type { FetchPageResult, FetchPageStreamResult, PageRequestOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const ABOUT_HELP_HTML = `<!doctype html>
<html>
  <head><title>verge-browser help</title></head>
  <body>
    <h1>verge-browser help</h1>
    <p>Deterministic terminal browsing with html-parser.</p>
    <pre>${escapeHtml(formatHelpText())}</pre>
  </body>
</html>`;

const UTF8_ENCODER = new TextEncoder();

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchFileUrl(requestUrl: string): Promise<FetchPageResult> {
  const fileUrl = new URL(requestUrl);
  assertAllowedProtocol(fileUrl);

  const filePath = decodeURIComponent(fileUrl.pathname);
  const html = await readFile(filePath, "utf8");

  return {
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html,
    setCookieHeaders: [],
    fetchedAtIso: nowIso()
  };
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function streamFromUtf8(value: string): ReadableStream<Uint8Array> {
  const chunk = UTF8_ENCODER.encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    }
  });
}

function withByteLimit(source: ReadableStream<Uint8Array>, maxContentBytes: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let totalBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }

      totalBytes += next.value.byteLength;
      if (totalBytes > maxContentBytes) {
        await reader.cancel(`maxContentBytes exceeded: ${String(maxContentBytes)}`);
        controller.error(new Error(`Response exceeded maxContentBytes=${String(maxContentBytes)}`));
        return;
      }

      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}

export async function readByteStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const textDecoder = new TextDecoder();
  let html = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    html += textDecoder.decode(value, { stream: true });
  }

  html += textDecoder.decode();
  return html;
}

async function readResponseBodyWithLimit(stream: ReadableStream<Uint8Array> | null, maxContentBytes: number): Promise<string> {
  if (!stream) {
    return "";
  }

  const limitedStream = withByteLimit(stream, maxContentBytes);
  return readByteStreamToText(limitedStream);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

interface NetworkFetchResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly setCookieHeaders: readonly string[];
  readonly fetchedAtIso: string;
}

function readSetCookieHeaders(headers: Headers): readonly string[] {
  const headersWithSetCookie = headers as Headers & {
    readonly getSetCookie?: () => string[];
  };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const singleHeader = headers.get("set-cookie");
  if (!singleHeader) {
    return [];
  }
  return [singleHeader];
}

async function fetchNetworkResponse(
  requestUrl: string,
  timeoutMs: number,
  securityPolicy: Required<SecurityPolicyOptions>,
  requestOptions: PageRequestOptions
): Promise<NetworkFetchResult> {
  let currentUrl = requestUrl;
  for (let redirectCount = 0; redirectCount <= securityPolicy.maxRedirects; redirectCount += 1) {
    const parsedCurrentUrl = new URL(currentUrl);
    assertAllowedProtocol(parsedCurrentUrl);

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort("fetch timeout");
    }, timeoutMs);

    try {
      const method = requestOptions.method ?? "GET";
      const requestHeaders: Record<string, string> = {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "verge-browser/0.1 (+terminal; html-parser)",
        ...(requestOptions.headers ?? {})
      };

      const response = await fetch(currentUrl, {
        method,
        redirect: "manual",
        signal: abortController.signal,
        headers: requestHeaders,
        ...(method === "POST" ? { body: requestOptions.bodyText ?? "" } : {})
      });

      if (isRedirectStatus(response.status)) {
        if (redirectCount >= securityPolicy.maxRedirects) {
          throw new Error(`Redirect limit exceeded (${String(securityPolicy.maxRedirects)})`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response missing location header: ${String(response.status)}`);
        }
        const nextUrl = new URL(location, currentUrl);
        assertAllowedProtocol(nextUrl);
        currentUrl = nextUrl.toString();
        continue;
      }

      const contentType = response.headers.get("content-type");
      if (!isHtmlLikeContentType(contentType)) {
        throw new Error(`Blocked non-HTML content-type: ${contentType ?? "unknown"}`);
      }

      return {
        requestUrl,
        finalUrl: response.url || currentUrl,
        status: response.status,
        statusText: response.statusText,
        contentType,
        body: response.body,
        setCookieHeaders: readSetCookieHeaders(response.headers),
        fetchedAtIso: nowIso()
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Network request timed out after ${String(timeoutMs)}ms`);
      }
      if (error instanceof Error) {
        const cause = (error as { readonly cause?: unknown }).cause;
        const causeMessage = cause instanceof Error
          ? cause.message
          : (
            cause && typeof cause === "object" && "code" in cause
              ? String(cause.code)
              : null
          );
        const detail = causeMessage ? `${error.message} (${causeMessage})` : error.message;
        throw new Error(`Network request failed for ${currentUrl}: ${detail}`);
      }
      throw new Error(`Network request failed for ${currentUrl}: ${String(error)}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new Error("Unreachable redirect state");
}

export async function fetchPage(
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {}
): Promise<FetchPageResult> {
  const policy = {
    ...DEFAULT_SECURITY_POLICY,
    ...securityPolicy
  };

  if (requestUrl === "about:help") {
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: ABOUT_HELP_HTML,
      setCookieHeaders: [],
      fetchedAtIso: nowIso()
    };
  }

  if (requestUrl.startsWith("file://")) {
    return fetchFileUrl(requestUrl);
  }

  const networkResult = await fetchNetworkResponse(requestUrl, timeoutMs, policy, requestOptions);
  const html = await readResponseBodyWithLimit(networkResult.body, policy.maxContentBytes);

  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    html,
    setCookieHeaders: networkResult.setCookieHeaders,
    fetchedAtIso: networkResult.fetchedAtIso
  };
}

export async function fetchPageStream(
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {}
): Promise<FetchPageStreamResult> {
  const policy = {
    ...DEFAULT_SECURITY_POLICY,
    ...securityPolicy
  };

  if (requestUrl === "about:help") {
    const aboutBytes = utf8ByteLength(ABOUT_HELP_HTML);
    if (aboutBytes > policy.maxContentBytes) {
      throw new Error(`Response exceeded maxContentBytes=${String(policy.maxContentBytes)}`);
    }
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      stream: streamFromUtf8(ABOUT_HELP_HTML),
      setCookieHeaders: [],
      fetchedAtIso: nowIso()
    };
  }

  if (requestUrl.startsWith("file://")) {
    const filePage = await fetchFileUrl(requestUrl);
    const fileBytes = utf8ByteLength(filePage.html);
    if (fileBytes > policy.maxContentBytes) {
      throw new Error(`Response exceeded maxContentBytes=${String(policy.maxContentBytes)}`);
    }
    return {
      requestUrl: filePage.requestUrl,
      finalUrl: filePage.finalUrl,
      status: filePage.status,
      statusText: filePage.statusText,
      contentType: filePage.contentType,
      stream: streamFromUtf8(filePage.html),
      setCookieHeaders: [],
      fetchedAtIso: filePage.fetchedAtIso
    };
  }

  const networkResult = await fetchNetworkResponse(requestUrl, timeoutMs, policy, requestOptions);
  const stream = networkResult.body ?? streamFromUtf8("");

  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    stream: withByteLimit(stream, policy.maxContentBytes),
    setCookieHeaders: networkResult.setCookieHeaders,
    fetchedAtIso: networkResult.fetchedAtIso
  };
}
