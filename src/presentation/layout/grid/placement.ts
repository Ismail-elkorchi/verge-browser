import type { CssGridLine } from "../../style/index.js";
import { SparseGridOccupancy } from "./auto-placement.js";
import {
  GridWorkBudgetExceeded,
  type ExpandedGridAxis,
  type GridAreaPlacement,
  type GridItemPlacementInput,
  type GridPlacementInput,
  type GridPlacementResult
} from "./types.js";

interface PlacementWork {
  steps: number;
  named: number;
  readonly input: GridPlacementInput;
}

interface ResolvedAxis {
  readonly start: number | null;
  readonly end: number | null;
  readonly span: number;
  readonly automaticSpan: CssGridLine;
}

const DEFAULT_AUTOMATIC_SPAN: CssGridLine = Object.freeze({
  kind: "line",
  span: true,
  index: 1,
  name: null
});

function step(work: PlacementWork): void {
  work.input.signal?.throwIfAborted();
  if (work.steps >= work.input.limits.maxGridPlacementSteps) {
    throw new GridWorkBudgetExceeded("maxGridPlacementSteps", work.input.limits.maxGridPlacementSteps);
  }
  work.steps += 1;
}

function namedResolution(work: PlacementWork): void {
  if (work.named >= work.input.limits.maxGridNamedLineResolutions) {
    throw new GridWorkBudgetExceeded("maxGridNamedLineResolutions", work.input.limits.maxGridNamedLineResolutions);
  }
  work.named += 1;
}

function namedPosition(
  line: Extract<CssGridLine, { readonly kind: "line" }>,
  edge: "start" | "end",
  axis: ExpandedGridAxis,
  work: PlacementWork
): number | null {
  if (line.name === null) return null;
  namedResolution(work);
  const direct = axis.namedLines.get(line.name);
  const area = axis.namedLines.get(`${line.name}-${edge}`);
  const positions = line.index === null && area !== undefined && area.length > 0
    ? area
    : direct ?? [];
  const occurrence = line.index ?? 1;
  if (positions.length === 0) {
    return occurrence > 0 ? axis.tracks.length + occurrence : occurrence;
  }
  const index = occurrence > 0 ? occurrence - 1 : positions.length + occurrence;
  if (index >= 0 && index < positions.length) return positions[index] ?? null;
  return occurrence > 0
    ? axis.tracks.length + (index - positions.length + 1)
    : index;
}

function definiteLine(
  line: CssGridLine,
  edge: "start" | "end",
  axis: ExpandedGridAxis,
  work: PlacementWork
): number | null {
  if (line.kind === "auto" || line.span) return null;
  const named = namedPosition(line, edge, axis, work);
  if (named !== null) return named;
  const index = line.index ?? 1;
  return index > 0 ? index - 1 : axis.tracks.length + 1 + index;
}

function span(line: CssGridLine): number {
  if (line.kind !== "line" || !line.span) return 1;
  return Math.max(1, line.index ?? 1);
}

function spanBoundary(
  line: CssGridLine,
  from: number,
  direction: 1 | -1,
  axis: ExpandedGridAxis,
  work: PlacementWork
): number {
  const distance = span(line);
  if (line.kind !== "line" || !line.span || line.name === null) return from + direction * distance;
  namedResolution(work);
  const positions = axis.namedLines.get(line.name) ?? [];
  let remaining = distance;
  if (direction > 0) {
    for (const position of positions) {
      namedResolution(work);
      if (position <= from) continue;
      remaining -= 1;
      if (remaining === 0) return position;
    }
  } else {
    for (let index = positions.length - 1; index >= 0; index -= 1) {
      namedResolution(work);
      const position = positions[index];
      if (position === undefined || position >= from) continue;
      remaining -= 1;
      if (remaining === 0) return position;
    }
  }
  return direction > 0
    ? Math.max(axis.tracks.length, from) + remaining
    : Math.min(0, from) - remaining;
}

