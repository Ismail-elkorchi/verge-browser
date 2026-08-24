import {
  HttpClientError,
  HttpFields,
  mergeHttpFields,
  NodeHttpClient,
  type HttpClientConfiguration,
  type HttpErrorCode,
  type HttpRequestOptions,
  type HttpSessionAdapter,
  type HttpSessionRequestContext,
  type HttpSessionResponseContext,
  type StreamingHttpResult,
  type StreamingHttpResponse
} from "@ismail-elkorchi/http-client";
import { fileURLToPath } from "node:url";

import { formatHelpText } from "./commands.js";
import {
  DEFAULT_SECURITY_POLICY,
  assertAllowedProtocol,
  isHtmlLikeContentType,
  resolveSecurityPolicy,
  type SecurityPolicyOptions
} from "./security.js";
import {
  navigationHttpSession,
  navigationSource
} from "./http-session-context.js";
import type {
  FetchPageResult,
  FetchPageStreamResult,
  FetchStylesheetResult,
  NetworkOutcome,
  NetworkOutcomeKind,
  PageRequestOptions
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DOCUMENT_STYLESHEET_URL = Symbol("documentStylesheetUrl");
const TRANSIENT_HTTP_FAILURES: ReadonlySet<HttpErrorCode> = new Set([
  "CONNECT_TIMEOUT",
  "NETWORK_FAILURE",
  "RESPONSE_BODY_TIMEOUT",
  "RESPONSE_FIELDS_TIMEOUT"
]);

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

const ABOUT_NEW_TAB_HTML = `<!doctype html>
<html><head><title>New Tab</title></head><body><h1>New Tab</h1></body></html>`;

function aboutPage(requestUrl: string): { readonly html: string; readonly code: string } | null {
  if (requestUrl === "about:help") return { html: ABOUT_HELP_HTML, code: "ABOUT_HELP" };
  if (requestUrl === "about:newtab") return { html: ABOUT_NEW_TAB_HTML, code: "ABOUT_NEW_TAB" };
  return null;
}

const UTF8_ENCODER = new TextEncoder();

/** Local text-file reader used for `file://` snapshots and tests. */
export type LocalFileReader = (path: string) => Promise<string>;

async function defaultReadLocalFileText(path: string): Promise<string> {
  const nodeFs = await import("node:fs/promises");
  return nodeFs.readFile(path, "utf8");
}

async function readDefaultLocalFileTextBounded(
  path: string,
  requestUrl: string,
  maxContentBytes: number
): Promise<string> {
  const nodeFs = await import("node:fs/promises");
  const handle = await nodeFs.open(path, "r");
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > maxContentBytes) {
      throw fileSizeLimitError(requestUrl, maxContentBytes);
    }
    for (;;) {
      const remainingWithSentinel = maxContentBytes - receivedBytes + 1;
      const buffer = new Uint8Array(Math.min(64 * 1024, remainingWithSentinel));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      receivedBytes += bytesRead;
      if (receivedBytes > maxContentBytes) {
        throw fileSizeLimitError(requestUrl, maxContentBytes);
      }
      chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await handle.close();
  }
}

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

