interface RestorationJob<T> {
  readonly documentId: string;
  readonly controller: AbortController;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
}

/** Three live slots; selection has priority, background starts require fewer than two inactive loads. */
export class TabRestorationScheduler<T> {
  readonly #queued: RestorationJob<T>[] = [];
  readonly #live = new Set<RestorationJob<T>>();
  #activeDocumentId: string | null = null;
  #backgroundEligible = false;
  #closed = false;

  public configure(activeDocumentId: string, backgroundEligible: boolean): void {
    this.#activeDocumentId = activeDocumentId;
    this.#backgroundEligible = backgroundEligible;
    this.#pump();
  }

  public metrics(): { readonly live: number; readonly queued: number; readonly capacity: number } {
    return { live: this.#live.size, queued: this.#queued.length, capacity: 3 };
  }

  public schedule(documentId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Tab restoration is closed."));
    if (this.#queued.length >= 256) return Promise.reject(new RangeError("Tab restoration queue budget exceeded."));
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort(signal?.reason);
        const index = this.#queued.indexOf(job);
        if (index >= 0) { this.#queued.splice(index, 1); job.detach(); }
        const reason: unknown = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error("Tab restoration was cancelled."));
      };
      const job: RestorationJob<T> = { documentId, controller, run, resolve, reject,
        detach: () => { signal?.removeEventListener("abort", abort); } };
      signal?.addEventListener("abort", abort, { once: true });
      this.#queued.push(job);
      this.#pump();
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of [...this.#queued, ...this.#live]) {
      job.controller.abort(new Error("Tab restoration is closed."));
      job.detach();
      job.reject(job.controller.signal.reason);
    }
    this.#queued.length = 0;
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#live.size < 3) {
      let index = this.#queued.findIndex((job) => job.documentId === this.#activeDocumentId);
      if (index < 0) {
        const backgroundLoads = [...this.#live].filter((job) => job.documentId !== this.#activeDocumentId).length;
        if (!this.#backgroundEligible || backgroundLoads >= 2) return;
        index = 0;
      }
      const job = this.#queued.splice(index, 1)[0];
      if (job === undefined) return;
      this.#live.add(job);
      void Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return job.run(job.controller.signal);
      }).then(job.resolve, job.reject).finally(() => {
        job.detach();
        this.#live.delete(job);
        this.#pump();
      });
    }
  }
}
