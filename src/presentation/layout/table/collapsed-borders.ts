import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { CssBorderStyle, CssColor } from "../../style/index.js";
import {
  cssDivide,
  cssMax,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import type {
  TableBorderOverride,
  TableCollapsedBorderCandidate,
  TableCollapsedBorderHost,
  TableCollapsedBorderWinner,
  TableSlotGrid,
} from "./types.js";

type Side = TableCollapsedBorderCandidate["side"];
const ZERO = cssNonNegativeLength(cssPx(0));
const ORIGIN_RANK = Object.freeze({ table: 0, "column-group": 1, column: 2, "row-group": 3, row: 4, cell: 5 });

function candidate(
  host: TableCollapsedBorderHost,
  node: FormattingNode,
  side: Side,
  origin: TableCollapsedBorderCandidate["origin"],
  sourceOrder: number,
  basis: CssPixelLength,
): TableCollapsedBorderCandidate | null {
  const style = host.computed(node);
  if (style === null || style.visibility !== "visible") return null;
  const borderStyle = style.box.borderStyles[side];
  const used = host.usedLength(style.box.borderWidths[side], basis, style) ?? ZERO;
  return Object.freeze({
    formattingNode: node.id,
    side,
    style: borderStyle,
    width: borderStyle === "none" ? ZERO : cssNonNegativeLength(cssMax(ZERO, used)),
    color: style.box.borderColors[side],
    origin,
    sourceOrder,
  });
}

function wins(left: TableCollapsedBorderCandidate, right: TableCollapsedBorderCandidate): TableCollapsedBorderCandidate {
  if (left.style === "hidden" || right.style === "hidden") return left.style === "hidden" ? left : right;
  if (left.style === "none" || right.style === "none") return left.style === "none" ? right : left;
  if (left.width !== right.width) return left.width > right.width ? left : right;
  const origin = ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin];
  if (origin !== 0) return origin > 0 ? left : right;
  return left.sourceOrder >= right.sourceOrder ? left : right;
}

function emptyOverride(): {
  styles: Record<Side, CssBorderStyle>;
  widths: Record<Side, CssNonNegativeLength>;
  colors: Record<Side, CssColor | null>;
} {
  return {
    styles: { top: "none", right: "none", bottom: "none", left: "none" },
    widths: { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO },
    colors: { top: null, right: null, bottom: null, left: null },
  };
}

