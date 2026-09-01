import { Worker } from "node:worker_threads";

import type { BrowserDocumentState } from "../model.js";
import type { RenderWorkerResponse } from "./protocol.js";
import { renderDocumentAttachment } from "./document-transfer.js";
import {
  transferDocumentState,
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

interface PendingRequest {
  readonly resolve: (response: RenderWorkerResponse) => void;
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
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #cancellation = new Map<string, DocumentCancellationState>();
  #requestId = 0;
  #closed = false;
  #failure: Error | null = null;

  public constructor() {
    this.#worker = new Worker(new URL("./worker-entry.js", import.meta.url));
    this.#worker.on("message", (response: RenderWorkerResponse) => {
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined) return;
      this.#pending.delete(response.requestId);
      if (response.kind === "render-failed") {
        const error = new Error(response.message);
        error.name = response.name;
        pending.reject(error);
      } else pending.resolve(response);
    });
    this.#worker.on("error", (error) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.#worker.on("exit", (code) => {
      if (!this.#closed && code !== 0) this.#fail(new Error(`Rendering worker exited with code ${String(code)}.`));
    });
  }

  public get failed(): boolean { return this.#failure !== null; }

  public async attach(document: BrowserDocumentState): Promise<void> {
    this.cancelDocument(document.id);
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
    const summary = response.payload.summary;
    return Object.freeze({
      ...response.payload,
      summary: summary === null ? null : Object.freeze({
        ...summary,
        scrollAnchorByDocumentNode: new Map(summary.scrollAnchors.map((anchor) => [
          anchor.documentNode,
          anchor,
        ])),
      }),
    });
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
  ): Promise<ViewportSearchGeometryResult> {
    const state = this.#cancellation.get(document.id);
    if (state === undefined) throw new Error(`Document ${document.id} is not attached to the rendering worker.`);
    const searchGeneration = Atomics.add(state.search, 0, 1) + 1;
    const response = await this.#send({
      kind: "search-document",
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
  }

  public async metrics(): Promise<Extract<RenderWorkerResponse, { readonly kind: "artifact-metrics" }>["metrics"]> {
    const response = await this.#send({ kind: "metrics", requestId: this.#nextRequestId() });
    if (response.kind !== "artifact-metrics") throw new Error("The rendering worker returned unexpected metrics.");
    return response.metrics;
  }

  public async release(documentId: string): Promise<void> {
    this.cancelDocument(documentId);
    this.#cancellation.delete(documentId);
    await this.#acknowledge({ kind: "release-document", requestId: this.#nextRequestId(), documentId });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#failure !== null) {
      await this.#worker.terminate();
      return;
    }
    try {
      await this.#acknowledge({ kind: "dispose", requestId: this.#nextRequestId() });
    } finally {
      await this.#worker.terminate();
      this.#fail(new Error("Rendering worker was disposed."));
    }
  }

  #nextRequestId(): number { this.#requestId += 1; return this.#requestId; }

  async #acknowledge(request: RenderWorkerRequest): Promise<void> {
    const response = await this.#send(request);
    if (response.kind !== "acknowledged") throw new Error("The rendering worker did not acknowledge the request.");
  }

  #send(request: RenderWorkerRequest): Promise<RenderWorkerResponse> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed && request.kind !== "dispose") return Promise.reject(new Error("Rendering worker is closed."));
    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
