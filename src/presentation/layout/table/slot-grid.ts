import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import { TableWorkBudgetExceeded } from "./types.js";
import type {
  TableCellSlot,
  TableColumnTrack,
  TableSlotGridHost,
  TableMissingCellInterval,
  TableOutOfFlowBox,
  TableRowGroupTrack,
  TableRowTrack,
  TableSlotGrid,
  TableSlotInterval,
  TableStructuralError,
} from "./types.js";

interface CollectedRow {
  readonly node: FormattingNode;
  readonly group: FormattingNode | null;
}

function overlap(intervals: readonly TableSlotInterval[], start: number, end: number): boolean {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = intervals[middle];
    if (entry === undefined) break;
    if (entry.columnEnd <= start) low = middle + 1;
    else high = middle;
  }
  const candidate = intervals[low];
  return candidate !== undefined && start < candidate.columnEnd && end > candidate.columnStart;
}

function insertInterval(intervals: TableSlotInterval[], interval: TableSlotInterval): void {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((intervals[middle]?.columnStart ?? Number.MAX_SAFE_INTEGER) <= interval.columnStart) low = middle + 1;
    else high = middle;
  }
  intervals.splice(low, 0, interval);
}

function collectRows(
  host: TableSlotGridHost,
  table: FormattingNode,
  addOutOfFlow: (node: FormattingNode, owner: FormattingNode) => void,
): {
  readonly rows: readonly CollectedRow[];
  readonly groups: readonly TableRowGroupTrack[];
  readonly displayBoxes: readonly FormattingNode[];
} {
  const source: { readonly node: FormattingNode; readonly sourceOrder: number }[] = [];
  for (const [sourceOrder, childId] of table.children.entries()) {
    const child = host.formattingNode(childId);
    if (host.isOutOfFlow(child)) {
      addOutOfFlow(child, table);
      continue;
    }
    if (child.kind === "table-row" || child.kind === "table-header-group"
      || child.kind === "table-body-group" || child.kind === "table-footer-group") source.push({ node: child, sourceOrder });
  }
  const firstHeader = source.find((entry) => entry.node.kind === "table-header-group") ?? null;
  const firstFooter = source.find((entry) => entry.node.kind === "table-footer-group") ?? null;
  const display = [
    ...(firstHeader === null ? [] : [firstHeader]),
    ...source.filter((entry) => entry !== firstHeader && entry !== firstFooter),
    ...(firstFooter === null ? [] : [firstFooter]),
  ];
  const rows: CollectedRow[] = [];
  const groups: TableRowGroupTrack[] = [];
  const displayBoxes: FormattingNode[] = [];
  for (const entry of display) {
    const child = entry.node;
    if (child.kind === "table-row") {
      rows.push({ node: child, group: null });
      displayBoxes.push(child);
      continue;
    }
    host.consume("maxTableRowGroups");
    const sourceRole = child.kind === "table-header-group" ? "header"
      : child.kind === "table-footer-group" ? "footer" : "body";
    const displayRole = entry === firstHeader ? "header" : entry === firstFooter ? "footer" : "body";
    groups.push(Object.freeze({ formattingNode: child.id, sourceRole, displayRole, sourceOrder: entry.sourceOrder }));
    displayBoxes.push(child);
    for (const rowId of child.children) {
      const row = host.formattingNode(rowId);
      if (host.isOutOfFlow(row)) addOutOfFlow(row, child);
      else if (row.kind === "table-row") rows.push({ node: row, group: child });
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    groups: Object.freeze(groups),
    displayBoxes: Object.freeze(displayBoxes),
  });
}

function rowGroupRange(rows: readonly TableRowTrack[], row: TableRowTrack): { readonly start: number; readonly end: number } {
  let start = row.index;
  let end = row.index + 1;
  while (start > 0 && rows[start - 1]?.rowGroup === row.rowGroup) start -= 1;
  while (end < rows.length && rows[end]?.rowGroup === row.rowGroup) end += 1;
  return Object.freeze({ start, end });
}

