import { readFile } from "node:fs/promises";

import { formatHelpText } from "./commands.js";
import { DEFAULT_SECURITY_POLICY, assertAllowedProtocol, isHtmlLikeContentType, type SecurityPolicyOptions } from "./security.js";
import type {
  FetchPageResult,
  FetchPageStreamResult,
  NetworkOutcome,
  NetworkOutcomeKind,
  PageRequestOptions
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DNS_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENODATA",
  "EHOSTUNREACH"
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
  "TIMEOUT"
]);
const TRANSIENT_RETRY_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const ERROR_CODE_PATTERN =
  /\b(ENOTFOUND|EAI_AGAIN|ENODATA|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|EPIPE|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|CERT_[A-Z_]+|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UND_ERR_[A-Z_]+)\b/gi;

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

function createNetworkOutcome(
  kind: NetworkOutcomeKind,
  options: {
    readonly finalUrl: string;
    readonly status?: number | null;
    readonly statusText?: string | null;
    readonly detailCode?: string | null;
    readonly detailMessage: string;
  }
): NetworkOutcome {
  return {
    kind,
    finalUrl: options.finalUrl,
    status: options.status ?? null,
    statusText: options.statusText ?? null,
    detailCode: options.detailCode ?? null,
    detailMessage: options.detailMessage
  };
}

function outcomeFromHttpStatus(finalUrl: string, status: number, statusText: string): NetworkOutcome {
  const detailCode = `HTTP_${String(status)}`;
  const detailMessage = `${String(status)} ${statusText}`;
  if (status >= 400) {
    return createNetworkOutcome("http_error", {
      finalUrl,
      status,
      statusText,
      detailCode,
      detailMessage
    });
  }
  return createNetworkOutcome("ok", {
    finalUrl,
    status,
    statusText,
    detailCode,
    detailMessage
  });
}

function tlsCodeLike(rawCode: string): boolean {
  const normalized = rawCode.toUpperCase();
  return (
    normalized.includes("TLS") ||
    normalized.includes("SSL") ||
    normalized.includes("CERT") ||
    normalized.includes("SELF_SIGNED") ||
    normalized.includes("UNABLE_TO_VERIFY")
  );
}

function collectErrorCodes(error: unknown): readonly string[] {
  const codes = new Set<string>();
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current === "object" && "code" in current) {
      const rawCode = (current as { readonly code: unknown }).code;
      if (typeof rawCode === "string" && rawCode.trim().length > 0) {
        codes.add(rawCode.toUpperCase());
      }
    }

    if (current instanceof Error) {
      for (const match of current.message.toUpperCase().matchAll(ERROR_CODE_PATTERN)) {
        const code = match[1];
        if (code) {
          codes.add(code);
        }
      }
      const cause = (current as { readonly cause?: unknown }).cause;
      if (cause !== undefined) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "string") {
      for (const match of current.toUpperCase().matchAll(ERROR_CODE_PATTERN)) {
        const code = match[1];
        if (code) {
          codes.add(code);
        }
      }
      continue;
    }

    if (typeof current === "object" && "cause" in current) {
      queue.push((current as { readonly cause?: unknown }).cause);
    }
  }

  return [...codes];
}

function detailCodeFromError(error: unknown): string | null {
  const codes = collectErrorCodes(error);
  return codes[0] ?? null;
}

