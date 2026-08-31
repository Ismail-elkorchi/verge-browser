import type { FormattingNodeId } from "../../formatting/index.js";
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

/** Resolve row minimums after columns are known, so wrapped text contributes its used block size. */
export function sizeTableRows(
  host: TableLayoutHost,
  grid: TableSlotGrid,
  columns: readonly UsedTableColumn[],
  horizontalSpacing: CssNonNegativeLength,
  verticalSpacing: CssNonNegativeLength,
  tableBlockSize: CssPixelLength | null,
): TableRowSizingResult {
  const sizes = grid.rows.map(() => ZERO);
  const maximums = grid.rows.map(() => null as CssNonNegativeLength | null);
  const baselines = grid.rows.map(() => null as CssPixelLength | null);
  const cellBlocks = grid.cells.map((cell) => {
    host.signal?.throwIfAborted();
    host.consume("maxTableIntrinsicMeasureWork");
    const inlineSize = spanInlineSize(columns, cell.column, cell.columnSpan, horizontalSpacing);
    const contribution = host.intrinsicContributions(cell.formattingNode, inlineSize);
    return Object.freeze({
      cell,
      block: contribution.borderBox.minimumBlockContribution,
      baseline: contribution.firstBaseline,
    });
  });
  for (const { cell, block } of cellBlocks) {
    if (cell.rowSpan !== 1) continue;
    sizes[cell.row] = cssMax(sizes[cell.row] ?? ZERO, block) as CssNonNegativeLength;
  }
  for (const row of grid.rows) {
    let ascent: CssPixelLength = ZERO;
    let descent: CssPixelLength = ZERO;
    for (const entry of cellBlocks) {
      if (entry.cell.row !== row.index || entry.cell.rowSpan !== 1) continue;
      const style = host.computed(host.formattingNode(entry.cell.formattingNode));
      if (style?.text.verticalAlign.kind !== "keyword" || style.text.verticalAlign.value !== "baseline") continue;
      const baseline = entry.baseline ?? entry.block;
      ascent = cssMax(ascent, baseline);
      descent = cssMax(descent, cssMax(ZERO, cssAdd(entry.block, cssNegate(baseline))));
    }
    sizes[row.index] = cssMax(sizes[row.index] ?? ZERO, cssAdd(ascent, descent)) as CssNonNegativeLength;
    if (ascent > 0) baselines[row.index] = ascent;
  }
  for (const row of grid.rows) {
    const style = host.computed(host.formattingNode(row.formattingNode));
    const specified = style === null ? null : host.usedLength(style.box.height, tableBlockSize, style);
    const minimum = style === null ? null : host.usedLength(style.box.minHeight, tableBlockSize, style);
    const maximum = style === null ? null : host.usedLength(style.box.maxHeight, tableBlockSize, style);
    let used = cssMax(sizes[row.index] ?? ZERO, specified ?? ZERO, minimum ?? ZERO);
    if (maximum !== null) used = cssMin(used, maximum);
    sizes[row.index] = row.collapsed ? ZERO : cssNonNegativeLength(used);
    maximums[row.index] = row.collapsed || maximum === null
      ? (row.collapsed ? ZERO : null)
      : cssNonNegativeLength(cssMax(ZERO, maximum));
  }
  const spanningBySpan = new Map<number, typeof cellBlocks>();
  for (const entry of cellBlocks) {
    if (entry.cell.rowSpan <= 1) continue;
    host.signal?.throwIfAborted();
    host.consume("maxTableRowDistributionWork");
    const group = spanningBySpan.get(entry.cell.rowSpan) ?? [];
    group.push(entry);
    spanningBySpan.set(entry.cell.rowSpan, group);
  }
  for (const span of [...spanningBySpan.keys()].sort((left, right) => left - right)) {
    const plan = sizes.map(() => ZERO);
    for (const { cell, block } of spanningBySpan.get(span) ?? []) {
      const activeRows = grid.rows
        .slice(cell.row, cell.row + span)
        .filter((row) => !row.collapsed).length;
      let current: CssPixelLength = cssMultiply(verticalSpacing, Math.max(0, activeRows - 1));
      for (let row = cell.row; row < cell.row + span; row += 1) current = cssAdd(current, sizes[row] ?? ZERO);
      const deficit = cssMax(ZERO, cssAdd(block, cssNegate(current)));
      if (deficit <= 0) continue;
      const eligible: number[] = [];
      for (let row = cell.row; row < cell.row + span; row += 1) {
        host.signal?.throwIfAborted();
        host.consume("maxTableRowDistributionWork");
        if (grid.rows[row]?.collapsed !== true) eligible.push(row);
      }
      if (eligible.length === 0) continue;
      const share = cssDivide(deficit, eligible.length);
      let assigned: CssPixelLength = ZERO;
      for (const [position, row] of eligible.entries()) {
        host.signal?.throwIfAborted();
        host.consume("maxTableRowDistributionWork");
        const increment = position === eligible.length - 1 ? cssAdd(deficit, cssNegate(assigned)) : share;
        plan[row] = cssMax(plan[row] ?? ZERO, increment) as CssNonNegativeLength;
        assigned = cssAdd(assigned, increment);
      }
    }
    for (let row = 0; row < sizes.length; row += 1) {
      sizes[row] = cssNonNegativeLength(cssAdd(sizes[row] ?? ZERO, plan[row] ?? ZERO));
    }
  }
  const distributeDeficit = (indexes: readonly number[], deficit: CssPixelLength): void => {
    let remaining = deficit;
    let eligible = indexes.filter((index) => grid.rows[index]?.collapsed !== true
      && (maximums[index] === null || (sizes[index] ?? ZERO) < (maximums[index] ?? ZERO)));
    while (remaining > 0 && eligible.length > 0) {
      host.signal?.throwIfAborted();
      const share = cssDivide(remaining, eligible.length);
      let consumed: CssPixelLength = ZERO;
      const next: number[] = [];
      for (const index of eligible) {
        host.consume("maxTableRowDistributionWork");
        const current = sizes[index] ?? ZERO;
        const maximum = maximums[index] ?? null;
        const capacity = maximum === null ? share : cssMin(share, cssMax(ZERO, cssAdd(maximum, cssNegate(current))));
        sizes[index] = cssNonNegativeLength(cssAdd(current, capacity));
        consumed = cssAdd(consumed, capacity);
        if (maximum === null || (sizes[index] ?? ZERO) < maximum) next.push(index);
      }
      if (consumed <= 0) break;
      remaining = cssAdd(remaining, cssNegate(consumed));
      eligible = next;
    }
    const fallback = indexes.filter((index) => grid.rows[index]?.collapsed !== true);
    if (remaining <= 0 || fallback.length === 0) return;
    const share = cssDivide(remaining, fallback.length);
    let assigned: CssPixelLength = ZERO;
    for (const [position, index] of fallback.entries()) {
      host.consume("maxTableRowDistributionWork");
      const increment = position === fallback.length - 1 ? cssAdd(remaining, cssNegate(assigned)) : share;
      sizes[index] = cssNonNegativeLength(cssAdd(sizes[index] ?? ZERO, increment));
      assigned = cssAdd(assigned, increment);
    }
  };
  const rowsByGroup = new Map<FormattingNodeId, number[]>();
  for (const row of grid.rows) {
    if (row.rowGroup === null) continue;
    const indexes = rowsByGroup.get(row.rowGroup) ?? [];
    indexes.push(row.index);
    rowsByGroup.set(row.rowGroup, indexes);
  }
  for (const [groupId, indexes] of rowsByGroup) {
    const style = host.computed(host.formattingNode(groupId));
    if (style === null) continue;
    const specified = host.usedLength(style.box.height, tableBlockSize, style);
    const minimum = host.usedLength(style.box.minHeight, tableBlockSize, style) ?? ZERO;
    const active = indexes.filter((index) => grid.rows[index]?.collapsed !== true).length;
    let current: CssPixelLength = cssMultiply(verticalSpacing, Math.max(0, active - 1));
    for (const index of indexes) current = cssAdd(current, sizes[index] ?? ZERO);
    const required = cssMax(specified ?? ZERO, minimum);
    distributeDeficit(indexes, cssMax(ZERO, cssAdd(required, cssNegate(current))));
  }
  if (tableBlockSize !== null) {
    const active = grid.rows.filter((row) => !row.collapsed).length;
    let current: CssPixelLength = cssMultiply(verticalSpacing, active === 0 ? 0 : active + 1);
    for (const size of sizes) current = cssAdd(current, size);
    distributeDeficit(grid.rows.map((row) => row.index), cssMax(ZERO, cssAdd(tableBlockSize, cssNegate(current))));
  }
  const rows: UsedTableRow[] = [];
  let offset: CssPixelLength = ZERO;
  let hasActiveRow = false;
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index] ?? ZERO;
    const collapsed = grid.rows[index]?.collapsed === true;
    if (!collapsed) {
      offset = cssAdd(offset, verticalSpacing);
      hasActiveRow = true;
    }
    rows.push(Object.freeze({ index, offset, size, baseline: baselines[index] ?? null, collapsed }));
    offset = cssAdd(offset, size);
  }
  if (hasActiveRow) offset = cssAdd(offset, verticalSpacing);
  return Object.freeze({ rows: Object.freeze(rows), usedGridHeight: cssNonNegativeLength(offset) });
}
