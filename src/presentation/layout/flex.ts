import {
  cssAdd,
  cssDivide,
  cssMax,
  cssMin,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength
} from "./fixed.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

function scalarSum(left: number, right: number): number {
  if (right > 0 && left > Number.MAX_SAFE_INTEGER - right) return Number.MAX_SAFE_INTEGER;
  return left + right;
}

export interface FlexItemInput<Identity> {
  readonly identity: Identity;
  readonly sourceIndex: number;
  readonly order: number;
  readonly flexBaseSize: CssNonNegativeLength;
  readonly hypotheticalMainSize: CssNonNegativeLength;
  readonly minimumMainSize: CssNonNegativeLength;
  readonly maximumMainSize: CssNonNegativeLength | null;
  /** Padding and border on the main axis; targetMainSize remains the content-box size. */
  readonly mainBorderPadding: CssNonNegativeLength;
  readonly flexGrow: number;
  readonly flexShrink: number;
  readonly marginMainStart: CssPixelLength;
  readonly marginMainEnd: CssPixelLength;
  readonly autoMarginMainStart: boolean;
  readonly autoMarginMainEnd: boolean;
}

export interface ResolvedFlexItem<Identity> {
  readonly identity: Identity;
  readonly sourceIndex: number;
  readonly order: number;
  readonly targetMainSize: CssNonNegativeLength;
  readonly mainOffset: CssPixelLength;
  readonly marginMainStart: CssPixelLength;
  readonly marginMainEnd: CssPixelLength;
}

export interface ResolvedFlexLine<Identity> {
  readonly items: readonly ResolvedFlexItem<Identity>[];
  readonly usedMainSize: CssNonNegativeLength;
  readonly remainingFreeSpace: CssPixelLength;
}

export interface ResolveFlexLinesInput<Identity> {
  readonly items: readonly FlexItemInput<Identity>[];
  readonly containerMainSize: CssNonNegativeLength;
  readonly gap: CssNonNegativeLength;
  readonly wrap: "nowrap" | "wrap" | "wrap-reverse";
  readonly reverse: boolean;
  readonly justifyContent: "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
  readonly maxSizingWork?: number;
  readonly signal?: AbortSignal;
}

export class FlexSizingBudgetExceeded extends Error {
  public readonly limit: number;

  public constructor(limit: number) {
    super(`Flex sizing work budget reached ${String(limit)}.`);
    this.name = "FlexSizingBudgetExceeded";
    this.limit = limit;
  }
}

interface FlexSizingWork {
  readonly signal: AbortSignal | undefined;
  readonly limit: number;
  used: number;
}

function consume(work: FlexSizingWork, units = 1): void {
  work.signal?.throwIfAborted();
  if (units > work.limit - work.used) throw new FlexSizingBudgetExceeded(work.limit);
  work.used += units;
}

interface MutableFlexItem<Identity> {
  readonly input: FlexItemInput<Identity>;
  target: CssNonNegativeLength;
  frozen: boolean;
  marginStart: CssPixelLength;
  marginEnd: CssPixelLength;
}

function clampMainSize<Identity>(item: FlexItemInput<Identity>, value: CssPixelLength): CssNonNegativeLength {
  let result = cssMax(ZERO, value) as CssNonNegativeLength;
  result = cssMax(result, item.minimumMainSize) as CssNonNegativeLength;
  if (item.maximumMainSize !== null) result = cssMin(result, item.maximumMainSize) as CssNonNegativeLength;
  return result;
}

function outerHypotheticalSize<Identity>(item: FlexItemInput<Identity>): CssPixelLength {
  return sum(
    item.hypotheticalMainSize,
    item.mainBorderPadding,
    item.autoMarginMainStart ? ZERO : item.marginMainStart,
    item.autoMarginMainEnd ? ZERO : item.marginMainEnd
  );
}

