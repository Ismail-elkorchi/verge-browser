import {
  applyPatchPlan,
  computePatch,
  parse,
  parseStream,
  findAllByTagName,
  getAttributeValue,
  hasAttribute,
  type DocumentTree,
  type Edit,
  type ParseOptions,
  type ParsedDocument
} from "@ismail-elkorchi/html-parser";

import {
  fetchPage,
  fetchPageStream,
  fetchStylesheet,
  type LocalFileReader
} from "./fetch-page.js";
import { buildPageContent, documentBaseUrl } from "./render.js";
import { terminalMediaApplies } from "./styles.js";
import type {
  FetchPagePayload,
  FetchPageResult,
  FetchPageStreamResult,
  FetchStylesheetResult,
  PageContent,
  PageContentInput,
  PageDiagnostics,
  PageRequestOptions,
  PageSnapshot,
  PageStyleIssue,
  PageStylesheetResource
} from "./types.js";

export type PageLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageResult>;

export type PageStreamLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageStreamResult>;

export type PageContentBuilder = (input: PageContentInput) => PageContent;

export type StylesheetLoader = (
  requestUrl: string,
  requestOptions?: Pick<PageRequestOptions, "headers" | "signal">
) => Promise<FetchStylesheetResult>;

export interface StylesheetPolicyOptions {
  readonly maxStylesheets?: number;
  readonly maxStylesheetBytes?: number;
  readonly maxTotalStylesheetBytes?: number;
}

const DEFAULT_STYLESHEET_POLICY: Required<StylesheetPolicyOptions> = Object.freeze({
  maxStylesheets: 32,
  maxStylesheetBytes: 512 * 1024,
  maxTotalStylesheetBytes: 2 * 1024 * 1024
});

function stylesheetLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

type ParseMode = "text" | "stream";

interface NavigationTimings {
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly contentDurationMs: number;
  readonly stylesheetDurationMs: number;
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
  readonly stylesheetLoader?: StylesheetLoader;
  readonly stylesheetPolicy?: StylesheetPolicyOptions;
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
  content: PageContent,
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
    stylesheetDurationMs: timings.stylesheetDurationMs,
    stylesheetCount: content.stylesheetCount,
    styleIssueCount: content.styleIssues.length,
    totalDurationMs: timings.totalDurationMs,
    usedCookies,
    networkOutcome: outcome,
    triageIds: buildTriageIds(document.tree, outcome)
  };
}

function linkedStylesheets(tree: DocumentTree): readonly {
  readonly ownerNodeId: number;
  readonly href: string;
  readonly media?: string;
}[] {
  const links: { ownerNodeId: number; href: string; media?: string }[] = [];
  for (const node of findAllByTagName(tree, "link")) {
    const relations = (getAttributeValue(node, "rel") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    const href = getAttributeValue(node, "href");
    const type = getAttributeValue(node, "type")?.trim().toLowerCase();
    if (
      !relations.includes("stylesheet")
      || relations.includes("alternate")
      || hasAttribute(node, "disabled")
      || href === undefined
      || href.trim().length === 0
      || type !== undefined && type !== "text/css"
    ) {
      continue;
    }
    const media = getAttributeValue(node, "media");
    links.push({
      ownerNodeId: node.id,
      href,
      ...(media === undefined ? {} : { media })
    });
  }
  return links;
}

function stylesheetRequestHeaders(
  documentUrl: string,
  stylesheetUrl: string,
  headers: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(documentUrl).origin === new URL(stylesheetUrl).origin;
  } catch {
    return undefined;
  }
  const filtered = Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    if (normalized === "accept" || normalized === "content-type" || normalized === "content-length") {
      return false;
    }
    return sameOrigin || normalized !== "cookie" && normalized !== "authorization";
  }));
  return Object.keys(filtered).length === 0 ? undefined : filtered;
}

interface LoadedStylesheets {
  readonly resources: readonly PageStylesheetResource[];
  readonly issues: readonly PageStyleIssue[];
}

