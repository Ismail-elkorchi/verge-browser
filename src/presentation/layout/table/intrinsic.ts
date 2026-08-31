import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { ComputedStyle, CssLength } from "../../style/index.js";
import {
  cssAdd,
  cssMax,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import { measureTableColumns } from "./column-measures.js";
import { resolveCollapsedTableBorders } from "./collapsed-borders.js";
import { applyRowspanPlans } from "./row-layout.js";
import { captionInlineSizes } from "./captions.js";
import type {
  TableCollapsedBorderHost,
  TableColumnMeasureHost,
  TableSlotGrid,
  TableSlotGridHost,
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface TableIntrinsicBlockSizingHost extends TableSlotGridHost {
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  usedLength(value: CssLength, basis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  intrinsicOuterBlockSize(id: FormattingNodeId, availableInlineSize: CssPixelLength, depth: number): CssNonNegativeLength;
  tableSlotGrid(table: FormattingNode): TableSlotGrid;
}

export interface TableIntrinsicInlineSizingHost extends TableSlotGridHost, TableColumnMeasureHost, TableCollapsedBorderHost {
  tableSlotGrid(table: FormattingNode): TableSlotGrid;
}

export interface TableIntrinsicInlineSizes {
  readonly minContent: CssNonNegativeLength;
  readonly maxContent: CssNonNegativeLength;
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

/** Derive table intrinsic inline contributions from the shared slot and column models. */
export function intrinsicTableInlineSizes(
  host: TableIntrinsicInlineSizingHost,
  node: FormattingNode,
): TableIntrinsicInlineSizes {
  const table = tableNode(host, node);
  if (table === null) return Object.freeze({ minContent: ZERO, maxContent: ZERO });
  const style = host.computed(table);
  if (style === null) return Object.freeze({ minContent: ZERO, maxContent: ZERO });
  const grid = host.tableSlotGrid(table);
  if (style.box.borderCollapse === "collapse")
    resolveCollapsedTableBorders(host, grid, table, ZERO);
  const spacing = style.box.borderCollapse === "collapse"
    ? ZERO
    : cssNonNegativeLength(cssMax(
        ZERO,
        host.usedLength(style.box.borderSpacing.horizontal, null, style) ?? ZERO,
      ));
  const measurements = measureTableColumns(host, grid, null, false, spacing);
  const activeColumns = measurements.columns.filter((measure) => !measure.collapsed).length;
  let minimum: CssPixelLength = cssMultiply(spacing, activeColumns === 0 ? 0 : activeColumns + 1);
  let maximum: CssPixelLength = minimum;
  for (const measure of measurements.columns) {
    minimum = cssAdd(minimum, measure.intrinsicMinimum);
    maximum = cssAdd(maximum, measure.intrinsicPreferred);
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
  const grid = host.tableSlotGrid(table);
  const sizes = grid.rows.map(() => ZERO);
  const automatic = grid.rows.map(() => true);
  const spanning: { row: number; span: number; size: CssNonNegativeLength }[] = [];
  for (const row of grid.rows) {
    host.signal?.throwIfAborted();
    host.consume("maxTableIntrinsicMeasureWork");
    const rowStyle = host.computed(host.formattingNode(row.formattingNode));
    const specified = rowStyle === null ? null : host.usedLength(rowStyle.box.height, null, rowStyle);
    const minimum = rowStyle === null ? null : host.usedLength(rowStyle.box.minHeight, null, rowStyle);
    sizes[row.index] = row.collapsed
      ? ZERO
      : cssNonNegativeLength(cssMax(sizes[row.index] ?? ZERO, specified ?? ZERO, minimum ?? ZERO));
    automatic[row.index] = specified === null;
  }
  for (const cell of grid.cells) {
    host.signal?.throwIfAborted();
    host.consume("maxTableIntrinsicMeasureWork");
    const size = host.intrinsicOuterBlockSize(cell.formattingNode, availableInlineSize, depth + 1);
    if (cell.rowSpan === 1) {
      sizes[cell.row] = cssMax(sizes[cell.row] ?? ZERO, size) as CssNonNegativeLength;
    } else {
      spanning.push({ row: cell.row, span: cell.rowSpan, size });
    }
  }
  applyRowspanPlans(
    host,
    grid,
    sizes,
    spanning.map((entry) => ({ row: entry.row, span: entry.span, required: entry.size })),
    automatic,
    verticalSpacing,
  );
  let result: CssPixelLength = ZERO;
  for (const size of sizes) result = cssAdd(result, size);
  if (style !== null && style.box.borderCollapse === "separate")
    result = cssAdd(
      result,
      cssMultiply(
        verticalSpacing,
        grid.rows.some((row) => !row.collapsed)
          ? grid.rows.filter((row) => !row.collapsed).length + 1
          : 0,
      ),
    );
  for (const caption of grid.captions) {
    result = cssAdd(
      result,
      host.intrinsicOuterBlockSize(caption, availableInlineSize, depth + 1),
    );
  }
  return cssNonNegativeLength(result);
}
