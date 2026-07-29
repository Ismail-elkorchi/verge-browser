import type { DocumentTree, ParsedDocument } from "@ismail-elkorchi/html-parser";

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

interface RenderedActionableBase {
  /** Stable action identity derived from the source document. */
  readonly id: string;
  /** Stable block identity containing the action. */
  readonly blockId: string;
  /** One-based actionable index shown to the user. */
  readonly index: number;
  /** Visible label surfaced by the terminal renderer. */
  readonly label: string;
  /** Zero-based rendered line index used for focus restoration. */
  readonly lineIndex: number;
}

/** One rendered link entry extracted from terminal output. */
export interface RenderedLink extends RenderedActionableBase {
  /** Stable actionable kind used by the browser UI. */
  readonly kind: "link";
  /** Original href value from the source document. */
  readonly href: string;
  /** Absolute resolved href when URL resolution succeeds. */
  readonly resolvedHref: string;
}

/** One rendered form entry surfaced as a direct page action. */
export interface RenderedFormAction extends RenderedActionableBase {
  /** Stable actionable kind used by the browser UI. */
  readonly kind: "form";
  /** Form method normalized to lower case. */
  readonly method: string;
  /** Absolute submission target used by form submission helpers. */
  readonly actionUrl: string;
  /** Number of named fields available on the form. */
  readonly fieldCount: number;
}

/** Union of rendered page actions that can receive direct focus. */
export type RenderedActionable = RenderedLink | RenderedFormAction;

/** Semantic block kinds retained independently from terminal width. */
export type PageBlockKind =
  | "heading"
  | "paragraph"
  | "definitionTerm"
  | "definitionDescription"
  | "image"
  | "preformatted"
  | "listItem"
  | "tableRow"
  | "quote"
  | "form"
  | "notice";

/** Semantic page landmark containing a block, when HTML exposes one. */
export type PageRegion =
  | "banner"
  | "navigation"
  | "main"
  | "complementary"
  | "contentinfo"
  | "search";

/** Computed terminal color derived from author CSS. */
export interface PageColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Computed inline style that terminal rendering can represent faithfully. */
export interface PageTextStyle {
  readonly foreground?: PageColor;
  readonly background?: PageColor;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

/** One styled half-open range in a semantic page block. */
export interface PageTextRun {
  readonly startCodeUnitIndex: number;
  readonly endCodeUnitIndexExclusive: number;
  readonly style: PageTextStyle;
}

export type PageWhiteSpace = "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
export type PageTextAlign = "left" | "center" | "right";

/** Terminal-independent block styling computed from supported CSS properties. */
export interface PageBlockStyle {
  readonly whiteSpace: PageWhiteSpace;
  readonly textAlign: PageTextAlign;
  readonly marginTopRows: number;
  readonly marginRightCells: number;
  readonly marginBottomRows: number;
  readonly marginLeftCells: number;
  readonly paddingTopRows: number;
  readonly paddingRightCells: number;
  readonly paddingBottomRows: number;
  readonly paddingLeftCells: number;
  readonly textIndentCells: number;
  readonly background?: PageColor;
}

/** One semantic document block before terminal layout. */
export interface PageBlock {
  readonly id: string;
  readonly kind: PageBlockKind;
  readonly text: string;
  readonly style: PageBlockStyle;
  readonly textRuns: readonly PageTextRun[];
  readonly level?: number;
  readonly depth?: number;
  readonly region?: PageRegion;
}

export type PageStyleIssueCode =
  | "stylesheet-fetch"
  | "stylesheet-limit"
  | "stylesheet-media"
  | "stylesheet-parse"
  | "unsupported-at-rule"
  | "selector-parse"
  | "selector-unknown"
  | "property-invalid"
  | "property-unsupported"
  | "value-unsupported";

/** Recoverable author-style issue retained for page diagnostics. */
export interface PageStyleIssue {
  readonly code: PageStyleIssueCode;
  readonly message: string;
  readonly sourceUrl: string;
}

/** One external stylesheet fetched in document order. */
export interface PageStylesheetResource {
  readonly ownerNodeId: number;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly transportEncodingLabel?: string;
}

/** Buffered CSS resource returned by the default stylesheet loader. */
export interface FetchStylesheetResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly transportEncodingLabel?: string;
}

