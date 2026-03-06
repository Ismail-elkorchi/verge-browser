import type { DocumentTree } from "@ismail-elkorchi/html-parser";

/** Classified network outcome kinds surfaced by fetch helpers and page snapshots. */
export type NetworkOutcomeKind =
  | "ok"
  | "http_error"
  | "timeout"
  | "dns"
  | "tls"
  | "redirect_limit"
  | "content_type_block"
  | "size_limit"
  | "unsupported_protocol"
  | "unknown";

/** Structured outcome emitted by fetch helpers for both successful and failed requests. */
export interface NetworkOutcome {
  /** Final URL after redirects or local resolution. */
  readonly finalUrl: string;
  /** Outcome class used for branching and telemetry. */
  readonly kind: NetworkOutcomeKind;
  /** HTTP status code when a response was received, otherwise `null`. */
  readonly status: number | null;
  /** HTTP status text when a response was received, otherwise `null`. */
  readonly statusText: string | null;
  /** Stable machine-oriented detail code when one is available. */
  readonly detailCode: string | null;
  /** Human-readable detail string for logs and diagnostics. */
  readonly detailMessage: string;
}

/** One rendered link entry extracted from terminal output. */
export interface RenderedLink {
  /** One-based link index shown to the user. */
  readonly index: number;
  /** Visible label rendered for the link. */
  readonly label: string;
  /** Original href value from the source document. */
  readonly href: string;
  /** Absolute resolved href when URL resolution succeeds. */
  readonly resolvedHref: string;
}

/** Terminal-rendered page output produced from a parsed HTML document. */
export interface RenderedPage {
  /** Page title selected by the renderer. */
  readonly title: string;
  /** User-facing display URL shown in the terminal output. */
  readonly displayUrl: string;
  /** Combined status line rendered near the top of the page. */
  readonly statusLine: string;
  /** Rendered text lines in display order. */
  readonly lines: readonly string[];
  /** Link table extracted during rendering. */
  readonly links: readonly RenderedLink[];
  /** Number of HTML parse errors attached to the source tree. */
  readonly parseErrorCount: number;
  /** ISO timestamp carried from the fetch result. */
  readonly fetchedAtIso: string;
}

/** Fully buffered HTML fetch result returned by `fetchPage()`. */
export interface FetchPageResult {
  /** Original request URL supplied by the caller. */
  readonly requestUrl: string;
  /** Final URL after redirects or local resolution. */
  readonly finalUrl: string;
  /** HTTP status code or synthetic success status for local/about pages. */
  readonly status: number;
  /** HTTP status text or synthetic status text for local/about pages. */
  readonly statusText: string;
  /** Response content type when known. */
  readonly contentType: string | null;
  /** Buffered HTML payload. */
  readonly html: string;
  /** Lower-cased flattened response headers. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** Set-Cookie headers captured from the response. */
  readonly setCookieHeaders: readonly string[];
  /** ISO timestamp recorded when the payload was fetched. */
  readonly fetchedAtIso: string;
  /** Structured outcome classification for the request. */
  readonly networkOutcome: NetworkOutcome;
}

/** Streaming HTML fetch result returned by `fetchPageStream()`. */
export interface FetchPageStreamResult {
  /** Original request URL supplied by the caller. */
  readonly requestUrl: string;
  /** Final URL after redirects or local resolution. */
  readonly finalUrl: string;
  /** HTTP status code or synthetic success status for local/about pages. */
  readonly status: number;
  /** HTTP status text or synthetic status text for local/about pages. */
  readonly statusText: string;
  /** Response content type when known. */
  readonly contentType: string | null;
  /** Stream of HTML bytes subject to the configured size limit. */
  readonly stream: ReadableStream<Uint8Array>;
  /** Lower-cased flattened response headers. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** Set-Cookie headers captured from the response. */
  readonly setCookieHeaders: readonly string[];
  /** ISO timestamp recorded when the payload was fetched. */
  readonly fetchedAtIso: string;
  /** Structured outcome classification for the request. */
  readonly networkOutcome: NetworkOutcome;
}