function collectedColumns(
  host: TableSlotGridHost,
  table: FormattingNode,
  addOutOfFlow: (node: FormattingNode, owner: FormattingNode) => void,
): TableColumnTrack[] {
  const tracks: TableColumnTrack[] = [];
  const append = (node: FormattingNode | null, group: FormattingNode | null, count: number): void => {
    for (let offset = 0; offset < count; offset += 1) {
      host.consume("maxTableColumns");
      tracks.push(Object.freeze({
        index: tracks.length,
        formattingNode: node?.id ?? null,
        columnGroup: group?.id ?? null,
        source: node?.source ?? group?.source ?? null,
        collapsed:
          (node !== null && host.computed(node)?.visibility === "collapse") ||
          (group !== null && host.computed(group)?.visibility === "collapse"),
      }));
    }
  };
  for (const childId of table.children) {
    const child = host.formattingNode(childId);
    if (host.isOutOfFlow(child)) {
      addOutOfFlow(child, table);
      continue;
    }
    if (child.kind === "table-column") {
      append(child, null, child.span);
    } else if (child.kind === "table-column-group") {
      host.consume("maxTableColumnGroups");
      const columnChildren: FormattingNode[] = [];
      for (const id of child.children) {
        const entry = host.formattingNode(id);
        if (host.isOutOfFlow(entry)) addOutOfFlow(entry, child);
        else if (entry.kind === "table-column") columnChildren.push(entry);
      }
      if (columnChildren.length === 0) {
        const span = child.source === null ? 1 : host.htmlTableColumnGroup(child.source)?.span ?? 1;
        append(null, child, span);
      } else {
        for (const column of columnChildren) append(column, child, column.kind === "table-column" ? column.span : 1);
      }
    }
  }
  return tracks;
}