function shouldRetryHttpFailure(
  error: HttpClientError,
  method: PageRequestOptions["method"],
  attemptIndex: number,
  maxRequestRetries: number
): boolean {
  return (
    method === "GET"
    && attemptIndex < maxRequestRetries
    && TRANSIENT_HTTP_FAILURES.has(error.code)
  );
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Error wrapper used when fetch helpers fail before a usable HTML response can be consumed.
 *
 * The structured `networkOutcome` property is the stable surface callers should branch on.
 */
export class NetworkFetchError extends Error {
  readonly networkOutcome: NetworkOutcome;

  constructor(networkOutcome: NetworkOutcome) {
    super(`${networkOutcome.kind}: ${networkOutcome.detailMessage}`);
    this.name = "NetworkFetchError";
    this.networkOutcome = networkOutcome;
  }
}

function outcomeFromHttpClientError(
  error: HttpClientError,
  fallbackUrl: string
): NetworkOutcome {
  const finalUrl = error.url.length === 0 ? fallbackUrl : error.url;
  switch (error.code) {
    case "CONNECT_TIMEOUT":
    case "RESPONSE_BODY_TIMEOUT":
    case "RESPONSE_FIELDS_TIMEOUT":
    case "TOTAL_TIMEOUT":
      return createNetworkOutcome("timeout", {
        finalUrl,
        detailCode: error.code,
        detailMessage: error.message
      });
    case "DNS_ERROR":
      return createNetworkOutcome("dns", {
        finalUrl,
        detailCode: error.code,
        detailMessage: error.message
      });
    case "TLS_ERROR":
      return createNetworkOutcome("tls", {
        finalUrl,
        detailCode: error.code,
        detailMessage: error.message
      });
    case "DECODED_RESPONSE_TOO_LARGE":
    case "WIRE_RESPONSE_TOO_LARGE":
      return createNetworkOutcome("size_limit", {
        finalUrl,
        detailCode: "MAX_CONTENT_BYTES",
        detailMessage: "Response exceeded maxContentBytes."
      });
    case "REDIRECT_LOOP":
    case "TOO_MANY_REDIRECTS":
      return createNetworkOutcome("redirect_limit", {
        finalUrl,
        detailCode: "REDIRECT_LIMIT",
        detailMessage: error.message
      });
    case "REDIRECT_TARGET_REJECTED":
    case "UNSUPPORTED_PROTOCOL":
      return createNetworkOutcome("unsupported_protocol", {
        finalUrl,
        detailCode: "UNSUPPORTED_PROTOCOL",
        detailMessage: error.message
      });
    case "NETWORK_SAFETY_REJECTED":
      return createNetworkOutcome("network_block", {
        finalUrl,
        detailCode: error.code,
        detailMessage: error.message
      });
    default:
      return createNetworkOutcome("unknown", {
        finalUrl,
        detailCode: error.code,
        detailMessage: error.message
      });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "timeoutMs must be a positive safe integer no greater than 2147483647."
    );
  }
}

function fileSizeLimitError(requestUrl: string, maxContentBytes: number): NetworkFetchError {
  return new NetworkFetchError(
    createNetworkOutcome("size_limit", {
      finalUrl: requestUrl,
      detailCode: "MAX_CONTENT_BYTES",
      detailMessage: `Response exceeded maxContentBytes=${String(maxContentBytes)}`
    })
  );
}

async function fetchFileUrl(
  requestUrl: string,
  readLocalFileText: LocalFileReader,
  maxContentBytes: number
): Promise<FetchPageResult> {
  const fileUrl = new URL(requestUrl);
  assertAllowedProtocol(fileUrl);
  const filePath = fileURLToPath(fileUrl);
  const html = readLocalFileText === defaultReadLocalFileText
    ? await readDefaultLocalFileTextBounded(filePath, requestUrl, maxContentBytes)
    : await readLocalFileText(filePath);
  if (utf8ByteLength(html) > maxContentBytes) {
    throw fileSizeLimitError(requestUrl, maxContentBytes);
  }

  return {
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html,
    responseFields: new HttpFields([
      { name: "content-type", value: "text/html" }
    ]),
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

function hasProtocol(requestUrl: string, protocol: string): boolean {
  try {
    return new URL(requestUrl).protocol === protocol;
  } catch {
    return false;
  }
}

/**
 * Reads a UTF-8 byte stream into a single string.
 *
 * @param stream Stream of response bytes.
 * @returns Fully decoded UTF-8 text.
 */
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

async function readByteStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface NetworkFetchResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly responseFields: HttpFields;
  readonly body: ReadableStream<Uint8Array>;
  readonly fetchedAtIso: string;
}

interface NetworkResourceProfile {
  readonly accept: string;
  readonly label: string;
  readonly acceptsContentType: (contentType: string | null) => boolean;
}

const HTML_RESOURCE_PROFILE: NetworkResourceProfile = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  label: "HTML",
  acceptsContentType: isHtmlLikeContentType
};