interface PageActionBase {
  readonly id: string;
  readonly blockId: string;
  readonly index: number;
  readonly label: string;
  readonly textOffset: number;
}

/** Stable link action retained in semantic page content. */
export interface PageLinkAction extends PageActionBase {
  readonly kind: "link";
  readonly href: string;
  readonly resolvedHref: string;
}

/** Stable form action retained in semantic page content. */
export interface PageFormAction extends PageActionBase {
  readonly kind: "form";
  readonly method: string;
  readonly actionUrl: string;
  readonly fieldCount: number;
}

export type PageAction = PageLinkAction | PageFormAction;

/** Parsed page meaning that does not depend on terminal dimensions. */
export interface PageContent {
  readonly title: string;
  readonly displayUrl: string;
  readonly statusLine: string;
  readonly blocks: readonly PageBlock[];
  readonly links: readonly PageLinkAction[];
  readonly actions: readonly PageAction[];
  readonly styleIssues: readonly PageStyleIssue[];
  readonly stylesheetCount: number;
  readonly parseErrorCount: number;
  readonly fetchedAtIso: string;
}

/** One styled half-open range in a terminal layout row. */
export interface PageLayoutStyleRun {
  readonly startCodeUnitIndex: number;
  readonly endCodeUnitIndexExclusive: number;
  readonly style: PageTextStyle;
}

/** One terminal row derived from a semantic block. */
export interface PageLayoutRow {
  readonly blockId: string;
  readonly text: string;
  readonly actionIds: readonly string[];
  readonly blockTextStartCodeUnitIndex: number;
  readonly blockTextEndCodeUnitIndexExclusive: number;
  readonly contentStartCodeUnitIndex: number;
  readonly styleRuns: readonly PageLayoutStyleRun[];
  readonly background?: PageColor;
  readonly backgroundStartCodeUnitIndex?: number;
  readonly backgroundEndCodeUnitIndexExclusive?: number;
}

/** Terminal geometry for one rendered segment of a stable page action. */
export interface PageActionPlacement {
  readonly actionId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly width: number;
}

/** Width-specific layout derived from `PageContent`. */
export interface PageLayout {
  readonly columns: number;
  readonly rows: readonly PageLayoutRow[];
  readonly actionPlacements: readonly PageActionPlacement[];
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
  /** Directly focusable page actions in visual order. */
  readonly actionables: readonly RenderedActionable[];
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
  /** Cancels fetch, retry waits, and parsing work owned by this navigation. */
  readonly signal?: AbortSignal;
}

/** Performance and triage metadata attached to a page snapshot. */
export interface PageDiagnostics {
  /** Parse path used to build the snapshot. */
  readonly parseMode: "text" | "stream";
  /** UTF-8 byte length of the decoded HTML source. */
  readonly sourceBytes: number;
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
  /** Time spent building semantic page content in milliseconds. */
  readonly contentDurationMs: number;
  /** Time spent fetching external stylesheets in milliseconds. */
  readonly stylesheetDurationMs: number;
  /** Number of embedded and successfully loaded external stylesheets parsed for the page. */
  readonly stylesheetCount: number;
  /** Number of recoverable stylesheet, selector, and property issues. */
  readonly styleIssueCount: number;
  /** End-to-end time for fetch, parse, and semantic content construction in milliseconds. */
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
  /** External author stylesheets already fetched in document order. */
  readonly stylesheets?: readonly PageStylesheetResource[];
  /** Recoverable stylesheet loading issues collected before page construction. */
  readonly stylesheetIssues?: readonly PageStyleIssue[];
  /** Whether author styles participate in page construction. */
  readonly authorStyles?: "apply" | "ignore";
}

/** Input accepted by semantic page-content construction. */
export type PageContentInput = Omit<RenderInput, "width">;

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
  /** Parsed HTML document, including its tree, source, and resource metadata. */
  readonly document: ParsedDocument;
  /** Semantic page content retained independently from terminal size. */
  readonly content: PageContent;
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
