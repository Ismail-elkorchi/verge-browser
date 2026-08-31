import type {
  FormattingContainerNode,
  FormattingNodeId,
} from "../../formatting/index.js";
import {
  cssAdd,
  cssCoordinateAdd,
  cssCoordinateDifference,
  cssCoordinateFromFixed,
  cssDivide,
  cssIntersection,
  cssMax,
  cssMin,
  cssNegate,
  cssNonNegativeLength,
  cssPx,
  cssRect,
  cssUnion,
  type CssCoordinate,
  type CssNonNegativeLength,
  type CssPixelLength,
  type CssRect,
} from "../fixed.js";
import { captionInlineSizes, groupTableCaptions } from "./captions.js";
import { measureTableColumns } from "./column-measures.js";
import { resolveCollapsedTableBorders } from "./collapsed-borders.js";
import { sizeTableRows } from "./row-layout.js";
import { usedTableBorderSpacing } from "./separated-borders.js";
import type {
  TableCollapsedBorderWinner,
  TableLayoutHost,
  TableLayoutOperationResult,
  TableSlotGrid,
  UsedTableColumn,
  UsedTableRow,
} from "./types.js";
import { distributeTableWidth } from "./width-distribution.js";
import type { LayoutTableCollapsedBorderSegment } from "../types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export type TableWrapperFormattingNode = FormattingContainerNode & {
  readonly kind: "table-wrapper";
};

export interface TableContainerLayoutInput {
  readonly wrapper: TableWrapperFormattingNode;
  readonly x: CssCoordinate;
  readonly y: CssCoordinate;
  readonly width: CssPixelLength;
  readonly clip: CssRect;
  readonly depth: number;
}

function point(value: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return cssCoordinateAdd(value, offset);
}

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

