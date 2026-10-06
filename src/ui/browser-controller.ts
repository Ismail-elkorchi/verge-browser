import { prepareBrowserViewportImages, discardBrowserViewportImages, acceptBrowserViewportImages } from "./image-presentation.js";
import { retainedImageBytes, MAX_RETAINED_IMAGE_BYTES } from "./image-loading.js";
import { TabRestorationScheduler } from "./tab-restoration.js";
import { type DocumentImageMetadata, type DocumentImageResource } from "../document/image-resources.js";
import { pageImageMetadata } from "../app/image-admission.js";
import { dirname } from "node:path";
import type { TuiEventSource } from "@ismail-elkorchi/terminal-ui/tui";

import {
  NetworkSafetyPolicy,
  type HttpSessionAdapter
} from "@ismail-elkorchi/http-client";

import {
  buildFormSubmissionRequest
} from "../app/forms.js";
import { assertPageInitiatedNavigation } from "../app/security.js";
import type { PageAcquisition } from "../app/page-acquisition.js";
import { commitNavigation, emptyHistory, currentEntry, type NavigationProvenance } from "../app/navigation-history.js";
import { emptyRendering, navigationFocus } from "./navigation-state.js";
import {
  type BrowserWorkspace,
  type DownloadRecord,
  type StoredBrowserDocument,
  type StoredSidePanel,
  type BrowserStore
} from "../app/storage.js";
import {
  type PageRequestOptions,
  type IndexedPageSnapshot
} from "../app/types.js";
import {
  createDocumentState,
  resolveDocumentFragment,
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
  BrowserTuiMessage,
  BrowserTuiState,
  BrowserTabState,
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

function diagnosticsLines(document: BrowserDocumentState): readonly string[] {
  const snapshot = document.snapshot;
  const summary = document.rendering.summary;
  const issues = summary?.styleDiagnostics ?? snapshot.styleDiagnostics;
  const shown = issues.slice(0, 24);
  const omitted = issues.length - shown.length + (summary?.omittedStyleDiagnosticCount ?? 0);
  const images = snapshot.images ?? [];
  const imageFailures = new Map<string, number>();
  for (const image of images) if (image.status === "failed") {
    imageFailures.set(image.failure, (imageFailures.get(image.failure) ?? 0) + 1);
  }
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
    `Images: ${String(images.filter((image) => image.status === "ready").length)} ready, ${String(images.filter((image) => image.status === "pending").length)} pending, ${String(images.filter((image) => image.status === "failed").length)} failed`,
    ...((snapshot.imageOmittedReferenceCount ?? 0) > 0
      ? [`Image references outside the resource limit: ${String(snapshot.imageOmittedReferenceCount)}`] : []),
    ...[...imageFailures].map(([failure, count]) => `Image ${failure}: ${String(count)}`),
    `Navigation ms (fetch, parse, stylesheets): ${String(snapshot.diagnostics.totalDurationMs)}`,
    `Rendering: ${document.rendering.status}`,
    ...(summary?.styleOutcome.status === "truncated" && summary.styleOutcome.fallback !== null
      ? [`Style fallback: ${summary.styleOutcome.fallback}`] : []),
    ...(summary?.incomplete.map((reason) => `Incomplete: ${reason}`) ?? []),
    ...(document.rendering.error === null ? [] : [`Render error: ${document.rendering.error}`]),
    ...shown.map((issue) =>
      `CSS ${issue.code}${issue.occurrences > 1 ? ` ×${String(issue.occurrences)}` : ""}: ${issue.detail} (${issue.sourceUrl})`
    ),
    ...(omitted === 0 ? [] : [`Additional CSS diagnostics omitted: ${String(omitted)}`])
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
        return { target: { kind: "element-id", value: id }, rowOffset: document.scrollAnchor.rowOffset, ...(document.scrollColumn === undefined || document.scrollColumn === 0 ? {} : { columnOffset: document.scrollColumn }) };
      }
    }
    if (sourceTarget === null && (node.kind === "element" || node.kind === "text") && node.sourceRange !== null) {
      sourceTarget = { kind: "source", offset: node.sourceRange.start, nodeKind: node.kind };
    }
    source = node.parent;
  }
  return { target: sourceTarget, rowOffset: document.scrollAnchor.rowOffset, ...(document.scrollColumn === undefined || document.scrollColumn === 0 ? {} : { columnOffset: document.scrollColumn }) };
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

