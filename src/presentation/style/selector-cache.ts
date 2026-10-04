import { registerRetainedOwner } from "../../memory/retained-cost.js";
import type { RetainedSelectorMatchSet } from "./types.js";

/** Counts owned descriptors/references, never the DOM objects referenced by a result. */
function entryBytes(key: string, value: RetainedSelectorMatchSet): number {
  // Map slot/wrapper, retained set, result/usage records, array headers, key
  // and property descriptors. References are charged without walking the DOM.
  let bytes = 1_024 + key.length * 2 + value.result.matches.length * 8;
  for (const dependency of value.dependencies) bytes += 64 + dependency.length * 2;
  for (const unknown of value.result.unknown) {
    bytes += 192 + unknown.reasons.length * 8;
    for (const reason of unknown.reasons) {
      // Includes the reason and source-span descriptors, including their keys.
      bytes += 512 + (reason.code.length + reason.name.length) * 2;
    }
  }
  return bytes;
}

/** Private bounded cache; iteration order is eviction order, not selector priority. */
export class SelectorResultCache {
  readonly #entries = new Map<string, { readonly value: RetainedSelectorMatchSet; readonly bytes: number }>();
  #bytes = 0;
  #limit: number;
  public constructor(limit: number) {
    this.#limit = 0;
    this.resize(limit);
    registerRetainedOwner(this, () => [this.#entries]);
  }
  public get size(): number { return this.#entries.size; }
  public get bytes(): number { return this.#bytes; }
  public get limit(): number { return this.#limit; }
  public get(key: string): RetainedSelectorMatchSet | undefined { return this.#entries.get(key)?.value; }
  public *[Symbol.iterator](): IterableIterator<readonly [string, RetainedSelectorMatchSet]> {
    for (const [key, entry] of this.#entries) yield [key, entry.value];
  }
  public resize(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid selector cache capacity.");
    this.#limit = limit;
    this.#evict(0);
  }
  public set(key: string, value: RetainedSelectorMatchSet): void {
    const bytes = entryBytes(key, value);
    this.delete(key);
    if (bytes > this.#limit) return;
    this.#evict(bytes);
    this.#entries.set(key, Object.freeze({ value, bytes }));
    this.#bytes += bytes;
  }
  #evict(incoming: number): void {
    while (this.#bytes + incoming > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  public delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#bytes -= entry.bytes;
    return this.#entries.delete(key);
  }
  public clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
