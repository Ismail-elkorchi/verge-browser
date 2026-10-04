import type { ValueSequence } from "../../memory/packed.js";
import type { BreakOpportunityKind } from "../../unicode/index.js";
import { cssAdd, cssPx, cssSubtract, type CssPixelLength } from "./fixed.js";

export interface LogicalLineSelectionItem {
  readonly logicalIndex: number;
  /** Signed inline advance: text is nonnegative, while box margins may be negative. */
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
  items: readonly LogicalLineSelectionItem[] | ValueSequence<LogicalLineSelectionItem>,
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
    if (item.logicalIndex !== position || !Number.isSafeInteger(item.advance)
      || item.tabInterval !== null && (!Number.isSafeInteger(item.tabInterval) || item.tabInterval < 0)) {
      return result(new Set(), new Set(), 0, new Map(), { status: "rejected", reason: "invalid-item" });
    }
  }
  const zero = cssPx(0);
  const canBreakBefore = (item: LogicalLineSelectionItem, includeEmergency: boolean): boolean =>
    item.breakBefore === "mandatory" || item.wrappingAllowed
      && (item.breakBefore === "allowed" || includeEmergency && item.breakBefore === "emergency");
  const runs = [false, true].map((includeEmergency) => ({
    includeEmergency,
    advances: new Array<CssPixelLength>(items.length).fill(zero),
    hasTabs: new Array<boolean>(items.length).fill(false)
  }));
  for (let index = items.length - 1; index >= 0; index -= 1) {
    signal?.throwIfAborted();
    const item = items.at(index);
    if (item === undefined || item.forcedBreak) continue;
    const next = items.at(index + 1);
    for (const run of runs) {
      const continues = next !== undefined && !next.forcedBreak && !canBreakBefore(next, run.includeEmergency);
      const remainder = continues ? run.advances[index + 1] ?? zero : zero;
      // Collapsible spaces at the end of a prospective line do not consume its width.
      run.advances[index] = item.collapsibleSpace && remainder === 0
        ? zero : cssAdd(item.advance, remainder);
      run.hasTabs[index] = item.tabInterval !== null || continues && (run.hasTabs[index + 1] ?? false);
    }
  }
  const breaksBefore = new Set<number>();
  const suppressed = new Set<number>();
  const usedAdvances = new Map<number, CssPixelLength>();
  const suppressTrailingSpaces = (beforeIndex: number): void => {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      signal?.throwIfAborted();
      if (items.at(index)?.collapsibleSpace !== true) break;
      suppressed.add(index);
    }
  };
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
      suppressTrailingSpaces(item.logicalIndex);
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
      const remainder = (current % candidate.tabInterval + candidate.tabInterval) % candidate.tabInterval;
      return (remainder === 0 ? candidate.tabInterval : candidate.tabInterval - remainder) as CssPixelLength;
    };
    const unbreakableAdvance = (): CssPixelLength => {
      // Ordinary opportunities measure through emergency boundaries so an intact
      // word moves to the next line first. Emergency boundaries only measure to
      // the next usable boundary, filling an otherwise overlong word greedily.
      const run = runs[item.breakBefore === "emergency" ? 1 : 0];
      if (run === undefined) return zero;
      if (!(run.hasTabs[item.logicalIndex] ?? false)) return run.advances[item.logicalIndex] ?? zero;
      let advance: CssPixelLength = zero;
      let trailingCollapsibleAdvance: CssPixelLength = zero;
      for (let index = item.logicalIndex; index < items.length; index += 1) {
        signal?.throwIfAborted();
        const candidate = items.at(index);
        if (candidate === undefined || candidate.forcedBreak) break;
        if (index > item.logicalIndex && canBreakBefore(candidate, run.includeEmergency)) break;
        const used = advanceAt(candidate, cssAdd(lineAdvance, advance));
        advance = cssAdd(advance, used);
        trailingCollapsibleAdvance = candidate.collapsibleSpace ? cssAdd(trailingCollapsibleAdvance, used) : zero;
      }
      return cssSubtract(advance, trailingCollapsibleAdvance);
    };
    if (lineHasContent && (item.breakBefore === "mandatory"
      || canBreakBefore(item, true) && cssAdd(lineAdvance, unbreakableAdvance()) > available)) {
      breaksBefore.add(item.logicalIndex);
      suppressTrailingSpaces(item.logicalIndex);
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
  suppressTrailingSpaces(items.length);
  return result(breaksBefore, suppressed, items.length, usedAdvances, { status: "complete", lines });
}
