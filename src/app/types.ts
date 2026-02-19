import type { DocumentTree } from "html-parser";

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

export interface NetworkOutcome {
  readonly kind: NetworkOutcomeKind;
  readonly finalUrl: string;
  readonly status: number | null;
  readonly statusText: string | null;
  readonly detailCode: string | null;
  readonly detailMessage: string;
}

export interface RenderedLink {
  readonly index: number;
  readonly label: string;
  readonly href: string;
  readonly resolvedHref: string;
}

export interface RenderedPage {
  readonly title: string;
  readonly displayUrl: string;
  readonly statusLine: string;
  readonly lines: readonly string[];
  readonly links: readonly RenderedLink[];
  readonly parseErrorCount: number;
  readonly fetchedAtIso: string;
}

export interface FetchPageResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly html: string;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly setCookieHeaders: readonly string[];
  readonly fetchedAtIso: string;
  readonly networkOutcome: NetworkOutcome;
}

export interface FetchPageStreamResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly stream: ReadableStream<Uint8Array>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly setCookieHeaders: readonly string[];
  readonly fetchedAtIso: string;
  readonly networkOutcome: NetworkOutcome;
}

export type FetchPagePayload = FetchPageResult | FetchPageStreamResult;

export interface PageRequestOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyText?: string;
}

export interface PageDiagnostics {
  readonly parseMode: "text" | "stream";
  readonly sourceBytes: number | null;
  readonly parseErrorCount: number;
  readonly traceEventCount: number;
  readonly traceKinds: readonly string[];
  readonly requestMethod: "GET" | "POST";
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly renderDurationMs: number;
  readonly totalDurationMs: number;
  readonly usedCookies: boolean;
  readonly networkOutcome: NetworkOutcome;
  readonly triageIds: readonly string[];
}

export interface RenderInput {
  readonly tree: DocumentTree;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
  readonly width: number;
}

export interface PageSnapshot {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly fetchedAtIso: string;
  readonly setCookieHeaders: readonly string[];
  readonly tree: DocumentTree;
  readonly rendered: RenderedPage;
  readonly sourceHtml?: string;
  readonly diagnostics: PageDiagnostics;
}

export interface KeyboardKey {
  readonly sequence: string;
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}
