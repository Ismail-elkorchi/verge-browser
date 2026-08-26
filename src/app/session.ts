import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import {
  parseWebDocument,
  parseWebDocumentStream,
  type DocumentNodeRef,
  type WebDocumentParseOptions,
  type IndexedWebDocumentSnapshot
} from "../document/index.js";
import {
  inspectStylesheetBytes,
  inspectStylesheetText,
  type StyleDiagnostic,
  type StylesheetDependencyInspection,
  type StylesheetResource
} from "../presentation/style/index.js";
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
    readonly maxRedirects?: number;
  }
) => Promise<FetchStylesheetResult>;

export interface StylesheetPolicyOptions {
  readonly maxStylesheets?: number;
  readonly maxStylesheetBytes?: number;
  readonly maxTotalStylesheetBytes?: number;
  readonly maxImportDepth?: number;
  readonly maxImportedSources?: number;
  readonly maxAggregateImportedBytes?: number;
  readonly maxStylesheetRedirects?: number;
  readonly maxParsedRules?: number;
  readonly maxDependencyEdges?: number;
}

const DEFAULT_STYLESHEET_POLICY: Required<StylesheetPolicyOptions> = Object.freeze({
  maxStylesheets: 32,
  maxStylesheetBytes: 512 * 1024,
  maxTotalStylesheetBytes: 2 * 1024 * 1024,
  maxImportDepth: 16,
  maxImportedSources: 64,
  maxAggregateImportedBytes: 2 * 1024 * 1024,
  maxStylesheetRedirects: 5,
  maxParsedRules: 100_000,
  maxDependencyEdges: 256
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
      ),
      maxImportDepth: stylesheetLimit(options.stylesheetPolicy?.maxImportDepth, DEFAULT_STYLESHEET_POLICY.maxImportDepth, "maxImportDepth"),
      maxImportedSources: stylesheetLimit(options.stylesheetPolicy?.maxImportedSources, DEFAULT_STYLESHEET_POLICY.maxImportedSources, "maxImportedSources"),
      maxAggregateImportedBytes: stylesheetLimit(options.stylesheetPolicy?.maxAggregateImportedBytes, DEFAULT_STYLESHEET_POLICY.maxAggregateImportedBytes, "maxAggregateImportedBytes"),
      maxStylesheetRedirects: stylesheetLimit(options.stylesheetPolicy?.maxStylesheetRedirects, DEFAULT_STYLESHEET_POLICY.maxStylesheetRedirects, "maxStylesheetRedirects"),
      maxParsedRules: stylesheetLimit(options.stylesheetPolicy?.maxParsedRules, DEFAULT_STYLESHEET_POLICY.maxParsedRules, "maxParsedRules"),
      maxDependencyEdges: stylesheetLimit(options.stylesheetPolicy?.maxDependencyEdges, DEFAULT_STYLESHEET_POLICY.maxDependencyEdges, "maxDependencyEdges")
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
    const externalRoots = document.stylesheets.filter((entry) => entry.kind === "external");
    if (externalRoots.length > this.#stylesheetPolicy.maxStylesheets) {
      diagnostics.push(stylesheetDiagnostic(
        "stylesheet-limit",
        document.finalUrl,
        `Only the first ${String(this.#stylesheetPolicy.maxStylesheets)} external stylesheets were considered.`
      ));
    }
    let totalBytes = 0;
    let importedBytes = 0;
    let importedSources = 0;
    let dependencyEdges = 0;
    let parsedRules = 0;
    let dependencyOrder = 0;
    const allowedExternalOwners = new Set(
      externalRoots.slice(0, this.#stylesheetPolicy.maxStylesheets).map((entry) => entry.owner)
    );
    const fetchResource = async (target: URL, requestBudget: number): Promise<FetchStylesheetResult | null> => {
      let fetched: FetchStylesheetResult;
      try {
        assertPageInitiatedNavigation(document.finalUrl, target.toString());
        if (!["http:", "https:", "file:"].includes(target.protocol)) {
          throw new Error(`Unsupported stylesheet protocol: ${target.protocol}`);
        }
        const stylesheetOptions = {
          ...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
          ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          maxContentBytes: requestBudget,
          maxRedirects: this.#stylesheetPolicy.maxStylesheetRedirects
        };
        fetched = this.#stylesheetLoader === null
          ? await fetchDocumentStylesheet(
            this.#requiredNetworkClient(),
            target.toString(),
            document.finalUrl,
            undefined,
            { maxContentBytes: requestBudget, maxRedirects: this.#stylesheetPolicy.maxStylesheetRedirects },
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
        return null;
      }
      if (fetched.bytes.byteLength > requestBudget) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-limit",
          fetched.finalUrl,
          "Stylesheet loader exceeded its explicit transport budget."
        ));
        return null;
      }
      try {
        assertPageInitiatedNavigation(document.finalUrl, fetched.finalUrl);
      } catch (error) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-fetch",
          fetched.finalUrl,
          error instanceof Error ? error.message : String(error)
        ));
        return null;
      }
      const mediaType = fetched.contentType?.toLowerCase().split(";", 1)[0]?.trim();
      if (mediaType !== undefined && mediaType !== "text/css") {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-fetch",
          fetched.finalUrl,
          `Blocked non-CSS content type: ${String(fetched.contentType)}`
        ));
        return null;
      }
      return fetched;
    };
    const inspect = (
      inspection: StylesheetDependencyInspection,
      sourceUrl: string
    ): inspection is Extract<StylesheetDependencyInspection, { readonly status: "complete" }> => {
      if (inspection.status !== "complete") {
        diagnostics.push(stylesheetDiagnostic("stylesheet-parse", sourceUrl, "Stylesheet dependency syntax could not be inspected."));
        return false;
      }
      if (parsedRules + inspection.parsedRules > this.#stylesheetPolicy.maxParsedRules) {
        diagnostics.push(stylesheetDiagnostic(
          "stylesheet-limit", sourceUrl,
          `Stylesheet rule budget reached ${String(this.#stylesheetPolicy.maxParsedRules)}.`
        ));
        return false;
      }
      parsedRules += inspection.parsedRules;
      return true;
    };
    const loadImported = async (
      owner: DocumentNodeRef,
      rootOrder: number,
      baseUrl: string,
      inspection: Extract<StylesheetDependencyInspection, { readonly status: "complete" }>,
      depth: number,
      parentUrl: string,
      inheritedLayer: string | null,
      mediaConditions: readonly string[],
      supportsConditions: readonly string[],
      inheritedPredeclaredLayers: readonly string[],
      active: ReadonlySet<string>
    ): Promise<void> => {
      for (const dependency of inspection.imports) {
        requestOptions.signal?.throwIfAborted();
        dependencyEdges += 1;
        if (dependencyEdges > this.#stylesheetPolicy.maxDependencyEdges) {
          diagnostics.push(stylesheetDiagnostic(
            "stylesheet-limit", parentUrl,
            `Stylesheet dependency-edge budget reached ${String(this.#stylesheetPolicy.maxDependencyEdges)}.`
          ));
          return;
        }
        if (depth > this.#stylesheetPolicy.maxImportDepth) {
          diagnostics.push(stylesheetDiagnostic(
            "stylesheet-limit", parentUrl,
            `Stylesheet import depth reached ${String(this.#stylesheetPolicy.maxImportDepth)}.`
          ));
          continue;
        }
        if (importedSources >= this.#stylesheetPolicy.maxImportedSources) {
          diagnostics.push(stylesheetDiagnostic(
            "stylesheet-limit", parentUrl,
            `Imported stylesheet source budget reached ${String(this.#stylesheetPolicy.maxImportedSources)}.`
          ));
          return;
        }
        let target: URL;
        try {
          target = new URL(dependency.request, baseUrl);
          assertPageInitiatedNavigation(document.finalUrl, target.toString());
        } catch (error) {
          diagnostics.push(stylesheetDiagnostic(
            "stylesheet-import", parentUrl,
            error instanceof Error ? error.message : String(error)
          ));
          continue;
        }
        if (active.has(target.toString())) {
          diagnostics.push(stylesheetDiagnostic("stylesheet-cycle", target.toString(), "Stylesheet import cycle was ignored."));
          continue;
        }
        const remainingTotal = this.#stylesheetPolicy.maxTotalStylesheetBytes - totalBytes;
        const remainingImports = this.#stylesheetPolicy.maxAggregateImportedBytes - importedBytes;
        const requestBudget = Math.min(this.#stylesheetPolicy.maxStylesheetBytes, remainingTotal, remainingImports);
        if (requestBudget <= 0) {
          diagnostics.push(stylesheetDiagnostic("stylesheet-limit", target.toString(), "Aggregate imported stylesheet byte budget was exhausted."));
          return;
        }
        const fetched = await fetchResource(target, requestBudget);
        if (fetched === null) continue;
        const finalIdentity = fetched.finalUrl;
        if (active.has(finalIdentity)) {
          diagnostics.push(stylesheetDiagnostic("stylesheet-cycle", finalIdentity, "Stylesheet redirect formed an import cycle."));
          continue;
        }
        importedSources += 1;
        importedBytes += fetched.bytes.byteLength;
        totalBytes += fetched.bytes.byteLength;
        const layer = dependency.layer === null ? inheritedLayer
          : dependency.layer.length === 0
            ? `${inheritedLayer === null ? "" : `${inheritedLayer}.`}__anonymous_${String(rootOrder)}_${String(dependencyEdges)}`
            : inheritedLayer === null ? dependency.layer : `${inheritedLayer}.${dependency.layer}`;
        const predeclaredLayers = Object.freeze([...new Set([
          ...inheritedPredeclaredLayers,
          ...dependency.precedingLayers.map((name) =>
            inheritedLayer === null ? name : `${inheritedLayer}.${name}`),
          ...(layer === null ? [] : [layer])
        ])]);
        const nestedMedia = dependency.media === null
          ? mediaConditions : Object.freeze([...mediaConditions, dependency.media]);
        const nestedSupports = dependency.supports === null
          ? supportsConditions : Object.freeze([...supportsConditions, dependency.supports]);
        const importedInspection = inspectStylesheetBytes(
          fetched.bytes,
          fetched.transportEncodingLabel ?? null,
          requestOptions.signal
        );
        const nextActive = new Set(active);
        nextActive.add(finalIdentity);
        if (inspect(importedInspection, finalIdentity)) {
          await loadImported(
            owner, rootOrder, finalIdentity, importedInspection, depth + 1, finalIdentity,
            layer, nestedMedia, nestedSupports, predeclaredLayers, nextActive
          );
        }
        resources.push(Object.freeze({
          owner,
          requestUrl: fetched.requestUrl,
          finalUrl: fetched.finalUrl,
          contentType: fetched.contentType,
          bytes: fetched.bytes,
          media: dependency.media,
          transportEncodingLabel: fetched.transportEncodingLabel ?? null,
          rootOrder,
          dependencyOrder: dependencyOrder++,
          importDepth: depth,
          importedFrom: parentUrl,
          importLayer: layer,
          mediaConditions: Object.freeze(nestedMedia),
          supportsConditions: Object.freeze(nestedSupports),
          predeclaredLayers
        }));
      }
    };
    for (const reference of document.stylesheets) {
      requestOptions.signal?.throwIfAborted();
      const rootMedia = reference.media === null ? Object.freeze([]) : Object.freeze([reference.media]);
      if (reference.kind === "embedded") {
        const inspection = inspectStylesheetText(reference.cssText, requestOptions.signal);
        if (inspect(inspection, document.finalUrl)) {
          await loadImported(
            reference.owner, reference.order, document.finalUrl, inspection, 1,
            `${document.finalUrl}#style-${String(reference.order)}`, null, rootMedia,
            Object.freeze([]),
            Object.freeze([]),
            new Set([document.finalUrl])
          );
        }
        continue;
      }
      if (!allowedExternalOwners.has(reference.owner)) continue;
      let target: URL;
      try {
        target = new URL(reference.destination);
      } catch (error) {
        diagnostics.push(stylesheetDiagnostic("stylesheet-fetch", reference.destination, error instanceof Error ? error.message : String(error)));
        continue;
      }
      const remainingBytes = this.#stylesheetPolicy.maxTotalStylesheetBytes - totalBytes;
      if (remainingBytes <= 0) {
        diagnostics.push(stylesheetDiagnostic("stylesheet-limit", target.toString(), "Aggregate stylesheet transport budget was exhausted."));
        break;
      }
      const fetched = await fetchResource(target, Math.min(this.#stylesheetPolicy.maxStylesheetBytes, remainingBytes));
      if (fetched === null) continue;
      totalBytes += fetched.bytes.byteLength;
      const inspection = inspectStylesheetBytes(fetched.bytes, fetched.transportEncodingLabel ?? null, requestOptions.signal);
      if (inspect(inspection, fetched.finalUrl)) {
        await loadImported(
          reference.owner, reference.order, fetched.finalUrl, inspection, 1, fetched.finalUrl,
          null, rootMedia, Object.freeze([]), Object.freeze([]), new Set([fetched.finalUrl])
        );
      }
      resources.push(Object.freeze({
        owner: reference.owner,
        requestUrl: fetched.requestUrl,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        bytes: fetched.bytes,
        media: reference.media,
        transportEncodingLabel: fetched.transportEncodingLabel ?? null,
        rootOrder: reference.order,
        dependencyOrder: dependencyOrder++,
        importDepth: 0,
        importedFrom: null,
        importLayer: null,
        mediaConditions: rootMedia,
        supportsConditions: Object.freeze([]),
        predeclaredLayers: Object.freeze([])
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
