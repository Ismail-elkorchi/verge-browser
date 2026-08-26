import type { BreakOpportunityKind } from "../../unicode/index.js";
import { cssAdd, cssPx, type CssPixelLength } from "./fixed.js";

export interface LogicalLineSelectionItem {
  readonly logicalIndex: number;
  readonly advance: CssPixelLength;
  readonly tabInterval: CssPixelLength | null;
  readonly breakBefore: BreakOpportunityKind;
  readonly forcedBreak: boolean;
  readonly collapsibleSpace: boolean;
  readonly wrappingAllowed: boolean;
}

export interface LogicalLineSelectionBudgets {
  readonly maxSelectedLines: number;
}

export type LogicalLineSelectionOutcome =
  | { readonly status: "complete"; readonly lines: number }
  | { readonly status: "truncated"; readonly lines: number; readonly budget: "maxSelectedLines"; readonly limit: number }
  | { readonly status: "rejected"; readonly reason: "invalid-size" | "invalid-budget" | "invalid-item" };

export interface LogicalLineSelection {
  readonly breaksBefore: ReadonlySet<number>;
  readonly suppressed: ReadonlySet<number>;
  readonly retainedItems: number;
  readonly usedAdvances: ReadonlyMap<number, CssPixelLength>;
  readonly outcome: LogicalLineSelectionOutcome;
}

function result(
  breaksBefore: Set<number>,
  suppressed: Set<number>,
  retainedItems: number,
  usedAdvances: Map<number, CssPixelLength>,
  outcome: LogicalLineSelectionOutcome
): LogicalLineSelection {
  return Object.freeze({ breaksBefore, suppressed, retainedItems, usedAdvances, outcome: Object.freeze(outcome) });
}

/** Greedy CSS line selection over precomputed Unicode/CSS break opportunities. */
export function selectLogicalLines(
  items: readonly LogicalLineSelectionItem[],
  firstAvailableInlineSize: CssPixelLength,
  continuationAvailableInlineSize: CssPixelLength,
  budgets: Partial<LogicalLineSelectionBudgets> = {},
  signal?: AbortSignal
): LogicalLineSelection {
  const limit = budgets.maxSelectedLines ?? 50_000;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return result(new Set(), new Set(), 0, new Map(), { status: "rejected", reason: "invalid-budget" });
  }
  if (!Number.isSafeInteger(firstAvailableInlineSize) || firstAvailableInlineSize < 0
    || !Number.isSafeInteger(continuationAvailableInlineSize) || continuationAvailableInlineSize < 0) {
    return result(new Set(), new Set(), 0, new Map(), { status: "rejected", reason: "invalid-size" });
  }
  for (const [position, item] of items.entries()) {
    if (item.logicalIndex !== position || !Number.isSafeInteger(item.advance) || item.advance < 0
      || item.tabInterval !== null && (!Number.isSafeInteger(item.tabInterval) || item.tabInterval < 0)) {
      return result(new Set(), new Set(), 0, new Map(), { status: "rejected", reason: "invalid-item" });
    }
  }
  const zero = cssPx(0);
  const unbreakable: CssPixelLength[] = new Array<CssPixelLength>(items.length).fill(zero);
  const tabInUnbreakable = new Array<boolean>(items.length).fill(false);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    signal?.throwIfAborted();
    const item = items[index];
    if (item === undefined || item.forcedBreak) continue;
    const next = items[index + 1];
    unbreakable[index] = cssAdd(
      item.advance,
      next !== undefined && !next.forcedBreak && next.breakBefore === "prohibited"
        ? unbreakable[index + 1] ?? zero : zero
    );
    tabInUnbreakable[index] = item.tabInterval !== null
      || next !== undefined && !next.forcedBreak && next.breakBefore === "prohibited"
        && (tabInUnbreakable[index + 1] ?? false);
  }
  const breaksBefore = new Set<number>();
  const suppressed = new Set<number>();
  const usedAdvances = new Map<number, CssPixelLength>();
  let lineAdvance: CssPixelLength = zero;
  let available = firstAvailableInlineSize;
  let lineHasContent = false;
  let lines = items.length === 0 ? 0 : 1;
  if (lines > limit) {
    return result(breaksBefore, suppressed, 0, usedAdvances, {
      status: "truncated", lines: limit, budget: "maxSelectedLines", limit
    });
  }
  for (const item of items) {
    signal?.throwIfAborted();
    if (item.forcedBreak) {
      const previous = items[item.logicalIndex - 1];
      if (previous?.collapsibleSpace === true) suppressed.add(previous.logicalIndex);
      lineAdvance = zero;
      available = continuationAvailableInlineSize;
      lineHasContent = false;
      lines += 1;
      if (lines > limit) {
        return result(breaksBefore, suppressed, item.logicalIndex + 1, usedAdvances, {
          status: "truncated", lines: limit, budget: "maxSelectedLines", limit
        });
      }
      continue;
    }
    if (item.collapsibleSpace && !lineHasContent) {
      suppressed.add(item.logicalIndex);
      continue;
    }
    const advanceAt = (candidate: LogicalLineSelectionItem, current: CssPixelLength): CssPixelLength => {
      if (candidate.tabInterval === null) return candidate.advance;
      if (candidate.tabInterval === 0) return zero;
      const remainder = current % candidate.tabInterval;
      return (remainder === 0 ? candidate.tabInterval : candidate.tabInterval - remainder) as CssPixelLength;
    };
    const unbreakableAdvance = (): CssPixelLength => {
      if (!(tabInUnbreakable[item.logicalIndex] ?? false)) return unbreakable[item.logicalIndex] ?? zero;
      let advance: CssPixelLength = zero;
      for (let index = item.logicalIndex; index < items.length; index += 1) {
        const candidate = items[index];
        if (candidate === undefined || candidate.forcedBreak) break;
        if (index > item.logicalIndex && candidate.breakBefore !== "prohibited") break;
        advance = cssAdd(advance, advanceAt(candidate, cssAdd(lineAdvance, advance)));
      }
      return advance;
    };
    if (item.wrappingAllowed && lineHasContent && item.breakBefore !== "prohibited"
      && cssAdd(lineAdvance, unbreakableAdvance()) > available) {
      breaksBefore.add(item.logicalIndex);
      const previous = items[item.logicalIndex - 1];
      if (previous?.collapsibleSpace === true) suppressed.add(previous.logicalIndex);
      lineAdvance = zero;
      available = continuationAvailableInlineSize;
      lineHasContent = false;
      lines += 1;
      if (lines > limit) {
        return result(breaksBefore, suppressed, item.logicalIndex, usedAdvances, {
          status: "truncated", lines: limit, budget: "maxSelectedLines", limit
        });
      }
    }
    if (item.collapsibleSpace && !lineHasContent) {
      suppressed.add(item.logicalIndex);
      continue;
    }
    const usedAdvance = advanceAt(item, lineAdvance);
    usedAdvances.set(item.logicalIndex, usedAdvance);
    lineAdvance = cssAdd(lineAdvance, usedAdvance);
    if (usedAdvance > 0 || !item.collapsibleSpace) lineHasContent = true;
  }
  const final = items.at(-1);
  if (final?.collapsibleSpace === true) suppressed.add(final.logicalIndex);
  return result(breaksBefore, suppressed, items.length, usedAdvances, { status: "complete", lines });
}
