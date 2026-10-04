import { registerRetainedOwner, registerRetainedCapacity, withRetainedAllocationObserver } from "./retained-cost.js";

/** Immutable indexed values. Decoded records are ephemeral; owners retain only packed columns. */
export abstract class ValueSequence<T> implements Iterable<T> {
  public abstract readonly length: number;
  public abstract at(index: number): T | undefined;
  public *[Symbol.iterator](): IterableIterator<T> {
    for (let index = 0; index < this.length; index += 1) {
      const value = this.at(index);
      if (value !== undefined) yield value;
    }
  }
  public *entries(): IterableIterator<[number, T]> {
    let index = 0;
    for (const value of this) yield [index++, value];
  }
  public map<U>(callback: (value: T, index: number) => U): U[] {
    const result: U[] = [];
    for (const [index, value] of this.entries()) result.push(callback(value, index));
    return result;
  }
  public reduce<U>(callback: (accumulator: U, value: T, index: number) => U, initial: U): U {
    let result = initial;
    for (const [index, value] of this.entries()) result = callback(result, value, index);
    return result;
  }
  public some(callback: (value: T, index: number) => boolean): boolean {
    for (const [index, value] of this.entries()) if (callback(value, index)) return true;
    return false;
  }
}

let allocationCheck: ((bytes: number, page: boolean, owner?: object) => void) | undefined;
let clearConstructionReservations: (() => void) | undefined;
/** A synchronous construction fence: positive preallocation checks and negative committed-ownership exchanges. */
export function withPackedAllocationCheck<T>(check: (bytes: number, page: boolean) => void, operation: () => T): T {
  const previous = allocationCheck;
  const previousClear = clearConstructionReservations;
  let reservations = new WeakMap<object, number>();
  clearConstructionReservations = () => { reservations = new WeakMap<object, number>(); };
  allocationCheck = (bytes, page, owner) => {
    check(bytes, page);
    if (owner !== undefined) reservations.set(owner, (reservations.get(owner) ?? 0) + bytes);
  };
  try {
    return withRetainedAllocationObserver({ observes: (owner) => reservations.has(owner), adopted: (owner) => {
      const bytes = reservations.get(owner); if (bytes === undefined) return;
      reservations.delete(owner); check(-bytes, false);
    } }, operation);
  } finally { allocationCheck = previous; clearConstructionReservations = previousClear; }
}

/** Drops construction-only owner handles after a phase adopts its complete immutable graph. */
export function finishPackedConstructionPhase(): void { clearConstructionReservations?.(); }

export function checkPackedCapacity(bytes: number, owner?: object): void { allocationCheck?.(bytes, true, owner); }
export function checkPackedMetadata(bytes: number, owner?: object): void { allocationCheck?.(bytes, false, owner); }

/** Fixed-size pages avoid copying old capacity during growth and bound the next allocation. */
export class PackedRows {
  readonly #pages: (Uint32Array | Float64Array)[];
  #capacityBytes = 176;
  readonly #width: number;
  readonly #pageRows: number;
  readonly #floating: boolean;
  #length = 0;
  #sealed = false;
  public constructor(width: number, floating = false, pageRows = 128) {
    allocationCheck?.(240, false, this);
    this.#pages = [];
    this.#width = width;
    this.#floating = floating;
    this.#pageRows = pageRows;
    registerRetainedOwner(this, () => [this.#pages], () => 112);
    registerRetainedCapacity(this, () => this.#capacityBytes);
  }
  public get length(): number { return this.#length; }
  public push(...values: readonly number[]): number {
    if (this.#sealed || values.length !== this.#width) throw new RangeError("Invalid packed row append.");
    const index = this.#length;
    const pageIndex = Math.floor(index / this.#pageRows);
    let page = this.#pages[pageIndex];
    if (page === undefined) {
      const bytes = this.#pageRows * this.#width * (this.#floating ? 8 : 4);
      // Page, backing buffer and owner-array slot are all charged before allocation.
      allocationCheck?.(bytes + 136, true, this);
      page = this.#floating ? new Float64Array(this.#pageRows * this.#width)
        : new Uint32Array(this.#pageRows * this.#width);
      this.#pages.push(page);
      this.#capacityBytes += bytes + 136;
    }
    page.set(values, index % this.#pageRows * this.#width);
    this.#length += 1;
    return index;
  }
  public get(index: number, column: number): number {
    if (index < 0 || index >= this.#length || column < 0 || column >= this.#width) throw new RangeError("Packed row out of range.");
    return this.#pages[Math.floor(index / this.#pageRows)]?.[index % this.#pageRows * this.#width + column] ?? 0;
  }
  public seal(): this { this.#sealed = true; Object.freeze(this.#pages); Object.freeze(this); return this; }
}
