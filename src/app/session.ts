import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import {
  parseWebDocument,
  parseWebDocumentStream,
  type WebDocumentParseOptions,
  type IndexedWebDocumentSnapshot
} from "../document/index.js";
import type { StyleDiagnostic, StylesheetResource } from "../presentation/style/index.js";
import {
  NetworkFetchError,
  PageNetworkClient,
  fetchDocumentStylesheet,
  type LocalFileReader
} from "./fetch-page.js";
import { navigationSource, withNavigationSource } from "./http-session-context.js";
import { assertPageInitiatedNavigation } from "./security.js";
import type {
  FetchPagePayload,
  FetchPageResult,
  FetchPageStreamResult,
  FetchStylesheetResult,
  PageDiagnostics,
  PageRequestOptions,
  PageSnapshot,
  IndexedPageSnapshot
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
    readonly maxContentBytes?: number;
  }
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

const DEFAULT_PARSE_OPTIONS: Omit<WebDocumentParseOptions, "signal"> = Object.freeze({
  budgets: Object.freeze({
    maxInputBytes: 2 * 1024 * 1024,
    maxNodes: 250_000,
    maxDepth: 2_048,
    maxTimeMs: 20_000
  })
});

type ParseMode = "text" | "stream";
type NavigationAccess = "direct" | "page-initiated";
const PAGE_INITIATED_NAVIGATION = Symbol("pageInitiatedNavigation");

interface NavigationTimings {
  readonly fetchDurationMs: number;
  readonly parseDurationMs: number;
  readonly documentDurationMs: number;
  readonly stylesheetDurationMs: number;
  readonly totalDurationMs: number;
}

interface HistoryEntry {
  readonly snapshot: IndexedPageSnapshot;
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
  readonly parseOptions?: Omit<WebDocumentParseOptions, "signal">;
  readonly defaultParseMode?: ParseMode;
  readonly localFileReader?: LocalFileReader;
}

function stylesheetLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function normalizeTriageToken(value: string | null | undefined): string {
  if (!value || value.trim().length === 0) return "NONE";
  return value.trim().replaceAll(/[^A-Za-z0-9_.:-]+/gu, "_");
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
  document: IndexedWebDocumentSnapshot,
  styleDiagnostics: readonly StyleDiagnostic[],
  stylesheetCount: number,
  parseMode: ParseMode,
  requestMethod: "GET" | "POST",
  timings: NavigationTimings,
  networkOutcome: PageDiagnostics["networkOutcome"] | undefined
): PageDiagnostics {
  const outcome = networkOutcome ?? unknownNetworkOutcome();
  const triage = new Set<string>([
    `NET:${normalizeTriageToken(outcome.kind.toUpperCase())}:${normalizeTriageToken(outcome.detailCode)}`
  ]);
  if (document.diagnostics.length === 0) triage.add("PARSE:NONE");
  else {
    for (const id of [...new Set(document.diagnostics.map((entry) => entry.id))].sort()) {
      triage.add(`PARSE:${normalizeTriageToken(id)}`);
    }
  }
  return Object.freeze({
    parseMode,
    sourceBytes: document.sourceMetadata.decodedUtf8Bytes,
    parseErrorCount: document.diagnostics.length,
    requestMethod,
    fetchDurationMs: timings.fetchDurationMs,
    parseDurationMs: timings.parseDurationMs,
    documentDurationMs: timings.documentDurationMs,
    stylesheetDurationMs: timings.stylesheetDurationMs,
    stylesheetCount,
    stylesheetLoadIssueCount: styleDiagnostics.length,
    totalDurationMs: timings.totalDurationMs,
    networkOutcome: outcome,
    triageIds: Object.freeze([...triage].sort())
  });
}

interface LoadedStylesheets {
  readonly resources: readonly StylesheetResource[];
  readonly diagnostics: readonly StyleDiagnostic[];
}

function stylesheetDiagnostic(
  code: StyleDiagnostic["code"],
  sourceUrl: string,
  detail: string
): StyleDiagnostic {
  return Object.freeze({ code, sourceUrl, detail, occurrences: 1 });
}

