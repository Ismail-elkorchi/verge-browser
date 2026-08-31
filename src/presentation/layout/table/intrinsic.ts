import type { DocumentNodeRef, HtmlTableCellMetadata } from "../../../document/index.js";
import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { ComputedStyle, CssLength } from "../../style/index.js";
import {
  cssAdd,
  cssDivide,
  cssMax,
  cssNegate,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import { measureTableColumns } from "./column-measures.js";
import { resolveCollapsedTableBorders } from "./collapsed-borders.js";
import { buildTableSlotGrid } from "./slot-grid.js";
import { captionInlineSizes } from "./captions.js";
import type { TableCollapsedBorderHost, TableColumnMeasureHost, TableSlotGridHost } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface TableIntrinsicBlockSizingHost {
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  htmlTableCell(node: DocumentNodeRef): HtmlTableCellMetadata | null;
  isOutOfFlow(node: FormattingNode): boolean;
  usedLength(value: CssLength, basis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  intrinsicOuterBlockSize(id: FormattingNodeId, availableInlineSize: CssPixelLength, depth: number): CssNonNegativeLength;
  consumeIntrinsicWork(): void;
}

export interface TableIntrinsicInlineSizingHost extends TableSlotGridHost, TableColumnMeasureHost, TableCollapsedBorderHost {}

export interface TableIntrinsicInlineSizes {
  readonly minContent: CssNonNegativeLength;
  readonly maxContent: CssNonNegativeLength;
}

interface IntrinsicRow {
  readonly node: FormattingNode;
  readonly group: FormattingNodeId | null;
  readonly cells: readonly FormattingNode[];
}

function tableNode(
  host: { formattingNode(id: FormattingNodeId): FormattingNode },
  node: FormattingNode,
): FormattingNode | null {
  if (node.kind === "table") return node;
  for (const child of node.children) {
    const candidate = host.formattingNode(child);
    if (candidate.kind === "table") return candidate;
  }
  return null;
}

function collectRows(host: TableIntrinsicBlockSizingHost, table: FormattingNode): IntrinsicRow[] {
  const rows: IntrinsicRow[] = [];
  for (const childId of table.children) {
    const child = host.formattingNode(childId);
    if (host.isOutOfFlow(child)) continue;
    if (child.kind === "table-row") rows.push({ node: child, group: null, cells: child.children.map((id) => host.formattingNode(id)).filter((node) => node.kind === "table-cell" && !host.isOutOfFlow(node)) });
    else if (child.kind === "table-header-group" || child.kind === "table-body-group" || child.kind === "table-footer-group") {
      for (const rowId of child.children) {
        const row = host.formattingNode(rowId);
        if (row.kind === "table-row" && !host.isOutOfFlow(row)) rows.push({ node: row, group: child.id, cells: row.children.map((id) => host.formattingNode(id)).filter((node) => node.kind === "table-cell" && !host.isOutOfFlow(node)) });
      }
    }
  }
  return rows;
}

/** Derive table intrinsic inline contributions from the shared slot and column models. */
export function intrinsicTableInlineSizes(
  host: TableIntrinsicInlineSizingHost,
  node: FormattingNode,
): TableIntrinsicInlineSizes {
  const table = tableNode(host, node);
  if (table === null) return Object.freeze({ minContent: ZERO, maxContent: ZERO });
  const style = host.computed(table);
  if (style === null) return Object.freeze({ minContent: ZERO, maxContent: ZERO });
  const grid = buildTableSlotGrid(host, table);
  if (style.box.borderCollapse === "collapse")
    resolveCollapsedTableBorders(host, grid, table, ZERO);
  const spacing = style.box.borderCollapse === "collapse"
    ? ZERO
    : cssNonNegativeLength(cssMax(
        ZERO,
        host.usedLength(style.box.borderSpacing.horizontal, null, style) ?? ZERO,
      ));
  const measures = measureTableColumns(host, grid, null, false, spacing);
  const activeColumns = measures.filter((measure) => !measure.collapsed).length;
  let minimum: CssPixelLength = cssMultiply(spacing, activeColumns === 0 ? 0 : activeColumns + 1);
  let maximum: CssPixelLength = minimum;
  for (const measure of measures) {
    minimum = cssAdd(minimum, measure.minimum);
    maximum = cssAdd(maximum, measure.preferred);
  }
  const captions = captionInlineSizes(host, grid.captions, null);
  minimum = cssMax(minimum, captions.minimum);
  maximum = cssMax(maximum, captions.maximum);
  return Object.freeze({
    minContent: cssNonNegativeLength(minimum),
    maxContent: cssNonNegativeLength(cssMax(minimum, maximum)),
  });
}

/** Intrinsic table block contribution used by Flex, Grid, nested tables, and shrink-to-fit callers. */
export function intrinsicTableBlockSize(
  host: TableIntrinsicBlockSizingHost,
  node: FormattingNode,
  availableInlineSize: CssPixelLength,
  depth: number,
): CssNonNegativeLength {
  const table = tableNode(host, node);
  if (table === null) return ZERO;
  const style = host.computed(table);
  const verticalSpacing = style !== null && style.box.borderCollapse === "separate"
    ? cssNonNegativeLength(cssMax(
        ZERO,
        host.usedLength(style.box.borderSpacing.vertical, availableInlineSize, style) ?? ZERO,
      ))
    : ZERO;
  const rows = collectRows(host, table);
  const sizes = rows.map(() => ZERO);
  const spanning: { row: number; span: number; size: CssNonNegativeLength }[] = [];
  const rowGroupEnd = new Map<FormattingNodeId, number>();
  for (const [rowIndex, row] of rows.entries()) {
    if (row.group !== null) rowGroupEnd.set(row.group, rowIndex + 1);
  }
  for (const [rowIndex, row] of rows.entries()) {
    host.signal?.throwIfAborted();
    host.consumeIntrinsicWork();
    for (const cell of row.cells) {
      host.signal?.throwIfAborted();
      host.consumeIntrinsicWork();
      const metadata = cell.source === null ? null : host.htmlTableCell(cell.source);
      const groupEnd = row.group === null ? rows.length : rowGroupEnd.get(row.group) ?? rowIndex + 1;
      const requested = metadata?.rowSpan ?? 1;
      const span = requested === "remaining-row-group"
        ? Math.max(1, groupEnd - rowIndex)
        : Math.max(1, Math.min(requested, groupEnd - rowIndex));
      const size = host.intrinsicOuterBlockSize(cell.id, availableInlineSize, depth + 1);
      if (span === 1) sizes[rowIndex] = cssMax(sizes[rowIndex] ?? ZERO, size) as CssNonNegativeLength;
      else spanning.push({ row: rowIndex, span: Math.min(span, rows.length - rowIndex), size });
    }
  }
  const spanningBySpan = new Map<number, typeof spanning>();
  for (const entry of spanning) {
    host.signal?.throwIfAborted();
    host.consumeIntrinsicWork();
    const group = spanningBySpan.get(entry.span) ?? [];
    group.push(entry);
    spanningBySpan.set(entry.span, group);
  }
  for (const span of [...spanningBySpan.keys()].sort((left, right) => left - right)) {
    const plan = sizes.map(() => ZERO);
    for (const entry of spanningBySpan.get(span) ?? []) {
      host.signal?.throwIfAborted();
      let current: CssPixelLength = cssMultiply(verticalSpacing, Math.max(0, entry.span - 1));
      for (let row = entry.row; row < entry.row + entry.span; row += 1) {
        host.consumeIntrinsicWork();
        current = cssAdd(current, sizes[row] ?? ZERO);
      }
      const deficit = cssMax(ZERO, cssAdd(entry.size, cssNegate(current)));
      const share = cssDivide(deficit, entry.span);
      let assigned: CssPixelLength = ZERO;
      for (let offset = 0; offset < entry.span; offset += 1) {
        host.consumeIntrinsicWork();
        const increment = offset === entry.span - 1 ? cssAdd(deficit, cssNegate(assigned)) : share;
        plan[entry.row + offset] = cssMax(plan[entry.row + offset] ?? ZERO, increment) as CssNonNegativeLength;
        assigned = cssAdd(assigned, increment);
      }
    }
    for (let row = 0; row < sizes.length; row += 1) {
      sizes[row] = cssNonNegativeLength(cssAdd(sizes[row] ?? ZERO, plan[row] ?? ZERO));
    }
  }
  let result: CssPixelLength = ZERO;
  for (const size of sizes) result = cssAdd(result, size);
  if (style !== null && style.box.borderCollapse === "separate")
    result = cssAdd(result, cssMultiply(verticalSpacing, rows.length + 1));
  for (const childId of table.children) {
    const child = host.formattingNode(childId);
    if (child.kind === "table-caption" && !host.isOutOfFlow(child)) result = cssAdd(result, host.intrinsicOuterBlockSize(child.id, availableInlineSize, depth + 1));
  }
  return cssNonNegativeLength(result);
}
