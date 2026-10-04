interface RetainedOwner {
  readonly roots: readonly unknown[] | (() => readonly unknown[]);
  readonly opaqueBytes: () => number;
}

const retainedOwners = new WeakMap<object, RetainedOwner[]>();

/** Registers independent private or side-cache roots without keeping their owner alive. */
export function registerRetainedOwner(
  owner: object,
  roots: readonly unknown[] | (() => readonly unknown[]),
  opaqueBytes: () => number = () => 0,
): void {
  const registrations = retainedOwners.get(owner) ?? [];
  registrations.push({ roots, opaqueBytes });
  retainedOwners.set(owner, registrations);
}

// Closed numeric owners have no externally shared internal allocations. The production
// path charges their measured capacity once; the recount still walks every backing buffer.
const capacityOwners = new WeakMap<object, () => number>();
export function registerRetainedCapacity(owner: object, bytesExcludingOwner: () => number): void {
  capacityOwners.set(owner, bytesExcludingOwner);
}

interface RetainedAllocationObserver {
  observes(owner: object): boolean;
  adopted(owner: object): void;
}
let allocationObserver: RetainedAllocationObserver | undefined;
/** Construction reservations are exchanged only after immutable ownership commits. */
export function withRetainedAllocationObserver<T>(observer: RetainedAllocationObserver, operation: () => T): T {
  const previous = allocationObserver; allocationObserver = observer;
  try { return operation(); } finally { allocationObserver = previous; }
}