function combineSignals(internal: AbortSignal, external: AbortSignal | undefined): AbortSignal {
  return external === undefined ? internal : AbortSignal.any([internal, external]);
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
  readonly #parseOptions: Omit<WebDocumentParseOptions, "signal">;
  readonly #defaultParseMode: ParseMode;
  readonly #history: HistoryEntry[] = [];
  #historyIndex = -1;
  #current: IndexedPageSnapshot | null = null;
  #activeNavigation: AbortController | null = null;
  #navigationSequence = 0;
  #closed = false;

  public constructor(options: BrowserSessionOptions = {}) {
    if (options.networkClient !== undefined && options.httpSession !== undefined) {
      throw new TypeError("BrowserSession accepts either networkClient or httpSession, not both.");
    }
    this.#localFileReader = options.localFileReader;
    const needsNetworkClient = options.loader === undefined
      || options.streamLoader === undefined
      || options.stylesheetLoader === undefined;
    this.#networkClient = options.networkClient ?? (needsNetworkClient
      ? new PageNetworkClient({
        ...(options.httpSession === undefined ? {} : { session: options.httpSession })
      })
      : null);
    this.#ownsNetworkClient = this.#networkClient !== null && options.networkClient === undefined;
    this.#loader = options.loader ?? ((requestUrl, requestOptions) =>
      this.#requiredNetworkClient().navigatePage(
        requestUrl, undefined, undefined, requestOptions, this.#localFileReader
      ));
    this.#streamLoader = options.streamLoader ?? ((requestUrl, requestOptions) =>
      this.#requiredNetworkClient().navigatePageStream(
        requestUrl, undefined, undefined, requestOptions, this.#localFileReader
      ));
    this.#pageInitiatedLoader = options.loader ?? ((requestUrl, requestOptions) =>
      this.#requiredNetworkClient().fetchPage(
        requestUrl, undefined, undefined, requestOptions, this.#localFileReader
      ));
    this.#pageInitiatedStreamLoader = options.streamLoader ?? ((requestUrl, requestOptions) =>
      this.#requiredNetworkClient().fetchPageStream(
        requestUrl, undefined, undefined, requestOptions, this.#localFileReader
      ));
    this.#stylesheetLoader = options.stylesheetLoader ?? null;
    this.#stylesheetPolicy = Object.freeze({
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
    });
    this.#parseOptions = {
      ...DEFAULT_PARSE_OPTIONS,
      ...options.parseOptions,
      budgets: {
        ...DEFAULT_PARSE_OPTIONS.budgets,
        ...options.parseOptions?.budgets
      }
    };
    this.#defaultParseMode = options.defaultParseMode ?? "stream";
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

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeNavigation?.abort(new Error("Browser session closed."));
    this.#activeNavigation = null;
    if (this.#ownsNetworkClient) await this.#networkClient?.close();
  }

  public async destroy(reason: Error = new Error("Browser session destroyed.")): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeNavigation?.abort(reason);
    this.#activeNavigation = null;
    if (this.#ownsNetworkClient) await this.#networkClient?.destroy(reason);
  }

  #requiredNetworkClient(): PageNetworkClient {
    if (this.#networkClient === null) throw new Error("The browser session has no default network client.");
    return this.#networkClient;
  }

  #navigationOptions(options: PageRequestOptions): {
    readonly sequence: number;
    readonly options: PageRequestOptions;
  } {
    if (this.#closed) throw new Error("Browser session is closed.");
    this.#activeNavigation?.abort(new Error("Navigation superseded."));
    const controller = new AbortController();
    this.#activeNavigation = controller;
    const sequence = ++this.#navigationSequence;
    return {
      sequence,
      options: { ...options, signal: combineSignals(controller.signal, options.signal) }
    };
  }

  #finishNavigation(sequence: number): void {
    if (sequence !== this.#navigationSequence) throw new Error("Navigation was superseded.");
    this.#activeNavigation = null;
  }

  #failNavigation(sequence: number): void {
    if (sequence === this.#navigationSequence) this.#activeNavigation = null;
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
    this.#activeNavigation?.abort(new Error("History navigation superseded the active request."));
    this.#activeNavigation = null;
    this.#navigationSequence += 1;
    this.#historyIndex -= 1;
    const entry = this.#history[this.#historyIndex];
    if (!entry) return Promise.reject(new Error("History entry is missing"));
    this.#current = entry.snapshot;
    return Promise.resolve(entry.snapshot);
  }

  public forward(signal?: AbortSignal): Promise<PageSnapshot> {
    signal?.throwIfAborted();
    if (!this.canForward()) return Promise.reject(new Error("No forward history entry"));
    this.#activeNavigation?.abort(new Error("History navigation superseded the active request."));
    this.#activeNavigation = null;
    this.#navigationSequence += 1;
    this.#historyIndex += 1;
    const entry = this.#history[this.#historyIndex];
    if (!entry) return Promise.reject(new Error("History entry is missing"));
    this.#current = entry.snapshot;
    return Promise.resolve(entry.snapshot);
  }

  public async openLink(linkIndex: number, signal?: AbortSignal): Promise<PageSnapshot> {
    const current = this.#current;
    if (!current) throw new Error("No page is loaded");
    const link = current.document.links.find((candidate) => candidate.index === linkIndex);
    if (!link) throw new Error(`No link exists at index ${String(linkIndex)}`);
    return this[PAGE_INITIATED_NAVIGATION](
      current.finalUrl,
      link.destination,
      { ...(signal === undefined ? {} : { signal }) },
      current.diagnostics.parseMode
    );
  }

  async #loadStylesheets(
    document: IndexedWebDocumentSnapshot,
    requestOptions: PageRequestOptions
  ): Promise<LoadedStylesheets> {
    const resources: StylesheetResource[] = [];
    const diagnostics: StyleDiagnostic[] = [];
    const links = document.stylesheets.filter((entry) => entry.kind === "external");
    if (links.length > this.#stylesheetPolicy.maxStylesheets) {
      diagnostics.push(stylesheetDiagnostic(
        "stylesheet-limit",
        document.finalUrl,
        `Only the first ${String(this.#stylesheetPolicy.maxStylesheets)} external stylesheets were considered.`
      ));
    }
    let totalBytes = 0;
    for (const link of links.slice(0, this.#stylesheetPolicy.maxStylesheets)) {
      requestOptions.signal?.throwIfAborted();
      let target: URL;
      try {
        target = new URL(link.destination);
        assertPageInitiatedNavigation(document.finalUrl, target.toString());
        if (!["http:", "https:", "file:"].includes(target.protocol)) {
          throw new Error(`Unsupported stylesheet protocol: ${target.protocol}`);
        }
      } catch (error) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-fetch",
          link.destination,
          error instanceof Error ? error.message : String(error)
        ));
        continue;
      }
      const remainingBytes = this.#stylesheetPolicy.maxTotalStylesheetBytes - totalBytes;
      if (remainingBytes <= 0) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-limit",
          target.toString(),
          `Aggregate stylesheet transport budget reached ${String(this.#stylesheetPolicy.maxTotalStylesheetBytes)} bytes.`
        ));
        break;
      }
      const requestBudget = Math.min(this.#stylesheetPolicy.maxStylesheetBytes, remainingBytes);
      let fetched: FetchStylesheetResult;
      try {
        const stylesheetOptions = {
          ...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
          ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          maxContentBytes: requestBudget
        };
        fetched = this.#stylesheetLoader === null
          ? await fetchDocumentStylesheet(
            this.#requiredNetworkClient(),
            target.toString(),
            document.finalUrl,
            undefined,
            { maxContentBytes: requestBudget },
            stylesheetOptions,
            this.#localFileReader
          )
          : await this.#stylesheetLoader(target.toString(), stylesheetOptions);
      } catch (error) {
        requestOptions.signal?.throwIfAborted();
        const sizeLimit = error instanceof NetworkFetchError
          && error.networkOutcome.kind === "size_limit";
        diagnostics.push(stylesheetDiagnostic(
          sizeLimit ? "stylesheet-limit" : "stylesheet-fetch",
          target.toString(),
          error instanceof Error ? error.message : String(error)
        ));
        if (sizeLimit) break;
        continue;
      }
      if (fetched.bytes.byteLength > requestBudget) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-limit",
          fetched.finalUrl,
          "Stylesheet loader exceeded its explicit transport budget."
        ));
        break;
      }
      try {
        assertPageInitiatedNavigation(document.finalUrl, fetched.finalUrl);
      } catch (error) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-fetch",
          fetched.finalUrl,
          error instanceof Error ? error.message : String(error)
        ));
        continue;
      }
      const mediaType = fetched.contentType?.toLowerCase().split(";", 1)[0]?.trim();
      if (mediaType !== undefined && mediaType !== "text/css") {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-fetch",
          fetched.finalUrl,
          `Blocked non-CSS content type: ${String(fetched.contentType)}`
        ));
        continue;
      }
      totalBytes += fetched.bytes.byteLength;
      resources.push(Object.freeze({
        owner: link.owner,
        requestUrl: fetched.requestUrl,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        bytes: fetched.bytes,
        media: link.media,
        transportEncodingLabel: fetched.transportEncodingLabel ?? null
      }));
    }
    return {
      resources: Object.freeze(resources),
      diagnostics: Object.freeze(diagnostics)
    };
  }

  async #parseFetchedPayload(
    parseMode: ParseMode,
    fetchedPage: FetchPagePayload,
    signal: AbortSignal
  ): Promise<IndexedWebDocumentSnapshot> {
    const context = { requestUrl: fetchedPage.requestUrl, finalUrl: fetchedPage.finalUrl };
    if ("html" in fetchedPage) {
      return parseWebDocument(fetchedPage.html, context, { ...this.#parseOptions, signal });
    }
    if (parseMode === "text") throw new Error("Text parse mode requires an HTML payload");
    return parseWebDocumentStream(fetchedPage.stream, context, {
      ...this.#parseOptions,
      signal,
      ...(fetchedPage.transportEncodingLabel === undefined
        ? {}
        : { transportEncodingLabel: fetchedPage.transportEncodingLabel })
    });
  }

  #commitHistory(
    snapshot: IndexedPageSnapshot,
    mode: "push" | "replace",
    parseMode: ParseMode,
    navigationAccess: NavigationAccess
  ): void {
    const entry = { snapshot, parseMode, navigationAccess };
    if (mode === "replace") {
      if (this.#historyIndex < 0) {
        this.#history.push(entry);
        this.#historyIndex = 0;
      } else this.#history[this.#historyIndex] = entry;
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
    const navigation = this.#navigationOptions(requestOptions);
    try {
      const options = navigation.options;
      const signal = options.signal;
      if (signal === undefined) throw new Error("Internal navigation signal is missing.");
      const startedAtMs = Date.now();
      signal.throwIfAborted();
      const fetchStartedAtMs = Date.now();
      const fetchedPage = navigationAccess === "page-initiated"
        ? parseMode === "stream"
          ? await this.#pageInitiatedStreamLoader(requestUrl, options)
          : await this.#pageInitiatedLoader(requestUrl, options)
        : parseMode === "stream"
          ? await this.#streamLoader(requestUrl, options)
          : await this.#loader(requestUrl, options);
      if (navigationAccess === "page-initiated") {
        const sourceUrl = navigationSource(options);
        if (sourceUrl === undefined) throw new Error("Page-initiated navigation source is missing.");
        assertPageInitiatedNavigation(sourceUrl, fetchedPage.finalUrl);
      }
      const fetchDurationMs = Date.now() - fetchStartedAtMs;
      const parseStartedAtMs = Date.now();
      let document: IndexedWebDocumentSnapshot;
      try {
        signal.throwIfAborted();
        document = await this.#parseFetchedPayload(parseMode, fetchedPage, signal);
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
      signal.throwIfAborted();
      const stylesheetStartedAtMs = Date.now();
      const stylesheets = await this.#loadStylesheets(document, options);
      const stylesheetDurationMs = Date.now() - stylesheetStartedAtMs;
      signal.throwIfAborted();
      this.#finishNavigation(navigation.sequence);
      const snapshot: IndexedPageSnapshot = Object.freeze({
        requestUrl: fetchedPage.requestUrl,
        finalUrl: fetchedPage.finalUrl,
        status: fetchedPage.status,
        statusText: fetchedPage.statusText,
        contentType: fetchedPage.contentType,
        responseFields: fetchedPage.responseFields,
        fetchedAtIso: fetchedPage.fetchedAtIso,
        document,
        stylesheets: stylesheets.resources,
        styleDiagnostics: stylesheets.diagnostics,
        diagnostics: diagnosticsFromDocument(
          document,
          stylesheets.diagnostics,
          document.stylesheets.filter((entry) => entry.kind === "embedded").length + stylesheets.resources.length,
          parseMode,
          options.method ?? "GET",
          {
            fetchDurationMs,
            parseDurationMs,
            documentDurationMs: parseDurationMs,
            stylesheetDurationMs,
            totalDurationMs: Date.now() - startedAtMs
          },
          fetchedPage.networkOutcome
        )
      });
      this.#current = snapshot;
      this.#commitHistory(snapshot, mode, parseMode, navigationAccess);
      return snapshot;
    } catch (error) {
      this.#failNavigation(navigation.sequence);
      throw error;
    }
  }
}

/** @internal Applies the browser workspace's page-initiated network capability. */
export function openPageInitiatedNavigation(
  session: BrowserSession,
  sourceUrl: string,
  requestUrl: string,
  requestOptions: PageRequestOptions = {},
  parseMode?: ParseMode
): Promise<PageSnapshot> {
  return session[PAGE_INITIATED_NAVIGATION](sourceUrl, requestUrl, requestOptions, parseMode);
}
