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
const STYLE_RANK = Object.freeze({ none: 0, solid: 1, hidden: 2 });

export interface TableCollapsedBorderEdge {
  readonly axis: "horizontal" | "vertical";
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly tablePerimeterSide: Side | null;
  readonly candidates: readonly TableCollapsedBorderCandidate[];
  readonly owner: { readonly target: FormattingNodeId; readonly side: Side };
}

export interface TableCollapsedBorderGraph {
  readonly direction: "ltr" | "rtl";
  readonly edges: readonly TableCollapsedBorderEdge[];
}

interface MutableCollapsedEdge {
  readonly axis: "horizontal" | "vertical";
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly tablePerimeterSide: Side | null;
  readonly candidates: TableCollapsedBorderCandidate[];
  owner: { readonly target: FormattingNodeId; readonly side: Side } | null;
}

function candidate(
  host: TableCollapsedBorderHost,
  node: FormattingNode,
  side: Side,
  origin: TableCollapsedBorderCandidate["origin"],
  sourceOrder: number,
  logicalRow: number,
  logicalColumn: number,
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
    logicalRow,
    logicalColumn,
  });
}

function wins(
  left: TableCollapsedBorderCandidate,
  right: TableCollapsedBorderCandidate,
  direction: "ltr" | "rtl",
): TableCollapsedBorderCandidate {
  const style = STYLE_RANK[left.style] - STYLE_RANK[right.style];
  if (style !== 0) return style > 0 ? left : right;
  if (left.width !== right.width) return left.width > right.width ? left : right;
  const origin = ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin];
  if (origin !== 0) return origin > 0 ? left : right;
  if (left.logicalRow !== right.logicalRow) return left.logicalRow < right.logicalRow ? left : right;
  if (left.logicalColumn !== right.logicalColumn) {
    return direction === "ltr"
      ? (left.logicalColumn < right.logicalColumn ? left : right)
      : (left.logicalColumn > right.logicalColumn ? left : right);
  }
  return left.sourceOrder <= right.sourceOrder ? left : right;
}

function emptyOverride(suppressPadding = false): {
  styles: Record<Side, CssBorderStyle>;
  widths: Record<Side, CssNonNegativeLength>;
  colors: Record<Side, CssColor | null>;
  suppressPadding: boolean;
} {
  return {
    styles: { top: "none", right: "none", bottom: "none", left: "none" },
    widths: { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO },
    colors: { top: null, right: null, bottom: null, left: null },
    suppressPadding,
  };
}