function resolvedAxis(
  startLine: CssGridLine,
  endLine: CssGridLine,
  axis: ExpandedGridAxis,
  work: PlacementWork
): ResolvedAxis {
  let start = definiteLine(startLine, "start", axis, work);
  let end = definiteLine(endLine, "end", axis, work);
  const automaticSpan = startLine.kind === "line" && startLine.span
    ? startLine
    : endLine.kind === "line" && endLine.span
      ? endLine
      : DEFAULT_AUTOMATIC_SPAN;
  const requestedSpan = span(automaticSpan);
  if (start !== null && end === null) end = spanBoundary(endLine, start, 1, axis, work);
  else if (end !== null && start === null) start = spanBoundary(startLine, end, -1, axis, work);
  if (start !== null && end !== null && end < start) [start, end] = [end, start];
  if (start !== null && end !== null && end === start) end += 1;
  return Object.freeze({
    start,
    end,
    span: Math.max(1, end !== null && start !== null ? end - start : requestedSpan),
    automaticSpan
  });
}

function automaticAxisEnd(
  axis: ResolvedAxis,
  start: number,
  definition: ExpandedGridAxis,
  work: PlacementWork
): number {
  return spanBoundary(axis.automaticSpan, start, 1, definition, work);
}

function partialPlacement(
  item: GridItemPlacementInput,
  input: GridPlacementInput,
  work: PlacementWork
): { readonly column: ResolvedAxis; readonly row: ResolvedAxis } {
  return Object.freeze({
    column: resolvedAxis(item.columnStart, item.columnEnd, input.columns, work),
    row: resolvedAxis(item.rowStart, item.rowEnd, input.rows, work)
  });
}

function ensureImplicitLimit(
  start: number,
  end: number,
  explicitTracks: number,
  input: GridPlacementInput
): void {
  const implicit = Math.max(0, -start) + Math.max(0, end - explicitTracks);
  if (implicit > input.limits.maxImplicitGridTracks) {
    throw new GridWorkBudgetExceeded("maxImplicitGridTracks", input.limits.maxImplicitGridTracks);
  }
}

