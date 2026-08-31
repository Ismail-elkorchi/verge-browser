import type { ComputedStyle } from "../../style/index.js";
import {
  cssAdd,
  cssDivide,
  cssMax,
  cssMin,
  cssMultiply,
  cssNegate,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import type { TableColumnMeasure, TableLayoutHost, TableWidthResult, UsedTableColumn } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function sum(values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

function distribute(
  host: TableLayoutHost,
  sizes: CssNonNegativeLength[],
  capacity: readonly CssNonNegativeLength[],
  extra: CssPixelLength,
): CssPixelLength {
  let remaining = extra;
  let active = sizes.map((_, index) => index).filter((index) => (capacity[index] ?? ZERO) > (sizes[index] ?? ZERO));
  while (remaining > 0 && active.length > 0) {
    host.signal?.throwIfAborted();
    const share = cssDivide(remaining, active.length);
    let consumed: CssPixelLength = ZERO;
    const next: number[] = [];
    for (const index of active) {
      host.consume("maxTableColumnDistributionWork");
      const current = sizes[index] ?? ZERO;
      const limit = capacity[index] ?? current;
      const increment = cssMin(share, cssAdd(limit, cssNegate(current)));
      sizes[index] = cssNonNegativeLength(cssAdd(current, increment));
      consumed = cssAdd(consumed, increment);
      if ((sizes[index] ?? ZERO) < limit) next.push(index);
    }
    if (consumed <= 0) break;
    remaining = cssAdd(remaining, cssNegate(consumed));
    active = next;
  }
  return remaining;
}

/** Resolve automatic or fixed table column widths without an equal-width fallback. */
export function distributeTableWidth(
  host: TableLayoutHost,
  style: ComputedStyle,
  measures: readonly TableColumnMeasure[],
  availableInlineSize: CssNonNegativeLength,
  horizontalSpacing: CssNonNegativeLength,
  minimumUsedGridWidth: CssNonNegativeLength = ZERO,
): TableWidthResult {
  const active = measures.filter((measure) => !measure.collapsed);
  const spacing = cssMultiply(horizontalSpacing, active.length + (active.length === 0 ? 0 : 1));
  const availableTracks = cssNonNegativeLength(cssMax(ZERO, cssAdd(availableInlineSize, cssNegate(spacing))));
  const minimums = measures.map((measure) => measure.minimum);
  const preferred = measures.map((measure) => cssMax(measure.minimum, measure.preferred) as CssNonNegativeLength);
  const minimumSum = sum(minimums);
  const preferredSum = sum(preferred);
  const definiteWidth = host.usedLength(style.box.width, availableInlineSize, style);
  const fixed = style.box.tableLayout === "fixed" && definiteWidth !== null;
  let target = fixed
    ? availableTracks
    : cssNonNegativeLength(cssMin(cssMax(minimumSum, availableTracks), preferredSum));
  target = cssMax(
    target,
    cssMax(ZERO, cssAdd(minimumUsedGridWidth, cssNegate(spacing))),
  ) as CssNonNegativeLength;
  const minimumConstraint = host.usedLength(style.box.minWidth, availableInlineSize, style);
  const maximumConstraint = host.usedLength(style.box.maxWidth, availableInlineSize, style);
  if (minimumConstraint !== null) target = cssMax(target, minimumConstraint) as CssNonNegativeLength;
  if (maximumConstraint !== null) target = cssMax(minimumSum, cssMin(target, maximumConstraint)) as CssNonNegativeLength;
  target = cssMax(target, minimumSum) as CssNonNegativeLength;
  const sizes = fixed ? measures.map((measure) => !measure.collapsed && measure.constrained ? measure.preferred : ZERO) : measures.map((measure) => measure.collapsed ? ZERO : measure.minimum);
  for (const measure of measures) {
    if (measure.collapsed) continue;
    if (measure.percentage === null) continue;
    const required = cssNonNegativeLength(cssMax(ZERO, cssMultiply(target, measure.percentage)));
    sizes[measure.index] = cssMax(sizes[measure.index] ?? ZERO, required) as CssNonNegativeLength;
  }
  let remaining = cssMax(ZERO, cssAdd(target, cssNegate(sum(sizes))));
  remaining = distribute(host, sizes, preferred, remaining);
  let expandable = measures.map((measure, index) => measure.collapsed || (fixed && measure.constrained) ? -1 : index).filter((index) => index >= 0);
  if (expandable.length === 0 && remaining > 0) expandable = measures.map((measure, index) => measure.collapsed ? -1 : index).filter((index) => index >= 0);
  if (remaining > 0 && expandable.length > 0) {
    const share = cssDivide(remaining, expandable.length);
    let assigned: CssPixelLength = ZERO;
    for (const [position, index] of expandable.entries()) {
      host.consume("maxTableColumnDistributionWork");
      const increment = position === expandable.length - 1 ? cssAdd(remaining, cssNegate(assigned)) : share;
      sizes[index] = cssNonNegativeLength(cssAdd(sizes[index] ?? ZERO, increment));
      assigned = cssAdd(assigned, increment);
    }
  }
  const columns: UsedTableColumn[] = [];
  let offset: CssPixelLength = ZERO;
  let hasActiveColumn = false;
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index] ?? ZERO;
    const collapsed = measures[index]?.collapsed === true;
    if (!collapsed) {
      offset = cssAdd(offset, horizontalSpacing);
      hasActiveColumn = true;
    }
    columns.push(Object.freeze({ index, offset, size, collapsed }));
    offset = cssAdd(offset, size);
  }
  if (hasActiveColumn) offset = cssAdd(offset, horizontalSpacing);
  return Object.freeze({
    mode: fixed ? "fixed" : "auto",
    columns: Object.freeze(columns),
    tableMinContentWidth: cssNonNegativeLength(cssMax(minimumUsedGridWidth, cssAdd(minimumSum, spacing))),
    tableMaxContentWidth: cssNonNegativeLength(cssMax(minimumUsedGridWidth, cssAdd(preferredSum, spacing))),
    usedGridWidth: cssNonNegativeLength(offset),
  });
}
