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
import type {
  TableLayoutHost,
  TableRowSizingResult,
  TableSlotGrid,
  UsedTableColumn,
  UsedTableRow,
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function spanInlineSize(
  columns: readonly UsedTableColumn[],
  start: number,
  span: number,
  spacing: CssPixelLength,
): CssNonNegativeLength {
  let result: CssPixelLength = ZERO;
  let active = 0;
  for (let index = start; index < start + span; index += 1) {
    const column = columns[index];
    if (column === undefined || column.collapsed) continue;
    if (active > 0) result = cssAdd(result, spacing);
    result = cssAdd(result, column.size);
    active += 1;
  }
  return cssNonNegativeLength(result);
}

function weightedPlan(
  host: Pick<TableLayoutHost, "signal" | "consume">,
  current: readonly CssNonNegativeLength[],
  indexes: readonly number[],
  deficit: CssPixelLength,
): readonly CssNonNegativeLength[] {
  const plan = current.map(() => ZERO);
  if (deficit <= 0 || indexes.length === 0) return plan;
  const weights = indexes.map((index) => cssMax(cssPx(1), current[index] ?? ZERO));
  let total: CssPixelLength = ZERO;
  for (const weight of weights) total = cssAdd(total, weight);
  let assigned: CssPixelLength = ZERO;
  for (const [position, index] of indexes.entries()) {
    host.signal?.throwIfAborted();
    host.consume("maxTableRowDistributionWork");
    const increment = position === indexes.length - 1
      ? cssAdd(deficit, cssNegate(assigned))
      : cssDivide(cssMultiply(deficit, weights[position] ?? cssPx(1)), total);
    plan[index] = cssNonNegativeLength(increment);
    assigned = cssAdd(assigned, increment);
  }
  return plan;
}

/** Apply order-independent rowspan increases from one snapshot per span group. */
export function applyRowspanPlans(
  host: Pick<TableLayoutHost, "signal" | "consume">,
  grid: TableSlotGrid,
  sizes: CssNonNegativeLength[],
  entries: readonly {
    readonly row: number;
    readonly span: number;
    readonly required: CssNonNegativeLength;
  }[],
  autoHeight: readonly boolean[],
  verticalSpacing: CssNonNegativeLength,
): void {
  const bySpan = new Map<number, typeof entries[number][]>();
  for (const entry of entries) {
    const group = bySpan.get(entry.span) ?? [];
    group.push(entry);
    bySpan.set(entry.span, group);
  }
  for (const span of [...bySpan.keys()].sort((left, right) => left - right)) {
    const snapshot = [...sizes];
    const planned = sizes.map(() => ZERO);
    const group = [...(bySpan.get(span) ?? [])].sort((left, right) => left.row - right.row);
    for (const entry of group) {
      host.signal?.throwIfAborted();
      const active: number[] = [];
      let current: CssPixelLength = ZERO;
      for (let row = entry.row; row < entry.row + entry.span; row += 1) {
        host.consume("maxTableRowDistributionWork");
        if (grid.rows[row]?.collapsed === true) continue;
        active.push(row);
        current = cssAdd(current, snapshot[row] ?? ZERO);
      }
      current = cssAdd(current, cssMultiply(verticalSpacing, Math.max(0, active.length - 1)));
      const deficit = cssMax(ZERO, cssAdd(entry.required, cssNegate(current)));
      const automatic = active.filter((row) => autoHeight[row] === true);
      const targets = automatic.length > 0 ? automatic : active;
      const increase = weightedPlan(host, snapshot, targets, deficit);
      for (const row of targets) planned[row] = cssMax(planned[row] ?? ZERO, increase[row] ?? ZERO) as CssNonNegativeLength;
    }
    for (let row = 0; row < sizes.length; row += 1) {
      sizes[row] = cssNonNegativeLength(cssAdd(sizes[row] ?? ZERO, planned[row] ?? ZERO));
    }
  }
}

function distributeTableHeight(
  host: TableLayoutHost,
  grid: TableSlotGrid,
  base: readonly CssNonNegativeLength[],
  reference: readonly CssNonNegativeLength[],
  autoHeight: readonly boolean[],
  availableRows: CssNonNegativeLength,
): readonly CssNonNegativeLength[] {
  const active = grid.rows.filter((row) => !row.collapsed).map((row) => row.index);
  let baseSum: CssPixelLength = ZERO;
  let referenceSum: CssPixelLength = ZERO;
  for (const row of active) {
    baseSum = cssAdd(baseSum, base[row] ?? ZERO);
    referenceSum = cssAdd(referenceSum, reference[row] ?? ZERO);
  }
  if (availableRows <= baseSum) return [...base];
  if (availableRows <= referenceSum && referenceSum > baseSum) {
    const ratio = Number(cssAdd(availableRows, cssNegate(baseSum)))
      / Number(cssAdd(referenceSum, cssNegate(baseSum)));
    return base.map((value, row) => grid.rows[row]?.collapsed === true
      ? ZERO
      : cssNonNegativeLength(cssAdd(value, cssMultiply(cssAdd(reference[row] ?? value, cssNegate(value)), ratio))));
  }
  const result = [...reference];
  const deficit = cssNonNegativeLength(
    cssMax(ZERO, cssAdd(availableRows, cssNegate(referenceSum))),
  );
  const automatic = active.filter((row) => autoHeight[row] === true);
  const targets = automatic.length > 0 ? automatic : active;
  if (targets.length === 0 || deficit <= 0) return result;
  const share = cssDivide(deficit, targets.length);
  let assigned: CssPixelLength = ZERO;
  for (const [position, row] of targets.entries()) {
    host.signal?.throwIfAborted();
    host.consume("maxTableRowDistributionWork");
    const increment = position === targets.length - 1 ? cssAdd(deficit, cssNegate(assigned)) : share;
    result[row] = cssNonNegativeLength(cssAdd(result[row] ?? ZERO, increment));
    assigned = cssAdd(assigned, increment);
  }
  return result;
}

/** Resolve row base/reference sizes and rowspan constraints after column sizing. */
export function sizeTableRows(
  host: TableLayoutHost,
  grid: TableSlotGrid,
  columns: readonly UsedTableColumn[],
  horizontalSpacing: CssNonNegativeLength,
  verticalSpacing: CssNonNegativeLength,
  tableBlockSize: CssPixelLength | null,
): TableRowSizingResult {
  const base = grid.rows.map(() => ZERO);
  const reference = grid.rows.map(() => ZERO);
  const baselines = grid.rows.map(() => null as CssPixelLength | null);
  const ascents = grid.rows.map(() => ZERO);
  const descents = grid.rows.map(() => ZERO);
  const autoHeight = grid.rows.map(() => true);
  const cells = grid.cells.map((cell) => {
    host.signal?.throwIfAborted();
    host.consume("maxTableIntrinsicMeasureWork");
    const inlineSize = spanInlineSize(columns, cell.column, cell.columnSpan, horizontalSpacing);
    const intrinsic = host.intrinsicContributions(cell.formattingNode, inlineSize);
    const style = host.computed(host.formattingNode(cell.formattingNode));
    const absoluteHeight = style === null ? null : host.usedLength(style.box.height, null, style);
    const absoluteMinimum = style === null ? null : host.usedLength(style.box.minHeight, null, style);
    const resolvedHeight = style === null ? null : host.usedLength(style.box.height, tableBlockSize, style);
    const resolvedMinimum = style === null ? null : host.usedLength(style.box.minHeight, tableBlockSize, style);
    return Object.freeze({
      cell,
      base: cssNonNegativeLength(cssMax(intrinsic.borderBox.minimumBlockContribution, absoluteHeight ?? ZERO, absoluteMinimum ?? ZERO)),
      reference: cssNonNegativeLength(cssMax(intrinsic.borderBox.minimumBlockContribution, resolvedHeight ?? ZERO, resolvedMinimum ?? ZERO)),
      baseline: intrinsic.firstBaseline,
      specified: absoluteHeight !== null || resolvedHeight !== null,
    });
  });

  for (const entry of cells) {
    if (entry.cell.rowSpan !== 1) continue;
    base[entry.cell.row] = cssMax(base[entry.cell.row] ?? ZERO, entry.base) as CssNonNegativeLength;
    reference[entry.cell.row] = cssMax(reference[entry.cell.row] ?? ZERO, entry.reference) as CssNonNegativeLength;
    if (entry.specified) autoHeight[entry.cell.row] = false;
  }
  for (const row of grid.rows) {
    const style = host.computed(host.formattingNode(row.formattingNode));
    const absolute = style === null ? null : host.usedLength(style.box.height, null, style);
    const absoluteMinimum = style === null ? null : host.usedLength(style.box.minHeight, null, style);
    const resolved = style === null ? null : host.usedLength(style.box.height, tableBlockSize, style);
    const resolvedMinimum = style === null ? null : host.usedLength(style.box.minHeight, tableBlockSize, style);
    base[row.index] = row.collapsed ? ZERO : cssNonNegativeLength(cssMax(base[row.index] ?? ZERO, absolute ?? ZERO, absoluteMinimum ?? ZERO));
    reference[row.index] = row.collapsed ? ZERO : cssNonNegativeLength(cssMax(base[row.index] ?? ZERO, reference[row.index] ?? ZERO, resolved ?? ZERO, resolvedMinimum ?? ZERO));
    autoHeight[row.index] &&= absolute === null && resolved === null;

    let ascent: CssPixelLength = ZERO;
    let descent: CssPixelLength = ZERO;
    for (const entry of cells) {
      if (entry.cell.row !== row.index) continue;
      const cellStyle = host.computed(host.formattingNode(entry.cell.formattingNode));
      const align = cellStyle?.text.verticalAlign;
      const baselineAligned = align === undefined || align.kind !== "keyword"
        || (align.value !== "top" && align.value !== "middle" && align.value !== "bottom");
      if (!baselineAligned) continue;
      const baseline = entry.baseline ?? entry.base;
      ascent = cssMax(ascent, baseline);
      if (entry.cell.rowSpan === 1) {
        descent = cssMax(
          descent,
          cssMax(ZERO, cssAdd(entry.base, cssNegate(baseline))),
        );
      }
    }
    base[row.index] = cssMax(base[row.index] ?? ZERO, cssAdd(ascent, descent)) as CssNonNegativeLength;
    reference[row.index] = cssMax(reference[row.index] ?? ZERO, base[row.index] ?? ZERO) as CssNonNegativeLength;
    ascents[row.index] = cssNonNegativeLength(ascent);
    descents[row.index] = cssNonNegativeLength(descent);
    baselines[row.index] = ascent > 0 ? ascent : null;
  }

  const spanningBase = cells.filter((entry) => entry.cell.rowSpan > 1).map((entry) => ({
    row: entry.cell.row,
    span: entry.cell.rowSpan,
    required: entry.base,
  }));
  const spanningReference = cells.filter((entry) => entry.cell.rowSpan > 1).map((entry) => ({
    row: entry.cell.row,
    span: entry.cell.rowSpan,
    required: entry.reference,
  }));
  applyRowspanPlans(host, grid, base, spanningBase, autoHeight, verticalSpacing);
  applyRowspanPlans(host, grid, reference, spanningReference, autoHeight, verticalSpacing);
  for (let row = 0; row < reference.length; row += 1) reference[row] = cssMax(reference[row] ?? ZERO, base[row] ?? ZERO) as CssNonNegativeLength;

  const activeRows = grid.rows.filter((row) => !row.collapsed).length;
  const outerSpacing = cssMultiply(verticalSpacing, activeRows === 0 ? 0 : activeRows + 1);
  const availableRows = tableBlockSize === null
    ? cssNonNegativeLength(reference.reduce<CssPixelLength>((total, size) => cssAdd(total, size), ZERO))
    : cssNonNegativeLength(cssMax(ZERO, cssAdd(tableBlockSize, cssNegate(outerSpacing))));
  const finalSizes = tableBlockSize === null
    ? [...reference]
    : distributeTableHeight(host, grid, base, reference, autoHeight, availableRows);
  const rows: UsedTableRow[] = [];
  let offset: CssPixelLength = ZERO;
  let hasActive = false;
  for (let index = 0; index < finalSizes.length; index += 1) {
    const collapsed = grid.rows[index]?.collapsed === true;
    const size = collapsed ? ZERO : finalSizes[index] ?? ZERO;
    if (!collapsed) {
      offset = cssAdd(offset, verticalSpacing);
      hasActive = true;
    }
    rows.push(Object.freeze({
      index,
      offset,
      size,
      baseline: baselines[index] ?? null,
      baselineAscent: ascents[index] ?? ZERO,
      baselineDescent: descents[index] ?? ZERO,
      baseSize: base[index] ?? ZERO,
      referenceSize: reference[index] ?? ZERO,
      autoHeight: autoHeight[index] ?? true,
      collapsed,
    }));
    offset = cssAdd(offset, size);
  }
  if (hasActive) offset = cssAdd(offset, verticalSpacing);
  return Object.freeze({ rows: Object.freeze(rows), usedGridHeight: cssNonNegativeLength(offset) });
}