class DisjointSet {
  readonly #parent: number[];
  public constructor(size: number) { this.#parent = Array.from({ length: size }, (_, index) => index); }
  public find(value: number): number {
    let root = value;
    while (this.#parent[root] !== root) root = this.#parent[root] as number;
    let cursor = value;
    while (this.#parent[cursor] !== cursor) {
      const next = this.#parent[cursor] as number;
      this.#parent[cursor] = root;
      cursor = next;
    }
    return root;
  }
  public union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.#parent[rightRoot] = leftRoot;
  }
}

/** Build the complete collapsed-border edge graph and its candidate sets. */
export function buildCollapsedTableBorderGraph(
  host: TableCollapsedBorderHost,
  grid: TableSlotGrid,
  table: FormattingNode,
  inlineBasis: CssPixelLength,
): TableCollapsedBorderGraph {
  const direction = host.computed(table)?.text.direction ?? "ltr";
  const rowLineCount = Math.max(1, grid.rows.length);
  const columnLineCount = Math.max(1, grid.columns.length);
  const rowSectionCount = Math.max(1, grid.rows.length);
  const columnSectionCount = Math.max(1, grid.columns.length);
  const edges: MutableCollapsedEdge[] = [];
  for (let line = 0; line <= rowLineCount; line += 1) {
    for (let column = 0; column < columnSectionCount; column += 1) {
      host.signal?.throwIfAborted();
      host.consume("maxTableCollapsedBorderSegments");
      edges.push({
        axis: "horizontal",
        line,
        start: column,
        end: column + 1,
        tablePerimeterSide: line === 0 ? "top" : line === rowLineCount ? "bottom" : null,
        candidates: [],
        owner: null,
      });
    }
  }
  for (let line = 0; line <= columnLineCount; line += 1) {
    for (let row = 0; row < rowSectionCount; row += 1) {
      host.signal?.throwIfAborted();
      host.consume("maxTableCollapsedBorderSegments");
      edges.push({
        axis: "vertical",
        line,
        start: row,
        end: row + 1,
        tablePerimeterSide: line === 0 ? "left" : line === columnLineCount ? "right" : null,
        candidates: [],
        owner: null,
      });
    }
  }
  const edgeIndexes = new Map<string, number>();
  for (const [index, edge] of edges.entries()) {
    edgeIndexes.set(`${edge.axis}:${String(edge.line)}:${String(edge.start)}`, index);
  }
  const edgeAt = (
    axis: "horizontal" | "vertical",
    line: number,
    start: number,
  ): MutableCollapsedEdge | null => {
    const index = edgeIndexes.get(`${axis}:${String(line)}:${String(start)}`);
    return index === undefined ? null : edges[index] ?? null;
  };
  const add = (
    edge: MutableCollapsedEdge | null,
    node: FormattingNode,
    side: Side,
    origin: TableCollapsedBorderCandidate["origin"],
    sourceOrder: number,
    row: number,
    column: number,
  ): void => {
    if (edge === null) return;
    host.signal?.throwIfAborted();
    host.consume("maxTableCollapsedBorderCandidates");
    const value = candidate(host, node, side, origin, sourceOrder, row, column, inlineBasis);
    if (value === null) return;
    edge.candidates.push(value);
    if (edge.owner === null || origin === "cell") edge.owner = { target: node.id, side };
  };
  const rowGroupRanges = new Map<FormattingNodeId, { start: number; end: number }>();
  for (const row of grid.rows) {
    if (row.rowGroup === null) continue;
    const range = rowGroupRanges.get(row.rowGroup);
    rowGroupRanges.set(row.rowGroup, { start: range?.start ?? row.index, end: row.index + 1 });
  }
  const columnGroupRanges = new Map<FormattingNodeId, { start: number; end: number }>();
  for (const column of grid.columns) {
    if (column.columnGroup === null) continue;
    const range = columnGroupRanges.get(column.columnGroup);
    columnGroupRanges.set(column.columnGroup, { start: range?.start ?? column.index, end: column.index + 1 });
  }
  const sourceOrder = new Map<FormattingNodeId, number>();
  sourceOrder.set(table.id, 0);
  for (const [index, group] of grid.columnGroups.entries()) sourceOrder.set(group, index + 1);
  for (const column of grid.columns) if (column.formattingNode !== null) sourceOrder.set(column.formattingNode, column.index + 1);
  for (const group of grid.rowGroups) sourceOrder.set(group.formattingNode, group.sourceOrder + 1);
  for (const row of grid.rows) sourceOrder.set(row.formattingNode, row.index + 1);
  for (const [index, cell] of grid.cells.entries()) sourceOrder.set(cell.formattingNode, index + 1);
  const order = (node: FormattingNode): number => sourceOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER;

  for (const cell of grid.cells) {
    host.signal?.throwIfAborted();
    const node = host.formattingNode(cell.formattingNode);
    for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
      add(edgeAt("horizontal", cell.row, column), node, "top", "cell", order(node), cell.row, cell.column);
      add(edgeAt("horizontal", cell.row + cell.rowSpan, column), node, "bottom", "cell", order(node), cell.row, cell.column);
    }
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      add(edgeAt("vertical", cell.column, row), node, "left", "cell", order(node), cell.row, cell.column);
      add(edgeAt("vertical", cell.column + cell.columnSpan, row), node, "right", "cell", order(node), cell.row, cell.column);
    }
  }
  for (const row of grid.rows) {
    const node = host.formattingNode(row.formattingNode);
    for (let column = 0; column < columnSectionCount; column += 1) {
      add(edgeAt("horizontal", row.index, column), node, "top", "row", order(node), row.index, column);
      add(edgeAt("horizontal", row.index + 1, column), node, "bottom", "row", order(node), row.index, column);
    }
  }
  for (const [groupId, range] of rowGroupRanges) {
    const group = host.formattingNode(groupId);
    for (let column = 0; column < columnSectionCount; column += 1) {
      add(edgeAt("horizontal", range.start, column), group, "top", "row-group", order(group), range.start, column);
      add(edgeAt("horizontal", range.end, column), group, "bottom", "row-group", order(group), range.end - 1, column);
    }
  }
  for (const column of grid.columns) {
    if (column.formattingNode === null) continue;
    const node = host.formattingNode(column.formattingNode);
    for (let row = 0; row < rowSectionCount; row += 1) {
      add(edgeAt("vertical", column.index, row), node, "left", "column", order(node), row, column.index);
      add(edgeAt("vertical", column.index + 1, row), node, "right", "column", order(node), row, column.index);
    }
  }
  for (const [groupId, range] of columnGroupRanges) {
    const group = host.formattingNode(groupId);
    for (let row = 0; row < rowSectionCount; row += 1) {
      add(edgeAt("vertical", range.start, row), group, "left", "column-group", order(group), row, range.start);
      add(edgeAt("vertical", range.end, row), group, "right", "column-group", order(group), row, range.end - 1);
    }
  }
  for (let columnIndex = 0; columnIndex < columnSectionCount; columnIndex += 1) {
    const column = grid.columns[columnIndex];
    if (column?.formattingNode !== null && column?.formattingNode !== undefined) {
      const node = host.formattingNode(column.formattingNode);
      add(edgeAt("horizontal", 0, columnIndex), node, "top", "column", order(node), 0, column.index);
      add(edgeAt("horizontal", rowLineCount, columnIndex), node, "bottom", "column", order(node), rowLineCount, column.index);
    }
    if (column?.columnGroup !== null && column?.columnGroup !== undefined) {
      const group = host.formattingNode(column.columnGroup);
      add(edgeAt("horizontal", 0, columnIndex), group, "top", "column-group", order(group), 0, column.index);
      add(edgeAt("horizontal", rowLineCount, columnIndex), group, "bottom", "column-group", order(group), rowLineCount, column.index);
    }
    add(edgeAt("horizontal", 0, columnIndex), table, "top", "table", order(table), 0, columnIndex);
    add(edgeAt("horizontal", rowLineCount, columnIndex), table, "bottom", "table", order(table), rowLineCount, columnIndex);
  }
  for (let rowIndex = 0; rowIndex < rowSectionCount; rowIndex += 1) {
    const row = grid.rows[rowIndex];
    if (row !== undefined) {
      const node = host.formattingNode(row.formattingNode);
      add(edgeAt("vertical", 0, rowIndex), node, "left", "row", order(node), row.index, 0);
      add(edgeAt("vertical", columnLineCount, rowIndex), node, "right", "row", order(node), row.index, columnLineCount);
      if (row.rowGroup !== null) {
        const group = host.formattingNode(row.rowGroup);
        add(edgeAt("vertical", 0, rowIndex), group, "left", "row-group", order(group), row.index, 0);
        add(edgeAt("vertical", columnLineCount, rowIndex), group, "right", "row-group", order(group), row.index, columnLineCount);
      }
    }
    add(edgeAt("vertical", 0, rowIndex), table, "left", "table", order(table), rowIndex, 0);
    add(edgeAt("vertical", columnLineCount, rowIndex), table, "right", "table", order(table), rowIndex, columnLineCount);
  }
  for (const edge of edges) {
    edge.owner ??= {
      target: table.id,
      side: edge.tablePerimeterSide ?? (edge.axis === "horizontal" ? "top" : "left"),
    };
  }

  return Object.freeze({
    direction,
    edges: Object.freeze(edges.map((edge) => Object.freeze({
      ...edge,
      candidates: Object.freeze(edge.candidates),
      owner: edge.owner as { readonly target: FormattingNodeId; readonly side: Side },
    }))),
  });
}

