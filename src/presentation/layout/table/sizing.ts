import type { FormattingNode } from "../../formatting/index.js";
import type { ComputedStyle } from "../../style/index.js";
import { cssMax, cssMin, cssNonNegativeLength, cssPx, type CssPixelLength } from "../fixed.js";
import { captionInlineSizes, groupTableCaptions } from "./captions.js";
import { measureTableColumns } from "./column-measures.js";
import { resolveCollapsedTableBorders } from "./collapsed-borders.js";
import { sizeTableRows } from "./row-layout.js";
import { usedTableBorderSpacing } from "./separated-borders.js";
import { distributeTableWidth } from "./width-distribution.js";
import type { TableSizingHost } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

/** Resolve columns before rows for both intrinsic and final table geometry. */
export function resolveTableSizing(
  host: TableSizingHost,
  table: FormattingNode,
  style: ComputedStyle,
  availableInlineSize: CssPixelLength,
) {
  const grid = host.tableSlotGrid(table);
  const collapsedWinners = style.box.borderCollapse === "collapse"
    ? resolveCollapsedTableBorders(
      host,
      grid,
      table,
      availableInlineSize,
    )
    : Object.freeze([]);
  const initialDimensions = host.dimensions(table, availableInlineSize, null, null);
  const spacing = usedTableBorderSpacing(host, style, initialDimensions.contentWidth);
  const fixedLayout = style.box.tableLayout === "fixed" && host.usedLength(style.box.width, availableInlineSize, style) !== null;
  const measures = measureTableColumns(
    host,
    grid,
    initialDimensions.contentWidth,
    fixedLayout,
    spacing.horizontal,
  );
  const captions = groupTableCaptions(host, grid);
  const captionMinimum = captionInlineSizes(
    host,
    [...captions.top, ...captions.bottom],
    initialDimensions.contentWidth,
  ).minimum;
  const widthResult = distributeTableWidth(
    host,
    style,
    measures,
    cssNonNegativeLength(initialDimensions.contentWidth),
    spacing.horizontal,
    captionMinimum,
  );
  const dimensions = host.dimensions(table, availableInlineSize, null, widthResult.usedGridWidth);
  let tableBlockSize = cssMax(initialDimensions.specifiedHeight ?? ZERO, initialDimensions.minHeight);
  if (initialDimensions.maxHeight !== null) tableBlockSize = cssMin(tableBlockSize, initialDimensions.maxHeight);
  const rows = sizeTableRows(
    host,
    grid,
    widthResult.columns,
    spacing.horizontal,
    spacing.vertical,
    initialDimensions.specifiedHeight === null && initialDimensions.minHeight === 0
    ? null
    : cssNonNegativeLength(tableBlockSize),
  );
  let contentHeight = cssMax(rows.usedGridHeight, dimensions.specifiedHeight ?? ZERO, dimensions.minHeight);
  if (dimensions.maxHeight !== null) contentHeight = cssMin(contentHeight, dimensions.maxHeight);
  return { grid, collapsedWinners, spacing, captions, widthResult, dimensions, rows,
    contentHeight: cssNonNegativeLength(contentHeight) };
}
