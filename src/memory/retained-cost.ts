interface RetainedOwner {
  readonly roots: () => readonly unknown[];
  readonly opaqueBytes: () => number;
}

const retainedOwners = new WeakMap<object, RetainedOwner>();

/** Registers private allocation roots without keeping their owner alive. */
export function registerRetainedOwner(
  owner: object,
  roots: () => readonly unknown[],
  opaqueBytes: () => number = () => 0,
): void {
  retainedOwners.set(owner, { roots, opaqueBytes });
}

/** Estimated allocation cost, not exact heap usage; shared objects are visited once. */
export function estimatedRetainedCost(roots: readonly unknown[], signal?: Pick<AbortSignal, "throwIfAborted">): number {
  const seen = new Set<object>();
  const strings = new Set<string>();
  const pending: object[] = [];
  let bytes = 0;
  const charge = (value: unknown): void => {
    if (typeof value === "string") {
      if (!strings.has(value)) { strings.add(value); bytes += 24 + value.length * 2; }
    } else if (value !== null && (typeof value === "object" || typeof value === "function") && !seen.has(value)) {
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
    const owner = retainedOwners.get(value);
    if (owner !== undefined) {
      for (const root of owner.roots()) charge(root);
      bytes += owner.opaqueBytes();
    }
    if (value instanceof Map) {
      bytes += value.size * 48;
      for (const [key, item] of value) { charge(key); charge(item); }
    } else if (value instanceof Set) {
      bytes += value.size * 32;
      for (const item of value) charge(item);
    } else if (ArrayBuffer.isView(value)) {
      charge(value.buffer);
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      bytes += value.byteLength;
    } else if (Array.isArray(value)) {
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
  return bytes;
}

export class RenderBudgetExceededError extends Error {
  public override readonly name = "RenderBudgetExceededError";
  public constructor(
    public readonly budget: "retained-cost" | "working-set",
    public readonly estimatedBytes: number,
    public readonly limit: number,
  ) {
    super(`Rendering ${budget} budget exceeded: ${String(estimatedBytes)} estimated bytes, limit ${String(limit)}.`);
  }
}