/** A render consumer can leave while shared attachment/state preparation is still running. */
function waitForPreparation<T>(preparation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return preparation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason instanceof Error ? signal.reason : new Error("Render preparation cancelled.", { cause: signal.reason })); };
    signal.addEventListener("abort", abort, { once: true });
    preparation.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new Error(String(error))); });
  });
}

export interface AcquiredNavigation {
  readonly snapshot: IndexedPageSnapshot;
  readonly provenance: NavigationProvenance;
  readonly mode: "push" | "replace";
}

export interface BrowserControllerOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createAcquisition: (httpSession: HttpSessionAdapter) => PageAcquisition;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
  readonly renderWorkerFactory?: () => RenderWorkerClient;
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
  readonly #createAcquisition: (httpSession: HttpSessionAdapter) => PageAcquisition;
  readonly #searchUrlTemplate: string;
  readonly #downloadDirectory: string;
  readonly #downloadMaxBytes: number;
  readonly #externalNetworkPolicy = new NetworkSafetyPolicy(EXTERNAL_NETWORK_POLICY);
  readonly #renderWorkerFactory: () => RenderWorkerClient;
  #renderer: RenderWorkerClient;
  #workerEpoch = 1;
  #restart: Promise<void> | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #documentAttachments = new Map<string, {
    readonly epoch: number;
    desired: { readonly documentRevision: number; readonly stateRevision: number };
    attached: { readonly sourceId: string; readonly documentRevision: number; readonly stateRevision: number;
      readonly state: DocumentState; readonly images: readonly DocumentImageMetadata[] } | null;
    preparation: Promise<RenderWorkerClient> | null;
    tail: Promise<unknown>;
  }>();
  readonly #restorations = new TabRestorationScheduler<BrowserDocumentState>();
  readonly #acquisitions = new Map<string, PageAcquisition>();
  readonly #provisionalAcquisitionIds = new Set<string>();
  #nextDocumentNumber = 1;
  #workspaceSaveRevision = 0;
  #imageOperation: Promise<unknown> | null = null;
  readonly #imageAcquisitionOwners = new Set<{ readonly snapshot: IndexedPageSnapshot }>();
  #imageRetentionState: BrowserTuiState | null = null;
  #imageRetentionRevision = 0;
  #acceptedImageRetentionRevision = 0;
  #imageRetentionCandidate: { readonly revision: number; readonly state: WeakRef<BrowserTuiState> } | null = null;
  readonly #imageCandidates = new Map<string, ViewportRenderPayload>();

  /** Adopt only a published state. Planning a reducer/subscription is speculative. */
  public observeImageRetentionState(state: BrowserTuiState): void {
    this.#imageRetentionState = state;
    if (this.#imageRetentionCandidate?.state.deref() === state) this.#imageRetentionCandidate = null;
  }

  /** One weak speculative owner cannot retain rejected states or form a history. */
  public reserveImageRetentionState(previous: BrowserTuiState, next: BrowserTuiState): void {
    this.#imageRetentionState ??= previous;
    if (next === this.#imageRetentionState) { this.#imageRetentionCandidate = null; return; }
    if (this.#imageRetentionCandidate?.state.deref() === next) return;
    this.#imageRetentionCandidate = { revision: ++this.#imageRetentionRevision, state: new WeakRef(next) };
  }

  public retainedImageStates(): readonly BrowserTuiState[] {
    const candidate = this.#imageRetentionCandidate?.state.deref();
    return [...(this.#imageRetentionState === null ? [] : [this.#imageRetentionState]),
      ...(candidate === undefined || candidate === this.#imageRetentionState ? [] : [candidate])];
  }

  /** Queued and retiring acquisitions keep their input pixels until cleanup settles. */
  public retainedImageSnapshots(): readonly IndexedPageSnapshot[] {
    return [...this.#imageAcquisitionOwners].map((owner) => owner.snapshot);
  }

  /** Subscription activation is synchronous after publication and budget admission.
   * It emits no message and coalesces every reducer in a dispatchMany transaction. */
  public imageRetentionSource(state: BrowserTuiState): TuiEventSource<BrowserTuiMessage> {
    const revision = this.#imageRetentionCandidate?.state.deref() === state
      ? this.#imageRetentionCandidate.revision : this.#acceptedImageRetentionRevision;
    const accepted = new WeakRef(state);
    return { id: "image-retention", generation: revision, channel: { capacity: 1 },
      run: (context) => {
        context.signal.throwIfAborted();
        const published = accepted.deref();
        if (published !== undefined && revision >= this.#acceptedImageRetentionRevision) {
          this.#acceptedImageRetentionRevision = revision;
          this.observeImageRetentionState(published);
        }
        return Promise.resolve();
      } };
  }

  /** Count the transport's existing owners too, including an unpublished candidate
   * or an accepted frame whose successor has not been acknowledged. */
  public retainedImageViewports(): readonly ViewportRenderPayload["cellBuffer"][] {
    return [...this.#renderer.retainedViewports()].map((viewport) => viewport.cellBuffer);
  }


  public constructor(options: BrowserControllerOptions) {
    this.#renderWorkerFactory = options.renderWorkerFactory ?? (() => new RenderWorkerClient());
    this.#renderer = this.#renderWorkerFactory();
    this.#store = options.store;
    this.#services = options.services;
    this.#createAcquisition = options.createAcquisition;
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
      this.#provisionalAcquisitionIds.delete(document.id);
    }
    await this.#releaseDiscardedAcquisitions(state);
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

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const candidate of this.#imageCandidates.values()) discardBrowserViewportImages(candidate.cellBuffer);
    this.#imageCandidates.clear();
    this.#imageRetentionState = null;
    this.#imageRetentionCandidate = null;
    this.#restorations.close();
    this.#workerEpoch += 1;
    for (const id of this.#documentAttachments.keys()) this.#renderer.cancelDocument(id);
    this.#documentAttachments.clear();
    this.#externalNetworkPolicy.close(new Error("Browser controller closed."));
    const sessions = [...this.#acquisitions.values()];
    this.#acquisitions.clear();
    this.#provisionalAcquisitionIds.clear();
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

  /** Reserves a stable tab identity without allocating acquisition or loading a page. */
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

  /** Starts loading a placeholder. Acquisition ownership begins at this boundary. */
  public restorePlaceholder(
    tab: BrowserPlaceholderTabState,
    signal?: AbortSignal,
  ): Promise<BrowserDocumentState> {
    return this.#restorations.schedule(tab.id, (loadSignal) =>
      this.#openDocument(tab.id, tab.requestedUrl, loadSignal, tab.storedScrollAnchor), signal);
  }

  public configureRestoration(tab: BrowserTabState): void {
    this.#restorations.configure(tab.id, tab.kind === "failed"
      || (tab.kind === "ready" && (tab.rendering.status === "ready" || tab.rendering.status === "failed")));
  }

  public restorationMetrics(): ReturnType<TabRestorationScheduler<BrowserDocumentState>["metrics"]> {
    return this.#restorations.metrics();
  }

  /** Keeps one live source per tab; activation revisions fence every derived request. */
  public async renderViewport(
    document: BrowserDocumentState,
    viewportRevision: number,
    parameters: ViewportRequestParameters,
    signal?: AbortSignal,
  ): Promise<ViewportRenderPayload> {
    signal?.throwIfAborted();
    const renderer = await waitForPreparation(this.#prepareRendering(document), signal);
    signal?.throwIfAborted();
    this.#discardImageCandidate(document.id);
    const payload = await renderer.renderViewport(document, viewportRevision, parameters);
    signal?.throwIfAborted();
    if (!(document.snapshot.images ?? []).some((resource) => resource.status === "ready")) return payload;
    this.#imageCandidates.set(document.id, payload);
    const retainedState = (): BrowserTuiState => this.#imageRetentionState ?? {
      documents: [document], recentlyClosed: [],
    } as unknown as BrowserTuiState;
    try {
      await prepareBrowserViewportImages(document.snapshot.images ?? [], payload.cellBuffer,
        () => MAX_RETAINED_IMAGE_BYTES - retainedImageBytes(retainedState(), undefined, this.retainedImageViewports(), this.retainedImageStates(), this.retainedImageSnapshots()), signal);
      signal?.throwIfAborted();
      return payload;
    } catch (error) {
      discardBrowserViewportImages(payload.cellBuffer);
      if (this.#imageCandidates.get(document.id) === payload) this.#imageCandidates.delete(document.id);
      throw error;
    }
  }

  #discardImageCandidate(documentId: string): void {
    const candidate = this.#imageCandidates.get(documentId);
    if (candidate !== undefined) discardBrowserViewportImages(candidate.cellBuffer);
    this.#imageCandidates.delete(documentId);
  }

  public cancelViewport(documentId: string): void {
    this.#discardImageCandidate(documentId);
    this.#renderer.cancelViewport(documentId);
  }

  public async acquireImages(
    documentId: string,
    snapshot: IndexedPageSnapshot,
    signal: AbortSignal,
    onResource: (resource: DocumentImageResource) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    const owner = { snapshot };
    this.#imageAcquisitionOwners.add(owner);
    try {
      while (this.#imageOperation !== null) {
        await waitForPreparation(this.#imageOperation.catch(() => undefined), signal);
        signal.throwIfAborted();
      }
      if (this.#closed) throw new Error("Browser controller is closed.");
      const operation = this.#acquisition(documentId).acquireImages(snapshot, { signal, onResource });
      this.#imageOperation = operation;
      try { await operation; }
      finally { if (this.#imageOperation === operation) this.#imageOperation = null; }
    } finally {
      this.#imageAcquisitionOwners.delete(owner);
    }
  }

  /** Internal interaction metrics used by deterministic browser qualification. */
  public renderingMetrics(): ReturnType<RenderWorkerClient["metrics"]> {
    return this.#renderer.metrics();
  }

  public async searchDocument(
    document: BrowserDocumentState,
    query: string,
    parameters: ViewportRequestParameters,
    requestGeneration: number,
    signal?: AbortSignal,
  ): ReturnType<RenderWorkerClient["search"]> {
    signal?.throwIfAborted();
    const renderer = await waitForPreparation(this.#prepareRendering(document), signal);
    signal?.throwIfAborted();
    return renderer.search(document, query, parameters, 2_000, requestGeneration);
  }

  public cancelDocumentRendering(documentId: string): void {
    this.#discardImageCandidate(documentId);
    this.#renderer.cancelDocument(documentId);
  }

  public cancelSearch(documentId: string): void { this.#renderer.cancelSearch(documentId); }

  public acknowledgeViewport(payload: ViewportRenderPayload): void {
    acceptBrowserViewportImages(payload.cellBuffer);
    if (this.#imageCandidates.get(payload.documentId) === payload) this.#imageCandidates.delete(payload.documentId);
    this.#renderer.acknowledgeViewport(payload);
  }

  public prioritizeRendering(documentId: string | null): void { this.#renderer.prioritize(documentId); }

  async #prepareRendering(document: BrowserDocumentState): Promise<RenderWorkerClient> {
    if (this.#closed) throw new Error("Browser controller is closed.");
    if (this.#renderer.failed) {
      this.#restart ??= (async () => {
        await this.#renderer.close();
        if (this.#closed) throw new Error("Browser controller is closed.");
        this.#workerEpoch += 1;
        this.#renderer = this.#renderWorkerFactory();
        this.#documentAttachments.clear();
      })().finally(() => { this.#restart = null; });
      await this.#restart;
    }
    const sourceId = currentEntry(document.navigation)?.documentId;
    if (sourceId === undefined) throw new Error("Active rendering source is missing.");
    const renderer = this.#renderer;
    let attachment = this.#documentAttachments.get(document.id);
    if (attachment === undefined) {
      attachment = { epoch: this.#workerEpoch, desired: { documentRevision: document.documentRevision, stateRevision: document.stateRevision }, attached: null, preparation: null, tail: Promise.resolve() };
      this.#documentAttachments.set(document.id, attachment);
    }
    const lifecycle = attachment;
    const desired = lifecycle.desired;
    if (document.documentRevision < desired.documentRevision
      || (document.documentRevision === desired.documentRevision && document.stateRevision < desired.stateRevision)) {
      throw this.#obsoletePreparation();
    }
    const sameRevision = document.documentRevision === desired.documentRevision && document.stateRevision === desired.stateRevision;
    if (sameRevision && lifecycle.preparation !== null) return lifecycle.preparation;
    if (!sameRevision) renderer.cancelDocument(document.id);
    lifecycle.desired = { documentRevision: document.documentRevision, stateRevision: document.stateRevision };
    const validate = (): void => {
      if (this.#closed || this.#workerEpoch !== lifecycle.epoch
        || this.#documentAttachments.get(document.id) !== lifecycle
        || lifecycle.desired.documentRevision !== document.documentRevision
        || lifecycle.desired.stateRevision !== document.stateRevision) throw this.#obsoletePreparation();
    };
    const operation = lifecycle.tail.catch(() => undefined).then(async () => {
      validate();
      const attached = lifecycle.attached;
      if (attached === null || attached.sourceId !== sourceId) {
        // A cancelled attach can have committed before its reply was detached.
        // Until it acknowledges, do not claim the previous source is resident.
        lifecycle.attached = null;
        await renderer.attach(document);
      } else if (attached.documentRevision !== document.documentRevision || attached.stateRevision !== document.stateRevision) {
        const changed: string[] = [];
        const previous = attached.state;
        if (previous.focus !== document.documentState.focus) changed.push("focus");
        if (previous.hover !== document.documentState.hover) changed.push("hover");
        if (previous.active !== document.documentState.active) changed.push("active");
        if (previous.urlTarget !== document.documentState.urlTarget) changed.push("target");
        if (previous.open !== document.documentState.open) changed.push("disclosure-open");
        if (previous.controls !== document.documentState.controls) changed.push("control-content", "checked-selected");
        await renderer.updateState(document, changed, attached.documentRevision === document.documentRevision
          ? undefined : attached.documentRevision);
      }
      const images = pageImageMetadata(document.snapshot);
      if (attached !== null && attached.sourceId === sourceId
        && (attached.images.length !== images.length || images.some((image, index) => {
          const previous = attached.images[index];
          return previous?.id !== image.id || previous.width !== image.width || previous.height !== image.height || previous.hasAlpha !== image.hasAlpha
            || previous.requestUrl !== image.requestUrl || previous.owners.length !== image.owners.length
            || previous.owners.some((owner, ownerIndex) => owner !== image.owners[ownerIndex]);
        }))) await renderer.updateDocumentImages(document);
      // Record an acknowledged producer even when its consumer was superseded.
      // The serialized successor must advance from the worker's actual revision.
      lifecycle.attached = { sourceId, documentRevision: document.documentRevision, stateRevision: document.stateRevision,
        state: document.documentState, images };
      validate();
      return renderer;
    });
    lifecycle.preparation = operation;
    lifecycle.tail = operation.finally(() => {
      if (lifecycle.preparation === operation) lifecycle.preparation = null;
    });
    // tail participates in lifecycle serialization even when its caller is cancelled.
    void lifecycle.tail.catch(() => undefined);
    return operation;
  }

  #obsoletePreparation(): Error {
    const error = new Error("Document attachment was superseded.");
    error.name = "AbortError";
    return error;
  }

  public async releaseRendering(documentId: string): Promise<void> {
    this.#discardImageCandidate(documentId);
    this.#documentAttachments.delete(documentId);
    await this.#renderer.release(documentId);
  }

  public resolveOmnibox(value: string, currentUrl: string): string {
    return resolveOmniboxInput(value, currentUrl, this.#searchUrlTemplate);
  }

  public omniboxSuggestions(
    value: string,
    document: BrowserTabState,
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

    if (addUntilFull(document.kind === "ready" ? document.snapshot.document.links : [], (link) => ({
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

  public async navigate(
    document: BrowserDocumentState,
    target: string,
    requestOptions: PageRequestOptions = {},
    parseMode?: "text" | "stream"
  ): Promise<AcquiredNavigation> {
    const snapshot = await this.#acquisition(document.id).acquire(
      resolveInputUrl(target, document.snapshot.finalUrl), requestOptions, parseMode);
    return { snapshot, provenance: { kind: "direct" }, mode: "push" };
  }

  public async openLink(document: BrowserDocumentState, linkIndex: number, signal?: AbortSignal): Promise<AcquiredNavigation> {
    const link = document.snapshot.document.links.find((candidate) => candidate.index === linkIndex);
    if (link === undefined) throw new Error(`No link exists at index ${String(linkIndex)}`);
    const provenance = { kind: "page-initiated" as const, sourceUrl: document.snapshot.finalUrl };
    const snapshot = await this.#acquisition(document.id).acquire(link.destination,
      signal === undefined ? {} : { signal }, document.snapshot.diagnostics.parseMode, provenance);
    return { snapshot, provenance, mode: "push" };
  }

  public async reload(document: BrowserDocumentState, signal?: AbortSignal): Promise<AcquiredNavigation> {
    const entry = currentEntry(document.navigation);
    if (entry === undefined) throw new Error("No page is loaded.");
    const snapshot = await this.#acquisition(document.id).acquire(entry.snapshot.finalUrl,
      signal === undefined ? {} : { signal }, entry.parseMode, entry.provenance);
    return { snapshot, provenance: entry.provenance, mode: "replace" };
  }

  public openNewFromDocument(
    document: BrowserDocumentState,
    target: string,
    signal?: AbortSignal
  ): Promise<BrowserDocumentState> {
    assertPageInitiatedNavigation(document.snapshot.finalUrl, target);
    return this.#openDocument(this.#newDocumentId(), target, signal, undefined, document.snapshot.finalUrl);
  }

  public async submitForm(
    document: BrowserDocumentState, form: DocumentForm, state: DocumentState,
    submitter: DocumentNodeRef | undefined, signal?: AbortSignal,
  ): Promise<AcquiredNavigation> {
    const submission = buildFormSubmissionRequest(document.snapshot.document, form, state, submitter, document.snapshot.finalUrl);
    const provenance = { kind: "page-initiated" as const, sourceUrl: document.snapshot.finalUrl };
    const snapshot = await this.#acquisition(document.id).acquire(submission.url, {
      ...submission.requestOptions, ...(signal === undefined ? {} : { signal }),
    }, undefined, provenance);
    return { snapshot, provenance, mode: "push" };
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
    if (kind === "diagnostics") return diagnosticsLines(document);
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

  async #openDocument(
    id: string,
    target: string,
    signal?: AbortSignal,
    scrollAnchor?: StoredBrowserDocument["scrollAnchor"],
    sourceUrl?: string,
  ): Promise<BrowserDocumentState> {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Browser controller is closed.");
    const session = this.#createAcquisition(this.#store.httpSession);
    this.#acquisitions.set(id, session);
    this.#provisionalAcquisitionIds.add(id);
    try {
      const snapshot = await session.acquire(resolveInputUrl(target), signal === undefined ? {} : { signal }, undefined,
        sourceUrl === undefined ? { kind: "direct" } : { kind: "page-initiated", sourceUrl });
      signal?.throwIfAborted();
      if (this.#acquisitions.get(id) !== session) throw this.#obsoletePreparation();
      return this.#document(id, snapshot, scrollAnchor, sourceUrl);
    } catch (error) {
      if (this.#acquisitions.get(id) === session) {
        this.#acquisitions.delete(id);
        this.#provisionalAcquisitionIds.delete(id);
      }
      await session.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
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

  #acquisition(documentId: string): PageAcquisition {
    const session = this.#acquisitions.get(documentId);
    if (!session) throw new Error(`No page acquisition exists for ${documentId}.`);
    return session;
  }

  async #releaseDiscardedAcquisitions(state: BrowserTuiState): Promise<void> {
    const retainedIds = new Set([
      ...state.documents.map((document) => document.id),
      ...state.recentlyClosed.map((document) => document.id)
    ]);
    const discarded = [...this.#acquisitions.entries()]
      .filter(([id]) => !retainedIds.has(id) && !this.#provisionalAcquisitionIds.has(id));
    const discardedRendering = [...this.#documentAttachments.keys()]
      .filter((id) => !retainedIds.has(id));
    for (const [id] of discarded) {
      this.#acquisitions.delete(id);
    }
    for (const id of discardedRendering) this.#documentAttachments.delete(id);
    await settleBrowserCleanup(
      [
        ...discarded.map(([, session]) => () => session.close()),
        ...discardedRendering.map((id) => () => this.releaseRendering(id)),
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
    storedAnchor?: StoredBrowserDocument["scrollAnchor"],
    sourceUrl?: string,
  ): BrowserDocumentState {
    const fragment = resolveDocumentFragment(snapshot.document, snapshot.finalUrl);
    const restoredAnchor = restoredScrollAnchor(snapshot, storedAnchor);
    const firstAnchor = {
      source: snapshot.document.body ?? snapshot.document.documentElement,
      rowOffset: 0,
    };
    return {
      kind: "ready",
      navigationGeneration: 0,
      id,
      documentRevision: 1,
      stateRevision: 1,
      snapshot,
      scrollAnchor: restoredAnchor ?? firstAnchor,
      scrollColumn: storedAnchor?.columnOffset ?? 0,
      scrollOffsets: [],
      documentState: createDocumentState(snapshot.document, snapshot.finalUrl),
      rendering: { ...emptyRendering(),
        pendingReveal: restoredAnchor === undefined && fragment.kind === "node" ? { node: fragment.node, blockAlign: "start" } : null,
        pendingFocus: fragment.kind === "node" ? navigationFocus(snapshot, fragment.node) : null },
      search: null,
      formEditors: {},
      navigation: commitNavigation(emptyHistory(), snapshot, "push", sourceUrl === undefined ? { kind: "direct" } : { kind: "page-initiated", sourceUrl }),
      entryViews: {},
      liveDocuments: {},
      loading: false,
      pendingUrl: null,
      canGoBack: false,
      canGoForward: false,
      error: null
    };
  }
}
