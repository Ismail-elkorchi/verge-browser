export interface CancellationSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
}

export class AtomicCancellationSignal implements AbortSignal, CancellationSignal {
  public onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  readonly #generation: Int32Array;
  readonly #expected: number;

  public constructor(storage: SharedArrayBuffer, expectedGeneration: number) {
    this.#generation = new Int32Array(storage);
    this.#expected = expectedGeneration;
  }

  public get aborted(): boolean {
    return Atomics.load(this.#generation, 0) !== this.#expected;
  }

  public get reason(): unknown {
    return this.aborted ? new DOMException("The render request was superseded.", "AbortError") : undefined;
  }

  public throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  public addEventListener(): void {}
  public removeEventListener(): void {}
  public dispatchEvent(): boolean { return false; }
}