/** Resolve one winning segment for each collapsed table edge and register cell geometry overrides. */
export function resolveCollapsedTableBorders(
  host: TableCollapsedBorderHost,
  grid: TableSlotGrid,
  table: FormattingNode,
  inlineBasis: CssPixelLength,
): readonly TableCollapsedBorderWinner[] {
  const candidates = new Map<string, TableCollapsedBorderCandidate[]>();
  const owners = new Map<string, { target: FormattingNodeId; side: Side }>();
  const add = (key: string, value: TableCollapsedBorderCandidate | null): void => {
    if (value === null) return;
    host.consume("maxTableCollapsedBorderCandidates");
    const list = candidates.get(key) ?? [];
    list.push(value);
    candidates.set(key, list);
  };
  const sourceOrder = new Map<FormattingNodeId, number>();
  let ordinal = 0;
  const order = (id: FormattingNodeId): number => {
    const existing = sourceOrder.get(id);
    if (existing !== undefined) return existing;
    sourceOrder.set(id, ++ordinal);
    return ordinal;
  };
  const rowGroupRanges = new Map<FormattingNodeId, { start: number; end: number }>();
  for (const row of grid.rows) {
    if (row.rowGroup === null) continue;
    const range = rowGroupRanges.get(row.rowGroup);
    rowGroupRanges.set(row.rowGroup, {
      start: range?.start ?? row.index,
      end: row.index + 1,
    });
  }
  const columnGroupRanges = new Map<FormattingNodeId, { start: number; end: number }>();
  for (const column of grid.columns) {
    if (column.columnGroup === null) continue;
    const range = columnGroupRanges.get(column.columnGroup);
    columnGroupRanges.set(column.columnGroup, {
      start: range?.start ?? column.index,
      end: column.index + 1,
    });
  }
  for (const cell of grid.cells) {
    const cellNode = host.formattingNode(cell.formattingNode);
    const rowNode = host.formattingNode(grid.rows[cell.row]?.formattingNode ?? cell.formattingNode);
    const rowGroup = cell.rowGroup === null ? null : host.formattingNode(cell.rowGroup);
    const column = grid.columns[cell.column];
    const columnNode = column?.formattingNode === null || column?.formattingNode === undefined ? null : host.formattingNode(column.formattingNode);
    const columnGroup = column?.columnGroup === null || column?.columnGroup === undefined ? null : host.formattingNode(column.columnGroup);
    const addEdge = (side: Side, key: string, perpendicularTrack: number, perimeter: boolean): void => {
      add(key, candidate(host, cellNode, side, "cell", order(cellNode.id), inlineBasis));
      if (side === "top" || side === "bottom") {
        add(key, candidate(host, rowNode, side, "row", order(rowNode.id), inlineBasis));
        const rowRange = rowGroup === null ? undefined : rowGroupRanges.get(rowGroup.id);
        const line = side === "top" ? cell.row : cell.row + cell.rowSpan;
        if (rowGroup !== null && rowRange !== undefined && (line === rowRange.start || line === rowRange.end)) {
          add(key, candidate(host, rowGroup, side, "row-group", order(rowGroup.id), inlineBasis));
        }
        if (perimeter) {
          const edgeColumn = grid.columns[perpendicularTrack];
          const edgeColumnNode = edgeColumn?.formattingNode === null || edgeColumn?.formattingNode === undefined
            ? null
            : host.formattingNode(edgeColumn.formattingNode);
          const edgeColumnGroup = edgeColumn?.columnGroup === null || edgeColumn?.columnGroup === undefined
            ? null
            : host.formattingNode(edgeColumn.columnGroup);
          if (edgeColumnNode !== null) add(key, candidate(host, edgeColumnNode, side, "column", order(edgeColumnNode.id), inlineBasis));
          if (edgeColumnGroup !== null) add(key, candidate(host, edgeColumnGroup, side, "column-group", order(edgeColumnGroup.id), inlineBasis));
        }
      } else {
        if (columnNode !== null) add(key, candidate(host, columnNode, side, "column", order(columnNode.id), inlineBasis));
        const columnRange = columnGroup === null ? undefined : columnGroupRanges.get(columnGroup.id);
        const line = side === "left" ? cell.column : cell.column + cell.columnSpan;
        if (columnGroup !== null && columnRange !== undefined && (line === columnRange.start || line === columnRange.end)) {
          add(key, candidate(host, columnGroup, side, "column-group", order(columnGroup.id), inlineBasis));
        }
        if (perimeter) {
          const edgeRow = grid.rows[perpendicularTrack];
          const edgeRowNode = edgeRow === undefined ? null : host.formattingNode(edgeRow.formattingNode);
          const edgeRowGroup = edgeRow?.rowGroup === null || edgeRow?.rowGroup === undefined
            ? null
            : host.formattingNode(edgeRow.rowGroup);
          if (edgeRowNode !== null) add(key, candidate(host, edgeRowNode, side, "row", order(edgeRowNode.id), inlineBasis));
          if (edgeRowGroup !== null) add(key, candidate(host, edgeRowGroup, side, "row-group", order(edgeRowGroup.id), inlineBasis));
        }
      }
      if (perimeter) add(key, candidate(host, table, side, "table", order(table.id), inlineBasis));
      const current = owners.get(key);
      const prefer = side === "top" || side === "left";
      if (current === undefined || prefer) owners.set(key, { target: cell.formattingNode, side });
    };
    for (let columnIndex = cell.column; columnIndex < cell.column + cell.columnSpan; columnIndex += 1) {
      addEdge("top", `h:${String(cell.row)}:${String(columnIndex)}:${String(columnIndex + 1)}`, columnIndex, cell.row === 0);
      addEdge("bottom", `h:${String(cell.row + cell.rowSpan)}:${String(columnIndex)}:${String(columnIndex + 1)}`, columnIndex, cell.row + cell.rowSpan === grid.rows.length);
    }
    for (let rowIndex = cell.row; rowIndex < cell.row + cell.rowSpan; rowIndex += 1) {
      addEdge("left", `v:${String(cell.column)}:${String(rowIndex)}:${String(rowIndex + 1)}`, rowIndex, cell.column === 0);
      addEdge("right", `v:${String(cell.column + cell.columnSpan)}:${String(rowIndex)}:${String(rowIndex + 1)}`, rowIndex, cell.column + cell.columnSpan === grid.columns.length);
    }
  }
  const overrides = new Map<FormattingNodeId, ReturnType<typeof emptyOverride>>();
  overrides.set(table.id, emptyOverride());
  for (const row of grid.rows) {
    overrides.set(row.formattingNode, emptyOverride());
    if (row.rowGroup !== null && !overrides.has(row.rowGroup)) overrides.set(row.rowGroup, emptyOverride());
  }
  for (const column of grid.columns) {
    if (column.formattingNode !== null && !overrides.has(column.formattingNode)) overrides.set(column.formattingNode, emptyOverride());
    if (column.columnGroup !== null && !overrides.has(column.columnGroup)) overrides.set(column.columnGroup, emptyOverride());
  }
  for (const cell of grid.cells) overrides.set(cell.formattingNode, emptyOverride());
  const cellsById = new Map(
    grid.cells.map((cell) => [cell.formattingNode, cell] as const),
  );
  const intervalsByRow = new Map<number, typeof grid.slotIntervals[number][]>();
  for (const interval of grid.slotIntervals) {
    const intervals = intervalsByRow.get(interval.row) ?? [];
    intervals.push(interval);
    intervalsByRow.set(interval.row, intervals);
  }
  const winners: TableCollapsedBorderWinner[] = [];
  for (const [key, values] of candidates) {
    host.signal?.throwIfAborted();
    host.consume("maxTableCollapsedBorderSegments");
    let winner = values[0];
    if (winner === undefined) continue;
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index];
      if (value !== undefined) winner = wins(winner, value);
    }
    const [axisToken, lineToken, startToken, endToken] = key.split(":");
    const segment: TableCollapsedBorderWinner = Object.freeze({
      ...winner,
      axis: axisToken === "h" ? "horizontal" : "vertical",
      line: Number(lineToken),
      start: Number(startToken),
      end: Number(endToken),
      ownerFormattingNode: owners.get(key)?.target ?? winner.formattingNode,
      ownerSide: owners.get(key)?.side ?? winner.side,
    });
    winners.push(segment);
    const owner = owners.get(key);
    if (owner === undefined) continue;
    const target = overrides.get(owner.target);
    if (target === undefined) continue;
    const perimeter = segment.axis === "horizontal"
      ? segment.line === 0 || segment.line === grid.rows.length
      : segment.line === 0 || segment.line === grid.columns.length;
    const half = cssNonNegativeLength(cssDivide(winner.width, 2));
    const contribution = perimeter ? winner.width : half;
    target.styles[owner.side] = "none";
    target.widths[owner.side] = winner.style === "hidden" ? ZERO : contribution;
    target.colors[owner.side] = winner.color;
    const touching = new Set<FormattingNodeId>();
    const rows: number[] = [];
    if (segment.axis === "horizontal") rows.push(segment.line - 1, segment.line);
    else {
      for (let row = segment.start; row < segment.end; row += 1) rows.push(row);
    }
    for (const row of rows) {
      host.signal?.throwIfAborted();
      for (const interval of intervalsByRow.get(row) ?? []) {
        host.consume("maxTableCollapsedBorderCandidates");
        if (
          segment.axis === "horizontal"
            ? interval.columnStart < segment.end &&
              interval.columnEnd > segment.start
            : interval.columnStart <= segment.line &&
              interval.columnEnd >= segment.line
        ) {
          touching.add(interval.cell);
        }
      }
    }
    for (const id of touching) {
      const cell = cellsById.get(id);
      if (cell === undefined) continue;
      const touches = segment.axis === "horizontal"
        ? cell.row === segment.line || cell.row + cell.rowSpan === segment.line
        : cell.column === segment.line || cell.column + cell.columnSpan === segment.line;
      if (!touches) continue;
      const geometry = overrides.get(cell.formattingNode);
      if (geometry === undefined) continue;
      const side: Side = segment.axis === "horizontal"
        ? (cell.row === segment.line ? "top" : "bottom")
        : (cell.column === segment.line ? "left" : "right");
      geometry.widths[side] = cssMax(geometry.widths[side], contribution) as CssNonNegativeLength;
    }
  }
  for (const [id, value] of overrides) {
    const frozen: TableBorderOverride = Object.freeze({
      styles: Object.freeze(value.styles),
      widths: Object.freeze(value.widths),
      colors: Object.freeze(value.colors),
    });
    host.registerCollapsedBorderOverride(id, frozen);
  }
  return Object.freeze(winners);
}