function collectLines<Identity>(
  input: ResolveFlexLinesInput<Identity>,
  work: FlexSizingWork
): readonly (readonly FlexItemInput<Identity>[])[] {
  const ordered = [...input.items].sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex);
  const lines: FlexItemInput<Identity>[][] = [];
  let line: FlexItemInput<Identity>[] = [];
  let occupied: CssPixelLength = ZERO;
  for (const item of ordered) {
    consume(work);
    const next = sum(
      occupied,
      line.length === 0 ? ZERO : input.gap,
      outerHypotheticalSize(item)
    );
    if (input.wrap !== "nowrap" && line.length > 0 && next > input.containerMainSize) {
      lines.push(line);
      line = [];
      occupied = ZERO;
    }
    occupied = sum(
      occupied,
      line.length === 0 ? ZERO : input.gap,
      outerHypotheticalSize(item)
    );
    line.push(item);
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function sumOuterTargets<Identity>(items: readonly MutableFlexItem<Identity>[], gap: CssPixelLength): CssPixelLength {
  let total = cssMultiply(gap, Math.max(0, items.length - 1));
  for (const item of items) total = sum(
    total, item.target, item.input.mainBorderPadding, item.marginStart, item.marginEnd
  );
  return total;
}

function resolveFlexibleLengths<Identity>(
  inputs: readonly FlexItemInput<Identity>[],
  containerMainSize: CssNonNegativeLength,
  gap: CssNonNegativeLength,
  work: FlexSizingWork
): MutableFlexItem<Identity>[] {
  const items = inputs.map((input) => ({
    input,
    target: input.flexBaseSize,
    frozen: false,
    marginStart: input.autoMarginMainStart ? ZERO : input.marginMainStart,
    marginEnd: input.autoMarginMainEnd ? ZERO : input.marginMainEnd
  }));
  let hypotheticalTotal = cssMultiply(gap, Math.max(0, items.length - 1));
  let baseTotal = hypotheticalTotal;
  for (const item of items) {
    consume(work);
    hypotheticalTotal = sum(
      hypotheticalTotal,
      item.input.hypotheticalMainSize,
      item.input.mainBorderPadding,
      item.marginStart,
      item.marginEnd
    );
    baseTotal = sum(baseTotal, item.input.flexBaseSize, item.input.mainBorderPadding, item.marginStart, item.marginEnd);
  }
  const growing = hypotheticalTotal < containerMainSize;
  const initialFreeSpace = cssAdd(containerMainSize, cssMultiply(baseTotal, -1));
  for (const item of items) {
    const factor = growing ? item.input.flexGrow : item.input.flexShrink;
    if (factor === 0 || (growing && item.input.flexBaseSize > item.input.hypotheticalMainSize)
      || (!growing && item.input.flexBaseSize < item.input.hypotheticalMainSize)) {
      item.target = item.input.hypotheticalMainSize;
      item.frozen = true;
    }
  }
  while (items.some((item) => !item.frozen)) {
    consume(work, items.length);
    let used = cssMultiply(gap, Math.max(0, items.length - 1));
    let flexFactorTotal = 0;
    let scaledFactorTotal = 0;
    for (const item of items) {
      used = sum(
        used, item.marginStart, item.marginEnd, item.input.mainBorderPadding,
        item.frozen ? item.target : item.input.flexBaseSize
      );
      if (!item.frozen) {
        const factor = growing ? item.input.flexGrow : item.input.flexShrink;
        flexFactorTotal = scalarSum(flexFactorTotal, factor);
        scaledFactorTotal = scalarSum(
          scaledFactorTotal,
          growing ? factor : cssMultiply(item.input.flexBaseSize, factor)
        );
      }
    }
    let free = cssAdd(containerMainSize, cssMultiply(used, -1));
    if (flexFactorTotal < 1) {
      const fractionalFree = cssMultiply(initialFreeSpace, flexFactorTotal);
      if (Math.abs(fractionalFree) < Math.abs(free)) free = fractionalFree;
    }
    let totalViolation: CssPixelLength = ZERO;
    const violations: { readonly item: MutableFlexItem<Identity>; readonly amount: CssPixelLength }[] = [];
    for (const item of items) {
      if (item.frozen) continue;
      const scaled = growing ? item.input.flexGrow : cssMultiply(item.input.flexBaseSize, item.input.flexShrink);
      const share = scaledFactorTotal === 0 ? ZERO : cssMultiply(free, scaled / scaledFactorTotal);
      const unclamped = cssAdd(item.input.flexBaseSize, share);
      const clamped = clampMainSize(item.input, unclamped);
      const violation = cssAdd(clamped, cssMultiply(unclamped, -1));
      item.target = clamped;
      totalViolation = cssAdd(totalViolation, violation);
      violations.push({ item, amount: violation });
    }
    if (totalViolation === 0) {
      for (const item of items) item.frozen = true;
    } else {
      const freezePositive = totalViolation > 0;
      let froze = false;
      for (const violation of violations) {
        if ((freezePositive && violation.amount > 0) || (!freezePositive && violation.amount < 0)) {
          violation.item.frozen = true;
          froze = true;
        }
      }
      if (!froze) for (const item of items) item.frozen = true;
    }
  }
  return items;
}

function justifyOffsets(
  free: CssPixelLength,
  itemCount: number,
  justify: ResolveFlexLinesInput<unknown>["justifyContent"]
): { readonly leading: CssPixelLength; readonly extraBetween: CssPixelLength } {
  if (free <= 0) return { leading: ZERO, extraBetween: ZERO };
  if (justify === "end") return { leading: free, extraBetween: ZERO };
  if (justify === "center") return { leading: cssDivide(free, 2), extraBetween: ZERO };
  if (justify === "space-between" && itemCount > 1) {
    return { leading: ZERO, extraBetween: cssDivide(free, itemCount - 1) };
  }
  if (justify === "space-around" && itemCount > 0) {
    const around = cssDivide(free, itemCount);
    return { leading: cssDivide(around, 2), extraBetween: around };
  }
  if (justify === "space-evenly" && itemCount > 0) {
    const even = cssDivide(free, itemCount + 1);
    return { leading: even, extraBetween: even };
  }
  return { leading: ZERO, extraBetween: ZERO };
}

function resolveLine<Identity>(
  inputs: readonly FlexItemInput<Identity>[],
  context: ResolveFlexLinesInput<Identity>,
  work: FlexSizingWork
): ResolvedFlexLine<Identity> {
  const items = resolveFlexibleLengths(inputs, context.containerMainSize, context.gap, work);
  let remaining = cssAdd(context.containerMainSize, cssMultiply(sumOuterTargets(items, context.gap), -1));
  let autoMargins = 0;
  for (const item of items) {
    consume(work);
    if (item.input.autoMarginMainStart) autoMargins += 1;
    if (item.input.autoMarginMainEnd) autoMargins += 1;
  }
  if (remaining > 0 && autoMargins > 0) {
    let unallocated = remaining;
    let remainingMargins = autoMargins;
    for (const item of items) {
      consume(work);
      if (item.input.autoMarginMainStart) {
        item.marginStart = cssDivide(unallocated, remainingMargins);
        unallocated = cssAdd(unallocated, cssMultiply(item.marginStart, -1));
        remainingMargins -= 1;
      }
      if (item.input.autoMarginMainEnd) {
        item.marginEnd = cssDivide(unallocated, remainingMargins);
        unallocated = cssAdd(unallocated, cssMultiply(item.marginEnd, -1));
        remainingMargins -= 1;
      }
    }
    remaining = ZERO;
  }
  const justification = justifyOffsets(remaining, items.length, context.justifyContent);
  const resolved: ResolvedFlexItem<Identity>[] = [];
  if (!context.reverse) {
    let cursor = justification.leading;
    for (const item of items) {
      cursor = cssAdd(cursor, item.marginStart);
      resolved.push(Object.freeze({
        identity: item.input.identity,
        sourceIndex: item.input.sourceIndex,
        order: item.input.order,
        targetMainSize: item.target,
        mainOffset: cursor,
        marginMainStart: item.marginStart,
        marginMainEnd: item.marginEnd
      }));
      cursor = sum(
        cursor, item.target, item.input.mainBorderPadding, item.marginEnd,
        context.gap, justification.extraBetween
      );
    }
  } else {
    let cursor = cssAdd(context.containerMainSize, cssMultiply(justification.leading, -1));
    for (const item of items) {
      cursor = sum(
        cursor,
        cssMultiply(item.marginStart, -1),
        cssMultiply(item.target, -1),
        cssMultiply(item.input.mainBorderPadding, -1)
      );
      resolved.push(Object.freeze({
        identity: item.input.identity,
        sourceIndex: item.input.sourceIndex,
        order: item.input.order,
        targetMainSize: item.target,
        mainOffset: cursor,
        marginMainStart: item.marginStart,
        marginMainEnd: item.marginEnd
      }));
      cursor = sum(cursor, cssMultiply(item.marginEnd, -1), cssMultiply(context.gap, -1), cssMultiply(justification.extraBetween, -1));
    }
  }
  const used = cssMax(ZERO, sumOuterTargets(items, context.gap)) as CssNonNegativeLength;
  return Object.freeze({
    items: Object.freeze(resolved),
    usedMainSize: used,
    remainingFreeSpace: remaining
  });
}

/** Resolves order-modified flex lines and flexible main sizes in fixed-point CSS pixels. */
export function resolveFlexLines<Identity>(input: ResolveFlexLinesInput<Identity>): readonly ResolvedFlexLine<Identity>[] {
  if (!Number.isFinite(input.gap) || input.gap < 0 || input.containerMainSize < 0) {
    throw new RangeError("Flex container sizes and gaps must be non-negative fixed-point CSS lengths.");
  }
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.sourceIndex) || !Number.isSafeInteger(item.order)
      || !Number.isFinite(item.flexGrow) || item.flexGrow < 0 || item.flexGrow > Number.MAX_SAFE_INTEGER
      || !Number.isFinite(item.flexShrink) || item.flexShrink < 0 || item.flexShrink > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Flex item order and flex factors must be finite and valid.");
    }
  }
  const limit = input.maxSizingWork ?? 2_000_000;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Flex sizing work budget must be a non-negative safe integer.");
  const work: FlexSizingWork = { signal: input.signal, limit, used: 0 };
  const result: ResolvedFlexLine<Identity>[] = [];
  for (const line of collectLines(input, work)) result.push(resolveLine(line, input, work));
  return Object.freeze(result);
}
