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

interface AllocationMeasurement {
  readonly bytes: number;
  readonly allocations: ReadonlySet<object>;
}

function measureAllocations(
  roots: readonly unknown[],
  signal?: Pick<AbortSignal, "throwIfAborted">,
  skip: (value: object) => boolean = () => false,
): AllocationMeasurement {
  const seen = new Set<object>();
  const strings = new Set<string>();
  const pending: object[] = [];
  let bytes = 0;
  const charge = (value: unknown): void => {
    if (typeof value === "string") {
      if (!strings.has(value)) { strings.add(value); bytes += 24 + value.length * 2; }
    } else if (value !== null && (typeof value === "object" || typeof value === "function")
      && !seen.has(value) && !skip(value)) {
      seen.add(value);
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
    for (const owner of retainedOwners.get(value) ?? []) {
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
  return { bytes, allocations: seen };
}

/** Full uncached graph recount for qualification and independently owned transport payloads. */
export function estimatedRetainedCost(roots: readonly unknown[], signal?: Pick<AbortSignal, "throwIfAborted">): number {
  return measureAllocations(roots, signal).bytes;
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
  #allocations = new Map<object, RetainedCostOwner>();
  #measuredAllocations = 0;

  public get measuredAllocations(): number { return this.#measuredAllocations; }

  public immutable(
    root: object,
    excluded: ReadonlySet<object> = new Set(),
    signal?: Pick<AbortSignal, "throwIfAborted">,
    sharedResource = false,
  ): RetainedCostOwner {
    const retained = this.#owners.get(root);
    if (retained !== undefined) return retained;
    const { owner, allocations } = this.#measure(root, excluded, signal);
    // Commit only after cancellation checks. Committed owner records never strongly retain allocation graphs.
    this.#owners.set(root, owner);
    for (const value of allocations) {
      this.#allocations.set(value, owner);
      if (sharedResource) this.#owners.set(value, owner);
    }
    return owner;
  }

  public mutable(root: object, signal?: Pick<AbortSignal, "throwIfAborted">): RetainedCostOwner {
    return this.#measure(root, new Set(), signal).owner;
  }

  #measure(root: object, excluded: ReadonlySet<object>, signal?: Pick<AbortSignal, "throwIfAborted">): {
    readonly owner: RetainedCostOwner;
    readonly allocations: ReadonlySet<object>;
  } {
    const dependencies = new Set<RetainedCostOwner>();
    const measurement = measureAllocations([root], signal, (value) => {
      if (excluded.has(value)) return true;
      const owner = this.#owners.get(value) ?? this.#allocations.get(value);
      if (owner === undefined) return false;
      dependencies.add(owner);
      return true;
    });
    this.#measuredAllocations += measurement.allocations.size;
    return {
      owner: Object.freeze({ bytes: measurement.bytes, dependencies: Object.freeze([...dependencies]) }),
      allocations: measurement.allocations,
    };
  }

  /** Discards construction-local sharing; later versions cannot retain unrelated retired owners. */
  public endBatch(): void { this.#allocations.clear(); }

  public total(owners: Iterable<RetainedCostOwner>): number {
    const seen = new Set<RetainedCostOwner>();
    const pending = [...owners];
    let bytes = 0;
    while (pending.length > 0) {
      const owner = pending.pop();
      if (owner === undefined || seen.has(owner)) continue;
      seen.add(owner);
      bytes += owner.bytes;
      pending.push(...owner.dependencies);
    }
    return bytes;
  }
}