/** Resolve connected border conflict sets and register their used geometry. */
export function resolveCollapsedBorderConflictSets(
  host: TableCollapsedBorderHost,
  grid: TableSlotGrid,
  table: FormattingNode,
  graph: TableCollapsedBorderGraph,
): readonly TableCollapsedBorderWinner[] {
  const { direction, edges } = graph;

  const sets = new DisjointSet(edges.length);
  const cellSideEdge = new Map<string, number>();
  for (const [edgeIndex, edge] of edges.entries()) {
    host.signal?.throwIfAborted();
    for (const value of edge.candidates) {
      if (value.origin !== "cell") continue;
      const key = `${value.formattingNode}:${value.side}`;
      const previous = cellSideEdge.get(key);
      if (previous === undefined) cellSideEdge.set(key, edgeIndex);
      else sets.union(previous, edgeIndex);
    }
  }
  const candidatesBySet = new Map<number, TableCollapsedBorderCandidate[]>();
  for (const [edgeIndex, edge] of edges.entries()) {
    host.signal?.throwIfAborted();
    const root = sets.find(edgeIndex);
    const values = candidatesBySet.get(root) ?? [];
    values.push(...edge.candidates);
    candidatesBySet.set(root, values);
  }
  const winnersBySet = new Map<number, TableCollapsedBorderCandidate>();
  for (const [root, values] of candidatesBySet) {
    host.signal?.throwIfAborted();
    let winner = values[0];
    if (winner === undefined) continue;
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index];
      if (value !== undefined) winner = wins(winner, value, direction);
    }
    winnersBySet.set(root, winner);
  }

  const overrides = new Map<FormattingNodeId, ReturnType<typeof emptyOverride>>();
  overrides.set(table.id, emptyOverride(true));
  for (const row of grid.rows) {
    host.signal?.throwIfAborted();
    overrides.set(row.formattingNode, emptyOverride());
    if (row.rowGroup !== null && !overrides.has(row.rowGroup)) overrides.set(row.rowGroup, emptyOverride());
  }
  for (const column of grid.columns) {
    host.signal?.throwIfAborted();
    if (column.formattingNode !== null && !overrides.has(column.formattingNode)) overrides.set(column.formattingNode, emptyOverride());
    if (column.columnGroup !== null && !overrides.has(column.columnGroup)) overrides.set(column.columnGroup, emptyOverride());
  }
  for (const cell of grid.cells) {
    host.signal?.throwIfAborted();
    overrides.set(cell.formattingNode, emptyOverride());
  }
  const winners: TableCollapsedBorderWinner[] = [];
  for (const [edgeIndex, edge] of edges.entries()) {
    host.signal?.throwIfAborted();
    const winner = winnersBySet.get(sets.find(edgeIndex));
    if (winner === undefined) continue;
    winners.push(Object.freeze({
      ...winner,
      axis: edge.axis,
      line: edge.line,
      start: edge.start,
      end: edge.end,
      ownerFormattingNode: edge.owner.target,
      ownerSide: edge.owner.side,
      tablePerimeterSide: edge.tablePerimeterSide,
    }));
    const half = winner.style === "hidden" ? ZERO : cssNonNegativeLength(cssDivide(winner.width, 2));
    for (const value of edge.candidates) {
      const geometry = overrides.get(value.formattingNode);
      if (geometry === undefined) continue;
      geometry.widths[value.side] = cssMax(geometry.widths[value.side], half) as CssNonNegativeLength;
      geometry.colors[value.side] = winner.color;
    }
    if (edge.tablePerimeterSide !== null) {
      const tableGeometry = overrides.get(table.id);
      if (tableGeometry !== undefined) {
        tableGeometry.widths[edge.tablePerimeterSide] = cssMax(tableGeometry.widths[edge.tablePerimeterSide], half) as CssNonNegativeLength;
        tableGeometry.colors[edge.tablePerimeterSide] = winner.color;
      }
    }
  }
  for (const [id, value] of overrides) {
    host.signal?.throwIfAborted();
    const frozen: TableBorderOverride = Object.freeze({
      styles: Object.freeze(value.styles),
      widths: Object.freeze(value.widths),
      colors: Object.freeze(value.colors),
      suppressPadding: value.suppressPadding,
    });
    host.registerCollapsedBorderOverride(id, frozen);
  }
  return Object.freeze(winners);
}

/** Build and harmonize the complete collapsed-border edge graph. */
export function resolveCollapsedTableBorders(
  host: TableCollapsedBorderHost,
  grid: TableSlotGrid,
  table: FormattingNode,
  inlineBasis: CssPixelLength,
): readonly TableCollapsedBorderWinner[] {
  const graph = buildCollapsedTableBorderGraph(host, grid, table, inlineBasis);
  return resolveCollapsedBorderConflictSets(host, grid, table, graph);
}