const CSS_RESOURCE_PROFILE: NetworkResourceProfile = {
  accept: "text/css,*/*;q=0.1",
  label: "CSS",
  acceptsContentType(contentType) {
    return contentType === null || contentType.toLowerCase().split(";", 1)[0]?.trim() === "text/css";
  }
};

function requestFields(
  resourceProfile: NetworkResourceProfile,
  supplied: Readonly<Record<string, string>> | undefined,
  session: HttpSessionAdapter | undefined
): HttpFields {
  const defaults = new HttpFields([
    { name: "accept", value: resourceProfile.accept },
    { name: "user-agent", value: "verge-browser/0.2.0" }
  ]);
  const caller = supplied === undefined
    ? undefined
    : new HttpFields(
      Object.entries(supplied).map(([name, value]) => ({ name, value }))
    );
  if (session !== undefined && caller?.has("cookie") === true) {
    throw new TypeError(
      "Cookie fields are managed by the browser HTTP session."
    );
  }
  return mergeHttpFields(defaults, caller);
}

function pageRequestMethod(options: PageRequestOptions): "GET" | "POST" {
  const requestedMethod: unknown = options.method ?? "GET";
  if (requestedMethod !== "GET" && requestedMethod !== "POST") {
    throw new TypeError("Page request method must be GET or POST.");
  }
  if (requestedMethod === "GET" && options.bodyText !== undefined) {
    throw new TypeError("GET requests cannot contain bodyText.");
  }
  return requestedMethod;
}

function operationFailure(
  error: unknown,
  finalUrl: string,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): unknown {
  if (callerSignal?.aborted === true) return callerSignal.reason;
  if (timeoutSignal.aborted) {
    return new NetworkFetchError(
      createNetworkOutcome("timeout", {
        finalUrl,
        detailCode: "TOTAL_TIMEOUT",
        detailMessage: "Network request timed out."
      })
    );
  }
  return networkFailure(error, finalUrl);
}

function networkFailure(error: unknown, finalUrl: string): unknown {
  if (error instanceof NetworkFetchError) return error;
  if (error instanceof HttpClientError) {
    return new NetworkFetchError(
      outcomeFromHttpClientError(error, finalUrl)
    );
  }
  return error;
}

function responseStream(
  response: StreamingHttpResponse,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = response.body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        const completion = await response.completion;
        if (completion.kind === "failure") {
          throw completion.error;
        }
        if (completion.kind === "cancelled") {
          throw new HttpClientError(
            "REQUEST_ABORTED",
            "The response body was cancelled.",
            response.finalUrl
          );
        }
        controller.close();
      } catch (error) {
        controller.error(
          operationFailure(
            error,
            response.finalUrl,
            callerSignal,
            timeoutSignal
          )
        );
      }
    },
    async cancel(reason) {
      response.cancel(reason instanceof Error ? reason : undefined);
      try {
        await reader.cancel(reason);
      } finally {
        await response.completion;
      }
    }
  }, { highWaterMark: 0 });
}

function buildHttpRequestOptions(
  timeoutMs: number,
  policy: Required<SecurityPolicyOptions>,
  options: PageRequestOptions,
  fields: HttpFields,
  signal: AbortSignal,
  session: HttpSessionAdapter | undefined
): HttpRequestOptions {
  const method = pageRequestMethod(options);
  const common = {
    fields: fields.lines(),
    signal,
    ...(session === undefined ? {} : { session }),
    maxRedirects: policy.maxRedirects,
    timeouts: {
      totalMs: null,
      responseFieldsMs: timeoutMs,
      responseBodyProgressMs: timeoutMs
    },
    responseTransferLimits: {
      maxWireBytes: policy.maxContentBytes,
      maxDecodedBytes: policy.maxContentBytes
    }
  } as const;
  if (method === "GET") {
    return { ...common, method };
  }
  return {
    ...common,
    method,
    body: { kind: "text", text: options.bodyText ?? "" }
  };
}

type HttpFetch = (
  requestUrl: string,
  options: HttpRequestOptions
) => Promise<StreamingHttpResult>;

class SameOriginHttpSession implements HttpSessionAdapter {
  readonly #session: HttpSessionAdapter;
  readonly #origin: string;

