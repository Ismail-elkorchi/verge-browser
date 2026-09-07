import { estimatedRetainedCost, RenderBudgetExceededError } from "../../memory/retained-cost.js";
import { setTimeout, clearTimeout } from "node:timers";
import { Worker } from "node:worker_threads";

import type { BrowserDocumentState } from "../model.js";
import type { RenderWorkerResponse } from "./protocol.js";
import { renderDocumentAttachment } from "./document-transfer.js";
import {
  transferDocumentState,
  type RenderDocumentSummary,
  type RenderWorkerRequest,
  type ViewportSearchGeometryResult,
  type ViewportRenderPayload,
  type ViewportRequestParameters,
} from "./protocol.js";

interface DocumentCancellationState {
  readonly document: Int32Array;
  readonly viewport: Int32Array;
  readonly search: Int32Array;
}

type ClientWorkerResponse = Exclude<RenderWorkerResponse, { readonly kind: "viewport-ready" }> | {
  readonly kind: "viewport-ready";
  readonly requestId: number;
  readonly payload: ViewportRenderPayload;
};

export interface RenderWorkerClientOptions {
  readonly transport?: Pick<Worker, "postMessage" | "on" | "terminate">;
  readonly shutdownDeadlineMilliseconds?: number;
  readonly maxRetainedArtifactBytes?: number;
  readonly maxWorkingSetBytes?: number;
  readonly maxClientRetainedBytes?: number;
}