/** Revisioned side caches remain mutable even when their phase wrapper is frozen. */
export class RetainedCacheMap<K, V> extends Map<K, V> {
  #revision = 0;
  readonly #owners = new Set<{ revision: number }>();
  public constructor(entries?: Iterable<readonly [K, V]> | null) {
    super();
    registerRetainedOwner(this, () => [this.#owners]);
    if (entries !== undefined && entries !== null) for (const [key, value] of entries) this.set(key, value);
  }
  public get revision(): number { return this.#revision; }
  public registerCostRevision(owner: { revision: number }): void {
    if (!this.#owners.has(owner)) { this.#owners.add(owner); this.#changed(); }
  }
  #changed(): void {
    this.#revision += 1;
    for (const owner of this.#owners) owner.revision += 1;
  }
  public override set(key: K, value: V): this {
    if (!this.has(key) || this.get(key) !== value) { super.set(key, value); this.#changed(); }
    return this;
  }
  public override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.#changed();
    return deleted;
  }
  public override clear(): void { if (this.size !== 0) { super.clear(); this.#changed(); } }
}
interface RetainedCacheCollection {
  readonly caches: Set<RetainedCacheMap<unknown, unknown>>;
  readonly token: { revision: number };
}
const retainedCaches = new WeakMap<object, RetainedCacheCollection>();
export function registerRetainedCache(owner: object, cache: RetainedCacheMap<unknown, unknown>): void {
  const collection = retainedCaches.get(owner) ?? { caches: new Set<RetainedCacheMap<unknown, unknown>>(), token: { revision: 0 } };
  if (collection.caches.has(cache)) return;
  collection.caches.add(cache);
  collection.token.revision += 1;
  cache.registerCostRevision(collection.token);
  retainedCaches.set(owner, collection);
  registerRetainedOwner(owner, [cache]);
}
export function retainedSideCaches(owner: object): Iterable<RetainedCacheMap<unknown, unknown>> {
  return retainedCaches.get(owner)?.caches ?? [];
}
export function retainedSideCacheRevision(owner: object): number {
  return retainedCaches.get(owner)?.token.revision ?? 0;
}

function measureAllocations(
  roots: readonly unknown[],
  signal: Pick<AbortSignal, "throwIfAborted"> | undefined,
  discover: (value: object) => boolean,
  recount = false,
): number {
  const strings = new Set<string>();
  const pending: object[] = [];
  let bytes = 0;
  const charge = (value: unknown): void => {
    if (typeof value === "string") {
      if (!strings.has(value)) { strings.add(value); bytes += 24 + value.length * 2; }
    } else if (value !== null && (typeof value === "object" || typeof value === "function")
      && discover(value)) {
      pending.push(value);
      bytes += 64;
    }
  };
  for (const root of roots) charge(root);
  let checkpoints = 0;
  while (pending.length > 0) {
    if ((checkpoints++ & 1023) === 0) signal?.throwIfAborted();
    const value = pending.pop();
    if (value === undefined) continue;
    const capacity = recount ? undefined : capacityOwners.get(value);
    if (capacity !== undefined) bytes += capacity();
    else for (const owner of retainedOwners.get(value) ?? []) {
      for (const root of typeof owner.roots === "function" ? owner.roots() : owner.roots) charge(root);
      bytes += owner.opaqueBytes();
    }
    if (value instanceof Map) {
      bytes += value.size * 48;
      for (const [key, item] of value) { charge(key); charge(item); }
    } else if (value instanceof Set) {
      bytes += value.size * 32;
      for (const item of value) charge(item);
    } else if (ArrayBuffer.isView(value)) charge(value.buffer);
    else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) bytes += value.byteLength;
    else if (Array.isArray(value)) {
      bytes += value.length * 8;
      for (const item of value) charge(item);
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += 16;
        charge(key);
        charge((value as Record<string, unknown>)[key]);
      }
    }
  }
  signal?.throwIfAborted();
  return bytes;
}

/** Full uncached graph recount for qualification and independently owned transport payloads. */
export function estimatedRetainedCost(roots: readonly unknown[], signal?: Pick<AbortSignal, "throwIfAborted">): number {
  const seen = new Set<object>();
  return measureAllocations(roots, signal, (value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  }, true);
}

export class RenderBudgetExceededError extends Error {
  public override readonly name = "RenderBudgetExceededError";
  public constructor(
    public readonly budget: "retained-cost" | "working-set",
    public readonly estimatedBytes: number,
    public readonly limit: number,
    public readonly owner: string = "render-artifacts",
  ) {
    super(`Rendering ${owner} ${budget} budget exceeded: ${String(estimatedBytes)} estimated bytes, limit ${String(limit)}.`);
  }
}

/** A measured allocation owner, with shared immutable allocations charged through dependencies. */
export interface RetainedCostOwner {
  readonly bytes: number;
  readonly dependencies: readonly RetainedCostOwner[];
}

/** Reuses immutable owner measurements; mutable caches are refreshed separately at their writes. */
export class RetainedCostAccounting {
  readonly #owners = new WeakMap<object, RetainedCostOwner>();
  // Construction-local ownership is also the visit ledger; adoption needs no second identity table.
  #allocations = new WeakMap<object, RetainedCostOwner>();
  readonly #discardedOwners = new WeakSet<RetainedCostOwner>();
  readonly #activeOwners = new Set<RetainedCostOwner>();
  #measuredAllocations = 0;

  public get measuredAllocations(): number { return this.#measuredAllocations; }

  public immutable(
    root: object,
    excluded: ReadonlySet<object> = new Set(),
    signal?: Pick<AbortSignal, "throwIfAborted">,
    sharedRoots: readonly object[] = [],
  ): RetainedCostOwner {
    const retained = this.#owners.get(root);
    if (retained !== undefined) return retained;
    const { owner } = this.#measure(root, excluded, signal, true, sharedRoots.length * 48);
    // Commit only after cancellation checks. Committed owner records never strongly retain allocation graphs.
    this.#owners.set(root, owner);
    for (const value of sharedRoots) this.#owners.set(value, owner);
    return owner;
  }

  public mutable(root: object, signal?: Pick<AbortSignal, "throwIfAborted">): RetainedCostOwner {
    return this.#measure(root, new Set(), signal, false).owner;
  }

  #measure(
    root: object,
    excluded: ReadonlySet<object>,
    signal?: Pick<AbortSignal, "throwIfAborted">,
    retainAllocations = true,
    metadataBytes = 0,
  ): {
    readonly owner: RetainedCostOwner;
  } {
    const dependencies = new Set<RetainedCostOwner>();
    const owner = { bytes: 0, dependencies: [] as RetainedCostOwner[] };
    let allocationCount = 0;
    const observer = retainAllocations ? allocationObserver : undefined;
    const adopted: object[] = [];
    // Only reentrant measurements can replace another active traversal's entries.
    let displaced: Map<object, RetainedCostOwner> | undefined;
    let committed = false;
    this.#activeOwners.add(owner);
    try {
      owner.bytes = measureAllocations([root], signal, (value) => {
        if (excluded.has(value) || (retainAllocations && value instanceof RetainedCacheMap)) return false;
        const allocated = this.#allocations.get(value);
        if (allocated === owner) return false;
        const retained = this.#owners.get(value)
          ?? (allocated !== undefined && !this.#activeOwners.has(allocated)
            && !this.#discardedOwners.has(allocated) ? allocated : undefined);
        if (retained !== undefined) {
          dependencies.add(retained);
          return false;
        }
        if (allocated !== undefined && this.#activeOwners.has(allocated)) {
          displaced ??= new Map();
          displaced.set(value, allocated);
        }
        this.#allocations.set(value, owner);
        allocationCount += 1;
        if (observer?.observes(value) === true) adopted.push(value);
        return true;
      });
      owner.bytes += metadataBytes;
      owner.dependencies = [...dependencies];
      Object.freeze(owner.dependencies);
      Object.freeze(owner);
      this.#measuredAllocations += allocationCount;
      committed = retainAllocations;
      for (const value of adopted) observer?.adopted(value);
      return { owner };
    } finally {
      this.#activeOwners.delete(owner);
      if (!committed) {
        // Invalidating a traversal token rolls back every provisional entry without
        // keeping a second strong list of every visited allocation. Weak keys cannot
        // keep retired phase graphs alive until the replacement is published.
        this.#discardedOwners.add(owner);
        for (const [value, previous] of displaced ?? []) {
          // A nested successful measurement owns its own committed entries.
          if (this.#allocations.get(value) === owner) this.#allocations.set(value, previous);
        }
      }
    }
  }

  /** Discards construction-local sharing; later versions cannot retain unrelated retired owners. */
  public endBatch(): void { this.#allocations = new WeakMap(); }

  public total(owners: Iterable<RetainedCostOwner>): number {
    const seen = new Set<RetainedCostOwner>();
    const pending = [...owners];
    let bytes = 0;
    while (pending.length > 0) {
      const owner = pending.pop();
      if (owner === undefined || seen.has(owner)) continue;
      seen.add(owner);
      bytes += owner.bytes + 128 + owner.dependencies.length * 8;
      pending.push(...owner.dependencies);
    }
    return bytes;
  }
}