  public constructor(session: HttpSessionAdapter, documentUrl: string) {
    this.#session = session;
    this.#origin = new URL(documentUrl).origin;
  }

  public prepareRequest(context: HttpSessionRequestContext) {
    return new URL(context.url).origin === this.#origin
      ? this.#session.prepareRequest(context)
      : undefined;
  }

  public acceptResponse(context: HttpSessionResponseContext) {
    if (new URL(context.url).origin === this.#origin) {
      return this.#session.acceptResponse(context);
    }
    return undefined;
  }
}

async function fetchNetworkResponse(
  fetchHttp: HttpFetch,
  session: HttpSessionAdapter | undefined,
  requestUrl: string,
  timeoutMs: number,
  securityPolicy: Required<SecurityPolicyOptions>,
  requestOptions: PageRequestOptions,
  resourceProfile: NetworkResourceProfile = HTML_RESOURCE_PROFILE
): Promise<NetworkFetchResult> {
  const parsedUrl = new URL(requestUrl);
  assertAllowedProtocol(parsedUrl);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestOptions.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([requestOptions.signal, timeoutSignal]);
  const method = requestOptions.method ?? "GET";
  const options = buildHttpRequestOptions(
    timeoutMs,
    securityPolicy,
    requestOptions,
    requestFields(resourceProfile, requestOptions.headers, session),
    signal,
    session
  );

  try {
    for (
      let attemptIndex = 0;
      attemptIndex <= securityPolicy.maxRequestRetries;
      attemptIndex += 1
    ) {
      signal.throwIfAborted();
      const result = await fetchHttp(requestUrl, options);
      if (result.kind === "failure") {
        if (
          shouldRetryHttpFailure(
            result.error,
            method,
            attemptIndex,
            securityPolicy.maxRequestRetries
          )
        ) {
          await sleep(securityPolicy.retryDelayMs, signal);
          continue;
        }
        throw result.error;
      }

      const contentType = result.fields.first("content-type");
      if (!resourceProfile.acceptsContentType(contentType)) {
        const error = new NetworkFetchError(
          createNetworkOutcome("content_type_block", {
            finalUrl: result.finalUrl,
            status: result.statusCode,
            statusText: result.statusMessage,
            detailCode: "CONTENT_TYPE_BLOCK",
            detailMessage:
              `Blocked non-${resourceProfile.label} content-type: ${contentType ?? "unknown"}`
          })
        );
        result.cancel(error);
        await result.completion;
        throw error;
      }

      return {
        requestUrl,
        finalUrl: result.finalUrl,
        status: result.statusCode,
        statusText: result.statusMessage ?? "",
        contentType,
        responseFields: result.fields,
        body: responseStream(result, requestOptions.signal, timeoutSignal),
        fetchedAtIso: nowIso()
      };
    }

    throw new Error("Retry loop exhausted without a result.");
  } catch (error) {
    throw operationFailure(
      error,
      requestUrl,
      requestOptions.signal,
      timeoutSignal
    );
  }
}

/**
 * Fetches a page and buffers its HTML body.
 *
 * Defaults:
 * - `timeoutMs = 15000`
 * - `securityPolicy = DEFAULT_SECURITY_POLICY`
 * - `requestOptions.method = "GET"`
 *
 * Special cases:
 * - `about:help` returns the built-in help page without network access.
 * - `file://` URLs are read through `readLocalFileText`.
 *
 * Error behavior:
 * - Throws `NetworkFetchError` for pre-response failures and safety-limit failures.
 * - Returns a normal result for HTTP `4xx` and `5xx` responses, with `networkOutcome.kind = "http_error"`.
 *
 * @param requestUrl Absolute URL, `about:help`, or `file://` URL.
 * @param timeoutMs Request timeout in milliseconds.
 * @param securityPolicy Partial fetch policy merged with `DEFAULT_SECURITY_POLICY`.
 * @param requestOptions Optional method, headers, and body text.
 * @param readLocalFileText Override for `file://` reads.
 * @returns Buffered HTML result with response metadata and `networkOutcome`.
 *
 * @example
 * ```ts
 * const page = await fetchPage("about:help");
 * console.log(page.status, page.networkOutcome.kind);
 * ```
 */