export function placeGridItems(input: GridPlacementInput): GridPlacementResult {
  input.signal?.throwIfAborted();
  if (input.items.length > input.limits.maxGridItems) {
    throw new GridWorkBudgetExceeded("maxGridItems", input.limits.maxGridItems);
  }
  const work: PlacementWork = { steps: 0, named: 0, input };
  const occupancy = new SparseGridOccupancy(input.limits.maxGridOccupancyIntervals);
  const ordered = [...input.items].sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex);
  const partial = new Map<GridItemPlacementInput["formattingNode"], ReturnType<typeof partialPlacement>>();
  for (const item of ordered) {
    input.signal?.throwIfAborted();
    partial.set(item.formattingNode, partialPlacement(item, input, work));
  }
  const result: GridAreaPlacement[] = [];
  let minimumColumn = 0;
  let maximumColumn = input.columns.tracks.length;
  let minimumRow = 0;
  let maximumRow = input.rows.tracks.length;
  for (const item of ordered) {
    input.signal?.throwIfAborted();
    const axes = partial.get(item.formattingNode);
    if (axes === undefined) continue;
    if (axes.column.start !== null) minimumColumn = Math.min(minimumColumn, axes.column.start);
    if (axes.column.end !== null) maximumColumn = Math.max(maximumColumn, axes.column.end);
    if (axes.row.start !== null) minimumRow = Math.min(minimumRow, axes.row.start);
    if (axes.row.end !== null) maximumRow = Math.max(maximumRow, axes.row.end);
  }
  if (input.autoFlow.axis === "row") {
    const minimumExtent = ordered.reduce((maximum, item) => {
      input.signal?.throwIfAborted();
      const axis = partial.get(item.formattingNode)?.column;
      if (axis === undefined || axis.start !== null) return maximum;
      return Math.max(
        maximum,
        automaticAxisEnd(axis, minimumColumn, input.columns, work) - minimumColumn
      );
    }, 1);
    maximumColumn = Math.max(maximumColumn, minimumColumn + minimumExtent);
  } else {
    const minimumExtent = ordered.reduce((maximum, item) => {
      input.signal?.throwIfAborted();
      const axis = partial.get(item.formattingNode)?.row;
      if (axis === undefined || axis.start !== null) return maximum;
      return Math.max(
        maximum,
        automaticAxisEnd(axis, minimumRow, input.rows, work) - minimumRow
      );
    }, 1);
    maximumRow = Math.max(maximumRow, minimumRow + minimumExtent);
  }
  ensureImplicitLimit(minimumColumn, maximumColumn, input.columns.tracks.length, input);
  ensureImplicitLimit(minimumRow, maximumRow, input.rows.tracks.length, input);
  const commit = (item: GridItemPlacementInput, columnStart: number, rowStart: number, columnSpan: number, rowSpan: number): void => {
    const placement = Object.freeze({
      formattingNode: item.formattingNode,
      sourceIndex: item.sourceIndex,
      order: item.order,
      columnStart,
      columnEnd: columnStart + columnSpan,
      rowStart,
      rowEnd: rowStart + rowSpan
    });
    ensureImplicitLimit(placement.columnStart, placement.columnEnd, input.columns.tracks.length, input);
    ensureImplicitLimit(placement.rowStart, placement.rowEnd, input.rows.tracks.length, input);
    occupancy.occupy(placement, () => { step(work); });
    result.push(placement);
    minimumColumn = Math.min(minimumColumn, placement.columnStart);
    maximumColumn = Math.max(maximumColumn, placement.columnEnd);
    minimumRow = Math.min(minimumRow, placement.rowStart);
    maximumRow = Math.max(maximumRow, placement.rowEnd);
  };
  for (const item of ordered) {
    const axes = partial.get(item.formattingNode);
    if (axes === undefined || axes.column.start === null || axes.row.start === null) continue;
    commit(item, axes.column.start, axes.row.start, axes.column.span, axes.row.span);
  }

  // Items locked to the auto-placement algorithm's major axis are placed
  // before the placement cursor is used for the remaining items.
  for (const item of ordered) {
    const axes = partial.get(item.formattingNode);
    if (axes === undefined) continue;
    if (input.autoFlow.axis === "row" && axes.row.start !== null && axes.column.start === null) {
      let column = minimumColumn;
      for (;;) {
        step(work);
        const end = automaticAxisEnd(axes.column, column, input.columns, work);
        const columnSpan = end - column;
        ensureImplicitLimit(column, end, input.columns.tracks.length, input);
        ensureImplicitLimit(axes.row.start, axes.row.start + axes.row.span, input.rows.tracks.length, input);
        if (occupancy.vacant(axes.row.start, axes.row.start + axes.row.span, column, end, () => { step(work); })) {
          maximumColumn = Math.max(maximumColumn, end);
          commit(item, column, axes.row.start, columnSpan, axes.row.span);
          break;
        }
        column += 1;
        ensureImplicitLimit(
          column,
          automaticAxisEnd(axes.column, column, input.columns, work),
          input.columns.tracks.length,
          input
        );
      }
    } else if (input.autoFlow.axis === "column" && axes.column.start !== null && axes.row.start === null) {
      let row = minimumRow;
      for (;;) {
        step(work);
        const end = automaticAxisEnd(axes.row, row, input.rows, work);
        const rowSpan = end - row;
        ensureImplicitLimit(row, end, input.rows.tracks.length, input);
        ensureImplicitLimit(axes.column.start, axes.column.start + axes.column.span, input.columns.tracks.length, input);
        if (occupancy.vacant(row, end, axes.column.start, axes.column.start + axes.column.span, () => { step(work); })) {
          maximumRow = Math.max(maximumRow, end);
          commit(item, axes.column.start, row, axes.column.span, rowSpan);
          break;
        }
        row += 1;
        ensureImplicitLimit(
          row,
          automaticAxisEnd(axes.row, row, input.rows, work),
          input.rows.tracks.length,
          input
        );
      }
    }
  }

  let cursorColumn = minimumColumn;
  let cursorRow = minimumRow;
  for (const item of ordered) {
    const axes = partial.get(item.formattingNode);
    if (axes === undefined || (axes.column.start !== null && axes.row.start !== null)) continue;
    if ((input.autoFlow.axis === "row" && axes.row.start !== null)
      || (input.autoFlow.axis === "column" && axes.column.start !== null)) continue;
    const dense = input.autoFlow.packing === "dense";
    let column = axes.column.start ?? (dense ? minimumColumn : cursorColumn);
    let row = axes.row.start ?? (dense ? minimumRow : cursorRow);
    if (input.autoFlow.axis === "row" && axes.column.start !== null && !dense) {
      if (axes.column.start < cursorColumn) cursorRow += 1;
      column = axes.column.start;
      row = cursorRow;
    } else if (input.autoFlow.axis === "column" && axes.row.start !== null && !dense) {
      if (axes.row.start < cursorRow) cursorColumn += 1;
      row = axes.row.start;
      column = cursorColumn;
    }
    for (;;) {
      step(work);
      let columnEnd = axes.column.start === null
        ? automaticAxisEnd(axes.column, column, input.columns, work)
        : column + axes.column.span;
      let rowEnd = axes.row.start === null
        ? automaticAxisEnd(axes.row, row, input.rows, work)
        : row + axes.row.span;
      if (input.autoFlow.axis === "row" && axes.column.start === null
        && columnEnd > maximumColumn) {
        column = minimumColumn;
        row += 1;
        columnEnd = automaticAxisEnd(axes.column, column, input.columns, work);
        rowEnd = axes.row.start === null
          ? automaticAxisEnd(axes.row, row, input.rows, work)
          : row + axes.row.span;
      } else if (input.autoFlow.axis === "column" && axes.row.start === null
        && rowEnd > maximumRow) {
        row = minimumRow;
        column += 1;
        columnEnd = axes.column.start === null
          ? automaticAxisEnd(axes.column, column, input.columns, work)
          : column + axes.column.span;
        rowEnd = automaticAxisEnd(axes.row, row, input.rows, work);
      }
      ensureImplicitLimit(column, columnEnd, input.columns.tracks.length, input);
      ensureImplicitLimit(row, rowEnd, input.rows.tracks.length, input);
      if (occupancy.vacant(
        row,
        rowEnd,
        column,
        columnEnd,
        () => { step(work); }
      )) break;
      if (input.autoFlow.axis === "row") {
        if (axes.column.start !== null) row += 1;
        else {
          column += 1;
          if (automaticAxisEnd(axes.column, column, input.columns, work) > maximumColumn) {
            column = minimumColumn;
            row += 1;
          }
        }
      } else if (axes.row.start !== null) column += 1;
      else {
        row += 1;
        if (automaticAxisEnd(axes.row, row, input.rows, work) > maximumRow) {
          row = minimumRow;
          column += 1;
        }
      }
      ensureImplicitLimit(
        column,
        axes.column.start === null
          ? automaticAxisEnd(axes.column, column, input.columns, work)
          : column + axes.column.span,
        input.columns.tracks.length,
        input
      );
      ensureImplicitLimit(
        row,
        axes.row.start === null
          ? automaticAxisEnd(axes.row, row, input.rows, work)
          : row + axes.row.span,
        input.rows.tracks.length,
        input
      );
    }
    const columnEnd = axes.column.start === null
      ? automaticAxisEnd(axes.column, column, input.columns, work)
      : column + axes.column.span;
    const rowEnd = axes.row.start === null
      ? automaticAxisEnd(axes.row, row, input.rows, work)
      : row + axes.row.span;
    commit(item, column, row, columnEnd - column, rowEnd - row);
    if (!dense) {
      cursorColumn = column;
      cursorRow = row;
      if (input.autoFlow.axis === "row") cursorColumn = columnEnd;
      else cursorRow = rowEnd;
    }
  }
  return Object.freeze({
    items: Object.freeze(result),
    minimumColumnLine: minimumColumn,
    maximumColumnLine: maximumColumn,
    minimumRowLine: minimumRow,
    maximumRowLine: maximumRow,
    placementSteps: work.steps,
    occupancyIntervals: occupancy.intervals
  });
}
