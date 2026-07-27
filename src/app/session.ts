import {
  applyPatchPlan,
  computePatch,
  parse,
  parseStream,
  type DocumentTree,
  type Edit,
  type ParseOptions,
  type ParsedDocument
} from "@ismail-elkorchi/html-parser";

import { fetchPage, fetchPageStream, type LocalFileReader } from "./fetch-page.js";
import { buildPageContent } from "./render.js";
import type {
  FetchPagePayload,
  FetchPageResult,
  FetchPageStreamResult,
  PageContent,
  PageDiagnostics,
  PageRequestOptions,
  PageSnapshot
} from "./types.js";

export type PageLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageResult>;

export type PageStreamLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageStreamResult>;

export type PageContentBuilder = (input: {
  readonly tree: DocumentTree;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
}) => PageContent;

type ParseMode = "text" | "stream";

interface NavigationTimings {
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly contentDurationMs: number;
  readonly totalDurationMs: number;
}

interface HistoryEntry {
  readonly snapshot: PageSnapshot;
  readonly parseMode: ParseMode;
}

export interface BrowserSessionOptions {
  readonly loader?: PageLoader;
  readonly streamLoader?: PageStreamLoader;
  readonly contentBuilder?: PageContentBuilder;
  readonly parseOptions?: ParseOptions;
  readonly defaultParseMode?: ParseMode;
  readonly localFileReader?: LocalFileReader;
}

const DEFAULT_PARSE_OPTIONS: ParseOptions = Object.freeze({
  captureSpans: true,
  sourceRetention: "text",
  trace: "summary",
  budgets: {
    maxInputBytes: 2 * 1024 * 1024,
    maxNodes: 250_000,
    maxDepth: 2_048,
    maxTimeMs: 20_000
  }
});

function hasCookieHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) => name.toLowerCase() === "cookie" && value.trim().length > 0
  );
}

function normalizeTriageToken(value: string | null | undefined): string {
  if (!value || value.trim().length === 0) return "NONE";
  return value.trim().replaceAll(/[^A-Za-z0-9_.:-]+/gu, "_");
}

function buildTriageIds(
  tree: DocumentTree,
  networkOutcome: PageDiagnostics["networkOutcome"]
): readonly string[] {
  const triage = new Set<string>([
    `NET:${normalizeTriageToken(networkOutcome.kind.toUpperCase())}:${normalizeTriageToken(networkOutcome.detailCode)}`
  ]);
  const parseErrorIds = tree.errors.flatMap((entry) =>
    typeof entry.parseErrorId === "string" && entry.parseErrorId.length > 0
      ? [entry.parseErrorId]
      : []
  );
  if (parseErrorIds.length === 0) triage.add("PARSE:NONE");
  else {
    for (const id of [...new Set(parseErrorIds)].sort()) {
      triage.add(`PARSE:${normalizeTriageToken(id)}`);
    }
  }
  return [...triage].sort();
}

function unknownNetworkOutcome(): PageDiagnostics["networkOutcome"] {
  return {
    kind: "unknown",
    finalUrl: "about:blank",
    status: null,
    statusText: null,
    detailCode: "MISSING_NETWORK_OUTCOME",
    detailMessage: "Network outcome unavailable"
  };
}

function diagnosticsFromDocument(
  document: ParsedDocument,
  parseMode: ParseMode,
  requestMethod: "GET" | "POST",
  timings: NavigationTimings,
  usedCookies: boolean,
  networkOutcome: PageDiagnostics["networkOutcome"] | undefined
): PageDiagnostics {
  const outcome = networkOutcome ?? unknownNetworkOutcome();
  return {
    parseMode,
    sourceBytes: document.metadata.resourceUsage.decodedUtf8Bytes,
    parseErrorCount: document.tree.errors.length,
    traceEventCount: document.tree.trace?.summary.eventCount ?? 0,
    traceKinds: document.tree.trace?.summary.eventKinds ?? [],
    requestMethod,
    fetchDurationMs: timings.fetchDurationMs,
    parseDurationMs: timings.parseDurationMs,
    contentDurationMs: timings.contentDurationMs,
    totalDurationMs: timings.totalDurationMs,
    usedCookies,
    networkOutcome: outcome,
    triageIds: buildTriageIds(document.tree, outcome)
  };
}

