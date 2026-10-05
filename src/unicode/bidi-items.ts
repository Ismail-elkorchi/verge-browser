import { PackedRows, ValueSequence, checkPackedCapacity, checkPackedMetadata } from "../memory/packed.js";
import { registerRetainedOwner } from "../memory/retained-cost.js";
import type { BidiItem, BidiLevel, BidiRun } from "./bidi.js";
import type { BidiClass } from "./properties.js";

const CLASSES: readonly BidiClass[] = ["L", "R", "AL", "EN", "ES", "ET", "AN", "CS", "NSM", "BN", "B", "S", "WS", "ON", "LRE", "LRO", "RLE", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"];
interface BidiStorage<T> {
  readonly rows: PackedRows;
  readonly identities: readonly T[];
  readonly text: ReadonlyMap<number, string>;
  readonly wideOffsets?: ReadonlyMap<number, readonly [number, number]>;
}
/** Numeric bidi items share one immutable owner across paragraph slices. */
export class BidiItems<T> extends ValueSequence<BidiItem<T>> {
  readonly #storage: BidiStorage<T>;
  readonly #start: number;
  public readonly length: number;
  public constructor(storage: BidiStorage<T>, start = 0, length = storage.rows.length) {
    super(); checkPackedMetadata(148, this); this.#storage = storage; this.#start = start; this.length = length;
    registerRetainedOwner(this, [storage], () => 32); Object.freeze(this);
  }
  public at(index: number): BidiItem<T> | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    index += this.#start;
    const rows = this.#storage.rows;
    const cp = rows.get(index, 0), flags = rows.get(index, 1), identity = rows.get(index, 4);
    const wide = this.#storage.wideOffsets?.get(index);
    return { kind: flags >>> 8 === 0 ? "code-point" : flags >>> 8 === 1 ? "atomic-inline" : "structural-control",
      text: this.#storage.text.get(index) ?? (cp === 0xffffffff ? "" : String.fromCodePoint(cp)),
      codePoint: cp === 0xffffffff ? null : cp, bidiClass: CLASSES[flags & 255] ?? "ON",
      sourceStartCodeUnit: wide?.[0] ?? rows.get(index, 2), sourceEndCodeUnit: wide?.[1] ?? rows.get(index, 3),
      identity: (identity % 2 === 0 ? identity / 2 - 1 : this.#storage.identities[(identity - 1) / 2]) as T };
  }
  public slice(start = 0, end = this.length): BidiItems<T> {
    const first = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    const last = end < 0 ? Math.max(first, this.length + end) : Math.max(first, Math.min(end, this.length));
    return first === 0 && last === this.length ? this : new BidiItems(this.#storage, this.#start + first, last - first);
  }
  public static from<T>(items: Iterable<BidiItem<T>>): BidiItems<T> {
    if (items instanceof BidiItems) return items as BidiItems<T>;
    const builder = new BidiItemsBuilder<T>("length" in items && typeof items.length === "number" ? items.length : 128); for (const item of items) builder.push(item); return builder.finish();
  }
}
export class BidiItemsBuilder<T> {
  #finished = false;
  readonly #rows: PackedRows;
  public constructor(expectedLength = 128) { this.#rows = new PackedRows(5, false, Math.max(1, Math.min(128, expectedLength))); }
  readonly #identities: T[] = [];
  readonly #identityIndex = new Map<T, number>();
  readonly #text = new Map<number, string>();
  #wideOffsets: Map<number, readonly [number, number]> | undefined;
  public get length(): number { return this.#rows.length; }
  public push(item: BidiItem<T>): void {
    if (this.#finished) throw new RangeError("Bidi item owner is sealed.");
    let identity: number;
    if (typeof item.identity === "number" && Number.isInteger(item.identity) && item.identity >= -1 && item.identity < 0x7fffffff) identity = (item.identity + 1) * 2;
    else {
      let index = this.#identityIndex.get(item.identity);
      if (index === undefined) { index = this.#identities.length; this.#identities.push(item.identity); this.#identityIndex.set(item.identity, index); }
      identity = index * 2 + 1;
    }
    const defaultText = item.codePoint === null ? "" : String.fromCodePoint(item.codePoint);
    if (item.text !== defaultText) this.#text.set(this.length, item.text);
    if (item.sourceStartCodeUnit > 0xffffffff || item.sourceEndCodeUnit > 0xffffffff) {
      this.#wideOffsets ??= new Map();
      this.#wideOffsets.set(this.length, Object.freeze([item.sourceStartCodeUnit, item.sourceEndCodeUnit]));
    }
    this.#rows.push(item.codePoint ?? 0xffffffff, CLASSES.indexOf(item.bidiClass) | ((item.kind === "code-point" ? 0 : item.kind === "atomic-inline" ? 1 : 2) << 8),
      item.sourceStartCodeUnit, item.sourceEndCodeUnit, identity);
  }
  public finish(): BidiItems<T> {
    if (this.#finished) throw new RangeError("Bidi item owner is sealed.");
    this.#finished = true;
    return new BidiItems(Object.freeze({ rows: this.#rows.seal(), identities: Object.freeze(this.#identities), text: this.#text,
      ...(this.#wideOffsets === undefined ? {} : { wideOffsets: this.#wideOffsets }) }));
  }
}

/** Paragraph slices and line summaries reference the same compact resolved level vector. */
export class BidiLevels extends ValueSequence<BidiLevel | null> {
  readonly #values: Int16Array;
  readonly #start: number;
  public readonly length: number;
  private constructor(values: readonly (number | null)[] | Int16Array, start = 0, length = values.length) {
    super();
    if (values instanceof Int16Array) { checkPackedMetadata(148, this); this.#values = values; }
    else { checkPackedCapacity(values.length * 2 + 276, this); this.#values = Int16Array.from(values, (value) => value ?? -1); }
    this.#start = start; this.length = length;
    registerRetainedOwner(this, [this.#values], () => 32); Object.freeze(this);
  }
  public static from(values: readonly (number | null)[]): BidiLevels {
    return new BidiLevels(values);
  }
  public at(index: number): BidiLevel | null | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const value = this.#values[this.#start + index];
    return value === -1 ? null : value as BidiLevel;
  }
  public slice(start = 0, end = this.length): BidiLevels {
    const first = Math.max(0, Math.min(this.length, start)), last = Math.max(first, Math.min(this.length, end));
    if (first === 0 && last === this.length) return this;
    return new BidiLevels(this.#values, this.#start + first, last - first);
  }
}

/** UAX #9 visual runs are contiguous ranges, so duplicated per-item order arrays are unnecessary. */
export class BidiOrderIndices extends ValueSequence<number> {
  readonly #runs: readonly BidiRun[];
  public readonly length: number;
  public constructor(runs: readonly BidiRun[]) {
    super(); checkPackedMetadata(132, this); this.#runs = Object.freeze(runs); this.length = runs.reduce((count, run) => count + run.logicalEnd - run.logicalStart, 0);
    registerRetainedOwner(this, [runs], () => 16); Object.freeze(this);
  }
  public at(index: number): number | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    for (const run of this.#runs) {
      const count = run.logicalEnd - run.logicalStart;
      if (index < count) return run.direction === "ltr" ? run.logicalStart + index : run.logicalEnd - index - 1;
      index -= count;
    }
    return undefined;
  }
  public override *[Symbol.iterator](): IterableIterator<number> {
    for (const run of this.#runs) for (let offset = 0; offset < run.logicalEnd - run.logicalStart; offset += 1)
      yield run.direction === "ltr" ? run.logicalStart + offset : run.logicalEnd - offset - 1;
  }
}