async function fetchPageWithClient(
  fetchHttp: HttpFetch,
  session: HttpSessionAdapter | undefined,
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchPageResult> {
  requestOptions.signal?.throwIfAborted();
  pageRequestMethod(requestOptions);
  assertTimeout(timeoutMs);
  const policy = resolveSecurityPolicy(securityPolicy);

  const localAboutPage = aboutPage(requestUrl);
  if (localAboutPage !== null) {
    if (utf8ByteLength(localAboutPage.html) > policy.maxContentBytes) {
      throw fileSizeLimitError(requestUrl, policy.maxContentBytes);
    }
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: localAboutPage.html,
      responseFields: new HttpFields([
        { name: "content-type", value: "text/html" }
      ]),
      fetchedAtIso: nowIso(),
      networkOutcome: createNetworkOutcome("ok", {
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: localAboutPage.code,
        detailMessage: `Loaded ${requestUrl}`
      })
    };
  }

  if (hasProtocol(requestUrl, "file:")) {
    const page = await fetchFileUrl(
      requestUrl,
      readLocalFileText,
      policy.maxContentBytes
    );
    requestOptions.signal?.throwIfAborted();
    return page;
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(
      fetchHttp,
      session,
      requestUrl,
      timeoutMs,
      policy,
      requestOptions
    );
  } catch (error) {
    if (requestOptions.signal?.aborted === true) throw requestOptions.signal.reason;
    throw networkFailure(error, requestUrl);
  }

  let html = "";
  try {
    html = await readByteStreamToText(networkResult.body);
  } catch (error) {
    if (requestOptions.signal?.aborted === true) throw requestOptions.signal.reason;
    throw networkFailure(error, networkResult.finalUrl);
  }

  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    html,
    responseFields: networkResult.responseFields,
    fetchedAtIso: networkResult.fetchedAtIso,
    networkOutcome: outcomeFromHttpStatus(networkResult.finalUrl, networkResult.status, networkResult.statusText)
  };
}

function contentTypeEncoding(contentType: string | null): string | undefined {
  const match = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)"?/iu.exec(contentType ?? "");
  return match?.[1];
}

