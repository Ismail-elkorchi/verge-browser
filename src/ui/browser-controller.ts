import { dirname } from "node:path";

import {
  NetworkSafetyPolicy,
  type HttpSessionAdapter
} from "@ismail-elkorchi/http-client";

import {
  buildFormSubmissionRequest
} from "../app/forms.js";
import { assertPageInitiatedNavigation } from "../app/security.js";
import {
  openPageInitiatedNavigation,
  type BrowserSession
} from "../app/session.js";
import {
  type BrowserWorkspace,
  type DownloadRecord,
  type StoredBrowserDocument,
  type StoredSidePanel,
  type BrowserStore
} from "../app/storage.js";
import {
  indexedPageSnapshot,
  type PageRequestOptions,
  type IndexedPageSnapshot
} from "../app/types.js";
import {
  createDocumentState,
  type DocumentForm,
  type DocumentNodeRef,
  type DocumentState
} from "../document/index.js";
import { buildReaderDocument, readerDocumentLines } from "../reader/index.js";
import {
  DEFAULT_SEARCH_URL_TEMPLATE,
  resolveInputUrl,
  resolveOmniboxInput
} from "../app/url.js";
import type { BrowserServices } from "./services.js";
import { RenderWorkerClient, type ViewportRenderPayload, type ViewportRequestParameters } from "./render-worker/index.js";
import type {
  BrowserDocumentState,
  BrowserPlaceholderTabState,
  BrowserTuiState,
  DetailKind,
  PickerKind,
  PickerValue
} from "./model.js";

const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const EXTERNAL_NETWORK_POLICY = Object.freeze({
  enabled: true,
  allowPrivateNetworks: false,
  allowLocalhost: false,
  mixedAddressPolicy: "reject-host" as const,
  dnsTimeoutMs: 5_000,
  dnsCacheTtlMs: 60_000,
  maxDnsCacheEntries: 1_024,
  addressAttemptDelayMs: 250
});

function excerpt(lines: readonly string[]): string {
  return lines
    .slice(0, 8)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 220)
    .trim();
}

function readerLines(snapshot: IndexedPageSnapshot): readonly string[] {
  return readerDocumentLines(buildReaderDocument(snapshot.document));
}

function diagnosticsLines(snapshot: IndexedPageSnapshot): readonly string[] {
  return [
    `URL: ${snapshot.finalUrl}`,
    `Status: ${String(snapshot.status)} ${snapshot.statusText}`,
    `Content type: ${snapshot.contentType ?? "unknown"}`,
    `Parse mode: ${snapshot.diagnostics.parseMode}`,
    `Request method: ${snapshot.diagnostics.requestMethod}`,
    `Network outcome: ${snapshot.diagnostics.networkOutcome.kind}`,
    `Network detail: ${snapshot.diagnostics.networkOutcome.detailMessage}`,
    `Source bytes: ${String(snapshot.diagnostics.sourceBytes)}`,
    `Parse errors: ${String(snapshot.diagnostics.parseErrorCount)}`,
    `Stylesheets: ${String(snapshot.diagnostics.stylesheetCount)}`,
    `Stylesheet load issues: ${String(snapshot.diagnostics.stylesheetLoadIssueCount)}`,
    `Total ms: ${String(snapshot.diagnostics.totalDurationMs)}`,
    ...snapshot.styleDiagnostics.slice(0, 12).map((issue) =>
      `CSS ${issue.code}${issue.occurrences > 1 ? ` ×${String(issue.occurrences)}` : ""}: ${issue.detail} (${issue.sourceUrl})`
    )
  ];
}

function storedScrollAnchor(document: BrowserDocumentState): StoredBrowserDocument["scrollAnchor"] {
  let source = document.scrollAnchor.source;
  let sourceTarget: Exclude<StoredBrowserDocument["scrollAnchor"]["target"], null> | null = null;
  while (source !== null) {
    const node = document.snapshot.document.node(source);
    if (node.kind === "element") {
      const id = document.snapshot.document.attribute(node.ref, "id");
      if (id !== null && id.length > 0) {
        return { target: { kind: "element-id", value: id }, rowOffset: document.scrollAnchor.rowOffset };
      }
    }
    if (sourceTarget === null && (node.kind === "element" || node.kind === "text") && node.sourceRange !== null) {
      sourceTarget = { kind: "source", offset: node.sourceRange.start, nodeKind: node.kind };
    }
    source = node.parent;
  }
  return { target: sourceTarget, rowOffset: document.scrollAnchor.rowOffset };
}

