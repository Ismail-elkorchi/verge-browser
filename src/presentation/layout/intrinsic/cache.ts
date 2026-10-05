import type { IntrinsicContributionRequest, IntrinsicContributionOutcome } from "./types.js";

function key(request: IntrinsicContributionRequest): string {
  return `${request.formattingNode}:${request.availableInlineSize === null ? "indefinite" : String(request.availableInlineSize)}:${request.inlineSizing}`;
}

export class IntrinsicContributionCache {
  readonly #entries = new Map<string, IntrinsicContributionOutcome>();
  readonly #active = new Set<string>();
  readonly #limit: number;
  #planningEntries = 0;

  public constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Intrinsic contribution cache limit must be non-negative.");
    this.#limit = limit;
  }

  public resolve(
    request: IntrinsicContributionRequest,
    calculate: () => IntrinsicContributionOutcome
  ): IntrinsicContributionOutcome {
    const identity = key(request);
    const cached = this.#entries.get(identity);
    if (cached !== undefined) return cached;
    if (this.#active.has(identity)) return Object.freeze({ status: "cycle" });
    if (this.#entries.size + this.#active.size + this.#planningEntries >= this.#limit) return Object.freeze({ status: "truncated", limit: this.#limit });
    this.#active.add(identity);
    try {
      const result = calculate();
      this.#entries.set(identity, result);
      return result;
    } finally {
      this.#active.delete(identity);
    }
  }

  /** Share admission with natural flex planning; a sizing record is one entry. */
  public reservePlanningEntries(count: number): boolean {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid planning reservation.");
    if (this.#entries.size + this.#active.size + this.#planningEntries + count > this.#limit) return false;
    this.#planningEntries += count;
    return true;
  }

  public releasePlanningEntries(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#planningEntries)
      throw new RangeError("Invalid planning release.");
    this.#planningEntries -= count;
  }

  public clear(): void {
    this.#entries.clear();
    this.#active.clear();
  }
}