/** Fetches one external stylesheet as bounded transport bytes. */
async function fetchStylesheetWithClient(
  fetchHttp: HttpFetch,
  session: HttpSessionAdapter | undefined,
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = {
    ...DEFAULT_SECURITY_POLICY,
    maxContentBytes: 512 * 1024
  },
  requestOptions: Pick<PageRequestOptions, "headers" | "signal"> = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchStylesheetResult> {
  requestOptions.signal?.throwIfAborted();
  assertTimeout(timeoutMs);
  const policy = resolveSecurityPolicy({
    ...securityPolicy,
    maxContentBytes: securityPolicy.maxContentBytes ?? 512 * 1024
  });
  if (hasProtocol(requestUrl, "file:")) {
    const fileUrl = new URL(requestUrl);
    assertAllowedProtocol(fileUrl);
    const filePath = fileURLToPath(fileUrl);
    const css = readLocalFileText === defaultReadLocalFileText
      ? await readDefaultLocalFileTextBounded(filePath, requestUrl, policy.maxContentBytes)
      : await readLocalFileText(filePath);
    const bytes = UTF8_ENCODER.encode(css);
    if (bytes.byteLength > policy.maxContentBytes) {
      throw fileSizeLimitError(requestUrl, policy.maxContentBytes);
    }
    return {
      requestUrl,
      finalUrl: requestUrl,
      contentType: "text/css",
      bytes,
      responseFields: new HttpFields([
        { name: "content-type", value: "text/css" }
      ]),
      transportEncodingLabel: "utf-8"
    };
  }
  let result: NetworkFetchResult;
  try {
    result = await fetchNetworkResponse(
      fetchHttp,
      session,
      requestUrl,
      timeoutMs,
      policy,
      { ...requestOptions, method: "GET" },
      CSS_RESOURCE_PROFILE
    );
    if (result.status < 200 || result.status >= 300) {
      const error = new NetworkFetchError(
        createNetworkOutcome("http_error", {
          finalUrl: result.finalUrl,
          status: result.status,
          statusText: result.statusText,
          detailCode: `HTTP_${String(result.status)}`,
          detailMessage:
            `Stylesheet request failed with ${String(result.status)} ${result.statusText}`
        })
      );
      await result.body.cancel(error);
      throw error;
    }
    const bytes = await readByteStream(result.body);
    const transportEncodingLabel = contentTypeEncoding(result.contentType);
    return {
      requestUrl: result.requestUrl,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      bytes,
      responseFields: result.responseFields,
      ...(transportEncodingLabel === undefined ? {} : { transportEncodingLabel })
    };
  } catch (error) {
    if (requestOptions.signal?.aborted === true) throw requestOptions.signal.reason;
    throw networkFailure(error, requestUrl);
  }
}

/**
 * Fetches a page and returns a size-limited HTML byte stream.
 *
 * This shares the same timeout, policy, request, and error semantics as `fetchPage()`,
 * but returns a `ReadableStream<Uint8Array>` instead of buffered HTML text.
 *
 * @param requestUrl Absolute URL, `about:help`, or `file://` URL.
 * @param timeoutMs Request timeout in milliseconds.
 * @param securityPolicy Partial fetch policy merged with `DEFAULT_SECURITY_POLICY`.
 * @param requestOptions Optional method, headers, and body text.
 * @param readLocalFileText Override for `file://` reads.
 * @returns Streaming HTML result with response metadata and `networkOutcome`.
 *
 * @example
 * ```ts
 * const page = await fetchPageStream("about:help");
 * console.log(page.status, page.networkOutcome.kind);
 * ```
 */
async function fetchPageStreamWithClient(
  fetchHttp: HttpFetch,
  session: HttpSessionAdapter | undefined,
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchPageStreamResult> {
  requestOptions.signal?.throwIfAborted();
  pageRequestMethod(requestOptions);
  assertTimeout(timeoutMs);
  const policy = resolveSecurityPolicy(securityPolicy);

  const localAboutPage = aboutPage(requestUrl);
  if (localAboutPage !== null) {
    const aboutBytes = utf8ByteLength(localAboutPage.html);
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
      stream: streamFromUtf8(localAboutPage.html),
      responseFields: new HttpFields([
        { name: "content-type", value: "text/html" }
      ]),
      transportEncodingLabel: "utf-8",
      fetchedAtIso: nowIso(),
      networkOutcome: createNetworkOutcome("ok", {
        finalUrl: requestUrl,
        status: 200,
        statusText: "OK",
        detailCode: localAboutPage.code,
        detailMessage: `Loaded ${requestUrl}`
      })
    };
  }

  if (hasProtocol(requestUrl, "file:")) {
    const filePage = await fetchFileUrl(
      requestUrl,
      readLocalFileText,
      policy.maxContentBytes
    );
    requestOptions.signal?.throwIfAborted();
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
      responseFields: filePage.responseFields,
      transportEncodingLabel: "utf-8",
      fetchedAtIso: filePage.fetchedAtIso,
      networkOutcome: filePage.networkOutcome
    };
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(
      fetchHttp,
      session,
      requestUrl,
      timeoutMs,
      policy,
      requestOptions
    );
  } catch (error) {
    if (requestOptions.signal?.aborted === true) throw requestOptions.signal.reason;
    throw networkFailure(error, requestUrl);
  }
  const transportEncodingLabel = contentTypeEncoding(
    networkResult.contentType
  );
  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    stream: networkResult.body,
    responseFields: networkResult.responseFields,
    ...(transportEncodingLabel === undefined
      ? {}
      : { transportEncodingLabel }),
    fetchedAtIso: networkResult.fetchedAtIso,
    networkOutcome: outcomeFromHttpStatus(networkResult.finalUrl, networkResult.status, networkResult.statusText)
  };
}

/**
 * Reusable HTTP transport for page, stylesheet, and streaming navigation.
 *
 * Close the client when its browsing scope ends.
 */