/** Union of buffered and streaming fetch payloads used by `BrowserSession`. */
export type FetchPagePayload = FetchPageResult | FetchPageStreamResult;

/** Request options accepted by `fetchPage()`, `fetchPageStream()`, and `BrowserSession.openWithRequest()`. */
export interface PageRequestOptions {
  /** HTTP method. Defaults to `GET`. */
  readonly method?: "GET" | "POST";
  /** Additional request headers merged into the deterministic defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /** UTF-8 request body used for `POST` requests. */
  readonly bodyText?: string;
}

/** Performance and triage metadata attached to a page snapshot. */
export interface PageDiagnostics {
  /** Parse path used to build the snapshot. */
  readonly parseMode: "text" | "stream";
  /** Source byte length when the HTML is available in memory, otherwise `null`. */
  readonly sourceBytes: number | null;
  /** Number of HTML parse errors attached to the tree. */
  readonly parseErrorCount: number;
  /** Number of trace events captured by the parser. */
  readonly traceEventCount: number;
  /** Unique parser trace event kinds observed during the parse. */
  readonly traceKinds: readonly string[];
  /** HTTP method used for the request. */
  readonly requestMethod: "GET" | "POST";
  /** Time spent fetching the page in milliseconds. */
  readonly fetchDurationMs: number;
  /** Time spent parsing the HTML in milliseconds. */
  readonly parseDurationMs: number;
  /** Time spent rendering the terminal output in milliseconds. */
  readonly renderDurationMs: number;
  /** End-to-end time for fetch, parse, and render in milliseconds. */
  readonly totalDurationMs: number;
  /** Whether request headers included a Cookie header. */
  readonly usedCookies: boolean;
  /** Structured network outcome carried into the snapshot. */
  readonly networkOutcome: NetworkOutcome;
  /** Stable triage identifiers derived from network and parse outcomes. */
  readonly triageIds: readonly string[];
}

/** Input contract accepted by `renderDocumentToTerminal()`. */
export interface RenderInput {
  /** Parsed HTML tree to render. */
  readonly tree: DocumentTree;
  /** Original request URL supplied by the caller. */
  readonly requestUrl: string;
  /** Final URL after redirects or local resolution. */
  readonly finalUrl: string;
  /** HTTP or synthetic status code for the page. */
  readonly status: number;
  /** HTTP or synthetic status text for the page. */
  readonly statusText: string;
  /** ISO timestamp carried from the fetch result. */
  readonly fetchedAtIso: string;
  /** Target terminal width in columns. */
  readonly width: number;
}

/** Rich page snapshot returned by `BrowserSession` navigation helpers. */
export interface PageSnapshot {
  /** Original request URL supplied by the caller. */
  readonly requestUrl: string;
  /** Final URL after redirects or local resolution. */
  readonly finalUrl: string;
  /** HTTP or synthetic status code. */
  readonly status: number;
  /** HTTP or synthetic status text. */
  readonly statusText: string;
  /** Response content type when known. */
  readonly contentType: string | null;
  /** Lower-cased flattened response headers. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** ISO timestamp recorded when the source was fetched. */
  readonly fetchedAtIso: string;
  /** Set-Cookie headers captured from the response. */
  readonly setCookieHeaders: readonly string[];
  /** Parsed HTML tree. */
  readonly tree: DocumentTree;
  /** Terminal-rendered representation of the page. */
  readonly rendered: RenderedPage;
  /** Original buffered HTML when available. */
  readonly sourceHtml?: string;
  /** Performance and triage metadata for the snapshot. */
  readonly diagnostics: PageDiagnostics;
}

/** Keyboard event shape used by the shortcut helpers. */
export interface KeyboardKey {
  /** Raw key sequence emitted by the terminal. */
  readonly sequence: string;
  /** Parsed key name when available. */
  readonly name?: string;
  /** Whether the Ctrl modifier is active. */
  readonly ctrl?: boolean;
  /** Whether the Meta/Alt modifier is active. */
  readonly meta?: boolean;
  /** Whether the Shift modifier is active. */
  readonly shift?: boolean;
}
