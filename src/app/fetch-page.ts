import {
  HttpClientError,
  HttpFields,
  mergeHttpFields,
  NodeHttpClient,
  type HttpClientConfiguration,
  type HttpErrorCode,
  type HttpRequestOptions,
  type StreamingHttpResponse
} from "@ismail-elkorchi/http-client";

import { formatHelpText } from "./commands.js";
import {
  DEFAULT_SECURITY_POLICY,
  assertAllowedProtocol,
  isHtmlLikeContentType,
  resolveSecurityPolicy,
  type SecurityPolicyOptions
} from "./security.js";
import type {
  FetchPageResult,
  FetchPageStreamResult,
  FetchStylesheetResult,
  NetworkOutcome,
  NetworkOutcomeKind,
  PageRequestOptions
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
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

async function fetchFileUrl(requestUrl: string, readLocalFileText: LocalFileReader): Promise<FetchPageResult> {
  const fileUrl = new URL(requestUrl);
  assertAllowedProtocol(fileUrl);

  const filePath = decodeURIComponent(fileUrl.pathname);
  const html = await readLocalFileText(filePath);

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
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
  readonly setCookieHeaders: readonly string[];
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

function flattenFields(fields: HttpFields): Readonly<Record<string, string>> {
  const groupedValues = new Map<string, string[]>();
  for (const { name, value } of fields) {
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

function requestFields(
  resourceProfile: NetworkResourceProfile,
  supplied: Readonly<Record<string, string>> | undefined
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
      await reader.cancel(reason);
      await response.completion;
    }
  }, { highWaterMark: 0 });
}

function buildHttpRequestOptions(
  timeoutMs: number,
  policy: Required<SecurityPolicyOptions>,
  options: PageRequestOptions,
  fields: HttpFields,
  signal: AbortSignal
): HttpRequestOptions {
  const method = pageRequestMethod(options);
  const common = {
    fields: fields.lines(),
    signal,
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

async function fetchNetworkResponse(
  client: NodeHttpClient,
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
    requestFields(resourceProfile, requestOptions.headers),
    signal
  );

  try {
    for (
      let attemptIndex = 0;
      attemptIndex <= securityPolicy.maxRequestRetries;
      attemptIndex += 1
    ) {
      signal.throwIfAborted();
      const result = await client.fetch(requestUrl, options);
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
        responseHeaders: flattenFields(result.fields),
        body: responseStream(result, requestOptions.signal, timeoutSignal),
        setCookieHeaders: result.fields.all("set-cookie"),
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
  client: NodeHttpClient,
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
    return {
      requestUrl,
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html: localAboutPage.html,
      responseHeaders: {
        "content-type": "text/html"
      },
      setCookieHeaders: [],
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

  if (requestUrl.startsWith("file://")) {
    const page = await fetchFileUrl(requestUrl, readLocalFileText);
    requestOptions.signal?.throwIfAborted();
    return page;
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(
      client,
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
    responseHeaders: networkResult.responseHeaders,
    setCookieHeaders: networkResult.setCookieHeaders,
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
  client: NodeHttpClient,
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
  if (requestUrl.startsWith("file://")) {
    const fileUrl = new URL(requestUrl);
    assertAllowedProtocol(fileUrl);
    const css = await readLocalFileText(decodeURIComponent(fileUrl.pathname));
    const bytes = UTF8_ENCODER.encode(css);
    if (bytes.byteLength > policy.maxContentBytes) {
      throw new NetworkFetchError(
        createNetworkOutcome("size_limit", {
          finalUrl: requestUrl,
          detailCode: "MAX_CONTENT_BYTES",
          detailMessage:
            `Response exceeded maxContentBytes=${String(policy.maxContentBytes)}`
        })
      );
    }
    return {
      requestUrl,
      finalUrl: requestUrl,
      contentType: "text/css",
      bytes,
      responseHeaders: { "content-type": "text/css" },
      transportEncodingLabel: "utf-8"
    };
  }
  let result: NetworkFetchResult;
  try {
    result = await fetchNetworkResponse(
      client,
      requestUrl,
      timeoutMs,
      policy,
      { ...requestOptions, method: "GET" },
      CSS_RESOURCE_PROFILE
    );
    if (result.status < 200 || result.status >= 300) {
      throw new NetworkFetchError(
        createNetworkOutcome("http_error", {
          finalUrl: result.finalUrl,
          status: result.status,
          statusText: result.statusText,
          detailCode: `HTTP_${String(result.status)}`,
          detailMessage:
            `Stylesheet request failed with ${String(result.status)} ${result.statusText}`
        })
      );
    }
    const bytes = await readByteStream(result.body);
    const transportEncodingLabel = contentTypeEncoding(result.contentType);
    return {
      requestUrl: result.requestUrl,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      bytes,
      responseHeaders: result.responseHeaders,
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
  client: NodeHttpClient,
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
      responseHeaders: {
        "content-type": "text/html"
      },
      setCookieHeaders: [],
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

  if (requestUrl.startsWith("file://")) {
    const filePage = await fetchFileUrl(requestUrl, readLocalFileText);
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
      responseHeaders: filePage.responseHeaders,
      setCookieHeaders: [],
      fetchedAtIso: filePage.fetchedAtIso,
      networkOutcome: filePage.networkOutcome
    };
  }

  let networkResult: NetworkFetchResult;
  try {
    networkResult = await fetchNetworkResponse(
      client,
      requestUrl,
      timeoutMs,
      policy,
      requestOptions
    );
  } catch (error) {
    if (requestOptions.signal?.aborted === true) throw requestOptions.signal.reason;
    throw networkFailure(error, requestUrl);
  }
  return {
    requestUrl: networkResult.requestUrl,
    finalUrl: networkResult.finalUrl,
    status: networkResult.status,
    statusText: networkResult.statusText,
    contentType: networkResult.contentType,
    stream: networkResult.body,
    responseHeaders: networkResult.responseHeaders,
    setCookieHeaders: networkResult.setCookieHeaders,
    fetchedAtIso: networkResult.fetchedAtIso,
    networkOutcome: outcomeFromHttpStatus(networkResult.finalUrl, networkResult.status, networkResult.statusText)
  };
}

/**
 * Reusable HTTP transport for page, stylesheet, and streaming navigation.
 *
 * Close the client when its browsing scope ends.
 */
export class PageNetworkClient {
  readonly #client: NodeHttpClient;

  public constructor(configuration: HttpClientConfiguration = {}) {
    this.#client = new NodeHttpClient({
      ...configuration,
      networkSafety: {
        enabled: false,
        ...configuration.networkSafety
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
    return fetchPageWithClient(
      this.#client,
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
    return fetchStylesheetWithClient(
      this.#client,
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
    return fetchPageStreamWithClient(
      this.#client,
      requestUrl,
      timeoutMs,
      securityPolicy,
      requestOptions,
      readLocalFileText
    );
  }

  public close(): Promise<void> {
    return this.#client.close();
  }

  public destroy(reason?: Error): Promise<void> {
    return this.#client.destroy(reason);
  }
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

function closeClientWithStream(
  stream: ReadableStream<Uint8Array>,
  client: PageNetworkClient
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
      await reader.cancel(reason);
      await client.destroy(
        reason instanceof Error
          ? reason
          : new Error("Page response stream was cancelled.")
      );
    }
  }, { highWaterMark: 0 });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
