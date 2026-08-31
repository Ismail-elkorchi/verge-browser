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
import type {
  TableColumnMeasure,
  TableColumnMeasures,
  TableLayoutHost,
  TableLengthConstraint,
  TableWidthResult,
  UsedTableColumn,
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function sum(values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

function resolveConstraint(
  host: TableLayoutHost,
  value: TableLengthConstraint,
  basis: CssPixelLength | null,
): CssNonNegativeLength | null {
  const style = host.computed(host.formattingNode(value.formattingNode));
  if (style === null) return null;
  const resolved = host.usedLength(value.width, basis, style);
  const minimum = host.usedLength(value.minWidth, basis, style) ?? ZERO;
  const maximum = host.usedLength(value.maxWidth, basis, style);
  if (resolved === null && minimum <= 0) return null;
  const preferred = resolved ?? ZERO;
  const constrained = cssNonNegativeLength(cssMax(
    ZERO,
    minimum,
    maximum === null ? preferred : cssMin(preferred, cssMax(minimum, maximum)),
  ));
  return value.source === "cell" || value.source === "first-row-cell"
    ? cssNonNegativeLength(cssAdd(
        constrained,
        style.box.boxSizing === "border-box" ? ZERO : value.inlineOffsets,
      ))
    : constrained;
}

function activeIndexes(measures: readonly TableColumnMeasure[]): number[] {
  return measures.filter((measure) => !measure.collapsed).map((measure) => measure.index);
}

function distributeWeighted(
  host: TableLayoutHost,
  sizes: CssNonNegativeLength[],
  indexes: readonly number[],
  extra: CssPixelLength,
  weights: readonly CssPixelLength[],
): void {
  if (extra <= 0 || indexes.length === 0) return;
  const totalWeight = sum(weights);
  const equal = totalWeight <= 0;
  const denominator = equal ? cssPx(indexes.length) : totalWeight;
  let assigned: CssPixelLength = ZERO;
  for (const [position, index] of indexes.entries()) {
    host.signal?.throwIfAborted();
    host.consume("maxTableColumnDistributionWork");
    const weight = equal ? cssPx(1) : weights[position] ?? ZERO;
    const increment = position === indexes.length - 1
      ? cssAdd(extra, cssNegate(assigned))
      : cssDivide(cssMultiply(extra, weight), denominator);
    sizes[index] = cssNonNegativeLength(cssAdd(sizes[index] ?? ZERO, increment));
    assigned = cssAdd(assigned, increment);
  }
}

function distributeEqual(
  host: TableLayoutHost,
  sizes: CssNonNegativeLength[],
  indexes: readonly number[],
  extra: CssPixelLength,
): void {
  distributeWeighted(host, sizes, indexes, extra, indexes.map(() => cssPx(1)));
}

function distributeCombinedConstraint(
  host: TableLayoutHost,
  sizes: CssNonNegativeLength[],
  measures: readonly TableColumnMeasure[],
  constraint: TableLengthConstraint,
  required: CssNonNegativeLength,
  spacing: CssNonNegativeLength,
  eligible?: ReadonlySet<number>,
): void {
  const active: number[] = [];
  const targets: number[] = [];
  let current: CssPixelLength = ZERO;
  for (let index = constraint.start; index < constraint.start + constraint.span; index += 1) {
    host.signal?.throwIfAborted();
    host.consume("maxTableColumnDistributionWork");
    if (measures[index]?.collapsed === true) continue;
    active.push(index);
    current = cssAdd(current, sizes[index] ?? ZERO);
    if (eligible === undefined || eligible.has(index)) targets.push(index);
  }
  current = cssAdd(current, cssMultiply(spacing, Math.max(0, active.length - 1)));
  distributeEqual(
    host,
    sizes,
    targets,
    cssMax(ZERO, cssAdd(required, cssNegate(current))),
  );
}

function usedColumns(
  measures: readonly TableColumnMeasure[],
  sizes: readonly CssNonNegativeLength[],
  spacing: CssNonNegativeLength,
): { readonly columns: readonly UsedTableColumn[]; readonly width: CssNonNegativeLength } {
  const columns: UsedTableColumn[] = [];
  let offset: CssPixelLength = ZERO;
  let hasActive = false;
  for (let index = 0; index < measures.length; index += 1) {
    const collapsed = measures[index]?.collapsed === true;
    const size = collapsed ? ZERO : sizes[index] ?? ZERO;
    if (!collapsed) {
      offset = cssAdd(offset, spacing);
      hasActive = true;
    }
    columns.push(Object.freeze({ index, offset, size, collapsed }));
    offset = cssAdd(offset, size);
  }
  if (hasActive) offset = cssAdd(offset, spacing);
  return Object.freeze({ columns: Object.freeze(columns), width: cssNonNegativeLength(offset) });
}

function tableWidthTarget(
  host: TableLayoutHost,
  style: ComputedStyle,
  availableInlineSize: CssNonNegativeLength,
  minimum: CssNonNegativeLength,
  maximum: CssNonNegativeLength,
  captionMinimum: CssNonNegativeLength,
): CssNonNegativeLength {
  const declared = host.usedLength(style.box.width, availableInlineSize, style);
  let target = declared === null
    ? (cssMax(maximum, captionMinimum) <= availableInlineSize
        ? cssMax(maximum, captionMinimum)
        : cssMax(minimum, captionMinimum, availableInlineSize))
    : cssMax(declared, minimum, captionMinimum);
  const minWidth = host.usedLength(style.box.minWidth, availableInlineSize, style);
  const maxWidth = host.usedLength(style.box.maxWidth, availableInlineSize, style);
  if (minWidth !== null) target = cssMax(target, minWidth);
  if (maxWidth !== null) target = cssMax(minimum, captionMinimum, cssMin(target, maxWidth));
  return cssNonNegativeLength(target);
}

function percentageTrackRequests(
  host: TableLayoutHost,
  measurements: TableColumnMeasures,
  basis: CssNonNegativeLength,
  spacing: CssNonNegativeLength,
): readonly CssNonNegativeLength[] {
  const requests = measurements.columns.map(() => ZERO);
  const percentageConstraints = measurements.constraints
    .filter((value) => value.percentageDependence !== "none")
    .sort((left, right) => left.span - right.span || left.sourceOrder - right.sourceOrder);
  const bySpan = new Map<number, TableLengthConstraint[]>();
  for (const value of percentageConstraints) {
    const values = bySpan.get(value.span) ?? [];
    values.push(value);
    bySpan.set(value.span, values);
  }
  for (const span of [...bySpan.keys()].sort((left, right) => left - right)) {
    const snapshot = [...requests];
    const planned = requests.map(() => ZERO);
    for (const value of bySpan.get(span) ?? []) {
      host.signal?.throwIfAborted();
      const resolved = resolveConstraint(host, value, basis);
      if (resolved === null) continue;
      const active: number[] = [];
      let current: CssPixelLength = ZERO;
      for (let index = value.start; index < value.start + value.span; index += 1) {
        host.consume("maxTableColumnDistributionWork");
        if (measurements.columns[index]?.collapsed === true) continue;
        active.push(index);
        current = cssAdd(current, snapshot[index] ?? ZERO);
      }
      current = cssAdd(current, cssMultiply(spacing, Math.max(0, active.length - 1)));
      const deficit = cssNonNegativeLength(cssMax(ZERO, cssAdd(resolved, cssNegate(current))));
      const zeroPercentage = active.filter((index) => (snapshot[index] ?? ZERO) === 0);
      const targets = zeroPercentage.length > 0 ? zeroPercentage : active;
      if (targets.length === 0 || deficit <= 0) continue;
      const weights = targets.map((index) =>
        cssMax(ZERO, measurements.columns[index]?.intrinsicPreferred ?? ZERO));
      const increases = requests.map(() => ZERO);
      distributeWeighted(host, increases, targets, deficit, weights);
      for (const index of targets) {
        planned[index] = cssMax(planned[index] ?? ZERO, increases[index] ?? ZERO) as CssNonNegativeLength;
      }
    }
    for (let index = 0; index < requests.length; index += 1) {
      requests[index] = cssNonNegativeLength(cssAdd(snapshot[index] ?? ZERO, planned[index] ?? ZERO));
    }
  }

  // The intrinsic percentage sum is capped in logical column order. Logical
  // order maps to physical left in LTR and physical right in RTL.
  let remaining: CssPixelLength = basis;
  for (const measure of measurements.columns) {
    if (measure.collapsed) continue;
    const request = cssMin(requests[measure.index] ?? ZERO, remaining);
    requests[measure.index] = cssNonNegativeLength(request);
    remaining = cssMax(ZERO, cssAdd(remaining, cssNegate(request)));
  }
  return Object.freeze(requests);
}

function interpolateGuesses(
  host: TableLayoutHost,
  lower: readonly CssNonNegativeLength[],
  upper: readonly CssNonNegativeLength[],
  target: CssNonNegativeLength,
): CssNonNegativeLength[] {
  const lowerSum = sum(lower);
  const upperSum = sum(upper);
  if (target <= lowerSum || upperSum <= lowerSum) return [...lower];
  if (target >= upperSum) return [...upper];
  const numerator = cssAdd(target, cssNegate(lowerSum));
  const denominator = cssAdd(upperSum, cssNegate(lowerSum));
  const result = [...lower];
  let assigned: CssPixelLength = lowerSum;
  const growing = lower.map((value, index) => (upper[index] ?? value) > value ? index : -1)
    .filter((index) => index >= 0);
  for (const [position, index] of growing.entries()) {
    host.signal?.throwIfAborted();
    host.consume("maxTableColumnDistributionWork");
    const capacity = cssAdd(upper[index] ?? ZERO, cssNegate(lower[index] ?? ZERO));
    const increment = position === growing.length - 1
      ? cssMin(capacity, cssAdd(target, cssNegate(assigned)))
      : cssDivide(cssMultiply(capacity, numerator), denominator);
    result[index] = cssNonNegativeLength(cssAdd(result[index] ?? ZERO, increment));
    assigned = cssAdd(assigned, increment);
  }
  return result;
}

function automaticWidths(
  host: TableLayoutHost,
  style: ComputedStyle,
  measurements: TableColumnMeasures,
  availableInlineSize: CssNonNegativeLength,
  horizontalSpacing: CssNonNegativeLength,
  captionMinimum: CssNonNegativeLength,
): TableWidthResult {
  const measures = measurements.columns;
  const active = activeIndexes(measures);
  const spacing = cssMultiply(horizontalSpacing, active.length === 0 ? 0 : active.length + 1);
  const minimumTracks = sum(measures.map((measure) => measure.intrinsicMinimum));
  const preferredTracks = sum(measures.map((measure) => measure.intrinsicPreferred));
  const tableMinimum = cssNonNegativeLength(cssAdd(minimumTracks, spacing));
  const tableMaximum = cssNonNegativeLength(cssMax(tableMinimum, cssAdd(preferredTracks, spacing)));
  const targetGrid = tableWidthTarget(host, style, availableInlineSize, tableMinimum, tableMaximum, captionMinimum);
  const targetTracks = cssNonNegativeLength(cssMax(ZERO, cssAdd(targetGrid, cssNegate(spacing))));
  const percentageRequests = percentageTrackRequests(host, measurements, targetTracks, horizontalSpacing);
  const measureAt = (index: number): TableColumnMeasure => {
    const measure = measures[index];
    if (measure === undefined) throw new RangeError(`Unknown table column measure: ${String(index)}`);
    return measure;
  };

  const minimumGuess = measures.map((measure) => measure.collapsed ? ZERO : measure.intrinsicMinimum);
  const percentageGuess = measures.map((measure) => measure.collapsed
    ? ZERO
    : cssNonNegativeLength(cssMax(measure.intrinsicMinimum, percentageRequests[measure.index] ?? ZERO)));
  const specifiedGuess = measures.map((measure) => {
    if (measure.collapsed) return ZERO;
    if ((percentageRequests[measure.index] ?? ZERO) > 0) return percentageGuess[measure.index] ?? ZERO;
    return measure.constrained ? measure.intrinsicPreferred : measure.intrinsicMinimum;
  });
  const preferredGuess = measures.map((measure) => measure.collapsed
    ? ZERO
    : (percentageRequests[measure.index] ?? ZERO) > 0
      ? percentageGuess[measure.index] ?? ZERO
      : measure.intrinsicPreferred);

  let sizes: CssNonNegativeLength[];
  if (targetTracks <= sum(minimumGuess)) sizes = [...minimumGuess];
  else if (targetTracks <= sum(percentageGuess)) {
    sizes = interpolateGuesses(host, minimumGuess, percentageGuess, targetTracks);
  } else if (targetTracks <= sum(specifiedGuess)) {
    sizes = interpolateGuesses(host, percentageGuess, specifiedGuess, targetTracks);
  } else if (targetTracks <= sum(preferredGuess)) {
    sizes = interpolateGuesses(host, specifiedGuess, preferredGuess, targetTracks);
  } else {
    sizes = [...preferredGuess];
    const extra = cssMax(ZERO, cssAdd(targetTracks, cssNegate(sum(sizes))));
    const zeroPercentage = (index: number): boolean => (percentageRequests[index] ?? ZERO) === 0;
    const categories = [
      active.filter((index) => measureAt(index).hasOriginatingCell
        && !measureAt(index).constrained && zeroPercentage(index)
        && measureAt(index).intrinsicPreferred > 0),
      active.filter((index) => measureAt(index).hasOriginatingCell
        && !measureAt(index).constrained && zeroPercentage(index)),
      active.filter((index) => measureAt(index).hasOriginatingCell
        && measureAt(index).constrained && zeroPercentage(index)
        && measureAt(index).intrinsicPreferred > 0),
      active.filter((index) => measureAt(index).hasOriginatingCell
        && (percentageRequests[index] ?? ZERO) > 0),
      active.filter((index) => measureAt(index).hasOriginatingCell),
      active,
    ];
    const targets = categories.find((value) => value.length > 0) ?? [];
    const proportional = targets.every((index) => measureAt(index).intrinsicPreferred > 0);
    const percentageCategory = targets.every((index) => (percentageRequests[index] ?? ZERO) > 0);
    const weights = targets.map((index) => percentageCategory
      ? percentageRequests[index] ?? ZERO
      : proportional ? measureAt(index).intrinsicPreferred : cssPx(1));
    distributeWeighted(host, sizes, targets, extra, weights);
  }
  const resolved = usedColumns(measures, sizes, horizontalSpacing);
  return Object.freeze({
    mode: "auto",
    columns: resolved.columns,
    tableMinContentWidth: cssNonNegativeLength(cssMax(tableMinimum, captionMinimum)),
    tableMaxContentWidth: cssNonNegativeLength(cssMax(tableMaximum, captionMinimum)),
    usedGridWidth: cssNonNegativeLength(cssMax(resolved.width, targetGrid)),
  });
}

function fixedWidths(
  host: TableLayoutHost,
  style: ComputedStyle,
  measurements: TableColumnMeasures,
  availableInlineSize: CssNonNegativeLength,
  horizontalSpacing: CssNonNegativeLength,
  captionMinimum: CssNonNegativeLength,
): TableWidthResult {
  const measures = measurements.columns;
  const active = activeIndexes(measures);
  const spacing = cssMultiply(horizontalSpacing, active.length === 0 ? 0 : active.length + 1);
  const declared = host.usedLength(style.box.width, availableInlineSize, style) ?? availableInlineSize;
  let targetTracks = cssNonNegativeLength(cssMax(ZERO, cssAdd(declared, cssNegate(spacing))));
  const sizes = measures.map(() => ZERO);
  const assigned = new Set<number>();
  const absoluteAssigned = new Set<number>();
  const percentageAssigned = new Set<number>();

  for (const index of active) {
    const measure = measures[index];
    if (measure === undefined) continue;
    let width: CssPixelLength = ZERO;
    for (const value of measure.originatingColumnConstraints) {
      const resolved = resolveConstraint(host, value, targetTracks);
      if (resolved !== null) width = cssMax(width, resolved);
    }
    if (width > 0 || measure.originatingColumnConstraints.length > 0) {
      sizes[index] = cssNonNegativeLength(width);
      assigned.add(index);
      if (measure.originatingColumnConstraints.some((value) => value.percentageDependence === "none")) {
        absoluteAssigned.add(index);
      } else {
        percentageAssigned.add(index);
      }
    }
  }
  for (const value of measurements.columnGroupConstraints) {
    const required = resolveConstraint(host, value, targetTracks);
    if (required === null) continue;
    const indexes = new Set(active.filter((index) => index >= value.start && index < value.start + value.span));
    distributeCombinedConstraint(host, sizes, measures, value, required, horizontalSpacing, indexes);
    for (const index of indexes) {
      assigned.add(index);
      (value.percentageDependence === "none" ? absoluteAssigned : percentageAssigned).add(index);
    }
  }
  const firstRow = new Map<string, TableLengthConstraint>();
  for (const measure of measures) {
    for (const value of measure.firstRowCellConstraints) {
      firstRow.set(`${value.formattingNode}:${String(value.start)}:${String(value.span)}`, value);
    }
  }
  for (const value of [...firstRow.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    const required = resolveConstraint(host, value, targetTracks);
    if (required === null) continue;
    const eligible = new Set(active.filter((index) => index >= value.start
      && index < value.start + value.span && !assigned.has(index)));
    if (eligible.size === 0) continue;
    distributeCombinedConstraint(host, sizes, measures, value, required, horizontalSpacing, eligible);
    for (const index of eligible) {
      assigned.add(index);
      (value.percentageDependence === "none" ? absoluteAssigned : percentageAssigned).add(index);
    }
  }
  const unassigned = active.filter((index) => !assigned.has(index));
  distributeEqual(host, sizes, unassigned, cssMax(ZERO, cssAdd(targetTracks, cssNegate(sum(sizes)))));
  const requiredTracks = sum(sizes);
  targetTracks = cssNonNegativeLength(cssMax(targetTracks, requiredTracks));
  const extra = cssMax(ZERO, cssAdd(targetTracks, cssNegate(requiredTracks)));
  if (extra > 0 && unassigned.length === 0) {
    const absolute = active.filter((index) => absoluteAssigned.has(index) && (sizes[index] ?? ZERO) > 0);
    const percentage = active.filter((index) => percentageAssigned.has(index) && (sizes[index] ?? ZERO) > 0);
    const nonzero = absolute.length > 0 ? absolute : percentage;
    const targets = nonzero.length > 0 ? nonzero : active;
    distributeWeighted(host, sizes, targets, extra, targets.map((index) => sizes[index] ?? ZERO));
  }
  const resolved = usedColumns(measures, sizes, horizontalSpacing);
  const constrainedWidth = cssNonNegativeLength(cssMax(resolved.width, declared, captionMinimum));
  return Object.freeze({
    mode: "fixed",
    columns: resolved.columns,
    tableMinContentWidth: constrainedWidth,
    tableMaxContentWidth: constrainedWidth,
    usedGridWidth: constrainedWidth,
  });
}

/** Dispatch to the sole fixed or automatic horizontal table-width algorithm. */
export function distributeTableWidth(
  host: TableLayoutHost,
  style: ComputedStyle,
  measurements: TableColumnMeasures,
  availableInlineSize: CssNonNegativeLength,
  horizontalSpacing: CssNonNegativeLength,
  captionMinimum: CssNonNegativeLength = ZERO,
): TableWidthResult {
  const fixed = style.box.tableLayout === "fixed"
    && host.usedLength(style.box.width, availableInlineSize, style) !== null;
  return fixed
    ? fixedWidths(host, style, measurements, availableInlineSize, horizontalSpacing, captionMinimum)
    : automaticWidths(host, style, measurements, availableInlineSize, horizontalSpacing, captionMinimum);
}
