import type { ComputedStyle, CssLength } from "../../style/index.js";
import {
  cssAdd,
  cssDivide,
  cssMax,
  cssMultiply,
  cssNegate,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import type { TableColumnMeasure, TableColumnMeasureHost, TableSlotGrid } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

interface MutableColumnMeasure {
  minimum: CssNonNegativeLength;
  preferred: CssNonNegativeLength;
  percentage: number | null;
  constrained: boolean;
  collapsed: boolean;
}

function percentage(value: CssLength): number | null {
  return value.kind === "length" && value.unit === "%" ? value.value / 100 : null;
}

function specifiedInlineSize(
  host: TableColumnMeasureHost,
  style: ComputedStyle | null,
  basis: CssPixelLength | null,
): CssNonNegativeLength | null {
  if (style === null) return null;
  const resolved = host.usedLength(style.box.width, basis, style);
  return resolved === null ? null : cssNonNegativeLength(cssMax(ZERO, resolved));
}

function distributeDeficit(
  host: TableColumnMeasureHost,
  measures: readonly MutableColumnMeasure[],
  start: number,
  span: number,
  required: CssNonNegativeLength,
  field: "minimum" | "preferred",
  interTrackSpacing: CssNonNegativeLength,
): void {
  let current: CssPixelLength = ZERO;
  const eligible: number[] = [];
  for (let index = start; index < start + span; index += 1) {
    host.consume("maxTableColumnDistributionWork");
    current = cssAdd(current, measures[index]?.[field] ?? ZERO);
    if (measures[index]?.collapsed !== true) eligible.push(index);
  }
  current = cssAdd(
    current,
    cssMultiply(interTrackSpacing, Math.max(0, eligible.length - 1)),
  );
  const deficit = cssMax(ZERO, cssAdd(required, cssNegate(current)));
  if (deficit === 0 || eligible.length === 0) return;
  const share = cssDivide(deficit, eligible.length);
  let assigned: CssPixelLength = ZERO;
  for (const [position, index] of eligible.entries()) {
    host.consume("maxTableColumnDistributionWork");
    const measure = measures[index];
    if (measure === undefined) continue;
    const increment = position === eligible.length - 1 ? cssAdd(deficit, cssNegate(assigned)) : share;
    measure[field] = cssNonNegativeLength(cssAdd(measure[field], increment));
    assigned = cssAdd(assigned, increment);
  }
}

/** Collect order-independent intrinsic column measures from the immutable slot grid. */
export function measureTableColumns(
  host: TableColumnMeasureHost,
  grid: TableSlotGrid,
  containingInlineSize: CssPixelLength | null,
  fixedLayout = false,
  interTrackSpacing: CssNonNegativeLength = ZERO,
): readonly TableColumnMeasure[] {
  const mutable: MutableColumnMeasure[] = grid.columns.map((column) => ({
    minimum: ZERO,
    preferred: ZERO,
    percentage: null,
    constrained: false,
    collapsed: column.collapsed,
  }));
  for (const column of grid.columns) {
    const node = column.formattingNode === null ? null : host.formattingNode(column.formattingNode);
    const group = column.columnGroup === null ? null : host.formattingNode(column.columnGroup);
    const style = node === null ? (group === null ? null : host.computed(group)) : host.computed(node);
    const target = mutable[column.index];
    if (target === undefined || style === null) continue;
    if (target.collapsed) continue;
    const width = specifiedInlineSize(host, style, containingInlineSize);
    if (width !== null) {
      target.minimum = cssMax(target.minimum, width) as CssNonNegativeLength;
      target.preferred = cssMax(target.preferred, width) as CssNonNegativeLength;
      target.constrained = true;
    }
    const ratio = percentage(style.box.width);
    if (ratio !== null) target.percentage = Math.max(target.percentage ?? 0, ratio);
  }
  const contributions = grid.cells
    .filter((cell) => !fixedLayout || cell.row === 0)
    .map((cell) => {
    host.signal?.throwIfAborted();
    const node = host.formattingNode(cell.formattingNode);
    const style = host.boxComputed(node) ?? host.computed(node);
    const specified = specifiedInlineSize(host, style, containingInlineSize);
    const result = (() => {
      host.consume("maxTableIntrinsicMeasureWork");
      return host.intrinsicContributions(cell.formattingNode, containingInlineSize);
    })();
    const fixedContribution = specified === null
      ? ZERO
      : result.borderBox.maxContentInlineSize;
    return Object.freeze({
      cell,
      minimum: (fixedLayout ? fixedContribution : cssMax(result.borderBox.minContentInlineSize, specified ?? ZERO)) as CssNonNegativeLength,
      preferred: (fixedLayout ? fixedContribution : cssMax(result.borderBox.maxContentInlineSize, specified ?? ZERO)) as CssNonNegativeLength,
      percentage: style === null ? null : percentage(style.box.width),
      constrained: specified !== null,
    });
  });
  for (const entry of contributions.filter((value) => value.cell.columnSpan === 1)) {
    const target = mutable[entry.cell.column];
    if (target === undefined || target.collapsed) continue;
    target.minimum = cssMax(target.minimum, entry.minimum) as CssNonNegativeLength;
    target.preferred = cssMax(target.preferred, entry.preferred) as CssNonNegativeLength;
    target.percentage = entry.percentage === null ? target.percentage : Math.max(target.percentage ?? 0, entry.percentage);
    target.constrained ||= entry.constrained;
  }
  const spanningBySpan = new Map<number, typeof contributions>();
  for (const entry of contributions) {
    if (entry.cell.columnSpan <= 1) continue;
    host.signal?.throwIfAborted();
    host.consume("maxTableColumnDistributionWork");
    const group = spanningBySpan.get(entry.cell.columnSpan) ?? [];
    group.push(entry);
    spanningBySpan.set(entry.cell.columnSpan, group);
  }
  for (const span of [...spanningBySpan.keys()].sort((left, right) => left - right)) {
    const group = spanningBySpan.get(span) ?? [];
    const minimumPlan = mutable.map(() => ZERO);
    const preferredPlan = mutable.map(() => ZERO);
    for (const entry of group) {
      const snapshot = mutable.map((measure) => ({ ...measure }));
      distributeDeficit(host, snapshot, entry.cell.column, span, entry.minimum, "minimum", interTrackSpacing);
      distributeDeficit(host, snapshot, entry.cell.column, span, entry.preferred, "preferred", interTrackSpacing);
      for (let index = entry.cell.column; index < entry.cell.column + span; index += 1) {
        const before = mutable[index];
        const after = snapshot[index];
        if (before === undefined || after === undefined) continue;
        minimumPlan[index] = cssMax(minimumPlan[index] ?? ZERO, cssAdd(after.minimum, cssNegate(before.minimum))) as CssNonNegativeLength;
        preferredPlan[index] = cssMax(preferredPlan[index] ?? ZERO, cssAdd(after.preferred, cssNegate(before.preferred))) as CssNonNegativeLength;
      }
    }
    for (let index = 0; index < mutable.length; index += 1) {
      const target = mutable[index];
      if (target === undefined) continue;
      target.minimum = cssNonNegativeLength(cssAdd(target.minimum, minimumPlan[index] ?? ZERO));
      target.preferred = cssNonNegativeLength(cssMax(target.minimum, cssAdd(target.preferred, preferredPlan[index] ?? ZERO)));
    }
  }
  return Object.freeze(mutable.map((measure, index) => Object.freeze({ index, ...measure })));
}