function restoredScrollAnchor(
  snapshot: IndexedPageSnapshot,
  stored: StoredBrowserDocument["scrollAnchor"] | undefined
): BrowserDocumentState["scrollAnchor"] | undefined {
  if (stored === undefined || stored.target === null) return undefined;
  if (stored.target.kind === "element-id") {
    const source = snapshot.document.elementById(stored.target.value);
    return source === null ? undefined : { source, rowOffset: stored.rowOffset };
  }
  const pending = [snapshot.document.root];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined) continue;
    const node = snapshot.document.node(ref);
    if (node.kind === stored.target.nodeKind && node.sourceRange?.start === stored.target.offset) {
      return { source: node.ref, rowOffset: stored.rowOffset };
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return undefined;
}

async function settleBrowserCleanup(
  operations: readonly (() => Promise<void>)[],
  message: string
): Promise<void> {
  const outcomes = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation))
  );
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") errors.push(outcome.reason as unknown);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

export interface BrowserControllerOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
}

export interface BrowserPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: PickerValue;
}

export class BrowserController {
  readonly #store: BrowserStore;
  readonly #services: BrowserServices;
  readonly #createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly #searchUrlTemplate: string;
  readonly #downloadDirectory: string;
  readonly #downloadMaxBytes: number;
  readonly #externalNetworkPolicy = new NetworkSafetyPolicy(EXTERNAL_NETWORK_POLICY);
  #renderer = new RenderWorkerClient();
  readonly #renderAttachments = new Map<string, {
    readonly documentRevision: number;
    readonly stateRevision: number;
    readonly state: DocumentState;
  }>();
  readonly #renderPreparations = new Map<string, Promise<void>>();
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #provisionalSessionIds = new Set<string>();
  #nextDocumentNumber = 1;
  #workspaceSaveRevision = 0;

  public constructor(options: BrowserControllerOptions) {
    this.#store = options.store;
    this.#services = options.services;
    this.#createSession = options.createSession;
    this.#searchUrlTemplate = options.searchUrlTemplate ?? DEFAULT_SEARCH_URL_TEMPLATE;
    this.#downloadDirectory = options.downloadDirectory ?? "Downloads";
    this.#downloadMaxBytes = options.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  }

  public library() {
    return {
      history: this.#store.listHistory(),
      bookmarks: this.#store.listBookmarks(),
      downloads: this.#store.listDownloads()
    };
  }

  public workspace(): BrowserWorkspace | null {
    return this.#store.workspace();
  }

  public async saveWorkspace(state: BrowserTuiState): Promise<void> {
    const revision = ++this.#workspaceSaveRevision;
    for (const document of [...state.documents, ...state.recentlyClosed]) {
      this.#provisionalSessionIds.delete(document.id);
    }
    await this.#releaseDiscardedSessions(state);
    const workspace: BrowserWorkspace = {
      documents: state.documents.map((document) => ({
        url: document.kind === "ready" ? document.snapshot.finalUrl : document.requestedUrl,
        scrollAnchor: document.kind === "ready"
          ? storedScrollAnchor(document)
          : document.storedScrollAnchor ?? { target: null, rowOffset: 0 },
      })),
      activeDocumentIndex: state.activeDocumentIndex,
      sidePanel: state.sidePanel satisfies StoredSidePanel
    };
    if (revision !== this.#workspaceSaveRevision) return;
    await this.#store.saveWorkspace(workspace);
  }

  public async close(): Promise<void> {
    this.#externalNetworkPolicy.close(new Error("Browser controller closed."));
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#renderPreparations.clear();
    this.#provisionalSessionIds.clear();
    const errors: unknown[] = [];
    try {
      await settleBrowserCleanup([
        ...sessions.map((session) => () => session.close()),
        () => this.#renderer.close(),
        () => this.#services.close()
      ], "Failed to close every browser session and host service.");
    } catch (error) {
      if (error instanceof AggregateError) {
        for (const nested of error.errors as unknown[]) errors.push(nested);
      } else {
        errors.push(error);
      }
    }
    try {
      await this.#store.flush();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to close every browser resource.");
    }
  }

  public async openInitial(
    target: string,
    scrollAnchor?: StoredBrowserDocument["scrollAnchor"]
  ): Promise<BrowserDocumentState> {
    return this.#openNewDocument(target, undefined, scrollAnchor, true);
  }

  /** Reserves a stable tab identity without allocating a session or loading a page. */
  public placeholder(
    target: string,
    scrollAnchor?: StoredBrowserDocument["scrollAnchor"],
  ): BrowserPlaceholderTabState {
    const resolved = resolveInputUrl(target);
    let label = resolved;
    try {
      const url = new URL(resolved);
      label = url.protocol === "about:" ? url.pathname : url.hostname || resolved;
    } catch {
      // resolveInputUrl owns URL validation; the display label remains the resolved target.
    }
    return Object.freeze({
      kind: "restoring",
      id: this.#newDocumentId(),
      requestedUrl: resolved,
      label,
      ...(scrollAnchor === undefined ? {} : { storedScrollAnchor: scrollAnchor }),
      restoreRevision: 1,
      retryCount: 0,
      error: null,
    });
  }

  /** Starts loading a placeholder. Session ownership begins at this boundary. */
  public restorePlaceholder(
    tab: BrowserPlaceholderTabState,
    signal?: AbortSignal,
  ): Promise<BrowserDocumentState> {
    return this.#openDocument(
      tab.id,
      tab.requestedUrl,
      signal,
      tab.storedScrollAnchor,
      false,
    );
  }

  /** Attaches a document revision once and requests only a viewport result thereafter. */
  public async renderViewport(
    document: BrowserDocumentState,
    viewportRevision: number,
    parameters: ViewportRequestParameters,
  ): Promise<ViewportRenderPayload> {
    await this.#prepareRendering(document);
    return this.#renderer.renderViewport(document, viewportRevision, parameters);
  }

  public cancelViewport(documentId: string): void { this.#renderer.cancelViewport(documentId); }

  /** Internal interaction metrics used by deterministic browser qualification. */
  public renderingMetrics(): ReturnType<RenderWorkerClient["metrics"]> {
    return this.#renderer.metrics();
  }

  public async searchDocument(
    document: BrowserDocumentState,
    query: string,
    parameters: ViewportRequestParameters,
  ): ReturnType<RenderWorkerClient["search"]> {
    await this.#prepareRendering(document);
    return this.#renderer.search(document, query, parameters);
  }

  async #prepareRendering(document: BrowserDocumentState): Promise<void> {
    const key = `${document.id}:${String(document.documentRevision)}:${String(document.stateRevision)}`;
    const pending = this.#renderPreparations.get(key);
    if (pending !== undefined) return pending;
    const operation = this.#prepareRenderingNow(document).finally(() => {
      if (this.#renderPreparations.get(key) === operation) this.#renderPreparations.delete(key);
    });
    this.#renderPreparations.set(key, operation);
    return operation;
  }

  async #prepareRenderingNow(document: BrowserDocumentState): Promise<void> {
    if (this.#renderer.failed) {
      await this.#renderer.close();
      this.#renderer = new RenderWorkerClient();
      this.#renderAttachments.clear();
    }
    const attached = this.#renderAttachments.get(document.id);
    if (attached === undefined || attached.documentRevision !== document.documentRevision) {
      await this.#renderer.attach(document);
    } else if (attached.stateRevision !== document.stateRevision) {
      const changed: string[] = [];
      if (attached.state.focus !== document.documentState.focus) changed.push("focus");
      if (attached.state.hover !== document.documentState.hover) changed.push("hover");
      if (attached.state.active !== document.documentState.active) changed.push("active");
      if (attached.state.urlTarget !== document.documentState.urlTarget) changed.push("target");
      if (attached.state.open !== document.documentState.open) changed.push("disclosure-open");
      if (attached.state.controls !== document.documentState.controls) {
        changed.push("control-content", "checked-selected");
      }
      await this.#renderer.updateState(document, changed);
    } else {
      return;
    }
    this.#renderAttachments.set(document.id, {
      documentRevision: document.documentRevision,
      stateRevision: document.stateRevision,
      state: document.documentState,
    });
  }

  public async releaseRendering(documentId: string): Promise<void> {
    this.#renderAttachments.delete(documentId);
    await this.#renderer.release(documentId);
  }

  public resolveOmnibox(value: string, currentUrl: string): string {
    return resolveOmniboxInput(value, currentUrl, this.#searchUrlTemplate);
  }

  public omniboxSuggestions(
    value: string,
    document: BrowserDocumentState,
    limit = 8
  ): readonly {
    readonly id: string;
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[] {
    const query = value.trim().toLowerCase();
    const suggestions: {
      readonly id: string;
      readonly value: string;
      readonly label: string;
      readonly description?: string;
    }[] = [];
    if (limit <= 0) return suggestions;
    const seen = new Set<string>();
    const add = (entry: {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
    }): boolean => {
      if (seen.has(entry.value)) return false;
      if (
        query.length > 0
        && !entry.value.toLowerCase().includes(query)
        && !entry.label.toLowerCase().includes(query)
      ) return false;
      seen.add(entry.value);
      suggestions.push({ ...entry, id: entry.value });
      return suggestions.length >= limit;
    };
    const addUntilFull = <T>(
      entries: readonly T[],
      project: (entry: T) => { readonly value: string; readonly label: string; readonly description?: string }
    ): boolean => {
      for (const entry of entries) {
        if (add(project(entry))) return true;
      }
      return false;
    };

    if (addUntilFull(document.snapshot.document.links, (link) => ({
      value: link.destination,
      label: link.label,
      description: "Current page"
    }))) return suggestions;
    if (addUntilFull(this.#store.listBookmarks(), (entry) => ({
      value: entry.url,
      label: entry.name,
      description: "Bookmark"
    }))) return suggestions;
    if (addUntilFull(this.#store.listHistory(), (entry) => ({
      value: entry.url,
      label: entry.title,
      description: "History"
    }))) return suggestions;
    addUntilFull(this.#store.searchIndex(value, limit), (entry) => ({
      value: entry.url,
      label: entry.title,
      description: "Page text"
    }));
    return suggestions;
  }

  public navigationAvailability(document: BrowserDocumentState): {
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
  } {
    const session = this.#session(document.id);
    return { canGoBack: session.canBack(), canGoForward: session.canForward() };
  }

  public restoreDocument(document: BrowserDocumentState): BrowserDocumentState {
    const session = this.#session(document.id);
    const snapshot = session.current === null ? document.snapshot : indexedPageSnapshot(session.current);
    const snapshotChanged = snapshot !== document.snapshot;
    const scrollAnchor = snapshotChanged
      ? { source: snapshot.document.body ?? snapshot.document.documentElement, rowOffset: 0 }
      : document.scrollAnchor;
    return {
      ...document,
      ...(snapshotChanged
        ? {
            documentRevision: document.documentRevision + 1,
            stateRevision: document.stateRevision + 1,
            rendering: {
              status: "idle" as const,
              requestedViewportRevision: 0,
              committedViewportRevision: 0,
              requestKey: null,
              pendingSearchQuery: null,
              pendingFocus: null,
              viewport: null,
              summary: null,
              error: null,
            },
          }
        : {}),
      snapshot,
      scrollAnchor,
      ...(snapshotChanged
        ? { search: null, documentState: createDocumentState(snapshot.document), formEditors: {} }
        : {}),
      loading: false,
      pendingUrl: null,
      canGoBack: session.canBack(),
      canGoForward: session.canForward(),
      error: null
    };
  }

  public async navigate(
    document: BrowserDocumentState,
    target: string,
    requestOptions: PageRequestOptions = {},
    parseMode?: "text" | "stream"
  ): Promise<IndexedPageSnapshot> {
    const resolvedTarget = resolveInputUrl(target, document.snapshot.finalUrl);
    return indexedPageSnapshot(await this.#session(document.id).openWithRequest(
      resolvedTarget,
      requestOptions,
      parseMode
    ));
  }

  public async openLink(
    document: BrowserDocumentState,
    linkIndex: number,
    signal?: AbortSignal
  ): Promise<IndexedPageSnapshot> {
    return indexedPageSnapshot(await this.#session(document.id).openLink(linkIndex, signal));
  }

  public async traverse(
    document: BrowserDocumentState,
    operation: "back" | "forward" | "reload",
    signal?: AbortSignal
  ): Promise<IndexedPageSnapshot> {
    const session = this.#session(document.id);
    return indexedPageSnapshot(operation === "back"
      ? await session.back(signal)
      : operation === "forward"
        ? await session.forward(signal)
        : await session.reload(signal));
  }

  public openNew(
    target = "about:newtab",
    signal?: AbortSignal
  ): Promise<BrowserDocumentState> {
    return this.#openNewDocument(target, signal);
  }

  public openNewFromDocument(
    document: BrowserDocumentState,
    target: string,
    signal?: AbortSignal
  ): Promise<BrowserDocumentState> {
    assertPageInitiatedNavigation(document.snapshot.finalUrl, target);
    return this.#openNewDocument(target, signal, undefined, false, document.snapshot.finalUrl);
  }

  public async submitForm(
    document: BrowserDocumentState,
    form: DocumentForm,
    state: DocumentState,
    submitter: DocumentNodeRef | undefined,
    signal?: AbortSignal
  ): Promise<IndexedPageSnapshot> {
    const submission = buildFormSubmissionRequest(form, state, submitter);
    assertPageInitiatedNavigation(document.snapshot.finalUrl, submission.url);
    return indexedPageSnapshot(await openPageInitiatedNavigation(
      this.#session(document.id),
      document.snapshot.finalUrl,
      submission.url,
      {
        ...submission.requestOptions,
        ...(signal === undefined ? {} : { signal })
      }
    ));
  }

  public async persistSnapshot(snapshot: IndexedPageSnapshot): Promise<void> {
    await this.#persist(snapshot);
  }

  public pickerEntries(
    kind: PickerKind,
    documents: readonly BrowserDocumentState[],
    activeDocumentIndex: number,
    query = ""
  ): readonly BrowserPickerEntry[] {
    const active = documents[activeDocumentIndex];
    if (!active) return [];
    if (kind === "links") {
      return active.snapshot.document.links.map((link) => ({
        id: `link-${String(link.index)}`,
        label: link.label,
        description: link.destination,
        value: { kind: "link", index: link.index, target: link.destination }
      }));
    }
    if (kind === "outline") {
      return active.snapshot.document.outline.map((entry, index) => ({
          id: `outline-${String(index)}`,
          label: entry.text,
          description: `Heading level ${String(entry.level)}`,
          value: { kind: "outline", index, node: entry.node }
        }));
    }
    return this.#store.searchIndex(query, 20).map((entry, index) => ({
      id: `recall-${String(index)}`,
      label: entry.title,
      description: entry.url,
      value: { kind: "recall", index, target: entry.url }
    }));
  }

  public forms(document: BrowserDocumentState): readonly DocumentForm[] {
    return document.snapshot.document.forms;
  }

  public form(document: BrowserDocumentState, formId: string): DocumentForm | undefined {
    return this.forms(document).find((form) => form.node === formId);
  }

  public detail(kind: Exclude<DetailKind, "help">, document: BrowserDocumentState): readonly string[] {
    if (kind === "diagnostics") return diagnosticsLines(document.snapshot);
    if (kind === "reader") return readerLines(document.snapshot);
    const cookies = this.#store.listCookies();
    return cookies.length === 0
      ? ["No cookies stored."]
      : cookies.flatMap((cookie) => [
        `${cookie.name}=${cookie.value}`,
        `  scope: ${cookie.domain}${cookie.path}`,
        `  expires: ${cookie.expiresAt ?? "session"}`
      ]);
  }

  public async toggleBookmark(document: BrowserDocumentState, name?: string): Promise<string> {
    const added = await this.#store.toggleBookmark(
      document.snapshot.finalUrl,
      name ?? document.snapshot.document.title
    );
    return added ? "Bookmark added." : "Bookmark removed.";
  }

  public async clearCookies(): Promise<string> {
    await this.#store.clearCookies();
    return "Cookie store cleared.";
  }

  public async saveText(path: string, text: string): Promise<string> {
    await this.#services.writeTextFile(path, `${text}\n`);
    return `Saved text export to ${path}.`;
  }

  public async savePage(document: BrowserDocumentState, path: string): Promise<string> {
    const source = document.snapshot.document.sourceText;
    if (source === null) throw new Error("No HTML source is available for this page.");
    await this.#services.writeTextFile(path, source);
    return `Saved page source to ${path}.`;
  }

  public async download(
    url: string,
    id: string,
    sourceUrl: string,
    signal?: AbortSignal
  ): Promise<DownloadRecord> {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Downloads require an HTTP or HTTPS URL, not ${parsedUrl.protocol}`);
    }
    const startedAtIso = new Date().toISOString();
    const initial: DownloadRecord = {
      id,
      url,
      fileName: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "download",
      destinationPath: null,
      status: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      startedAtIso,
      updatedAtIso: startedAtIso
    };
    await this.#store.upsertDownload(initial);
    try {
      const downloaded = await this.#services.downloadFile({
        url,
        sourceUrl,
        directory: this.#downloadDirectory,
        maxBytes: this.#downloadMaxBytes,
        session: this.#store.httpSession,
        ...(signal === undefined ? {} : { signal })
      });
      const completed: DownloadRecord = {
        ...initial,
        fileName: downloaded.fileName,
        destinationPath: downloaded.path,
        status: "completed",
        receivedBytes: downloaded.receivedBytes,
        totalBytes: downloaded.totalBytes,
        updatedAtIso: new Date().toISOString()
      };
      await this.#store.upsertDownload(completed);
      return completed;
    } catch (error) {
      const failed: DownloadRecord = {
        ...initial,
        status: signal?.aborted === true ? "interrupted" : "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAtIso: new Date().toISOString()
      };
      await this.#store.upsertDownload(failed);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { download: failed });
    }
  }

  public async removeDownload(id: string): Promise<string> {
    await this.#store.removeDownload(id);
    return "Download removed from the list.";
  }

  public async openDownload(id: string, location: "file" | "directory"): Promise<string> {
    const download = this.#store.listDownloads().find((entry) => entry.id === id);
    if (!download?.destinationPath) throw new Error("The download has no completed file.");
    await this.#services.openPath(location === "file" ? download.destinationPath : dirname(download.destinationPath));
    return location === "file" ? "Opened downloaded file." : "Opened download directory.";
  }

  public async openExternal(
    sourceUrl: string,
    target: string,
    access: "direct" | "page-initiated"
  ): Promise<string> {
    const parsedTarget = new URL(target);
    if (
      parsedTarget.protocol !== "http:"
      && parsedTarget.protocol !== "https:"
      && parsedTarget.protocol !== "file:"
    ) {
      throw new Error(`External opening does not support ${parsedTarget.protocol}`);
    }
    if (access === "page-initiated") {
      assertPageInitiatedNavigation(sourceUrl, parsedTarget.toString());
    }
    if (access === "page-initiated"
      && (parsedTarget.protocol === "http:" || parsedTarget.protocol === "https:")) {
      const decision = await this.#externalNetworkPolicy.decide(parsedTarget.toString());
      if (!decision.allowed) {
        throw new Error("Blocked a page-initiated private-network or unresolved external target.");
      }
    }
    await this.#services.openExternal(parsedTarget.toString());
    return `Opened ${parsedTarget.toString()} externally.`;
  }

  async #openNewDocument(
    target: string,
    signal?: AbortSignal,
    scrollAnchor?: StoredBrowserDocument["scrollAnchor"],
    persist = false,
    sourceUrl?: string
  ): Promise<BrowserDocumentState> {
    const id = this.#newDocumentId();
    return this.#openDocument(id, target, signal, scrollAnchor, persist, sourceUrl);
  }

  async #openDocument(
    id: string,
    target: string,
    signal?: AbortSignal,
    scrollAnchor?: StoredBrowserDocument["scrollAnchor"],
    persist = false,
    sourceUrl?: string,
  ): Promise<BrowserDocumentState> {
    const session = this.#createSession(this.#store.httpSession);
    this.#sessions.set(id, session);
    this.#provisionalSessionIds.add(id);
    try {
      const snapshot = await this.#open(session, target, signal, sourceUrl);
      if (persist) await this.#persist(snapshot);
      return this.#document(id, snapshot, scrollAnchor);
    } catch (error) {
      this.#sessions.delete(id);
      this.#provisionalSessionIds.delete(id);
      await session.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async #open(
    session: BrowserSession,
    target: string,
    signal?: AbortSignal,
    sourceUrl?: string
  ): Promise<IndexedPageSnapshot> {
    const resolvedTarget = resolveInputUrl(target);
    const snapshot = sourceUrl === undefined
      ? await session.open(resolvedTarget, signal)
      : await openPageInitiatedNavigation(
        session,
        sourceUrl,
        resolvedTarget,
        { ...(signal === undefined ? {} : { signal }) }
      );
    return indexedPageSnapshot(snapshot);
  }

  async #persist(snapshot: IndexedPageSnapshot): Promise<void> {
    if (snapshot.finalUrl.startsWith("about:")) return;
    const readerDocument = buildReaderDocument(snapshot.document);
    const lines = readerDocumentLines(readerDocument);
    await this.#store.recordPage(
      snapshot.finalUrl,
      snapshot.document.title,
      excerpt(lines),
      lines.join("\n")
    );
  }

  #session(documentId: string): BrowserSession {
    const session = this.#sessions.get(documentId);
    if (!session) throw new Error(`No browser session exists for ${documentId}.`);
    return session;
  }

  async #releaseDiscardedSessions(state: BrowserTuiState): Promise<void> {
    const retainedIds = new Set([
      ...state.documents.map((document) => document.id),
      ...state.recentlyClosed.map((document) => document.id)
    ]);
    const discarded = [...this.#sessions.entries()]
      .filter(([id]) => !retainedIds.has(id) && !this.#provisionalSessionIds.has(id));
    const discardedRendering = [...this.#renderAttachments.keys()]
      .filter((id) => !retainedIds.has(id));
    for (const [id] of discarded) {
      this.#sessions.delete(id);
    }
    for (const id of discardedRendering) this.#renderAttachments.delete(id);
    await settleBrowserCleanup(
      [
        ...discarded.map(([, session]) => () => session.close()),
        ...discardedRendering.map((id) => () => this.#renderer.release(id)),
      ],
      "Failed to close every discarded browser session."
    );
  }

  #newDocumentId(): string {
    const id = `document-${String(this.#nextDocumentNumber)}`;
    this.#nextDocumentNumber += 1;
    return id;
  }

  #document(
    id: string,
    snapshot: IndexedPageSnapshot,
    storedAnchor?: StoredBrowserDocument["scrollAnchor"]
  ): BrowserDocumentState {
    const firstAnchor = {
      source: snapshot.document.body ?? snapshot.document.documentElement,
      rowOffset: 0,
    };
    return {
      kind: "ready",
      id,
      documentRevision: 1,
      stateRevision: 1,
      snapshot,
      scrollAnchor: restoredScrollAnchor(snapshot, storedAnchor) ?? firstAnchor,
      documentState: createDocumentState(snapshot.document),
      rendering: {
        status: "idle",
        requestedViewportRevision: 0,
        committedViewportRevision: 0,
        requestKey: null,
        pendingSearchQuery: null,
        pendingFocus: null,
        viewport: null,
        summary: null,
        error: null
      },
      search: null,
      formEditors: {},
      savedViews: {},
      loading: false,
      pendingUrl: null,
      canGoBack: false,
      canGoForward: false,
      error: null
    };
  }
}
