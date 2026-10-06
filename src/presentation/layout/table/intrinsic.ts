import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
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
import { resolveTableSizing } from "./sizing.js";
import { captionInlineSizes } from "./captions.js";
import type {
  TableCollapsedBorderHost,
  TableColumnMeasureHost,
  TableSlotGrid,
  TableSlotGridHost,
  TableSizingHost,
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface TableIntrinsicBlockSizingHost extends TableSizingHost {
  intrinsicOuterBlockSize(id: FormattingNodeId, availableInlineSize: CssPixelLength, depth: number): CssNonNegativeLength;
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
  forcedContentWidth: CssPixelLength | null = null,
): CssNonNegativeLength {
  const table = tableNode(host, node);
  if (table === null) return ZERO;
  const style = host.computed(table);
  if (style === null) return ZERO;
  const sizing = resolveTableSizing(host, table, style, availableInlineSize, null, forcedContentWidth);
  let result: CssPixelLength = sizing.contentHeight;
  if (node.kind === "table-wrapper") {
    const captionWidth = cssAdd(sizing.widthResult.usedGridWidth,
      cssAdd(cssAdd(sizing.dimensions.padding.left, sizing.dimensions.padding.right),
        cssAdd(sizing.dimensions.border.left, sizing.dimensions.border.right)));
    for (const caption of sizing.grid.captions)
      result = cssAdd(result, host.intrinsicOuterBlockSize(caption, captionWidth, depth + 1));
  }
  return cssNonNegativeLength(result);
}
