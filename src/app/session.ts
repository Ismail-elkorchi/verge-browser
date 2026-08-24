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
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import {
  NetworkFetchError,
  PageNetworkClient,
  fetchDocumentStylesheet,
  type LocalFileReader
} from "./fetch-page.js";
import { withNavigationSource } from "./http-session-context.js";
import { attachPageContent, pageContent } from "./page-content.js";
import { buildPageContent, documentBaseUrl, renderPageContent } from "./render.js";
import { assertPageInitiatedNavigation } from "./security.js";
import { terminalMediaApplies } from "./styles.js";
import type {
  FetchPagePayload,
  FetchPageResult,
  FetchPageStreamResult,
  FetchStylesheetResult,
  PageContent,
  PageDiagnostics,
  PageRequestOptions,
  PageSnapshot,
  PageStyleIssue,
  PageStylesheetResource,
  RenderInput,
  RenderedPage
} from "./types.js";

export type PageLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageResult>;

export type PageStreamLoader = (
  requestUrl: string,
  requestOptions?: PageRequestOptions
) => Promise<FetchPageStreamResult>;

export type StylesheetLoader = (
  requestUrl: string,
  requestOptions?: Pick<PageRequestOptions, "headers" | "signal"> & {
    /** Maximum bytes this individual load may consume from the page budget. */
    readonly maxContentBytes?: number;
  }
) => Promise<FetchStylesheetResult>;

/** Stable terminal renderer override retained for npm library compatibility. */
export type PageRenderer = (input: RenderInput) => RenderedPage;

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
type NavigationAccess = "direct" | "page-initiated";
const PAGE_INITIATED_NAVIGATION = Symbol("pageInitiatedNavigation");

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
  readonly navigationAccess: NavigationAccess;
}

export interface BrowserSessionOptions {
  readonly networkClient?: PageNetworkClient;
  readonly httpSession?: HttpSessionAdapter;
  readonly loader?: PageLoader;
  readonly streamLoader?: PageStreamLoader;
  readonly stylesheetLoader?: StylesheetLoader;
  readonly stylesheetPolicy?: StylesheetPolicyOptions;
  readonly renderer?: PageRenderer;
  readonly widthProvider?: () => number;
  readonly parseOptions?: ParseOptions;
  readonly defaultParseMode?: ParseMode;
  readonly localFileReader?: LocalFileReader;
}