function shouldRetryNetworkError(error: unknown, method: string, attemptIndex: number, maxRequestRetries: number): boolean {
  if (attemptIndex >= maxRequestRetries || method !== "GET") {
    return false;
  }
  for (const code of collectErrorCodes(error)) {
    if (TRANSIENT_RETRY_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class NetworkFetchError extends Error {
  readonly networkOutcome: NetworkOutcome;

  constructor(networkOutcome: NetworkOutcome) {
    super(`${networkOutcome.kind}: ${networkOutcome.detailMessage}`);
    this.name = "NetworkFetchError";
    this.networkOutcome = networkOutcome;
  }
}

export function classifyNetworkFailure(error: unknown, finalUrl: string): NetworkOutcome {
  if (error instanceof NetworkFetchError) {
    return error.networkOutcome;
  }

  const message = error instanceof Error ? error.message : String(error);
  const messageUpper = message.toUpperCase();
  const detailCode = detailCodeFromError(error);

  if (
    isAbortError(error) ||
    messageUpper.includes("TIMED OUT") ||
    messageUpper.includes("FETCH TIMEOUT") ||
    (detailCode !== null && TIMEOUT_ERROR_CODES.has(detailCode))
  ) {
    return createNetworkOutcome("timeout", {
      finalUrl,
      detailCode: detailCode ?? "TIMEOUT",
      detailMessage: message
    });
  }
  if (messageUpper.includes("BLOCKED UNSUPPORTED PROTOCOL")) {
    return createNetworkOutcome("unsupported_protocol", {
      finalUrl,
      detailCode: detailCode ?? "UNSUPPORTED_PROTOCOL",
      detailMessage: message
    });
  }
  if (messageUpper.includes("REDIRECT LIMIT EXCEEDED")) {
    return createNetworkOutcome("redirect_limit", {
      finalUrl,
      detailCode: detailCode ?? "REDIRECT_LIMIT",
      detailMessage: message
    });
  }
  if (messageUpper.includes("NON-HTML CONTENT-TYPE")) {
    return createNetworkOutcome("content_type_block", {
      finalUrl,
      detailCode: detailCode ?? "CONTENT_TYPE_BLOCK",
      detailMessage: message
    });
  }
  if (messageUpper.includes("MAXCONTENTBYTES")) {
    return createNetworkOutcome("size_limit", {
      finalUrl,
      detailCode: detailCode ?? "MAX_CONTENT_BYTES",
      detailMessage: message
    });
  }
  if (detailCode && DNS_ERROR_CODES.has(detailCode)) {
    return createNetworkOutcome("dns", {
      finalUrl,
      detailCode,
      detailMessage: message
    });
  }
  if (detailCode && tlsCodeLike(detailCode)) {
    return createNetworkOutcome("tls", {
      finalUrl,
      detailCode,
      detailMessage: message
    });
  }
  return createNetworkOutcome("unknown", {
    finalUrl,
    detailCode,
    detailMessage: message
  });
}

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
    responseHeaders: {
      "content-type": "text/html"
    },
    setCookieHeaders: [],
    fetchedAtIso: nowIso(),
    networkOutcome: createNetworkOutcome("ok", {
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "FILE_URL",
      detailMessage: "Loaded file URL"
    })
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
  readonly responseHeaders: Readonly<Record<string, string>>;
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

function flattenHeaders(headers: Headers): Readonly<Record<string, string>> {
  const groupedValues = new Map<string, string[]>();
  for (const [name, value] of headers.entries()) {
    const normalizedName = name.toLowerCase();
    const values = groupedValues.get(normalizedName) ?? [];
    values.push(value);
    groupedValues.set(normalizedName, values);
  }

  const flattened: Record<string, string> = {};
  for (const name of [...groupedValues.keys()].sort((left, right) => left.localeCompare(right))) {
    flattened[name] = (groupedValues.get(name) ?? []).join(", ");
  }
  return flattened;
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
    const method = requestOptions.method ?? "GET";
    const requestHeaders: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "verge-browser/0.1 (+terminal; html-parser)",
      ...(requestOptions.headers ?? {})
    };

    for (let attemptIndex = 0; attemptIndex <= securityPolicy.maxRequestRetries; attemptIndex += 1) {
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort("fetch timeout");
      }, timeoutMs);

      try {
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
          break;
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
          responseHeaders: flattenHeaders(response.headers),
          body: response.body,
          setCookieHeaders: readSetCookieHeaders(response.headers),
          fetchedAtIso: nowIso()
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Network request timed out after ${String(timeoutMs)}ms`, { cause: error });
        }
        if (shouldRetryNetworkError(error, method, attemptIndex, securityPolicy.maxRequestRetries)) {
          await sleep(securityPolicy.retryDelayMs);
          continue;
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
          throw new Error(`Network request failed for ${currentUrl}: ${detail}`, { cause: error });
        }
        throw new Error(`Network request failed for ${currentUrl}: ${String(error)}`);
      } finally {
        clearTimeout(timeoutHandle);
      }
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
      responseHeaders: {
        "content-type": "text/html"
      },
      setCookieHeaders: [],
      fetchedAtIso: nowIso(),
      networkOutcome: createNetworkOutcome("ok", {
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: "ABOUT_HELP",
        detailMessage: "Loaded about:help"
      })
    };
  }

  if (requestUrl.startsWith("file://")) {
    return fetchFileUrl(requestUrl);
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(requestUrl, timeoutMs, policy, requestOptions);
  } catch (error) {
    throw new NetworkFetchError(classifyNetworkFailure(error, requestUrl));
  }

  let html = "";
  try {
    html = await readResponseBodyWithLimit(networkResult.body, policy.maxContentBytes);
  } catch (error) {
    throw new NetworkFetchError(classifyNetworkFailure(error, networkResult.finalUrl));
  }

  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    html,
    responseHeaders: networkResult.responseHeaders,
    setCookieHeaders: networkResult.setCookieHeaders,
    fetchedAtIso: networkResult.fetchedAtIso,
    networkOutcome: outcomeFromHttpStatus(networkResult.finalUrl, networkResult.status, networkResult.statusText)
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
      throw new NetworkFetchError(
        createNetworkOutcome("size_limit", {
          finalUrl: requestUrl,
          detailCode: "MAX_CONTENT_BYTES",
          detailMessage: `Response exceeded maxContentBytes=${String(policy.maxContentBytes)}`
        })
      );
    }
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      stream: streamFromUtf8(ABOUT_HELP_HTML),
      responseHeaders: {
        "content-type": "text/html"
      },
      setCookieHeaders: [],
      fetchedAtIso: nowIso(),
      networkOutcome: createNetworkOutcome("ok", {
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: "ABOUT_HELP",
        detailMessage: "Loaded about:help"
      })
    };
  }

  if (requestUrl.startsWith("file://")) {
    const filePage = await fetchFileUrl(requestUrl);
    const fileBytes = utf8ByteLength(filePage.html);
    if (fileBytes > policy.maxContentBytes) {
      throw new NetworkFetchError(
        createNetworkOutcome("size_limit", {
          finalUrl: filePage.finalUrl,
          detailCode: "MAX_CONTENT_BYTES",
          detailMessage: `Response exceeded maxContentBytes=${String(policy.maxContentBytes)}`
        })
      );
    }
    return {
      requestUrl: filePage.requestUrl,
      finalUrl: filePage.finalUrl,
      status: filePage.status,
      statusText: filePage.statusText,
      contentType: filePage.contentType,
      stream: streamFromUtf8(filePage.html),
      responseHeaders: filePage.responseHeaders,
      setCookieHeaders: [],
      fetchedAtIso: filePage.fetchedAtIso,
      networkOutcome: filePage.networkOutcome
    };
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(requestUrl, timeoutMs, policy, requestOptions);
  } catch (error) {
    throw new NetworkFetchError(classifyNetworkFailure(error, requestUrl));
  }
  const stream = networkResult.body ?? streamFromUtf8("");

  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    stream: withByteLimit(stream, policy.maxContentBytes),
    responseHeaders: networkResult.responseHeaders,
    setCookieHeaders: networkResult.setCookieHeaders,
    fetchedAtIso: networkResult.fetchedAtIso,
    networkOutcome: outcomeFromHttpStatus(networkResult.finalUrl, networkResult.status, networkResult.statusText)
  };
}