export class BrowserSession {
  readonly #loader: PageLoader;
  readonly #streamLoader: PageStreamLoader;
  readonly #contentBuilder: PageContentBuilder;
  readonly #stylesheetLoader: StylesheetLoader;
  readonly #stylesheetPolicy: Required<StylesheetPolicyOptions>;
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
    this.#stylesheetLoader = options.stylesheetLoader
      ?? ((requestUrl, requestOptions) =>
        fetchStylesheet(
          requestUrl,
          undefined,
          options.stylesheetPolicy?.maxStylesheetBytes === undefined
            ? {}
            : { maxContentBytes: options.stylesheetPolicy.maxStylesheetBytes },
          requestOptions,
          localFileReader
        ));
    this.#stylesheetPolicy = {
      maxStylesheets: stylesheetLimit(
        options.stylesheetPolicy?.maxStylesheets,
        DEFAULT_STYLESHEET_POLICY.maxStylesheets,
        "maxStylesheets"
      ),
      maxStylesheetBytes: stylesheetLimit(
        options.stylesheetPolicy?.maxStylesheetBytes,
        DEFAULT_STYLESHEET_POLICY.maxStylesheetBytes,
        "maxStylesheetBytes"
      ),
      maxTotalStylesheetBytes: stylesheetLimit(
        options.stylesheetPolicy?.maxTotalStylesheetBytes,
        DEFAULT_STYLESHEET_POLICY.maxTotalStylesheetBytes,
        "maxTotalStylesheetBytes"
      )
    };
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

  async #loadStylesheets(
    tree: DocumentTree,
    finalUrl: string,
    requestOptions: PageRequestOptions
  ): Promise<LoadedStylesheets> {
    const resources: PageStylesheetResource[] = [];
    const issues: PageStyleIssue[] = [];
    const baseUrl = documentBaseUrl(tree, finalUrl);
    const links = linkedStylesheets(tree);
    if (links.length > this.#stylesheetPolicy.maxStylesheets) {
      issues.push({
        code: "stylesheet-limit",
        message: `Only the first ${String(this.#stylesheetPolicy.maxStylesheets)} external stylesheets were considered.`,
        sourceUrl: finalUrl
      });
    }
    const candidates: {
      readonly link: (typeof links)[number];
      readonly requestUrl: string;
    }[] = [];
    for (const link of links.slice(0, this.#stylesheetPolicy.maxStylesheets)) {
      requestOptions.signal?.throwIfAborted();
      if (!terminalMediaApplies(link.media)) {
        issues.push({
          code: "stylesheet-media",
          message: "Skipped a stylesheet whose media query does not target terminal rendering.",
          sourceUrl: finalUrl
        });
        continue;
      }
      try {
        candidates.push({
          link,
          requestUrl: new URL(link.href, baseUrl).toString()
        });
      } catch {
        issues.push({
          code: "stylesheet-fetch",
          message: `Invalid stylesheet URL: ${link.href}`,
          sourceUrl: finalUrl
        });
      }
    }
    const fetchedStylesheets = await Promise.all(candidates.map(async (candidate) => {
      const headers = stylesheetRequestHeaders(
        finalUrl,
        candidate.requestUrl,
        requestOptions.headers
      );
      try {
        const fetched = await this.#stylesheetLoader(candidate.requestUrl, {
          ...(headers === undefined ? {} : { headers }),
          ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal })
        });
        return { ...candidate, fetched } as const;
      } catch (error) {
        requestOptions.signal?.throwIfAborted();
        return { ...candidate, error } as const;
      }
    }));
    let totalBytes = 0;
    for (const result of fetchedStylesheets) {
      if ("error" in result) {
        issues.push({
          code: "stylesheet-fetch",
          message: result.error instanceof Error ? result.error.message : String(result.error),
          sourceUrl: result.requestUrl
        });
        continue;
      }
      const { fetched, link } = result;
      const mediaType = fetched.contentType?.toLowerCase().split(";", 1)[0]?.trim();
      if (mediaType !== undefined && mediaType !== "text/css") {
        issues.push({
          code: "stylesheet-fetch",
          message: `Blocked non-CSS content-type: ${String(fetched.contentType)}`,
          sourceUrl: fetched.finalUrl
        });
        continue;
      }
      if (fetched.bytes.byteLength > this.#stylesheetPolicy.maxStylesheetBytes) {
        issues.push({
          code: "stylesheet-limit",
          message: `Stylesheet exceeded ${String(this.#stylesheetPolicy.maxStylesheetBytes)} bytes.`,
          sourceUrl: fetched.finalUrl
        });
        continue;
      }
      if (totalBytes + fetched.bytes.byteLength > this.#stylesheetPolicy.maxTotalStylesheetBytes) {
        issues.push({
          code: "stylesheet-limit",
          message: `Aggregate stylesheet data exceeded ${String(this.#stylesheetPolicy.maxTotalStylesheetBytes)} bytes.`,
          sourceUrl: fetched.finalUrl
        });
        break;
      }
      totalBytes += fetched.bytes.byteLength;
      resources.push({
        ownerNodeId: link.ownerNodeId,
        requestUrl: fetched.requestUrl,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        bytes: fetched.bytes,
        ...(fetched.transportEncodingLabel === undefined
          ? {}
          : { transportEncodingLabel: fetched.transportEncodingLabel })
      });
    }
    return { resources, issues };
  }

  public async applyEdits(edits: readonly Edit[]): Promise<PageSnapshot> {
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
    const stylesheetStartedAtMs = Date.now();
    const stylesheets = await this.#loadStylesheets(document.tree, current.finalUrl, {});
    const stylesheetDurationMs = Date.now() - stylesheetStartedAtMs;
    const contentStartedAtMs = Date.now();
    const content = this.#contentBuilder({
      tree: document.tree,
      requestUrl: current.requestUrl,
      finalUrl: current.finalUrl,
      status: current.status,
      statusText: current.statusText,
      fetchedAtIso: current.fetchedAtIso,
      stylesheets: stylesheets.resources,
      stylesheetIssues: stylesheets.issues
    });
    const contentDurationMs = Date.now() - contentStartedAtMs;
    const snapshot: PageSnapshot = {
      ...current,
      setCookieHeaders: [],
      document,
      content,
      diagnostics: diagnosticsFromDocument(
        document,
        content,
        current.diagnostics.parseMode,
        current.diagnostics.requestMethod,
        {
          fetchDurationMs: 0,
          parseDurationMs,
          contentDurationMs,
          stylesheetDurationMs,
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
    const stylesheetStartedAtMs = Date.now();
    const stylesheets = await this.#loadStylesheets(
      document.tree,
      fetchedPage.finalUrl,
      requestOptions
    );
    const stylesheetDurationMs = Date.now() - stylesheetStartedAtMs;
    requestOptions.signal?.throwIfAborted();
    const contentStartedAtMs = Date.now();
    const content = this.#contentBuilder({
      tree: document.tree,
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      stylesheets: stylesheets.resources,
      stylesheetIssues: stylesheets.issues
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
        content,
        parseMode,
        requestOptions.method ?? "GET",
        {
          fetchDurationMs,
          parseDurationMs,
          contentDurationMs,
          stylesheetDurationMs,
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
