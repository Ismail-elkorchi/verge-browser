import type { HttpFields } from "@ismail-elkorchi/http-client";

import type { IndexedWebDocumentSnapshot, WebDocumentSnapshot } from "../document/index.js";
import type { StyleDiagnostic, StylesheetResource } from "../presentation/style/index.js";

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
  | "network_block"
  | "unsupported_protocol"
  | "unknown";

/** Structured outcome emitted by fetch helpers for successful and failed requests. */
export interface NetworkOutcome {
  readonly finalUrl: string;
  readonly kind: NetworkOutcomeKind;
  readonly status: number | null;
  readonly statusText: string | null;
  readonly detailCode: string | null;
  readonly detailMessage: string;
}

/** Fully buffered HTML fetch result returned by `fetchPage()`. */
export interface FetchPageResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly html: string;
  readonly responseFields: HttpFields;
  readonly fetchedAtIso: string;
  readonly networkOutcome: NetworkOutcome;
}

/** Streaming HTML fetch result returned by `fetchPageStream()`. */
export interface FetchPageStreamResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly stream: ReadableStream<Uint8Array>;
  readonly responseFields: HttpFields;
  readonly transportEncodingLabel?: string;
  readonly fetchedAtIso: string;
  readonly networkOutcome: NetworkOutcome;
}

export type FetchPagePayload = FetchPageResult | FetchPageStreamResult;

/** Buffered CSS resource returned by the default stylesheet loader. */
export interface FetchStylesheetResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly responseFields: HttpFields;
  readonly transportEncodingLabel?: string;
}

/** Options accepted by page navigation and fetch helpers. */
export interface PageRequestOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyText?: string;
  readonly signal?: AbortSignal;
}

/** Performance and triage metadata attached to a page snapshot. */
export interface PageDiagnostics {
  readonly parseMode: "text" | "stream";
  readonly sourceBytes: number;
  readonly parseErrorCount: number;
  readonly requestMethod: "GET" | "POST";
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly documentDurationMs: number;
  readonly stylesheetDurationMs: number;
  readonly stylesheetCount: number;
  readonly stylesheetLoadIssueCount: number;
  readonly totalDurationMs: number;
  readonly networkOutcome: NetworkOutcome;
  readonly triageIds: readonly string[];
}

/** Result of one navigation. Its document is immutable; presentation is derived per viewport. */
export interface PageSnapshot {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly responseFields: HttpFields;
  readonly fetchedAtIso: string;
  readonly document: WebDocumentSnapshot;
  readonly stylesheets: readonly StylesheetResource[];
  readonly styleDiagnostics: readonly StyleDiagnostic[];
  readonly diagnostics: PageDiagnostics;
}

/** @internal Browser-owned snapshot with indexes required by presentation and UI subsystems. */
export interface IndexedPageSnapshot extends Omit<PageSnapshot, "document"> {
  readonly document: IndexedWebDocumentSnapshot;
}

/** @internal Narrows a browser-produced public snapshot at Verge's internal ownership boundary. */
export function indexedPageSnapshot(snapshot: PageSnapshot): IndexedPageSnapshot {
  return snapshot as IndexedPageSnapshot;
}