/** Build a bounded sparse table slot grid before any table sizing occurs. */
export function buildTableSlotGrid(host: TableSlotGridHost, table: FormattingNode): TableSlotGrid {
  host.consume("maxTableRoots");
  const outOfFlow: TableOutOfFlowBox[] = [];
  const outOfFlowNodes = new Set<FormattingNodeId>();
  const addOutOfFlow = (node: FormattingNode, owner: FormattingNode): void => {
    if (outOfFlowNodes.has(node.id)) return;
    outOfFlowNodes.add(node.id);
    outOfFlow.push(Object.freeze({
      formattingNode: node.id,
      containingTableBox: owner.id,
    }));
  };
  const captions = table.children.filter((id) => {
    const node = host.formattingNode(id);
    if (node.kind !== "table-caption") return false;
    if (host.isOutOfFlow(node)) {
      addOutOfFlow(node, table);
      return false;
    }
    return true;
  });
  const collected = collectRows(host, table, addOutOfFlow);
  const explicitColumns = collectedColumns(host, table, addOutOfFlow);
  const columnGroups = table.children.filter((id) => {
    const node = host.formattingNode(id);
    return node.kind === "table-column-group" && !host.isOutOfFlow(node);
  });
  const rows: TableRowTrack[] = [];
  for (const [index, entry] of collected.rows.entries()) {
    host.consume("maxTableRows");
    rows.push(Object.freeze({
      index,
      formattingNode: entry.node.id,
      rowGroup: entry.group?.id ?? null,
      source: entry.node.source,
      collapsed: host.computed(entry.node)?.visibility === "collapse" || (entry.group !== null && host.computed(entry.group)?.visibility === "collapse"),
    }));
  }
  const rowByFormattingNode = new Map(rows.map((row) => [row.formattingNode, row.index] as const));
  const rowSequence = collected.displayBoxes.map((node) => node.kind === "table-row"
    ? Object.freeze({ kind: "row" as const, row: rowByFormattingNode.get(node.id) as number })
    : Object.freeze({ kind: "row-group" as const, formattingNode: node.id }));
  const occupied = new Map<number, TableSlotInterval[]>();
  const cells: TableCellSlot[] = [];
  const slotIntervals: TableSlotInterval[] = [];
  const errors: TableStructuralError[] = [];
  let columnCount = explicitColumns.length;
  for (const row of rows) {
    const rowNode = host.formattingNode(row.formattingNode);
    let cursor = 0;
    for (const childId of rowNode.children) {
      const cellNode = host.formattingNode(childId);
      if (host.isOutOfFlow(cellNode)) {
        addOutOfFlow(cellNode, rowNode);
        continue;
      }
      if (cellNode.kind !== "table-cell") {
        errors.push(Object.freeze({ kind: "orphan-internal-box", formattingNode: cellNode.id }));
        continue;
      }
      host.consume("maxTableCells");
      const metadata = cellNode.source === null ? null : host.htmlTableCell(cellNode.source);
      const columnSpan = metadata?.columnSpan ?? 1;
      const range = rowGroupRange(rows, row);
      const requestedRowSpan = metadata?.rowSpan ?? 1;
      const rowSpan = requestedRowSpan === "remaining-row-group"
        ? Math.max(1, range.end - row.index)
        : Math.max(1, Math.min(requestedRowSpan, range.end - row.index));
      if (requestedRowSpan !== "remaining-row-group" && row.index + requestedRowSpan > range.end) {
        errors.push(Object.freeze({ kind: "rowspan-crosses-row-group", formattingNode: cellNode.id }));
      }
      const rowIntervals = occupied.get(row.index) ?? [];
      while (overlap(rowIntervals, cursor, cursor + columnSpan)) {
        host.consume("maxTableColspanWork");
        cursor += 1;
      }
      if (cursor + columnSpan > host.budgets.maxTableColumns) {
        errors.push(Object.freeze({ kind: "track-limit", formattingNode: cellNode.id }));
        throw new TableWorkBudgetExceeded("maxTableColumns");
      }
      const intervals: TableSlotInterval[] = [];
      for (let targetRow = row.index; targetRow < row.index + rowSpan; targetRow += 1) {
        host.consume("maxTableRowspanWork");
        host.consume("maxTableSlotIntervals");
        const interval = Object.freeze({ row: targetRow, columnStart: cursor, columnEnd: cursor + columnSpan, cell: cellNode.id });
        const targetIntervals = occupied.get(targetRow) ?? [];
        if (overlap(targetIntervals, cursor, cursor + columnSpan)) {
          errors.push(Object.freeze({ kind: "overlap", formattingNode: cellNode.id }));
        }
        insertInterval(targetIntervals, interval);
        occupied.set(targetRow, targetIntervals);
        intervals.push(interval);
        slotIntervals.push(interval);
      }
      cells.push(Object.freeze({
        formattingNode: cellNode.id,
        source: cellNode.source,
        row: row.index,
        column: cursor,
        rowSpan,
        columnSpan,
        rowGroup: row.rowGroup,
        columnGroups: Object.freeze([...new Set(explicitColumns
          .slice(cursor, cursor + columnSpan)
          .map((column) => column.columnGroup)
          .filter((group): group is FormattingNodeId => group !== null))]),
        intervals: Object.freeze(intervals),
        htmlMetadata: metadata,
      }));
      host.consume("maxTableHeaderAssociations", cellNode.semantic?.tableHeaders.length ?? 0);
      cursor += columnSpan;
      columnCount = Math.max(columnCount, cursor);
    }
  }
  const columns = [...explicitColumns];
  while (columns.length < columnCount) {
    host.consume("maxTableColumns");
    columns.push(Object.freeze({ index: columns.length, formattingNode: null, columnGroup: null, source: null, collapsed: false }));
  }
  const missingCells: TableMissingCellInterval[] = [];
  for (const row of rows) {
    const intervals = occupied.get(row.index) ?? [];
    let cursor = 0;
    for (const interval of intervals) {
      if (interval.columnStart > cursor) {
        host.consume("maxTableAnonymousMissingCells", interval.columnStart - cursor);
        missingCells.push(Object.freeze({ row: row.index, columnStart: cursor, columnEnd: interval.columnStart }));
      }
      cursor = Math.max(cursor, interval.columnEnd);
    }
    if (cursor < columnCount) {
      host.consume("maxTableAnonymousMissingCells", columnCount - cursor);
      missingCells.push(Object.freeze({ row: row.index, columnStart: cursor, columnEnd: columnCount }));
    }
  }
  return Object.freeze({
    table: table.id,
    captions: Object.freeze(captions),
    rowGroups: collected.groups,
    rowSequence: Object.freeze(rowSequence),
    columnGroups: Object.freeze(columnGroups),
    rows: Object.freeze(rows),
    columns: Object.freeze(columns),
    cells: Object.freeze(cells),
    slotIntervals: Object.freeze(slotIntervals),
    missingCells: Object.freeze(missingCells),
    outOfFlow: Object.freeze(outOfFlow),
    errors: Object.freeze(errors),
  });
}