export class BrowserSession {
  readonly #loader: PageLoader;
  readonly #streamLoader: PageStreamLoader;
  readonly #contentBuilder: PageContentBuilder;
  readonly #parseOptions: ParseOptions;
  readonly #defaultParseMode: ParseMode;
  readonly #history: HistoryEntry[] = [];
  #historyIndex = -1;
  #current: PageSnapshot | null = null;

  public constructor(options: BrowserSessionOptions = {}) {
    const localFileReader = options.localFileReader;
    this.#loader = options.loader
      ?? ((requestUrl, requestOptions) =>
        fetchPage(requestUrl, undefined, undefined, requestOptions, localFileReader));
    this.#streamLoader = options.streamLoader
      ?? ((requestUrl, requestOptions) =>
        fetchPageStream(requestUrl, undefined, undefined, requestOptions, localFileReader));
    this.#contentBuilder = options.contentBuilder ?? buildPageContent;
    this.#parseOptions = {
      ...DEFAULT_PARSE_OPTIONS,
      ...options.parseOptions,
      captureSpans: true,
      sourceRetention: "text",
      budgets: {
        ...DEFAULT_PARSE_OPTIONS.budgets,
        ...options.parseOptions?.budgets
      }
    };
    this.#defaultParseMode = options.defaultParseMode ?? "text";
  }

  public get current(): PageSnapshot | null {
    return this.#current;
  }

  public canBack(): boolean {
    return this.#historyIndex > 0;
  }

  public canForward(): boolean {
    return this.#historyIndex >= 0 && this.#historyIndex < this.#history.length - 1;
  }

  public open(requestUrl: string, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.#navigate(requestUrl, "push", this.#defaultParseMode, {
      ...(signal === undefined ? {} : { signal })
    });
  }

  public openStream(requestUrl: string, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.#navigate(requestUrl, "push", "stream", {
      ...(signal === undefined ? {} : { signal })
    });
  }

  public openWithRequest(
    requestUrl: string,
    requestOptions: PageRequestOptions,
    parseMode: ParseMode = this.#defaultParseMode
  ): Promise<PageSnapshot> {
    return this.#navigate(requestUrl, "push", parseMode, requestOptions);
  }

  public reload(signal?: AbortSignal): Promise<PageSnapshot> {
    const current = this.#history[this.#historyIndex];
    if (!current) return Promise.reject(new Error("No page is loaded"));
    return this.#navigate(current.snapshot.finalUrl, "replace", current.parseMode, {
      ...(signal === undefined ? {} : { signal })
    });
  }

  public back(signal?: AbortSignal): Promise<PageSnapshot> {
    signal?.throwIfAborted();
    if (!this.canBack()) return Promise.reject(new Error("No backward history entry"));
    this.#historyIndex -= 1;
    const entry = this.#history[this.#historyIndex];
    if (!entry) return Promise.reject(new Error("History entry is missing"));
    this.#current = entry.snapshot;
    return Promise.resolve(entry.snapshot);
  }

  public forward(signal?: AbortSignal): Promise<PageSnapshot> {
    signal?.throwIfAborted();
    if (!this.canForward()) return Promise.reject(new Error("No forward history entry"));
    this.#historyIndex += 1;
    const entry = this.#history[this.#historyIndex];
    if (!entry) return Promise.reject(new Error("History entry is missing"));
    this.#current = entry.snapshot;
    return Promise.resolve(entry.snapshot);
  }

  public openLink(linkIndex: number, signal?: AbortSignal): Promise<PageSnapshot> {
    const current = this.#current;
    if (!current) return Promise.reject(new Error("No page is loaded"));
    const link = current.content.links.find((candidate) => candidate.index === linkIndex);
    if (!link) return Promise.reject(new Error(`No link exists at index ${String(linkIndex)}`));
    return this.#navigate(link.resolvedHref, "push", current.diagnostics.parseMode, {
      ...(signal === undefined ? {} : { signal })
    });
  }

  public applyEdits(edits: readonly Edit[]): PageSnapshot {
    const current = this.#current;
    if (!current) throw new Error("No page is loaded");
    if (current.document.sourceText === null) {
      throw new Error("Cannot apply patch: source HTML is unavailable for this snapshot");
    }
    const startedAtMs = Date.now();
    const patchedHtml = applyPatchPlan(current.document, computePatch(current.document, edits));
    const parseStartedAtMs = Date.now();
    const document = parse(patchedHtml, this.#parseOptions);
    const parseDurationMs = Date.now() - parseStartedAtMs;
    const contentStartedAtMs = Date.now();
    const content = this.#contentBuilder({
      tree: document.tree,
      requestUrl: current.requestUrl,
      finalUrl: current.finalUrl,
      status: current.status,
      statusText: current.statusText,
      fetchedAtIso: current.fetchedAtIso
    });
    const contentDurationMs = Date.now() - contentStartedAtMs;
    const snapshot: PageSnapshot = {
      ...current,
      setCookieHeaders: [],
      document,
      content,
      diagnostics: diagnosticsFromDocument(
        document,
        current.diagnostics.parseMode,
        current.diagnostics.requestMethod,
        {
          fetchDurationMs: 0,
          parseDurationMs,
          contentDurationMs,
          totalDurationMs: Date.now() - startedAtMs
        },
        current.diagnostics.usedCookies,
        current.diagnostics.networkOutcome
      )
    };
    this.#current = snapshot;
    if (this.#historyIndex >= 0) {
      this.#history[this.#historyIndex] = {
        snapshot,
        parseMode: current.diagnostics.parseMode
      };
    }
    return snapshot;
  }

  async #parseFetchedPayload(
    parseMode: ParseMode,
    fetchedPage: FetchPagePayload,
    signal?: AbortSignal
  ): Promise<ParsedDocument> {
    const parseOptions = {
      ...this.#parseOptions,
      ...(signal === undefined ? {} : { signal })
    };
    if ("html" in fetchedPage) return parse(fetchedPage.html, parseOptions);
    if (parseMode === "text") throw new Error("Text parse mode requires an HTML payload");
    return parseStream(fetchedPage.stream, parseOptions);
  }

  #commitHistory(snapshot: PageSnapshot, mode: "push" | "replace", parseMode: ParseMode): void {
    const entry = { snapshot, parseMode };
    if (mode === "replace") {
      if (this.#historyIndex < 0) {
        this.#history.push(entry);
        this.#historyIndex = 0;
      } else {
        this.#history[this.#historyIndex] = entry;
      }
      return;
    }
    this.#history.splice(this.#historyIndex + 1);
    this.#history.push(entry);
    this.#historyIndex = this.#history.length - 1;
  }

  async #navigate(
    requestUrl: string,
    mode: "push" | "replace",
    parseMode: ParseMode,
    requestOptions: PageRequestOptions
  ): Promise<PageSnapshot> {
    const startedAtMs = Date.now();
    requestOptions.signal?.throwIfAborted();
    const fetchStartedAtMs = Date.now();
    const fetchedPage = parseMode === "stream"
      ? await this.#streamLoader(requestUrl, requestOptions)
      : await this.#loader(requestUrl, requestOptions);
    const fetchDurationMs = Date.now() - fetchStartedAtMs;
    requestOptions.signal?.throwIfAborted();
    const parseStartedAtMs = Date.now();
    const document = await this.#parseFetchedPayload(parseMode, fetchedPage, requestOptions.signal);
    const parseDurationMs = Date.now() - parseStartedAtMs;
    requestOptions.signal?.throwIfAborted();
    const contentStartedAtMs = Date.now();
    const content = this.#contentBuilder({
      tree: document.tree,
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso
    });
    const contentDurationMs = Date.now() - contentStartedAtMs;
    const snapshot: PageSnapshot = {
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      contentType: fetchedPage.contentType,
      responseHeaders: fetchedPage.responseHeaders,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      setCookieHeaders: fetchedPage.setCookieHeaders,
      document,
      content,
      diagnostics: diagnosticsFromDocument(
        document,
        parseMode,
        requestOptions.method ?? "GET",
        {
          fetchDurationMs,
          parseDurationMs,
          contentDurationMs,
          totalDurationMs: Date.now() - startedAtMs
        },
        hasCookieHeader(requestOptions.headers),
        fetchedPage.networkOutcome
      )
    };
    this.#current = snapshot;
    this.#commitHistory(snapshot, mode, parseMode);
    return snapshot;
  }
}
