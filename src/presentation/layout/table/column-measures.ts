import type { ComputedStyle, CssLength } from "../../style/index.js";
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
  TableColumnGroupConstraintMembership,
  TableColumnMeasureHost,
  TableColumnMeasures,
  TableConstraintSource,
  TableLengthConstraint,
  TablePercentageDependence,
  TableSlotGrid,
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function sumLengths(values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

interface MutableColumnMeasure {
  intrinsicMinimum: CssNonNegativeLength;
  intrinsicPreferred: CssNonNegativeLength;
  intrinsicPercentages: TableLengthConstraint[];
  originatingColumnConstraints: TableLengthConstraint[];
  containingColumnGroupConstraints: TableColumnGroupConstraintMembership[];
  cellConstraints: TableLengthConstraint[];
  firstRowCellConstraints: TableLengthConstraint[];
  constrained: boolean;
  hasOriginatingCell: boolean;
  collapsed: boolean;
}

interface CellContribution {
  readonly constraint: TableLengthConstraint | null;
  readonly start: number;
  readonly span: number;
  readonly minimum: CssNonNegativeLength;
  readonly preferred: CssNonNegativeLength;
}

function dependence(value: CssLength): TablePercentageDependence {
  if (value.kind === "length") return value.unit === "%" ? "percentage" : "none";
  return value.kind === "calculation" ? value.calculation.percentageDependence : "none";
}

function constraintDependence(style: ComputedStyle): TablePercentageDependence {
  const values = [style.box.width, style.box.minWidth, style.box.maxWidth]
    .filter(hasSpecifiedLength);
  const dependencies = values.map(dependence);
  if (dependencies.includes("mixed")) return "mixed";
  const percentage = dependencies.includes("percentage");
  if (!percentage) return "none";
  return dependencies.some((value) => value === "none") ? "mixed" : "percentage";
}

function hasSpecifiedLength(value: CssLength): boolean {
  return value.kind !== "auto" && value.kind !== "none";
}

function constraint(
  node: { readonly id: string },
  style: ComputedStyle,
  source: TableConstraintSource,
  start: number,
  span: number,
  sourceOrder: number,
  inlineOffsets: CssNonNegativeLength = ZERO,
): TableLengthConstraint | null {
  if (!hasSpecifiedLength(style.box.width) && !hasSpecifiedLength(style.box.minWidth)
    && !hasSpecifiedLength(style.box.maxWidth)) return null;
  return Object.freeze({
    source,
    formattingNode: node.id,
    start,
    span,
    width: style.box.width,
    minWidth: style.box.minWidth,
    maxWidth: style.box.maxWidth,
    percentageDependence: constraintDependence(style),
    inlineOffsets,
    sourceOrder,
  }) as TableLengthConstraint;
}

function resolvedConstraint(
  host: TableColumnMeasureHost,
  value: CssLength,
  style: ComputedStyle,
  basis: CssPixelLength | null,
): CssNonNegativeLength | null {
  if (!hasSpecifiedLength(value)) return null;
  const resolved = host.usedLength(value, basis, style);
  return resolved === null ? null : cssNonNegativeLength(cssMax(ZERO, resolved));
}

function resolvedTableConstraint(
  host: TableColumnMeasureHost,
  value: TableLengthConstraint,
  basis: CssPixelLength | null,
): CssNonNegativeLength | null {
  const style = host.computed(host.formattingNode(value.formattingNode));
  if (style === null) return null;
  const width = resolvedConstraint(host, value.width, style, basis);
  const minimum = resolvedConstraint(host, value.minWidth, style, basis) ?? ZERO;
  const maximum = resolvedConstraint(host, value.maxWidth, style, basis);
  if (width === null && minimum <= 0) return null;
  const constrained = cssMax(
    minimum,
    maximum === null ? width ?? ZERO : cssMin(width ?? ZERO, cssMax(minimum, maximum)),
  );
  return cssNonNegativeLength(cssAdd(
    constrained,
    (value.source === "cell" || value.source === "first-row-cell")
      && style.box.boxSizing !== "border-box" ? value.inlineOffsets : ZERO,
  ));
}

function outerSpecifiedWidth(
  host: TableColumnMeasureHost,
  style: ComputedStyle,
  contribution: ReturnType<TableColumnMeasureHost["intrinsicContributions"]>,
  basis: CssPixelLength | null,
): CssNonNegativeLength | null {
  const width = resolvedConstraint(host, style.box.width, style, basis);
  if (width === null) return null;
  if (style.box.boxSizing === "border-box") return width;
  const offsets = cssMax(
    ZERO,
    cssAdd(contribution.borderBox.maxContentInlineSize, cssNegate(contribution.contentBox.maxContentInlineSize)),
  );
  return cssNonNegativeLength(cssAdd(width, offsets));
}

function distributePlannedIncrease(
  host: TableColumnMeasureHost,
  snapshot: readonly MutableColumnMeasure[],
  start: number,
  span: number,
  required: CssNonNegativeLength,
  field: "intrinsicMinimum" | "intrinsicPreferred",
  interTrackSpacing: CssNonNegativeLength,
): readonly CssNonNegativeLength[] {
  const plan = snapshot.map(() => ZERO);
  const active: number[] = [];
  let current: CssPixelLength = ZERO;
  for (let index = start; index < start + span; index += 1) {
    host.signal?.throwIfAborted();
    host.consume("maxTableColumnDistributionWork");
    const measure = snapshot[index];
    if (measure === undefined || measure.collapsed) continue;
    active.push(index);
    current = cssAdd(current, measure[field]);
  }
  current = cssAdd(current, cssMultiply(interTrackSpacing, Math.max(0, active.length - 1)));
  let remaining = cssMax(ZERO, cssAdd(required, cssNegate(current)));
  if (remaining <= 0 || active.length === 0) return plan;
  const distribute = (
    amount: CssPixelLength,
    weights: readonly CssPixelLength[],
  ): void => {
    if (amount <= 0) return;
    let totalWeight: CssPixelLength = ZERO;
    for (const weight of weights) totalWeight = cssAdd(totalWeight, weight);
    const equal = totalWeight <= 0;
    const denominator = equal ? cssPx(active.length) : totalWeight;
    let assigned: CssPixelLength = ZERO;
    for (const [position, index] of active.entries()) {
      host.signal?.throwIfAborted();
      host.consume("maxTableColumnDistributionWork");
      const weight = equal ? cssPx(1) : weights[position] ?? ZERO;
      const increment = position === active.length - 1
        ? cssAdd(amount, cssNegate(assigned))
        : cssDivide(cssMultiply(amount, weight), denominator);
      plan[index] = cssNonNegativeLength(cssAdd(plan[index] ?? ZERO, increment));
      assigned = cssAdd(assigned, increment);
    }
  };
  if (field === "intrinsicMinimum") {
    const flexibility = active.map((index) => {
      const measure = snapshot[index];
      return measure === undefined
        ? ZERO
        : cssMax(
            ZERO,
            cssAdd(measure.intrinsicPreferred, cssNegate(measure.intrinsicMinimum)),
          );
    });
    const withinPreferred = cssMin(remaining, sumLengths(flexibility));
    distribute(withinPreferred, flexibility);
    remaining = cssMax(ZERO, cssAdd(remaining, cssNegate(withinPreferred)));
  }
  distribute(
    remaining,
    active.map((index) => snapshot[index]?.intrinsicPreferred ?? ZERO),
  );
  return plan;
}

function applySpanningPhase(
  host: TableColumnMeasureHost,
  mutable: MutableColumnMeasure[],
  contributions: readonly CellContribution[],
  field: "intrinsicMinimum" | "intrinsicPreferred",
  interTrackSpacing: CssNonNegativeLength,
): void {
  const bySpan = new Map<number, CellContribution[]>();
  for (const entry of contributions) {
    if (entry.span <= 1) continue;
    const group = bySpan.get(entry.span) ?? [];
    group.push(entry);
    bySpan.set(entry.span, group);
  }
  for (const span of [...bySpan.keys()].sort((left, right) => left - right)) {
    const snapshot = mutable.map((measure) => ({ ...measure }));
    const planned = mutable.map(() => ZERO);
    const ordered = [...(bySpan.get(span) ?? [])].sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      const leftNode = left.constraint?.formattingNode ?? "";
      const rightNode = right.constraint?.formattingNode ?? "";
      return leftNode.localeCompare(rightNode);
    });
    for (const entry of ordered) {
      const required = field === "intrinsicMinimum" ? entry.minimum : entry.preferred;
      const increase = distributePlannedIncrease(
        host,
        snapshot,
        entry.start,
        entry.span,
        required,
        field,
        interTrackSpacing,
      );
      for (let index = entry.start; index < entry.start + entry.span; index += 1) {
        planned[index] = cssMax(planned[index] ?? ZERO, increase[index] ?? ZERO) as CssNonNegativeLength;
      }
    }
    for (let index = 0; index < mutable.length; index += 1) {
      const measure = mutable[index];
      if (measure === undefined) continue;
      measure[field] = cssNonNegativeLength(cssAdd(measure[field], planned[index] ?? ZERO));
      measure.intrinsicPreferred = cssMax(measure.intrinsicMinimum, measure.intrinsicPreferred) as CssNonNegativeLength;
    }
  }
}