export interface PageNetworkClientOptions {
  readonly transport?: Omit<HttpClientConfiguration, "networkSafety">;
  readonly session?: HttpSessionAdapter;
  readonly publicAddressPolicy?:
    | "public-only"
    | "allow-private-and-local";
}

export class PageNetworkClient {
  readonly #publicClient: NodeHttpClient;
  readonly #localNavigationClient: NodeHttpClient;
  readonly #session: HttpSessionAdapter | undefined;

  public constructor(options: PageNetworkClientOptions = {}) {
    const publicAddressPolicy: unknown =
      options.publicAddressPolicy;
    if (
      publicAddressPolicy !== undefined
      && publicAddressPolicy !== "public-only"
      && publicAddressPolicy !== "allow-private-and-local"
    ) {
      throw new TypeError(
        "publicAddressPolicy must be public-only or allow-private-and-local."
      );
    }
    if (
      options.transport !== undefined
      && Object.hasOwn(options.transport, "networkSafety")
    ) {
      throw new TypeError(
        "Configure address access with publicAddressPolicy, not transport.networkSafety."
      );
    }
    this.#session = options.session;
    this.#publicClient = new NodeHttpClient({
      ...options.transport,
      ...(options.publicAddressPolicy === "allow-private-and-local"
        ? {
          networkSafety: {
            allowLocalhost: true,
            allowPrivateNetworks: true
          }
        }
        : {})
    });
    this.#localNavigationClient = new NodeHttpClient({
      ...options.transport,
      networkSafety: {
        allowLocalhost: true,
        allowPrivateNetworks: true
      }
    });
  }

  public fetchPage(
    requestUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
    requestOptions: PageRequestOptions = {},
    readLocalFileText: LocalFileReader = defaultReadLocalFileText
  ): Promise<FetchPageResult> {
    const session = navigationHttpSession(
      this.#session,
      navigationSource(requestOptions)
    );
    return fetchPageWithClient(
      (url, options) => this.#publicClient.fetch(url, options),
      session,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public navigatePage(
    requestUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
    requestOptions: PageRequestOptions = {},
    readLocalFileText: LocalFileReader = defaultReadLocalFileText
  ): Promise<FetchPageResult> {
    return fetchPageWithClient(
      (url, options) => this.#fetchNavigation(url, options),
      this.#session,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public fetchStylesheet(
    requestUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    securityPolicy: SecurityPolicyOptions = {
      ...DEFAULT_SECURITY_POLICY,
      maxContentBytes: 512 * 1024
    },
    requestOptions: Pick<PageRequestOptions, "headers" | "signal"> = {},
    readLocalFileText: LocalFileReader = defaultReadLocalFileText
  ): Promise<FetchStylesheetResult> {
    const documentUrl = (requestOptions as typeof requestOptions & {
      readonly [DOCUMENT_STYLESHEET_URL]?: string;
    })[DOCUMENT_STYLESHEET_URL];
    const stylesheetSession = this.#session === undefined || documentUrl === undefined
      ? this.#session
      : new SameOriginHttpSession(this.#session, documentUrl);
    return fetchStylesheetWithClient(
      (url, options) => this.#publicClient.fetch(url, options),
      stylesheetSession,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public fetchPageStream(
    requestUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
    requestOptions: PageRequestOptions = {},
    readLocalFileText: LocalFileReader = defaultReadLocalFileText
  ): Promise<FetchPageStreamResult> {
    const session = navigationHttpSession(
      this.#session,
      navigationSource(requestOptions)
    );
    return fetchPageStreamWithClient(
      (url, options) => this.#publicClient.fetch(url, options),
      session,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public navigatePageStream(
    requestUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
    requestOptions: PageRequestOptions = {},
    readLocalFileText: LocalFileReader = defaultReadLocalFileText
  ): Promise<FetchPageStreamResult> {
    return fetchPageStreamWithClient(
      (url, options) => this.#fetchNavigation(url, options),
      this.#session,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public async close(): Promise<void> {
    await settleCleanup([
      () => this.#publicClient.close(),
      () => this.#localNavigationClient.close()
    ], "Failed to close every page-network transport.");
  }

  public async destroy(reason?: Error): Promise<void> {
    await settleCleanup([
      () => this.#publicClient.destroy(reason),
      () => this.#localNavigationClient.destroy(reason)
    ], "Failed to destroy every page-network transport.");
  }

  async #fetchNavigation(
    requestUrl: string,
    options: HttpRequestOptions
  ): Promise<StreamingHttpResult> {
    const result = await this.#publicClient.fetch(requestUrl, options);
    if (
      result.kind !== "failure"
      || result.error.code !== "NETWORK_SAFETY_REJECTED"
      || result.redirects.length !== 0
    ) {
      return result;
    }
    return this.#localNavigationClient.fetch(requestUrl, options);
  }
}

/** @internal BrowserSession resource-loading bridge. */
export function fetchDocumentStylesheet(
  client: PageNetworkClient,
  requestUrl: string,
  documentUrl: string,
  timeoutMs: number | undefined,
  securityPolicy: SecurityPolicyOptions,
  requestOptions: Pick<PageRequestOptions, "headers" | "signal">,
  readLocalFileText?: LocalFileReader
): Promise<FetchStylesheetResult> {
  const scopedOptions = {
    ...requestOptions,
    [DOCUMENT_STYLESHEET_URL]: documentUrl
  };
  return readLocalFileText === undefined
    ? client.fetchStylesheet(requestUrl, timeoutMs, securityPolicy, scopedOptions)
    : client.fetchStylesheet(requestUrl, timeoutMs, securityPolicy, scopedOptions, readLocalFileText);
}

/** Fetches and buffers one page with an operation-scoped HTTP client. */
export async function fetchPage(
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchPageResult> {
  const client = new PageNetworkClient();
  try {
    return await client.fetchPage(
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  } finally {
    await client.close();
  }
}

/** Fetches one stylesheet with an operation-scoped HTTP client. */
export async function fetchStylesheet(
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = {
    ...DEFAULT_SECURITY_POLICY,
    maxContentBytes: 512 * 1024
  },
  requestOptions: Pick<PageRequestOptions, "headers" | "signal"> = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchStylesheetResult> {
  const client = new PageNetworkClient();
  try {
    return await client.fetchStylesheet(
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  } finally {
    await client.close();
  }
}

/** Fetches one streaming page and closes its HTTP client with the stream. */
export async function fetchPageStream(
  requestUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  securityPolicy: SecurityPolicyOptions = DEFAULT_SECURITY_POLICY,
  requestOptions: PageRequestOptions = {},
  readLocalFileText: LocalFileReader = defaultReadLocalFileText
): Promise<FetchPageStreamResult> {
  const client = new PageNetworkClient();
  try {
    const result = await client.fetchPageStream(
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
    return {
      ...result,
      stream: closeClientWithStream(result.stream, client)
    };
  } catch (error) {
    await client.destroy(toError(error));
    throw error;
  }
}

/** @internal Binds an operation-scoped client's lifetime to a returned stream. */
export function closeClientWithStream(
  stream: ReadableStream<Uint8Array>,
  client: Pick<PageNetworkClient, "close" | "destroy">
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await client.close();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        await client.destroy(toError(error));
        controller.error(error);
      }
    },
    async cancel(reason) {
      let cancellationError: unknown;
      try {
        await reader.cancel(reason);
      } catch (error) {
        cancellationError = error;
      }
      let destroyError: unknown;
      try {
        await client.destroy(
          reason instanceof Error
            ? reason
            : new Error("Page response stream was cancelled.")
        );
      } catch (error) {
        destroyError = error;
      }
      if (cancellationError !== undefined && destroyError !== undefined) {
        throw new AggregateError(
          [cancellationError, destroyError],
          "Failed to cancel the page stream and destroy its HTTP client."
        );
      }
      if (cancellationError !== undefined) throw toError(cancellationError);
      if (destroyError !== undefined) throw toError(destroyError);
    }
  }, { highWaterMark: 0 });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function settleCleanup(
  operations: readonly (() => Promise<void>)[],
  message: string
): Promise<void> {
  const outcomes = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation))
  );
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") errors.push(outcome.reason as unknown);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