interface PendingRequest {
  readonly request: RenderWorkerRequest;
  readonly transferCost: number;
  readonly resolve: (response: ClientWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

function cancellationState(): DocumentCancellationState {
  return {
    document: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    viewport: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    search: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  };
}

/** Long-lived interactive renderer client. Heavy browser artifacts never leave its worker. */
export class RenderWorkerClient {
  readonly #worker: Pick<Worker, "postMessage" | "on" | "terminate">;
  readonly #summaries = new Map<string, RenderDocumentSummary>();
  readonly #summaryCosts = new WeakMap<RenderDocumentSummary, number>();
  readonly #viewportCosts = new WeakMap<ViewportRenderPayload, number>();
  readonly #viewports = new Map<string, ViewportRenderPayload>();
  readonly #committedViewports = new Map<string, ViewportRenderPayload>();
  readonly #clientBudget: number;
  readonly #cleanupReserve: number;
  #clientRetainedCost = 0;
  readonly #queue: number[] = [];
  readonly #shutdownDeadline: number;
  #activeRequest: number | null = null;
  #activeDocument: string | null = null;
  #closePromise: Promise<void> | null = null;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #cancellation = new Map<string, DocumentCancellationState>();
  #requestId = 0;
  #closed = false;
  #failure: Error | null = null;

  public constructor(options: RenderWorkerClientOptions = {}) {
    this.#shutdownDeadline = options.shutdownDeadlineMilliseconds ?? 250;
    this.#clientBudget = options.maxClientRetainedBytes ?? 64 * 1024 * 1024;
    this.#cleanupReserve = Math.min(32 * 1024, Math.floor(this.#clientBudget / 8));
    for (const limit of [this.#shutdownDeadline, this.#clientBudget, options.maxWorkingSetBytes ?? 1024 * 1024 * 1024]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Worker budgets must be positive safe integers.");
    }
    this.#worker = options.transport ?? new Worker(new URL("./worker-entry.js", import.meta.url), {
      workerData: { maxRetainedArtifactBytes: options.maxRetainedArtifactBytes,
        maxWorkingSetBytes: options.maxWorkingSetBytes ?? 1024 * 1024 * 1024 },
      resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.ceil((options.maxWorkingSetBytes ?? 1024 * 1024 * 1024) / (1024 * 1024))) },
    });
    this.#worker.on("message", (response: RenderWorkerResponse) => {
      const pending = this.#pending.get(response.requestId);
      if (this.#activeRequest === response.requestId) this.#activeRequest = null;
      if (pending === undefined) { this.#dispatch(); return; }
      this.#pending.delete(response.requestId);
      try {
        if (response.kind === "budget-exceeded") {
          pending.reject(new RenderBudgetExceededError(response.budget, response.estimatedBytes, response.limit));
        } else if (response.kind === "render-failed") {
          const error = new Error(response.message);
          error.name = response.name;
          pending.reject(error);
        } else if (response.kind === "viewport-ready") {
          const payload = response.payload;
          const received = payload.summary;
          if (received !== null) {
            if (received.identity !== payload.summaryIdentity) throw new Error("Mismatched document summary identity.");
            this.#summaries.set(payload.documentId, Object.freeze({
              ...received,
              scrollAnchorByDocumentNode: new Map(received.scrollAnchors.map((anchor) => [anchor.documentNode, anchor])),
            }));
          }
          const summary = this.#summaries.get(payload.documentId);
          if (summary === undefined || summary.identity !== payload.summaryIdentity) {
            throw new Error("Viewport requires an unavailable document summary.");
          }
          const viewport = Object.freeze({ ...payload, summary });
          this.#admitViewport(viewport);
          pending.resolve({ ...response, payload: viewport });
        } else pending.resolve(response);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.#dispatch();
    });
    this.#worker.on("error", (error) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.#worker.on("exit", (code) => {
      this.#fail(new Error(`Rendering worker exited with code ${String(code)}.`));
    });
  }

  public get failed(): boolean { return this.#failure !== null; }
  public get pendingRequestCount(): number { return this.#pending.size; }

  public acknowledgeViewport(payload: ViewportRenderPayload): void {
    if (this.#viewports.get(payload.documentId) !== payload) return;
    this.#committedViewports.set(payload.documentId, payload);
    this.#clientRetainedCost = this.#viewportCost();
  }

  #viewportCost(extra?: ViewportRenderPayload): number {
    const viewports = new Set([...this.#viewports.values(), ...this.#committedViewports.values(), ...(extra === undefined ? [] : [extra])]);
    const summaries = new Set([...this.#summaries.values(), ...[...viewports].map((viewport) => viewport.summary)]);
    let bytes = 0;
    for (const viewport of viewports) {
      let cost = this.#viewportCosts.get(viewport);
      if (cost === undefined) {
        const cells = { ...viewport, summary: null };
        cost = estimatedRetainedCost([cells]);
        this.#viewportCosts.set(viewport, cost);
      }
      bytes += cost;
    }
    for (const summary of summaries) {
      let cost = this.#summaryCosts.get(summary);
      if (cost === undefined) { cost = estimatedRetainedCost([summary]); this.#summaryCosts.set(summary, cost); }
      bytes += cost;
    }
    return bytes;
  }

  #admitViewport(payload: ViewportRenderPayload): void {
    const peak = this.#viewportCost(payload) + this.#pendingTransferCost();
    const limit = this.#clientBudget - this.#cleanupReserve;
    if (peak > limit) {
      this.#summaries.delete(payload.documentId);
      throw new RenderBudgetExceededError("retained-cost", peak, limit);
    }
    this.#viewports.set(payload.documentId, payload);
    this.#clientRetainedCost = this.#viewportCost();
  }

  public prioritize(documentId: string | null): void {
    if (this.#activeDocument === documentId) return;
    const previous = this.#activeDocument;
    this.#activeDocument = documentId;
    if (previous !== null) this.cancelDocument(previous);
    this.#dispatch();
  }

  public async attach(document: BrowserDocumentState): Promise<void> {
    this.cancelDocument(document.id);
    this.#summaries.delete(document.id);
    const state = cancellationState();
    this.#cancellation.set(document.id, state);
    await this.#acknowledge({
      kind: "attach-document",
      requestId: this.#nextRequestId(),
      attachment: renderDocumentAttachment(document),
      documentGeneration: Atomics.load(state.document, 0),
      documentCancellation: state.document.buffer as SharedArrayBuffer,
    });
  }

  public async updateState(
    document: BrowserDocumentState,
    changed: readonly string[],
  ): Promise<void> {
    await this.#acknowledge({
      kind: "update-document-state",
      requestId: this.#nextRequestId(),
      documentId: document.id,
      documentRevision: document.documentRevision,
      stateRevision: document.stateRevision,
      state: transferDocumentState(document.documentState),
      changed,
    });
  }

  public async renderViewport(
    document: BrowserDocumentState,
    viewportRevision: number,
    parameters: ViewportRequestParameters,
  ): Promise<ViewportRenderPayload> {
    const state = this.#cancellation.get(document.id);
    if (state === undefined) throw new Error(`Document ${document.id} is not attached to the rendering worker.`);
    const viewportGeneration = Atomics.add(state.viewport, 0, 1) + 1;
    const response = await this.#send({
      kind: "request-viewport",
      heldSummaryIdentity: this.#summaries.get(document.id)?.identity ?? null,
      requestId: this.#nextRequestId(),
      documentId: document.id,
      documentRevision: document.documentRevision,
      stateRevision: document.stateRevision,
      viewportRevision,
      documentGeneration: Atomics.load(state.document, 0),
      viewportGeneration,
      documentCancellation: state.document.buffer as SharedArrayBuffer,
      viewportCancellation: state.viewport.buffer as SharedArrayBuffer,
      parameters,
    });
    if (response.kind !== "viewport-ready") throw new Error("The rendering worker returned an unexpected response.");
    return response.payload;
  }

  public cancelViewport(documentId: string): void {
    const state = this.#cancellation.get(documentId);
    if (state !== undefined) Atomics.add(state.viewport, 0, 1);
  }

  public async search(
    document: BrowserDocumentState,
    query: string,
    parameters: ViewportRequestParameters,
    limit = 2_000,
    requestGeneration?: number,
  ): Promise<ViewportSearchGeometryResult> {
    const state = this.#cancellation.get(document.id);
    if (state === undefined) throw new Error(`Document ${document.id} is not attached to the rendering worker.`);
    const searchGeneration = Atomics.add(state.search, 0, 1) + 1;
    const response = await this.#send({
      kind: "search-document",
      stateRevision: document.stateRevision,
      requestGeneration: requestGeneration ?? searchGeneration,
      requestId: this.#nextRequestId(),
      documentId: document.id,
      documentRevision: document.documentRevision,
      documentGeneration: Atomics.load(state.document, 0),
      documentCancellation: state.document.buffer as SharedArrayBuffer,
      searchGeneration,
      searchCancellation: state.search.buffer as SharedArrayBuffer,
      query,
      limit,
      parameters,
    });
    if (response.kind !== "search-ready") throw new Error("The rendering worker returned an unexpected search response.");
    return response.result;
  }

  public cancelDocument(documentId: string): void {
    const state = this.#cancellation.get(documentId);
    if (state === undefined) return;
    Atomics.add(state.document, 0, 1);
    Atomics.add(state.viewport, 0, 1);
    Atomics.add(state.search, 0, 1);
    this.#cancelRequests(documentId);
  }

  public cancelSearch(documentId: string): void {
    const state = this.#cancellation.get(documentId);
    if (state !== undefined) Atomics.add(state.search, 0, 1);
    this.#cancelRequests(documentId, "search-document");
  }

  #cancelRequests(documentId: string, kind?: RenderWorkerRequest["kind"]): void {
    for (const [id, pending] of this.#pending) {
      const request = pending.request;
      const owner = request.kind === "attach-document" ? request.attachment.documentId
        : "documentId" in request ? request.documentId : null;
      if (request.kind === "release-document" || owner !== documentId || (kind !== undefined && request.kind !== kind)) continue;
      this.#pending.delete(id);
      const queued = this.#queue.indexOf(id);
      if (queued >= 0) this.#queue.splice(queued, 1);
      const error = new Error("Document render job was cancelled.");
      error.name = "AbortError";
      pending.reject(error);
    }
  }

  public async metrics(collectGarbage = false): Promise<Extract<RenderWorkerResponse, { readonly kind: "artifact-metrics" }>["metrics"]> {
    const response = await this.#send({ kind: "metrics", collectGarbage, requestId: this.#nextRequestId() });
    if (response.kind !== "artifact-metrics") throw new Error("The rendering worker returned unexpected metrics.");
    return { ...response.metrics, clientRetainedCost: this.#clientRetainedCost, pendingTransferCost: this.#pendingTransferCost(), pendingRequests: this.#pending.size, queuedRequests: this.#queue.length };
  }

  public async release(documentId: string): Promise<void> {
    this.cancelDocument(documentId);
    this.#cancellation.delete(documentId);
    this.#summaries.delete(documentId);
    this.#viewports.delete(documentId);
    this.#committedViewports.delete(documentId);
    this.#clientRetainedCost = this.#viewportCost();
    await this.#acknowledge({ kind: "release-document", requestId: this.#nextRequestId(), documentId });
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const id of this.#cancellation.keys()) this.cancelDocument(id);
    this.#settlePending(new Error("Rendering worker was disposed."));
    this.#summaries.clear();
    this.#viewports.clear();
    this.#committedViewports.clear();
    this.#clientRetainedCost = 0;
    this.#cancellation.clear();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.#failure === null) {
        await Promise.race([
          this.#acknowledge({ kind: "dispose", requestId: this.#nextRequestId() }).catch(() => undefined),
          new Promise<void>((resolve) => { deadline = setTimeout(resolve, this.#shutdownDeadline); }),
        ]);
      }
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      try { await this.#worker.terminate(); }
      finally { this.#fail(new Error("Rendering worker was disposed.")); }
    }
  }

  #nextRequestId(): number { this.#requestId += 1; return this.#requestId; }

  async #acknowledge(request: RenderWorkerRequest): Promise<void> {
    const response = await this.#send(request);
    if (response.kind !== "acknowledged") throw new Error("The rendering worker did not acknowledge the request.");
  }

  #pendingTransferCost(): number {
    return [...this.#pending.values()].reduce((cost, pending) => cost + pending.transferCost, 0);
  }

  #send(request: RenderWorkerRequest): Promise<ClientWorkerResponse> {
    if (this.#closed && request.kind !== "dispose") return Promise.reject(new Error("Rendering worker is closed."));
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (request.kind === "request-viewport" || request.kind === "search-document") {
      for (const id of [...this.#queue]) {
        const pending = this.#pending.get(id);
        if (pending?.request.kind === request.kind && pending.request.documentId === request.documentId) {
          this.#pending.delete(id);
          this.#queue.splice(this.#queue.indexOf(id), 1);
          const error = new Error("Render job was superseded.");
          error.name = "AbortError";
          pending.reject(error);
        }
      }
    }
    const cleanup = request.kind === "dispose" || request.kind === "release-document";
    if (cleanup && this.#pending.size >= 128) {
      const displaced = this.#queue.find((id) => {
        const kind = this.#pending.get(id)?.request.kind;
        return kind !== "dispose" && kind !== "release-document";
      });
      if (displaced !== undefined) {
        const pending = this.#pending.get(displaced);
        this.#pending.delete(displaced);
        this.#queue.splice(this.#queue.indexOf(displaced), 1);
        const error = new Error("Render job was preempted by document cleanup.");
        error.name = "AbortError";
        pending?.reject(error);
      }
    }
    const transferCost = estimatedRetainedCost([request]);
    const pendingCost = this.#pendingTransferCost();
    const limit = this.#clientBudget - (cleanup ? 0 : this.#cleanupReserve);
    if (transferCost + pendingCost + this.#clientRetainedCost > limit) return Promise.reject(new RenderBudgetExceededError("working-set", transferCost + pendingCost + this.#clientRetainedCost, limit));
    if (this.#pending.size >= (cleanup ? 128 : 120)) return Promise.reject(new RangeError("Rendering worker queue budget exceeded."));
    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { request, transferCost, resolve, reject });
      this.#queue.push(request.requestId);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    if (this.#activeRequest !== null || this.#failure !== null) return;
    const priority = (id: number): number => {
      const request = this.#pending.get(id)?.request;
      if (request?.kind === "dispose" || request?.kind === "release-document") return 0;
      const documentId = request?.kind === "attach-document" ? request.attachment.documentId
        : request !== undefined && "documentId" in request ? request.documentId : null;
      return documentId === this.#activeDocument ? 1 : 2;
    };
    this.#queue.sort((left, right) => priority(left) - priority(right));
    const id = this.#queue.shift();
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) { this.#dispatch(); return; }
    this.#activeRequest = id;
    try {
      const request = pending.request;
      this.#worker.postMessage(request.kind === "request-viewport" ? {
        ...request, heldSummaryIdentity: this.#summaries.get(request.documentId)?.identity ?? null,
      } : request);
    } catch (error) {
      this.#pending.delete(id);
      this.#activeRequest = null;
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.#dispatch();
    }
  }

  #settlePending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#queue.length = 0;
    this.#activeRequest = null;
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#settlePending(error);
  }
}