const DEFAULT_PARSE_OPTIONS: ParseOptions = Object.freeze({
  scriptingMode: "disabled",
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

interface LoadedStylesheets {
  readonly resources: readonly PageStylesheetResource[];
  readonly issues: readonly PageStyleIssue[];
}

export class BrowserSession {
  readonly #networkClient: PageNetworkClient | null;
  readonly #ownsNetworkClient: boolean;
  readonly #loader: PageLoader;
  readonly #streamLoader: PageStreamLoader;
  readonly #pageInitiatedLoader: PageLoader;
  readonly #pageInitiatedStreamLoader: PageStreamLoader;
  readonly #stylesheetLoader: StylesheetLoader | null;
  readonly #stylesheetPolicy: Required<StylesheetPolicyOptions>;
  readonly #localFileReader: LocalFileReader | undefined;
  readonly #renderer: PageRenderer | null;
  readonly #widthProvider: () => number;
  readonly #parseOptions: ParseOptions;
  readonly #defaultParseMode: ParseMode;
  readonly #history: HistoryEntry[] = [];
  #historyIndex = -1;
  #current: PageSnapshot | null = null;

  public constructor(options: BrowserSessionOptions = {}) {
    if (
      options.networkClient !== undefined
      && options.httpSession !== undefined
    ) {
      throw new TypeError(
        "BrowserSession accepts either networkClient or httpSession, not both."
      );
    }
    const localFileReader = options.localFileReader;
    this.#localFileReader = localFileReader;
    const needsNetworkClient = (
      options.loader === undefined
      || options.streamLoader === undefined
      || options.stylesheetLoader === undefined
    );
    this.#networkClient = options.networkClient
      ?? (
        needsNetworkClient
          ? new PageNetworkClient({
            ...(options.httpSession === undefined
              ? {}
              : { session: options.httpSession })
          })
          : null
      );
    this.#ownsNetworkClient = (
      this.#networkClient !== null
      && options.networkClient === undefined
    );
    this.#loader = options.loader
      ?? ((requestUrl, requestOptions) =>
        this.#requiredNetworkClient().navigatePage(
          requestUrl,
          undefined,
          undefined,
          requestOptions,
          localFileReader
        ));
    this.#streamLoader = options.streamLoader
      ?? ((requestUrl, requestOptions) =>
        this.#requiredNetworkClient().navigatePageStream(
          requestUrl,
          undefined,
          undefined,
          requestOptions,
          localFileReader
        ));
    this.#pageInitiatedLoader = options.loader
      ?? ((requestUrl, requestOptions) =>
        this.#requiredNetworkClient().fetchPage(
          requestUrl,
          undefined,
          undefined,
          requestOptions,
          localFileReader
        ));
    this.#pageInitiatedStreamLoader = options.streamLoader
      ?? ((requestUrl, requestOptions) =>
        this.#requiredNetworkClient().fetchPageStream(
          requestUrl,
          undefined,
          undefined,
          requestOptions,
          localFileReader
        ));
    this.#stylesheetLoader = options.stylesheetLoader ?? null;
    this.#renderer = options.renderer ?? null;
    this.#widthProvider = options.widthProvider ?? (() => 100);
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
    this.#defaultParseMode = options.defaultParseMode ?? "stream";
  }

  public async close(): Promise<void> {
    if (this.#ownsNetworkClient) {
      await this.#networkClient?.close();
    }
  }

  public async destroy(reason?: Error): Promise<void> {
    if (this.#ownsNetworkClient) {
      await this.#networkClient?.destroy(reason);
    }
  }

  #requiredNetworkClient(): PageNetworkClient {
    if (this.#networkClient === null) {
      throw new Error("The browser session has no default network client.");
    }
    return this.#networkClient;
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
    }, "direct");
  }

  public openStream(requestUrl: string, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.#navigate(requestUrl, "push", "stream", {
      ...(signal === undefined ? {} : { signal })
    }, "direct");
  }

  public openWithRequest(
    requestUrl: string,
    requestOptions: PageRequestOptions,
    parseMode: ParseMode = this.#defaultParseMode
  ): Promise<PageSnapshot> {
    return this.#navigate(requestUrl, "push", parseMode, requestOptions, "direct");
  }

  public [PAGE_INITIATED_NAVIGATION](
    sourceUrl: string,
    requestUrl: string,
    requestOptions: PageRequestOptions = {},
    parseMode: ParseMode = this.#defaultParseMode
  ): Promise<PageSnapshot> {
    assertPageInitiatedNavigation(sourceUrl, requestUrl);
    return this.#navigate(
      requestUrl,
      "push",
      parseMode,
      withNavigationSource(requestOptions, sourceUrl),
      "page-initiated"
    );
  }

  public reload(signal?: AbortSignal): Promise<PageSnapshot> {
    const current = this.#history[this.#historyIndex];
    if (!current) return Promise.reject(new Error("No page is loaded"));
    return this.#navigate(current.snapshot.finalUrl, "replace", current.parseMode, {
      ...(signal === undefined ? {} : { signal })
    }, current.navigationAccess);
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

  public async openLink(linkIndex: number, signal?: AbortSignal): Promise<PageSnapshot> {
    const current = this.#current;
    if (!current) throw new Error("No page is loaded");
    const link = pageContent(current).links.find((candidate) => candidate.index === linkIndex);
    if (!link) throw new Error(`No link exists at index ${String(linkIndex)}`);
    return this[PAGE_INITIATED_NAVIGATION](
      current.finalUrl,
      link.resolvedHref,
      { ...(signal === undefined ? {} : { signal }) },
      current.diagnostics.parseMode
    );
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
        sourceUrl: finalUrl,
        occurrences: 1
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
          sourceUrl: finalUrl,
          occurrences: 1
        });
        continue;
      }
      try {
        const requestUrl = new URL(link.href, baseUrl);
        if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
          issues.push({
            code: "stylesheet-fetch",
            message: `Blocked page-initiated stylesheet protocol: ${requestUrl.protocol}`,
            sourceUrl: requestUrl.toString(),
            occurrences: 1
          });
          continue;
        }
        candidates.push({
          link,
          requestUrl: requestUrl.toString()
        });
      } catch {
        issues.push({
          code: "stylesheet-fetch",
          message: `Invalid stylesheet URL: ${link.href}`,
          sourceUrl: finalUrl,
          occurrences: 1
        });
      }
    }
    let totalBytes = 0;
    for (const candidate of candidates) {
      const remainingBytes = this.#stylesheetPolicy.maxTotalStylesheetBytes - totalBytes;
      if (remainingBytes <= 0) {
        issues.push({
          code: "stylesheet-limit",
          message: `Aggregate stylesheet data reached ${String(this.#stylesheetPolicy.maxTotalStylesheetBytes)} bytes.`,
          sourceUrl: candidate.requestUrl,
          occurrences: 1
        });
        break;
      }
      const requestBudget = Math.min(
        this.#stylesheetPolicy.maxStylesheetBytes,
        remainingBytes
      );
      let fetched: FetchStylesheetResult;
      try {
        const stylesheetRequestOptions = {
          ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          maxContentBytes: requestBudget
        };
        if (this.#stylesheetLoader === null) {
          const networkClient = this.#requiredNetworkClient();
          fetched = await fetchDocumentStylesheet(
            networkClient,
            candidate.requestUrl,
            finalUrl,
            undefined,
            { maxContentBytes: requestBudget },
            stylesheetRequestOptions,
            this.#localFileReader
          );
        } else {
          fetched = await this.#stylesheetLoader(candidate.requestUrl, stylesheetRequestOptions);
        }
      } catch (error) {
        requestOptions.signal?.throwIfAborted();
        issues.push({
          code: error instanceof NetworkFetchError
            && error.networkOutcome.kind === "size_limit"
            ? "stylesheet-limit"
            : "stylesheet-fetch",
          message: error instanceof Error ? error.message : String(error),
          sourceUrl: candidate.requestUrl,
          occurrences: 1
        });
        if (
          error instanceof NetworkFetchError
          && error.networkOutcome.kind === "size_limit"
        ) {
          break;
        }
        continue;
      }
      const { link } = candidate;
      if (fetched.bytes.byteLength > requestBudget) {
        issues.push({
          code: "stylesheet-limit",
          message: requestBudget < this.#stylesheetPolicy.maxStylesheetBytes
            ? `Aggregate stylesheet data exceeded ${String(this.#stylesheetPolicy.maxTotalStylesheetBytes)} bytes.`
            : `Stylesheet exceeded ${String(this.#stylesheetPolicy.maxStylesheetBytes)} bytes.`,
          sourceUrl: fetched.finalUrl,
          occurrences: 1
        });
        break;
      }
      totalBytes += fetched.bytes.byteLength;
      const mediaType = fetched.contentType?.toLowerCase().split(";", 1)[0]?.trim();
      if (mediaType !== undefined && mediaType !== "text/css") {
        issues.push({
          code: "stylesheet-fetch",
          message: `Blocked non-CSS content-type: ${String(fetched.contentType)}`,
          sourceUrl: fetched.finalUrl,
          occurrences: 1
        });
        continue;
      }
      resources.push({
        ownerNodeId: link.ownerNodeId,
        requestUrl: fetched.requestUrl,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        bytes: fetched.bytes,
        ...(link.media === undefined ? {} : { media: link.media }),
        ...(fetched.transportEncodingLabel === undefined
          ? {}
          : { transportEncodingLabel: fetched.transportEncodingLabel })
      });
    }
    return { resources, issues };
  }

  public async applyEdits(edits: readonly Edit[], signal?: AbortSignal): Promise<PageSnapshot> {
    signal?.throwIfAborted();
    const current = this.#current;
    if (!current) throw new Error("No page is loaded");
    if (current.document.sourceText === null) {
      throw new Error("Cannot apply patch: source HTML is unavailable for this snapshot");
    }
    const startedAtMs = Date.now();
    const patchedHtml = applyPatchPlan(current.document, computePatch(current.document, edits));
    const parseStartedAtMs = Date.now();
    const document = parse(patchedHtml, {
      ...this.#parseOptions,
      ...(signal === undefined ? {} : { signal })
    });
    const parseDurationMs = Date.now() - parseStartedAtMs;
    const stylesheetStartedAtMs = Date.now();
    const stylesheets = await this.#loadStylesheets(document.tree, current.finalUrl, {
      ...(signal === undefined ? {} : { signal })
    });
    const stylesheetDurationMs = Date.now() - stylesheetStartedAtMs;
    const contentStartedAtMs = Date.now();
    const renderInput: RenderInput = {
      tree: document.tree,
      requestUrl: current.requestUrl,
      finalUrl: current.finalUrl,
      status: current.status,
      statusText: current.statusText,
      fetchedAtIso: current.fetchedAtIso,
      stylesheets: stylesheets.resources,
      stylesheetIssues: stylesheets.issues,
      width: Math.max(40, Math.floor(this.#widthProvider()))
    };
    const content = buildPageContent(renderInput);
    const contentDurationMs = Date.now() - contentStartedAtMs;
    signal?.throwIfAborted();
    const snapshot: PageSnapshot = {
      ...current,
      document,
      rendered: this.#renderer === null
        ? renderPageContent(content, renderInput.width)
        : this.#renderer(renderInput),
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
        current.diagnostics.networkOutcome
      )
    };
    attachPageContent(snapshot, content);
    this.#current = snapshot;
    if (this.#historyIndex >= 0) {
      this.#history[this.#historyIndex] = {
        snapshot,
        parseMode: current.diagnostics.parseMode,
        navigationAccess: this.#history[this.#historyIndex]?.navigationAccess
          ?? "direct"
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
    return parseStream(fetchedPage.stream, {
      ...parseOptions,
      ...(fetchedPage.transportEncodingLabel === undefined
        ? {}
        : {
          transportEncodingLabel:
            fetchedPage.transportEncodingLabel
        })
    });
  }

  #commitHistory(
    snapshot: PageSnapshot,
    mode: "push" | "replace",
    parseMode: ParseMode,
    navigationAccess: NavigationAccess
  ): void {
    const entry = { snapshot, parseMode, navigationAccess };
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
    requestOptions: PageRequestOptions,
    navigationAccess: NavigationAccess
  ): Promise<PageSnapshot> {
    const startedAtMs = Date.now();
    requestOptions.signal?.throwIfAborted();
    const fetchStartedAtMs = Date.now();
    const fetchedPage = navigationAccess === "page-initiated"
      ? parseMode === "stream"
        ? await this.#pageInitiatedStreamLoader(requestUrl, requestOptions)
        : await this.#pageInitiatedLoader(requestUrl, requestOptions)
      : parseMode === "stream"
        ? await this.#streamLoader(requestUrl, requestOptions)
        : await this.#loader(requestUrl, requestOptions);
    let document: ParsedDocument;
    const fetchDurationMs = Date.now() - fetchStartedAtMs;
    const parseStartedAtMs = Date.now();
    try {
      requestOptions.signal?.throwIfAborted();
      document = await this.#parseFetchedPayload(parseMode, fetchedPage, requestOptions.signal);
    } catch (error) {
      if ("stream" in fetchedPage && !fetchedPage.stream.locked) {
        try {
          await fetchedPage.stream.cancel(error);
        } catch {
          // Preserve the navigation or parser failure that caused cleanup.
        }
      }
      throw error;
    }
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
    const renderInput: RenderInput = {
      tree: document.tree,
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      stylesheets: stylesheets.resources,
      stylesheetIssues: stylesheets.issues,
      width: Math.max(40, Math.floor(this.#widthProvider()))
    };
    const content = buildPageContent(renderInput);
    const contentDurationMs = Date.now() - contentStartedAtMs;
    const snapshot: PageSnapshot = {
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      contentType: fetchedPage.contentType,
      responseFields: fetchedPage.responseFields,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      document,
      rendered: this.#renderer === null
        ? renderPageContent(content, renderInput.width)
        : this.#renderer(renderInput),
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
        fetchedPage.networkOutcome
      )
    };
    attachPageContent(snapshot, content);
    this.#current = snapshot;
    this.#commitHistory(snapshot, mode, parseMode, navigationAccess);
    return snapshot;
  }
}

/** @internal Applies the browser workspace's page-initiated network capability. */
export function openPageInitiatedNavigation(
  session: BrowserSession,
  sourceUrl: string,
  requestUrl: string,
  requestOptions: PageRequestOptions = {},
  parseMode?: "text" | "stream"
): Promise<PageSnapshot> {
  return session[PAGE_INITIATED_NAVIGATION](
    sourceUrl,
    requestUrl,
    requestOptions,
    parseMode
  );
}
