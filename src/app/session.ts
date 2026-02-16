import {
  applyPatchPlan,
  computePatch,
  parse,
  parseStream,
  type DocumentTree,
  type Edit,
  type ParseOptions,
  type TraceEvent
} from "html-parser";

import { fetchPage, fetchPageStream, readByteStreamToText } from "./fetch-page.js";
import { renderDocumentToTerminal } from "./render.js";
import type {
  FetchPagePayload,
  FetchPageResult,
  FetchPageStreamResult,
  PageDiagnostics,
  PageRequestOptions,
  PageSnapshot,
  RenderedPage
} from "./types.js";

export type PageLoader = (requestUrl: string, requestOptions?: PageRequestOptions) => Promise<FetchPageResult>;
export type PageStreamLoader = (requestUrl: string, requestOptions?: PageRequestOptions) => Promise<FetchPageStreamResult>;
export type PageRenderer = (input: {
  readonly tree: DocumentTree;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
  readonly width: number;
}) => RenderedPage;

const TEXT_ENCODER = new TextEncoder();
const DEFAULT_PARSE_OPTIONS: ParseOptions = Object.freeze({
  captureSpans: true,
  trace: true,
  budgets: {
    maxInputBytes: 2 * 1024 * 1024,
    maxBufferedBytes: 512 * 1024,
    maxNodes: 250_000,
    maxDepth: 2_048,
    maxTraceEvents: 8_192,
    maxTraceBytes: 2 * 1024 * 1024,
    maxTimeMs: 20_000
  }
});

type ParseMode = "text" | "stream";

interface NavigationTimings {
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly renderDurationMs: number;
  readonly totalDurationMs: number;
}

export interface BrowserSessionOptions {
  readonly loader?: PageLoader;
  readonly streamLoader?: PageStreamLoader;
  readonly renderer?: PageRenderer;
  readonly widthProvider?: () => number;
  readonly parseOptions?: ParseOptions;
  readonly defaultParseMode?: ParseMode;
}

function uniqueTraceKinds(trace: readonly TraceEvent[] | undefined): readonly string[] {
  if (!trace || trace.length === 0) {
    return [];
  }
  const seenKinds = new Set<string>();
  for (const event of trace) {
    seenKinds.add(event.kind);
  }
  return [...seenKinds].sort((left, right) => left.localeCompare(right));
}

function hasCookieHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (!headers) {
    return false;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "cookie" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function diagnosticsFromTree(
  tree: DocumentTree,
  parseMode: ParseMode,
  sourceHtml: string | undefined,
  requestMethod: "GET" | "POST",
  timings: NavigationTimings,
  usedCookies: boolean
): PageDiagnostics {
  return {
    parseMode,
    sourceBytes: sourceHtml === undefined ? null : TEXT_ENCODER.encode(sourceHtml).byteLength,
    parseErrorCount: tree.errors.length,
    traceEventCount: tree.trace?.length ?? 0,
    traceKinds: uniqueTraceKinds(tree.trace),
    requestMethod,
    fetchDurationMs: timings.fetchDurationMs,
    parseDurationMs: timings.parseDurationMs,
    renderDurationMs: timings.renderDurationMs,
    totalDurationMs: timings.totalDurationMs,
    usedCookies
  };
}

export class BrowserSession {
  private readonly loader: PageLoader;
  private readonly streamLoader: PageStreamLoader;
  private readonly renderer: PageRenderer;
  private readonly widthProvider: () => number;
  private readonly parseOptions: ParseOptions;
  private readonly defaultParseMode: ParseMode;
  private readonly historyUrls: string[] = [];
  private readonly historyModes: ParseMode[] = [];
  private historyIndex = -1;
  private currentSnapshot: PageSnapshot | null = null;

  public constructor(options: BrowserSessionOptions = {}) {
    this.loader = options.loader ?? ((requestUrl, requestOptions) => fetchPage(requestUrl, undefined, undefined, requestOptions));
    this.streamLoader = options.streamLoader
      ?? ((requestUrl, requestOptions) => fetchPageStream(requestUrl, undefined, undefined, requestOptions));
    this.renderer = options.renderer ?? renderDocumentToTerminal;
    this.widthProvider = options.widthProvider ?? (() => 100);
    this.parseOptions = options.parseOptions ?? DEFAULT_PARSE_OPTIONS;
    this.defaultParseMode = options.defaultParseMode ?? "text";
  }

  public get current(): PageSnapshot | null {
    return this.currentSnapshot;
  }

  public canBack(): boolean {
    return this.historyIndex > 0;
  }

  public canForward(): boolean {
    return this.historyIndex >= 0 && this.historyIndex < this.historyUrls.length - 1;
  }

  public async open(requestUrl: string): Promise<PageSnapshot> {
    return this.navigate(requestUrl, "push", this.defaultParseMode, {});
  }

  public async openStream(requestUrl: string): Promise<PageSnapshot> {
    return this.navigate(requestUrl, "push", "stream", {});
  }

  public async openWithRequest(
    requestUrl: string,
    requestOptions: PageRequestOptions,
    parseMode: ParseMode = this.defaultParseMode
  ): Promise<PageSnapshot> {
    return this.navigate(requestUrl, "push", parseMode, requestOptions);
  }

  public async reload(): Promise<PageSnapshot> {
    const currentUrl = this.historyUrls[this.historyIndex];
    const currentMode = this.historyModes[this.historyIndex];
    if (!currentUrl) {
      throw new Error("No page is loaded");
    }
    return this.navigate(currentUrl, "replace", currentMode ?? this.defaultParseMode, {});
  }

  public async back(): Promise<PageSnapshot> {
    if (!this.canBack()) {
      throw new Error("No backward history entry");
    }
    this.historyIndex -= 1;
    const targetUrl = this.historyUrls[this.historyIndex];
    const targetMode = this.historyModes[this.historyIndex];
    if (!targetUrl) {
      throw new Error("History entry is missing");
    }
    return this.navigate(targetUrl, "replace", targetMode ?? this.defaultParseMode, {});
  }

  public async forward(): Promise<PageSnapshot> {
    if (!this.canForward()) {
      throw new Error("No forward history entry");
    }
    this.historyIndex += 1;
    const targetUrl = this.historyUrls[this.historyIndex];
    const targetMode = this.historyModes[this.historyIndex];
    if (!targetUrl) {
      throw new Error("History entry is missing");
    }
    return this.navigate(targetUrl, "replace", targetMode ?? this.defaultParseMode, {});
  }

  public async openLink(linkIndex: number): Promise<PageSnapshot> {
    const currentPage = this.currentSnapshot;
    if (!currentPage) {
      throw new Error("No page is loaded");
    }

    const targetLink = currentPage.rendered.links.find((link) => link.index === linkIndex);
    if (!targetLink) {
      throw new Error(`No link exists at index ${String(linkIndex)}`);
    }

    const linkParseMode = currentPage.diagnostics.parseMode;
    return this.navigate(targetLink.resolvedHref, "push", linkParseMode, {});
  }

  public applyEdits(edits: readonly Edit[]): PageSnapshot {
    const currentPage = this.currentSnapshot;
    if (!currentPage) {
      throw new Error("No page is loaded");
    }
    if (!currentPage.sourceHtml) {
      throw new Error("Cannot apply patch: source HTML is unavailable for this snapshot");
    }

    const patchPlan = computePatch(currentPage.sourceHtml, edits);
    const patchedHtml = applyPatchPlan(currentPage.sourceHtml, patchPlan);
    const startedAtMs = Date.now();
    const parseStartMs = Date.now();
    const tree = parse(patchedHtml, this.parseOptions);
    const parseDurationMs = Date.now() - parseStartMs;

    const width = Math.max(40, this.widthProvider());
    const renderStartMs = Date.now();
    const rendered = this.renderer({
      tree,
      requestUrl: currentPage.requestUrl,
      finalUrl: currentPage.finalUrl,
      status: currentPage.status,
      statusText: currentPage.statusText,
      fetchedAtIso: currentPage.fetchedAtIso,
      width
    });
    const renderDurationMs = Date.now() - renderStartMs;
    const totalDurationMs = Date.now() - startedAtMs;

    const snapshot: PageSnapshot = {
      requestUrl: currentPage.requestUrl,
      finalUrl: currentPage.finalUrl,
      status: currentPage.status,
      statusText: currentPage.statusText,
      contentType: currentPage.contentType,
      responseHeaders: currentPage.responseHeaders,
      fetchedAtIso: currentPage.fetchedAtIso,
      setCookieHeaders: [],
      tree,
      rendered,
      sourceHtml: patchedHtml,
      diagnostics: diagnosticsFromTree(
        tree,
        currentPage.diagnostics.parseMode,
        patchedHtml,
        currentPage.diagnostics.requestMethod,
        {
          fetchDurationMs: 0,
          parseDurationMs,
          renderDurationMs,
          totalDurationMs
        },
        currentPage.diagnostics.usedCookies
      )
    };

    this.currentSnapshot = snapshot;
    return snapshot;
  }

  private commitHistory(url: string, mode: "push" | "replace", parseMode: ParseMode): void {
    if (mode === "replace") {
      if (this.historyIndex < 0) {
        this.historyUrls.push(url);
        this.historyModes.push(parseMode);
        this.historyIndex = 0;
        return;
      }
      this.historyUrls[this.historyIndex] = url;
      this.historyModes[this.historyIndex] = parseMode;
      return;
    }

    const truncatedHistory = this.historyUrls.slice(0, this.historyIndex + 1);
    const truncatedModes = this.historyModes.slice(0, this.historyIndex + 1);
    truncatedHistory.push(url);
    truncatedModes.push(parseMode);
    this.historyUrls.splice(0, this.historyUrls.length, ...truncatedHistory);
    this.historyModes.splice(0, this.historyModes.length, ...truncatedModes);
    this.historyIndex = this.historyUrls.length - 1;
  }

  private async parseFetchedPayload(
    parseMode: ParseMode,
    fetchedPage: FetchPagePayload
  ): Promise<{ readonly tree: DocumentTree; readonly sourceHtml: string | undefined }> {
    if (parseMode === "text") {
      if (!("html" in fetchedPage)) {
        throw new Error("Text parse mode requires an HTML payload");
      }
      const tree = parse(fetchedPage.html, this.parseOptions);
      return {
        tree,
        sourceHtml: fetchedPage.html
      };
    }

    if ("html" in fetchedPage) {
      const tree = parse(fetchedPage.html, this.parseOptions);
      return {
        tree,
        sourceHtml: fetchedPage.html
      };
    }

    const [parseStreamInput, sourceStreamInput] = fetchedPage.stream.tee();
    const [tree, sourceHtml] = await Promise.all([
      parseStream(parseStreamInput, this.parseOptions),
      readByteStreamToText(sourceStreamInput)
    ]);

    return {
      tree,
      sourceHtml
    };
  }

  private async navigate(
    requestUrl: string,
    mode: "push" | "replace",
    parseMode: ParseMode,
    requestOptions: PageRequestOptions
  ): Promise<PageSnapshot> {
    const startedAtMs = Date.now();

    const fetchStartMs = Date.now();
    const fetchedPage = parseMode === "stream"
      ? await this.streamLoader(requestUrl, requestOptions)
      : await this.loader(requestUrl, requestOptions);
    const fetchDurationMs = Date.now() - fetchStartMs;

    const parseStartMs = Date.now();
    const parsedPayload = await this.parseFetchedPayload(parseMode, fetchedPage);
    const parseDurationMs = Date.now() - parseStartMs;

    const width = Math.max(40, this.widthProvider());
    const renderStartMs = Date.now();
    const rendered = this.renderer({
      tree: parsedPayload.tree,
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      width
    });
    const renderDurationMs = Date.now() - renderStartMs;
    const totalDurationMs = Date.now() - startedAtMs;
    const requestMethod = requestOptions.method ?? "GET";
    const usedCookies = hasCookieHeader(requestOptions.headers);

    const snapshot: PageSnapshot = {
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      contentType: fetchedPage.contentType,
      responseHeaders: fetchedPage.responseHeaders,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      setCookieHeaders: fetchedPage.setCookieHeaders,
      tree: parsedPayload.tree,
      rendered,
      ...(parsedPayload.sourceHtml !== undefined ? { sourceHtml: parsedPayload.sourceHtml } : {}),
      diagnostics: diagnosticsFromTree(
        parsedPayload.tree,
        parseMode,
        parsedPayload.sourceHtml,
        requestMethod,
        {
          fetchDurationMs,
          parseDurationMs,
          renderDurationMs,
          totalDurationMs
        },
        usedCookies
      )
    };

    this.currentSnapshot = snapshot;
    this.commitHistory(snapshot.finalUrl, mode, parseMode);

    return snapshot;
  }
}