function areaInlineSize(
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

function areaBlockSize(
  rows: readonly UsedTableRow[],
  start: number,
  span: number,
  spacing: CssPixelLength,
): CssNonNegativeLength {
  let result: CssPixelLength = ZERO;
  let active = 0;
  for (let index = start; index < start + span; index += 1) {
    const row = rows[index];
    if (row === undefined || row.collapsed) continue;
    if (active > 0) result = cssAdd(result, spacing);
    result = cssAdd(result, row.size);
    active += 1;
  }
  return cssNonNegativeLength(result);
}

function physicalColumnX(
  direction: "ltr" | "rtl",
  contentX: CssCoordinate,
  gridWidth: CssPixelLength,
  column: UsedTableColumn,
): CssCoordinate {
  return direction === "ltr"
    ? point(contentX, column.offset)
    : point(
        contentX,
        sum(gridWidth, cssNegate(column.offset), cssNegate(column.size)),
      );
}

function physicalAreaX(
  direction: "ltr" | "rtl",
  contentX: CssCoordinate,
  gridWidth: CssPixelLength,
  columns: readonly UsedTableColumn[],
  start: number,
  span: number,
): CssCoordinate {
  let result: CssCoordinate | null = null;
  for (let index = start; index < start + span; index += 1) {
    const column = columns[index];
    if (column === undefined || column.collapsed) continue;
    const candidate = physicalColumnX(direction, contentX, gridWidth, column);
    result = result === null
      ? candidate
      : cssCoordinateFromFixed(Math.min(result, candidate));
  }
  return result ?? contentX;
}

function captionSequence(
  host: TableLayoutHost,
  ids: readonly FormattingNodeId[],
  x: CssCoordinate,
  y: CssCoordinate,
  width: CssPixelLength,
  clip: CssRect,
  depth: number,
): { readonly fragments: readonly TableLayoutOperationResult[]; readonly nextY: CssCoordinate } {
  const fragments: TableLayoutOperationResult[] = [];
  let currentY = y;
  for (const id of ids) {
    const laidOut = host.layoutChild(id, x, currentY, width, clip, depth + 1, null, null, null);
    if (laidOut === null) break;
    const free = cssMax(ZERO, sum(width, cssNegate(laidOut.marginRect.width)));
    const result = free > 0
      ? host.translate(laidOut, cssDivide(free, 2), ZERO, clip)
      : laidOut;
    fragments.push(result);
    currentY = cssCoordinateAdd(result.marginRect.y, result.marginRect.height);
  }
  return Object.freeze({ fragments: Object.freeze(fragments), nextY: currentY });
}

function rowsByGroup(grid: TableSlotGrid): ReadonlyMap<FormattingNodeId | null, readonly number[]> {
  const result = new Map<FormattingNodeId | null, number[]>();
  for (const row of grid.rows) {
    const indexes = result.get(row.rowGroup) ?? [];
    indexes.push(row.index);
    result.set(row.rowGroup, indexes);
  }
  return result;
}

export function buildCollapsedTableBorderSegments(
  host: TableLayoutHost,
  winners: readonly TableCollapsedBorderWinner[],
  columns: readonly UsedTableColumn[],
  rows: readonly UsedTableRow[],
  direction: "ltr" | "rtl",
  contentX: CssCoordinate,
  contentY: CssCoordinate,
  gridWidth: CssPixelLength,
  gridHeight: CssPixelLength,
  clipRect: CssRect,
): ReadonlyMap<FormattingNodeId, readonly LayoutTableCollapsedBorderSegment[]> {
  const active: TableCollapsedBorderWinner[] = [];
  for (const winner of winners) {
    host.signal?.throwIfAborted();
    if (winner.style === "solid" && winner.width > 0) active.push(winner);
  }
  const horizontalJunctions = new Map<string, CssNonNegativeLength>();
  const verticalJunctions = new Map<string, CssNonNegativeLength>();
  const retainJunction = (
    map: Map<string, CssNonNegativeLength>,
    column: number,
    row: number,
    width: CssNonNegativeLength,
  ): void => {
    const key = `${String(column)}:${String(row)}`;
    map.set(key, cssNonNegativeLength(cssMax(map.get(key) ?? ZERO, width)));
  };
  for (const winner of active) {
    host.signal?.throwIfAborted();
    if (winner.axis === "horizontal") {
      retainJunction(
        horizontalJunctions,
        winner.start,
        winner.line,
        winner.width,
      );
      retainJunction(
        horizontalJunctions,
        winner.end,
        winner.line,
        winner.width,
      );
    } else {
      retainJunction(
        verticalJunctions,
        winner.line,
        winner.start,
        winner.width,
      );
      retainJunction(
        verticalJunctions,
        winner.line,
        winner.end,
        winner.width,
      );
    }
  }
  const columnLine = (index: number): CssCoordinate => {
    const logical = columns.length === 0
      ? (index === 0 ? ZERO : gridWidth)
      : index >= columns.length ? gridWidth : (columns[index]?.offset ?? gridWidth);
    return direction === "ltr"
      ? point(contentX, logical)
      : point(contentX, sum(gridWidth, cssNegate(logical)));
  };
  const rowLine = (index: number): CssCoordinate => {
    const logical = rows.length === 0
      ? (index === 0 ? ZERO : gridHeight)
      : index >= rows.length ? gridHeight : (rows[index]?.offset ?? gridHeight);
    return point(contentY, logical);
  };
  const junctionWidth = (
    map: ReadonlyMap<string, CssNonNegativeLength>,
    column: number,
    row: number,
  ): CssNonNegativeLength => map.get(`${String(column)}:${String(row)}`) ?? ZERO;
  const grouped = new Map<FormattingNodeId, LayoutTableCollapsedBorderSegment[]>();
  for (const winner of active) {
    host.signal?.throwIfAborted();
    const owner = host.formattingNode(winner.ownerFormattingNode);
    const source = host.formattingNode(winner.formattingNode);
    const borderWidths = {
      top: ZERO,
      right: ZERO,
      bottom: ZERO,
      left: ZERO,
    };
    let borderRect: CssRect;
    if (winner.axis === "horizontal") {
      const first = columnLine(winner.start);
      const last = columnLine(winner.end);
      const startJunction = junctionWidth(verticalJunctions, winner.start, winner.line);
      const endJunction = junctionWidth(verticalJunctions, winner.end, winner.line);
      const x = point(
        cssCoordinateFromFixed(Math.min(first, last)),
        cssNegate(cssDivide(startJunction, 2)),
      );
      const width = cssNonNegativeLength(
        sum(
          cssCoordinateDifference(
            cssCoordinateFromFixed(Math.max(first, last)),
            cssCoordinateFromFixed(Math.min(first, last)),
          ),
          cssDivide(startJunction, 2),
          cssDivide(endJunction, 2),
        ),
      );
      const line = rowLine(winner.line);
      const y = point(line, cssNegate(cssDivide(winner.width, 2)));
      borderRect = cssRect(x, y, width, winner.width);
      borderWidths[winner.ownerSide] = winner.width;
      borderWidths.left = junctionWidth(
        verticalJunctions,
        winner.start,
        winner.line,
      );
      borderWidths.right = junctionWidth(
        verticalJunctions,
        winner.end,
        winner.line,
      );
    } else {
      const first = rowLine(winner.start);
      const last = rowLine(winner.end);
      const startJunction = junctionWidth(horizontalJunctions, winner.line, winner.start);
      const endJunction = junctionWidth(horizontalJunctions, winner.line, winner.end);
      const y = point(
        cssCoordinateFromFixed(Math.min(first, last)),
        cssNegate(cssDivide(startJunction, 2)),
      );
      const height = cssNonNegativeLength(
        sum(
          cssCoordinateDifference(
            cssCoordinateFromFixed(Math.max(first, last)),
            cssCoordinateFromFixed(Math.min(first, last)),
          ),
          cssDivide(startJunction, 2),
          cssDivide(endJunction, 2),
        ),
      );
      const line = columnLine(winner.line);
      const x = point(line, cssNegate(cssDivide(winner.width, 2)));
      borderRect = cssRect(x, y, winner.width, height);
      borderWidths[winner.ownerSide] = winner.width;
      borderWidths.top = junctionWidth(
        horizontalJunctions,
        winner.line,
        winner.start,
      );
      borderWidths.bottom = junctionWidth(
        horizontalJunctions,
        winner.line,
        winner.end,
      );
    }
    const baseStyle = host.paintStyle(source);
    const borderStyles = {
      top: "none" as const,
      right: "none" as const,
      bottom: "none" as const,
      left: "none" as const,
      [winner.ownerSide]: "solid" as const,
    };
    const borderColors = {
      top: null,
      right: null,
      bottom: null,
      left: null,
      [winner.ownerSide]: winner.color,
    };
    const segments = grouped.get(owner.id) ?? [];
    segments.push(Object.freeze({
      id: `table-collapsed-border:${winner.axis}:${String(winner.line)}:${String(winner.start)}:${String(winner.end)}:${String(winner.formattingNode)}`,
      edge: Object.freeze({
        axis: winner.axis,
        line: winner.line,
        start: winner.start,
        end: winner.end,
      }),
      paintPhase: "collapsed-border" as const,
      formattingNode: winner.formattingNode,
      documentNode: source.source,
      sourceRange: source.sourceRange,
      side: winner.ownerSide,
      borderRect,
      borderWidths: Object.freeze(borderWidths),
      clipRect,
      style: Object.freeze({
        ...baseStyle,
        background: null,
        borderStyles: Object.freeze(borderStyles),
        borderColors: Object.freeze(borderColors),
      }),
    }));
    grouped.set(owner.id, segments);
  }
  const result = new Map<FormattingNodeId, readonly LayoutTableCollapsedBorderSegment[]>();
  for (const [id, segments] of grouped) {
    host.signal?.throwIfAborted();
    result.set(id, Object.freeze(segments));
  }
  return result;
}

/** Own the complete horizontal-writing-mode table formatting context. */
export function layoutTableContainer(
  host: TableLayoutHost,
  input: TableContainerLayoutInput,
): TableLayoutOperationResult {
  return host.withTableBudget(() => {
    const table = input.wrapper.children
      .map((id) => host.formattingNode(id))
      .find((node) => node.kind === "table");
    if (table === undefined) {
      const empty = cssRect(input.x, input.y, ZERO, ZERO);
      return host.container(input.wrapper, empty, empty, empty, empty, input.clip, [], []);
    }
    const style = host.computed(table);
    if (style === null) {
      const empty = cssRect(input.x, input.y, ZERO, ZERO);
      return host.container(input.wrapper, empty, empty, empty, empty, input.clip, [], []);
    }
    const grid = host.tableSlotGrid(table);
    const collapsedWinners = style.box.borderCollapse === "collapse"
      ? resolveCollapsedTableBorders(
          host,
          grid,
          table,
          input.width,
        )
      : Object.freeze([]);
    const initialDimensions = host.dimensions(table, input.width, null, null);
    const spacing = usedTableBorderSpacing(host, style, initialDimensions.contentWidth);
    const fixedLayout = style.box.tableLayout === "fixed" && host.usedLength(style.box.width, input.width, style) !== null;
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
    const dimensions = host.dimensions(table, input.width, null, widthResult.usedGridWidth);
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
    const hasActiveColumns = widthResult.columns.some((column) => !column.collapsed);
    const hasActiveRows = rows.rows.some((row) => !row.collapsed);
    const outerX = point(input.x, dimensions.marginLeft);
    const top = captionSequence(host, captions.top, outerX, input.y, sum(widthResult.usedGridWidth, dimensions.padding.left, dimensions.padding.right, dimensions.border.left, dimensions.border.right), input.clip, input.depth);
    const tableMarginY = top.nextY;
    const borderX = outerX;
    const borderY = point(tableMarginY, dimensions.margin.top);
    const paddingX = point(borderX, dimensions.border.left);
    const paddingY = point(borderY, dimensions.border.top);
    const contentX = point(paddingX, dimensions.padding.left);
    const contentY = point(paddingY, dimensions.padding.top);
    let contentHeight = cssMax(rows.usedGridHeight, dimensions.specifiedHeight ?? ZERO, dimensions.minHeight);
    if (dimensions.maxHeight !== null) contentHeight = cssMin(contentHeight, dimensions.maxHeight);
    const constrainedContentHeight = cssNonNegativeLength(contentHeight);
    const contentRect = cssRect(contentX, contentY, widthResult.usedGridWidth, constrainedContentHeight);
    const paddingRect = cssRect(
      paddingX,
      paddingY,
      sum(contentRect.width, dimensions.padding.left, dimensions.padding.right),
      sum(contentRect.height, dimensions.padding.top, dimensions.padding.bottom),
    );
    const borderRect = cssRect(
      borderX,
      borderY,
      sum(paddingRect.width, dimensions.border.left, dimensions.border.right),
      sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom),
    );
    const tableMarginRect = cssRect(
      input.x,
      tableMarginY,
      sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight),
      sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom),
    );
    const tableClip = host.clip(table, paddingRect, borderRect, input.clip);
    for (const [owner, segments] of buildCollapsedTableBorderSegments(
      host,
      collapsedWinners,
      widthResult.columns,
      rows.rows,
      style.text.direction,
      contentX,
      contentY,
      widthResult.usedGridWidth,
      contentRect.height,
      tableClip,
    )) {
      host.registerCollapsedBorderSegments(owner, segments);
    }
    if (style.box.position !== "static") host.registerPositionedContainingBlock(table.id, paddingRect);
    const cellsByRow = new Map<number, typeof grid.cells[number][]>();
    for (const cell of grid.cells) {
      const cells = cellsByRow.get(cell.row) ?? [];
      cells.push(cell);
      cellsByRow.set(cell.row, cells);
    }
    const layoutOwnedOutOfFlow = (
      owner: FormattingNodeId,
      containingBlock: CssRect,
      depth: number,
    ): readonly TableLayoutOperationResult[] => {
      const fragments: TableLayoutOperationResult[] = [];
      const ownerNode = host.formattingNode(owner);
      const ownerEstablishesContainingBlock = host.computed(ownerNode)?.box.position !== "static";
      for (const entry of grid.outOfFlow) {
        if (entry.containingTableBox !== owner) continue;
        const node = host.formattingNode(entry.formattingNode);
        const fixed = host.computed(node)?.box.position === "fixed";
        const result = host.layoutOutOfFlow(
          node,
          containingBlock.x,
          containingBlock.y,
          tableClip,
          depth,
          fixed || !ownerEstablishesContainingBlock ? undefined : containingBlock,
        );
        if (result === null) break;
        fragments.push(result);
      }
      return fragments;
    };
    const layoutCell = (cell: typeof grid.cells[number]): TableLayoutOperationResult | null => {
      host.signal?.throwIfAborted();
      const areaWidth = areaInlineSize(widthResult.columns, cell.column, cell.columnSpan, spacing.horizontal);
      const areaHeight = areaBlockSize(rows.rows, cell.row, cell.rowSpan, spacing.vertical);
      const areaX = physicalAreaX(
        style.text.direction,
        contentX,
        widthResult.usedGridWidth,
        widthResult.columns,
        cell.column,
        cell.columnSpan,
      );
      const firstActiveRow = rows.rows
        .slice(cell.row, cell.row + cell.rowSpan)
        .find((row) => !row.collapsed);
      const areaY = point(contentY, firstActiveRow?.offset ?? ZERO);
      const cellNode = host.formattingNode(cell.formattingNode);
      if (areaWidth === 0 || areaHeight === 0) {
        return host.tryContainerReservation(() => {
          const empty = cssRect(areaX, areaY, ZERO, ZERO);
          return host.container(
            cellNode,
            empty,
            empty,
            empty,
            empty,
            empty,
            [],
            [],
          );
        });
      }
      const cellDimensions = host.dimensions(cellNode, areaWidth, areaHeight, null);
      const forcedWidth = cssNonNegativeLength(
        cssMax(
          ZERO,
          sum(
            areaWidth,
            cssNegate(cellDimensions.padding.left),
            cssNegate(cellDimensions.padding.right),
            cssNegate(cellDimensions.border.left),
            cssNegate(cellDimensions.border.right),
          ),
        ),
      );
      const forcedHeight = cssNonNegativeLength(
        cssMax(
          ZERO,
          sum(
            areaHeight,
            cssNegate(cellDimensions.padding.top),
            cssNegate(cellDimensions.padding.bottom),
            cssNegate(cellDimensions.border.top),
            cssNegate(cellDimensions.border.bottom),
          ),
        ),
      );
      const result = host.layoutChild(cell.formattingNode, areaX, areaY, areaWidth, tableClip, input.depth + 3, areaHeight, forcedWidth, forcedHeight);
      if (result === null) return null;
      const fragment = host.fragment(result.fragment);
      const verticalAlign = host.computed(cellNode)?.text.verticalAlign;
      if (fragment !== undefined && verticalAlign?.kind === "keyword" && (verticalAlign.value === "middle" || verticalAlign.value === "bottom")) {
        let contentBottom = fragment.contentRect.y;
        for (const child of fragment.children) {
          const childFragment = host.fragment(child);
          if (childFragment !== undefined) contentBottom = cssCoordinateFromFixed(Math.max(contentBottom, cssCoordinateAdd(childFragment.marginRect.y, childFragment.marginRect.height)));
        }
        const occupied = cssNonNegativeLength(cssMax(ZERO, cssCoordinateDifference(contentBottom, fragment.contentRect.y)));
        const free = cssMax(
          ZERO,
          sum(fragment.contentRect.height, cssNegate(occupied)),
        );
        host.translateChildren(result, verticalAlign.value === "middle" ? Math.trunc(free / 2) as CssPixelLength : free, tableClip);
      }
      return result;
    };
    const layoutRow = (rowIndex: number): TableLayoutOperationResult | null =>
      host.tryContainerReservation(() => {
        const row = grid.rows[rowIndex];
        const used = rows.rows[rowIndex];
        if (row === undefined || used === undefined) throw new RangeError("Table row geometry is incomplete.");
        const cellFragments = new Map<FormattingNodeId, TableLayoutOperationResult>();
        for (const cell of cellsByRow.get(rowIndex) ?? []) {
          const result = layoutCell(cell);
          if (result === null) break;
          cellFragments.set(cell.formattingNode, result);
        }
        const baselineCells = (cellsByRow.get(rowIndex) ?? [])
          .map((cell) => ({ cell, result: cellFragments.get(cell.formattingNode) }))
          .filter((entry) => {
            if (entry.result === undefined) return false;
            const alignment = host.computed(
              host.formattingNode(entry.cell.formattingNode),
            )?.text.verticalAlign;
            return alignment === undefined || alignment.kind !== "keyword"
              || (alignment.value !== "top"
                && alignment.value !== "middle"
                && alignment.value !== "bottom");
          });
        let sharedBaseline: CssPixelLength = ZERO;
        for (const entry of baselineCells) {
          const fragment = entry.result === undefined ? undefined : host.fragment(entry.result.fragment);
          if (fragment?.baseline !== null && fragment?.baseline !== undefined) sharedBaseline = cssMax(sharedBaseline, fragment.baseline);
        }
        for (const entry of baselineCells) {
          if (entry.result === undefined) continue;
          const fragment = host.fragment(entry.result.fragment);
          if (fragment?.baseline === null || fragment?.baseline === undefined) continue;
          const offset = sum(sharedBaseline, cssNegate(fragment.baseline));
          if (offset > 0) host.translateChildren(entry.result, offset, tableClip);
        }
        const rowX = hasActiveColumns ? point(contentX, spacing.horizontal) : contentX;
        const rowY = point(contentY, used.offset);
        const rowWidth = cssNonNegativeLength(
          cssMax(
            ZERO,
            sum(
              widthResult.usedGridWidth,
              cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
              cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
            ),
          ),
        );
        const rect = cssRect(rowX, rowY, rowWidth, used.size);
        const rowNode = host.formattingNode(row.formattingNode);
        if (host.computed(rowNode)?.box.position !== "static") {
          host.registerPositionedContainingBlock(row.formattingNode, rect);
        }
        const positioned = layoutOwnedOutOfFlow(
          row.formattingNode,
          rect,
          input.depth + 4,
        );
        return host.container(
          host.formattingNode(row.formattingNode),
          rect,
          rect,
          rect,
          rect,
          tableClip,
          [...cellFragments.values(), ...positioned].map(
            (entry) => entry.fragment,
          ),
          [],
        );
      });
    const buildRoot = (): TableLayoutOperationResult => {
      const structuralChildren: TableLayoutOperationResult[] = [];
      for (const columnGroupId of grid.columnGroups) {
        const group = host.tryContainerReservation(() => {
          const tracks = grid.columns.filter((column) => column.columnGroup === columnGroupId);
          const columnChildren: TableLayoutOperationResult[] = [];
          for (const track of tracks) {
            if (track.formattingNode === null) continue;
            const used = widthResult.columns[track.index];
            if (used === undefined) continue;
            const x = physicalColumnX(style.text.direction, contentX, widthResult.usedGridWidth, used);
            const columnY = hasActiveRows ? point(contentY, spacing.vertical) : contentY;
            const columnHeight = cssNonNegativeLength(cssMax(
              ZERO,
              sum(
                rows.usedGridHeight,
                cssNegate(hasActiveRows ? spacing.vertical : ZERO),
                cssNegate(hasActiveRows ? spacing.vertical : ZERO),
              ),
            ));
            const rect = cssRect(x, columnY, used.size, columnHeight);
            const columnNode = host.formattingNode(track.formattingNode);
            if (host.computed(columnNode)?.box.position !== "static") {
              host.registerPositionedContainingBlock(track.formattingNode, rect);
            }
            const column = host.tryContainerReservation(() => host.container(host.formattingNode(track.formattingNode as FormattingNodeId), rect, rect, rect, rect, tableClip, [], []));
            if (column === null) break;
            columnChildren.push(column);
          }
          const groupRect = tracks.length === 0 ? cssRect(contentX, contentY, ZERO, ZERO) : cssUnion(tracks.map((track) => {
            const used = widthResult.columns[track.index];
            const columnY = hasActiveRows ? point(contentY, spacing.vertical) : contentY;
            const columnHeight = cssNonNegativeLength(cssMax(
              ZERO,
              sum(
                rows.usedGridHeight,
                cssNegate(hasActiveRows ? spacing.vertical : ZERO),
                cssNegate(hasActiveRows ? spacing.vertical : ZERO),
              ),
            ));
            return used === undefined ? cssRect(contentX, columnY, ZERO, columnHeight) : cssRect(physicalColumnX(style.text.direction, contentX, widthResult.usedGridWidth, used), columnY, used.size, columnHeight);
          }), contentRect);
          const columnGroupNode = host.formattingNode(columnGroupId);
          if (host.computed(columnGroupNode)?.box.position !== "static") {
            host.registerPositionedContainingBlock(columnGroupId, groupRect);
          }
          const positioned = layoutOwnedOutOfFlow(
            columnGroupId,
            groupRect,
            input.depth + 3,
          );
          return host.container(host.formattingNode(columnGroupId), groupRect, groupRect, groupRect, groupRect, tableClip, [...columnChildren, ...positioned].map((entry) => entry.fragment), []);
        });
        if (group === null) break;
        structuralChildren.push(group);
      }
      for (const column of grid.columns.filter((entry) => entry.columnGroup === null && entry.formattingNode !== null)) {
        const used = widthResult.columns[column.index];
        if (used === undefined || column.formattingNode === null) continue;
        const columnY = hasActiveRows ? point(contentY, spacing.vertical) : contentY;
        const columnHeight = cssNonNegativeLength(cssMax(
          ZERO,
          sum(
            rows.usedGridHeight,
            cssNegate(hasActiveRows ? spacing.vertical : ZERO),
            cssNegate(hasActiveRows ? spacing.vertical : ZERO),
          ),
        ));
        const rect = cssRect(physicalColumnX(style.text.direction, contentX, widthResult.usedGridWidth, used), columnY, used.size, columnHeight);
        const columnNode = host.formattingNode(column.formattingNode);
        if (host.computed(columnNode)?.box.position !== "static") {
          host.registerPositionedContainingBlock(column.formattingNode, rect);
        }
        const fragment = host.tryContainerReservation(() => host.container(host.formattingNode(column.formattingNode as FormattingNodeId), rect, rect, rect, rect, tableClip, [], []));
        if (fragment === null) break;
        structuralChildren.push(fragment);
      }
      const groupedRows = rowsByGroup(grid);
      for (const sequenceEntry of grid.rowSequence) {
        if (sequenceEntry.kind === "row") {
          const row = layoutRow(sequenceEntry.row);
          if (row === null) break;
          structuralChildren.push(row);
          continue;
        }
        const groupId = sequenceEntry.formattingNode;
        const group = host.tryContainerReservation(() => {
          const indexes = groupedRows.get(groupId) ?? [];
          const children: TableLayoutOperationResult[] = [];
          for (const index of indexes) {
            const row = layoutRow(index);
            if (row === null) break;
            children.push(row);
          }
          const first = indexes[0] === undefined ? undefined : rows.rows[indexes[0]];
          const lastIndex = indexes[indexes.length - 1];
          const last = lastIndex === undefined ? undefined : rows.rows[lastIndex];
          const rect = first === undefined || last === undefined
            ? cssRect(
                hasActiveColumns ? point(contentX, spacing.horizontal) : contentX,
                contentY,
                cssNonNegativeLength(cssMax(
                  ZERO,
                  sum(
                    widthResult.usedGridWidth,
                    cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
                    cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
                  ),
                )),
                ZERO,
              )
            : cssRect(
                hasActiveColumns ? point(contentX, spacing.horizontal) : contentX,
                point(contentY, first.offset),
                cssNonNegativeLength(cssMax(
                  ZERO,
                  sum(
                    widthResult.usedGridWidth,
                    cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
                    cssNegate(hasActiveColumns ? spacing.horizontal : ZERO),
                  ),
                )),
                cssNonNegativeLength(
                  sum(last.offset, last.size, cssNegate(first.offset)),
                ),
              );
          const rowGroupNode = host.formattingNode(groupId);
          if (host.computed(rowGroupNode)?.box.position !== "static") {
            host.registerPositionedContainingBlock(groupId, rect);
          }
          const positioned = layoutOwnedOutOfFlow(
            groupId,
            rect,
            input.depth + 3,
          );
          return host.container(host.formattingNode(groupId), rect, rect, rect, rect, tableClip, [...children, ...positioned].map((entry) => entry.fragment), []);
        });
        if (group === null) break;
        structuralChildren.push(group);
      }
      structuralChildren.push(
        ...layoutOwnedOutOfFlow(table.id, paddingRect, input.depth + 2),
      );
      return host.container(table, contentRect, paddingRect, borderRect, tableMarginRect, tableClip, structuralChildren.map((entry) => entry.fragment), []);
    };
    const root = host.tryContainerReservation(buildRoot);
    const bottomStart = point(tableMarginRect.y, tableMarginRect.height);
    const bottom = root === null
      ? Object.freeze({ fragments: Object.freeze([]), nextY: bottomStart })
      : captionSequence(host, captions.bottom, outerX, bottomStart, borderRect.width, input.clip, input.depth);
    const all = root === null ? [...top.fragments] : [...top.fragments, root, ...bottom.fragments];
    const wrapperRect = cssUnion(all.map((entry) => entry.marginRect), cssRect(input.x, input.y, ZERO, ZERO));
    return host.container(input.wrapper, wrapperRect, wrapperRect, wrapperRect, wrapperRect, cssIntersection(input.clip, wrapperRect), all.map((entry) => entry.fragment), []);
  });
}