/** Collect typed column, column-group, and cell constraints before width distribution. */
export function measureTableColumns(
  host: TableColumnMeasureHost,
  grid: TableSlotGrid,
  containingInlineSize: CssPixelLength | null,
  fixedLayout = false,
  interTrackSpacing: CssNonNegativeLength = ZERO,
): TableColumnMeasures {
  const mutable: MutableColumnMeasure[] = grid.columns.map((column) => ({
    intrinsicMinimum: ZERO,
    intrinsicPreferred: ZERO,
    intrinsicPercentages: [],
    originatingColumnConstraints: [],
    containingColumnGroupConstraints: [],
    cellConstraints: [],
    firstRowCellConstraints: [],
    constrained: false,
    hasOriginatingCell: false,
    collapsed: column.collapsed,
  }));
  let sourceOrder = 0;
  const columnConstraints: TableLengthConstraint[] = [];
  const seenColumns = new Set<string>();
  for (const column of grid.columns) {
    if (column.formattingNode === null || seenColumns.has(column.formattingNode)) continue;
    seenColumns.add(column.formattingNode);
    const matching = grid.columns.filter((entry) => entry.formattingNode === column.formattingNode);
    const node = host.formattingNode(column.formattingNode);
    const style = host.computed(node);
    if (style === null) continue;
    for (const track of matching) {
      const value = constraint(node, style, "column", track.index, 1, sourceOrder++);
      if (value === null) continue;
      columnConstraints.push(value);
      const target = mutable[track.index];
      if (target === undefined) continue;
      target.originatingColumnConstraints.push(value);
      target.constrained ||= value.percentageDependence === "none";
    }
  }

  const columnGroupConstraints: TableLengthConstraint[] = [];
  for (const groupTrack of grid.columnGroups) {
    const columns = grid.columns.filter((column) => column.columnGroup === groupTrack);
    if (columns.length === 0) continue;
    const start = columns[0]?.index ?? 0;
    const span = columns.length;
    const node = host.formattingNode(groupTrack);
    const style = host.computed(node);
    const value = style === null ? null : constraint(node, style, "column-group", start, span, sourceOrder++);
    if (value === null) continue;
    columnGroupConstraints.push(value);
    for (const column of columns) {
      const target = mutable[column.index];
      if (target === undefined) continue;
      target.containingColumnGroupConstraints.push(Object.freeze({
        constraint: value,
        spanOffset: column.index - start,
      }));
      target.constrained ||= value.percentageDependence === "none";
    }
  }

  const spanningCellConstraints: TableLengthConstraint[] = [];
  const allCellConstraints: TableLengthConstraint[] = [];
  const contributions: CellContribution[] = [];
  for (const cell of grid.cells) {
    host.signal?.throwIfAborted();
    const node = host.formattingNode(cell.formattingNode);
    const style = host.boxComputed(node) ?? host.computed(node);
    if (style === null) continue;
    const source: TableConstraintSource = cell.row === 0 ? "first-row-cell" : "cell";
    const value = constraint(
      node,
      style,
      source,
      cell.column,
      cell.columnSpan,
      sourceOrder++,
      host.inlineBoxOffsets(node, containingInlineSize ?? ZERO),
    );
    if (value !== null) {
      allCellConstraints.push(value);
      if (cell.columnSpan > 1) spanningCellConstraints.push(value);
      for (let index = cell.column; index < cell.column + cell.columnSpan; index += 1) {
        const target = mutable[index];
        if (target === undefined) continue;
        target.cellConstraints.push(value);
        if (cell.row === 0) target.firstRowCellConstraints.push(value);
        target.constrained ||= cell.columnSpan === 1 && value.percentageDependence === "none";
        if (value.percentageDependence !== "none") target.intrinsicPercentages.push(value);
      }
    }
    const originating = mutable[cell.column];
    if (originating !== undefined) originating.hasOriginatingCell = true;
    if (fixedLayout) continue;
    host.consume("maxTableIntrinsicMeasureWork");
    // A percentage cell width participates in the table width algorithm; it
    // must not become an intrinsic width by resolving it against the table's
    // containing block during contribution measurement.
    const intrinsic = host.intrinsicContributions(cell.formattingNode, null);
    const absoluteBasis = value?.percentageDependence === "none" ? containingInlineSize : ZERO;
    const specified = outerSpecifiedWidth(host, style, intrinsic, absoluteBasis);
    const minimumConstraint = resolvedConstraint(host, style.box.minWidth, style, absoluteBasis);
    const maximumConstraint = resolvedConstraint(host, style.box.maxWidth, style, absoluteBasis);
    const minimum = cssNonNegativeLength(cssMax(
      intrinsic.borderBox.minContentInlineSize,
      specified ?? ZERO,
      minimumConstraint ?? ZERO,
    ));
    let preferred = cssMax(intrinsic.borderBox.maxContentInlineSize, specified ?? ZERO, minimumConstraint ?? ZERO);
    if (maximumConstraint !== null) preferred = cssMax(minimum, cssMin(preferred, maximumConstraint));
    contributions.push(Object.freeze({
      constraint: value,
      start: cell.column,
      span: cell.columnSpan,
      minimum,
      preferred: cssNonNegativeLength(preferred),
    }));
  }

  if (!fixedLayout) {
    for (const entry of contributions.filter((value) => value.span === 1)) {
      const target = mutable[entry.start];
      if (target === undefined || target.collapsed) continue;
      target.intrinsicMinimum = cssMax(target.intrinsicMinimum, entry.minimum) as CssNonNegativeLength;
      target.intrinsicPreferred = cssMax(target.intrinsicPreferred, entry.preferred) as CssNonNegativeLength;
    }
    applySpanningPhase(host, mutable, contributions, "intrinsicMinimum", interTrackSpacing);
    applySpanningPhase(host, mutable, contributions, "intrinsicPreferred", interTrackSpacing);
  }

  const allAbsoluteConstraints = [...columnConstraints, ...columnGroupConstraints]
    .filter((value) => value.percentageDependence === "none");
  const absoluteBySpan = new Map<number, TableLengthConstraint[]>();
  for (const value of allAbsoluteConstraints) {
    const group = absoluteBySpan.get(value.span) ?? [];
    group.push(value);
    absoluteBySpan.set(value.span, group);
  }
  for (const span of [...absoluteBySpan.keys()].sort((left, right) => left - right)) {
    const snapshot = mutable.map((measure) => ({ ...measure }));
    const planned = mutable.map(() => ZERO);
    for (const value of absoluteBySpan.get(span) ?? []) {
      const required = resolvedTableConstraint(host, value, containingInlineSize);
      if (required === null) continue;
      const increase = distributePlannedIncrease(
        host,
        snapshot,
        value.start,
        value.span,
        required,
        "intrinsicMinimum",
        interTrackSpacing,
      );
      for (let index = value.start; index < value.start + value.span; index += 1) {
        planned[index] = cssMax(planned[index] ?? ZERO, increase[index] ?? ZERO) as CssNonNegativeLength;
      }
    }
    for (let index = 0; index < mutable.length; index += 1) {
      const target = mutable[index];
      if (target === undefined) continue;
      target.intrinsicMinimum = cssNonNegativeLength(
        cssAdd(target.intrinsicMinimum, planned[index] ?? ZERO),
      );
      target.intrinsicPreferred = cssMax(
        target.intrinsicPreferred,
        target.intrinsicMinimum,
      ) as CssNonNegativeLength;
    }
  }

  return Object.freeze({
    columns: Object.freeze(mutable.map((measure, index) => Object.freeze({
      index,
      intrinsicMinimum: measure.intrinsicMinimum,
      intrinsicPreferred: measure.intrinsicPreferred,
      intrinsicPercentages: Object.freeze(measure.intrinsicPercentages),
      originatingColumnConstraints: Object.freeze(measure.originatingColumnConstraints),
      containingColumnGroupConstraints: Object.freeze(measure.containingColumnGroupConstraints),
      cellConstraints: Object.freeze(measure.cellConstraints),
      firstRowCellConstraints: Object.freeze(measure.firstRowCellConstraints),
      constrained: measure.constrained,
      hasOriginatingCell: measure.hasOriginatingCell,
      collapsed: measure.collapsed,
    }))),
    constraints: Object.freeze([
      ...columnConstraints,
      ...columnGroupConstraints,
      ...allCellConstraints,
    ].filter((value, index, values) => values.findIndex((candidate) =>
      candidate.formattingNode === value.formattingNode
      && candidate.start === value.start
      && candidate.span === value.span
      && candidate.source === value.source) === index)),
    spanningCellConstraints: Object.freeze(spanningCellConstraints),
    columnGroupConstraints: Object.freeze(columnGroupConstraints),
  });
}
