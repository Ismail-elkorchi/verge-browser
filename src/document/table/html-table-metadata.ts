import type { DocumentNodeRef, WebDocumentNode, WebElementNode } from "../types.js";
import { associateTableHeaders } from "./headers.js";
import type {
  HtmlTableCellMetadata,
  HtmlTableCellScope,
  HtmlTableColumnMetadata,
  HtmlTableColumnGroupMetadata,
  HtmlTableHeaderCellPlacement,
  HtmlTableMetadata,
  HtmlTableMetadataIndex,
} from "./types.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_COLUMN_SPAN = 1_000;
const MAX_ROW_SPAN = 65_534;
const MAX_TABLE_COLUMN_SLOTS = 100_000_000;

function boundedUnsignedInteger(value: string | null, fallback: number, maximum: number, allowZero = false): number {
  if (value === null || !/^\s*\d+\s*$/u.test(value)) return fallback;
  const normalized = value.trim().replace(/^0+(?=\d)/u, "");
  if (normalized.length > 16) return maximum;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) return fallback;
  return Math.min(parsed, maximum);
}

export interface BuildHtmlTableMetadataInput {
  readonly elements: readonly WebElementNode[];
  readonly maxSlotWork: number;
  readonly maxHeaderAssociationWork: number;
  node(ref: DocumentNodeRef): WebDocumentNode;
  attribute(ref: DocumentNodeRef, name: string): string | null;
  elementById(id: string): DocumentNodeRef | null;
}

class HtmlTableSlotWorkExceeded extends Error {}
class HtmlTableHeaderAssociationWorkExceeded extends Error {}

interface SlotInterval {
  readonly start: number;
  readonly end: number;
}

interface ColumnGroupRange extends SlotInterval {
  readonly node: DocumentNodeRef;
}

function firstOverlap(intervals: readonly SlotInterval[], start: number, end: number): SlotInterval | null {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((intervals[middle]?.end ?? Number.MAX_SAFE_INTEGER) <= start) low = middle + 1;
    else high = middle;
  }
  const candidate = intervals[low];
  return candidate !== undefined && candidate.start < end ? candidate : null;
}

function insertInterval(intervals: SlotInterval[], interval: SlotInterval): void {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((intervals[middle]?.start ?? Number.MAX_SAFE_INTEGER) <= interval.start) low = middle + 1;
    else high = middle;
  }
  intervals.splice(low, 0, interval);
}

function columnGroupAt(ranges: readonly ColumnGroupRange[], column: number): DocumentNodeRef | null {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((ranges[middle]?.end ?? Number.MAX_SAFE_INTEGER) <= column) low = middle + 1;
    else high = middle;
  }
  const candidate = ranges[low];
  return candidate !== undefined && candidate.start <= column ? candidate.node : null;
}

function isHtml(element: WebElementNode, name?: string): boolean {
  return element.namespace === HTML_NAMESPACE && (name === undefined || element.name === name);
}

function descendantsWithoutNestedTables(
  input: BuildHtmlTableMetadataInput,
  root: WebElementNode,
): WebElementNode[] {
  const result: WebElementNode[] = [];
  const pending = [...root.children].reverse();
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined) continue;
    const node = input.node(ref);
    if (node.kind !== "element") continue;
    if (isHtml(node, "table")) continue;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return result;
}

/** Build bounded HTML-only table metadata; CSS table boxes are handled later by box generation. */
export function buildHtmlTableMetadata(input: BuildHtmlTableMetadataInput): HtmlTableMetadataIndex {
  const tables = new Map<DocumentNodeRef, HtmlTableMetadata>();
  const cells = new Map<DocumentNodeRef, HtmlTableCellMetadata>();
  const columns = new Map<DocumentNodeRef, HtmlTableColumnMetadata>();
  const columnGroups = new Map<DocumentNodeRef, HtmlTableColumnGroupMetadata>();
  const headerAssociations = new Map<DocumentNodeRef, readonly DocumentNodeRef[]>();
  const allPlacements: HtmlTableHeaderCellPlacement[] = [];
  let slotWork = 0;
  let headerAssociationWork = 0;
  let truncation: HtmlTableMetadataIndex["truncation"] = null;
  let activeTable: DocumentNodeRef | null = null;
  let activePlacementStart = 0;
  const consumeSlotWork = (): void => {
    if (slotWork >= input.maxSlotWork) throw new HtmlTableSlotWorkExceeded();
    slotWork += 1;
  };
  const consumeHeaderAssociationWork = (): void => {
    if (headerAssociationWork >= input.maxHeaderAssociationWork) {
      throw new HtmlTableHeaderAssociationWorkExceeded();
    }
    headerAssociationWork += 1;
  };
  try {
    for (const table of input.elements) {
      if (!isHtml(table, "table")) continue;
      activeTable = table.ref;
      activePlacementStart = allPlacements.length;
      const descendants = descendantsWithoutNestedTables(input, table);
      const captions = descendants.filter((entry) => isHtml(entry, "caption")).map((entry) => entry.ref);
      const rowGroups = descendants.filter((entry) => isHtml(entry) && ["thead", "tbody", "tfoot"].includes(entry.name)).map((entry) => entry.ref);
      const rows = descendants.filter((entry) => isHtml(entry, "tr"));
      const tableColumnGroups = descendants.filter((entry) => isHtml(entry, "colgroup")).map((entry) => entry.ref);
      const columnElements = descendants.filter((entry) => isHtml(entry, "col"));
      const cellElements = descendants.filter((entry) => isHtml(entry) && (entry.name === "td" || entry.name === "th"));
      const tableMetadata: HtmlTableMetadata = Object.freeze({
        node: table.ref,
        captions: Object.freeze(captions),
        rowGroups: Object.freeze(rowGroups),
        rows: Object.freeze(rows.map((entry) => entry.ref)),
        columnGroups: Object.freeze(tableColumnGroups),
        columns: Object.freeze(columnElements.map((entry) => entry.ref)),
        cells: Object.freeze(cellElements.map((entry) => entry.ref)),
      });
      tables.set(table.ref, tableMetadata);
      const columnGroupRanges: ColumnGroupRange[] = [];
      let tableColumn = 0;
      for (const columnGroup of descendants.filter((entry) => isHtml(entry, "colgroup"))) {
        const ownedColumns = columnGroup.children.map((ref) => input.node(ref))
          .filter((node): node is WebElementNode => node.kind === "element" && isHtml(node, "col"));
        const groupSpan = ownedColumns.length === 0
          ? boundedUnsignedInteger(input.attribute(columnGroup.ref, "span"), 1, MAX_COLUMN_SPAN)
          : ownedColumns.reduce((total, column) => Math.min(
            MAX_TABLE_COLUMN_SLOTS,
            total + boundedUnsignedInteger(input.attribute(column.ref, "span"), 1, MAX_COLUMN_SPAN),
          ), 0);
        columnGroups.set(columnGroup.ref, Object.freeze({
          node: columnGroup.ref,
          table: table.ref,
          span: groupSpan,
        }));
        columnGroupRanges.push(Object.freeze({
          node: columnGroup.ref,
          start: tableColumn,
          end: Math.min(MAX_TABLE_COLUMN_SLOTS, tableColumn + groupSpan),
        }));
        tableColumn = Math.min(MAX_TABLE_COLUMN_SLOTS, tableColumn + groupSpan);
      }
      for (const column of columnElements) {
        let ancestor = column.parent;
        let columnGroup: DocumentNodeRef | null = null;
        while (ancestor !== null && ancestor !== table.ref) {
          const candidate = input.node(ancestor);
          if (candidate.kind === "element" && isHtml(candidate, "colgroup")) {
            columnGroup = candidate.ref;
            break;
          }
          ancestor = candidate.parent;
        }
        columns.set(column.ref, Object.freeze({
          node: column.ref,
          table: table.ref,
          columnGroup,
          span: boundedUnsignedInteger(input.attribute(column.ref, "span"), 1, MAX_COLUMN_SPAN),
        }));
      }
      const rowGroupByRow = new Map<DocumentNodeRef, DocumentNodeRef | null>();
      const rowGroupEnd = new Map<DocumentNodeRef, number>();
      for (const [rowIndex, row] of rows.entries()) {
        let ancestor = row.parent;
        let rowGroup: DocumentNodeRef | null = null;
        while (ancestor !== null && ancestor !== table.ref) {
          const candidate = input.node(ancestor);
          if (candidate.kind === "element" && isHtml(candidate) && ["thead", "tbody", "tfoot"].includes(candidate.name)) {
            rowGroup = candidate.ref;
            break;
          }
          ancestor = candidate.parent;
        }
        rowGroupByRow.set(row.ref, rowGroup);
        if (rowGroup !== null) rowGroupEnd.set(rowGroup, rowIndex + 1);
      }
      const occupied = new Map<number, SlotInterval[]>();
      for (const [rowIndex, row] of rows.entries()) {
        const rowCells = row.children.map((ref) => input.node(ref)).filter((entry): entry is WebElementNode =>
          entry.kind === "element" && isHtml(entry) && (entry.name === "td" || entry.name === "th"));
        let column = 0;
        for (const cell of rowCells) {
          const intervals = occupied.get(rowIndex) ?? [];
          const columnSpan = boundedUnsignedInteger(input.attribute(cell.ref, "colspan"), 1, MAX_COLUMN_SPAN);
          for (let overlap = firstOverlap(intervals, column, column + columnSpan); overlap !== null;
            overlap = firstOverlap(intervals, column, column + columnSpan)) {
            consumeSlotWork();
            column = Math.max(column + 1, overlap.end);
          }
          const rawRowSpan = boundedUnsignedInteger(input.attribute(cell.ref, "rowspan"), 1, MAX_ROW_SPAN, true);
          const rowSpan: number | "remaining-row-group" = rawRowSpan === 0 ? "remaining-row-group" : rawRowSpan;
          const rowGroup = rowGroupByRow.get(row.ref) ?? null;
          const scopeValue = (input.attribute(cell.ref, "scope") ?? "auto").trim().toLowerCase();
          const scope: HtmlTableCellScope = scopeValue === "row" || scopeValue === "col" || scopeValue === "rowgroup" || scopeValue === "colgroup"
            ? scopeValue : "auto";
          const explicitHeaders = (input.attribute(cell.ref, "headers") ?? "").trim().split(/\s+/u)
            .filter(Boolean).map((id) => input.elementById(id)).filter((ref): ref is DocumentNodeRef => ref !== null);
          const metadata: HtmlTableCellMetadata = Object.freeze({
            node: cell.ref,
            table: table.ref,
            row: row.ref,
            rowGroup,
            columnSpan,
            rowSpan,
            scope,
            explicitHeaders: Object.freeze(explicitHeaders),
            abbreviation: input.attribute(cell.ref, "abbr"),
            header: cell.name === "th",
          });
          cells.set(cell.ref, metadata);
          const groupEnd = rowGroup === null ? rows.length : rowGroupEnd.get(rowGroup) ?? rowIndex + 1;
          const effectiveRowSpan = rowSpan === "remaining-row-group" ? Math.max(1, groupEnd - rowIndex) : rowSpan;
          for (let coveredRow = rowIndex; coveredRow < Math.min(rows.length, rowIndex + effectiveRowSpan); coveredRow += 1) {
            consumeSlotWork();
            const rowIntervals = occupied.get(coveredRow) ?? [];
            insertInterval(rowIntervals, Object.freeze({ start: column, end: column + columnSpan }));
            occupied.set(coveredRow, rowIntervals);
          }
          const columnGroup = columnGroupAt(columnGroupRanges, column);
          allPlacements.push(Object.freeze({
            node: cell.ref,
            table: table.ref,
            row: rowIndex,
            column,
            rowSpan: effectiveRowSpan,
            columnSpan,
            rowGroup,
            columnGroup,
            scope,
            header: cell.name === "th",
            explicitHeaders: Object.freeze(explicitHeaders),
          }));
          column += columnSpan;
        }
      }
      const tableAssociations = associateTableHeaders(
        allPlacements.slice(activePlacementStart),
        consumeHeaderAssociationWork,
      );
      for (const [cell, associated] of tableAssociations) headerAssociations.set(cell, associated);
      activeTable = null;
    }
  } catch (error) {
    if (!(error instanceof HtmlTableSlotWorkExceeded)
      && !(error instanceof HtmlTableHeaderAssociationWorkExceeded)) throw error;
    if (activeTable !== null) {
      tables.delete(activeTable);
      for (const [node, metadata] of cells) {
        if (metadata.table === activeTable) cells.delete(node);
      }
      for (const [node, metadata] of columns) {
        if (metadata.table === activeTable) columns.delete(node);
      }
      for (const [node, metadata] of columnGroups) {
        if (metadata.table === activeTable) columnGroups.delete(node);
      }
      for (const placement of allPlacements.slice(activePlacementStart)) {
        headerAssociations.delete(placement.node);
      }
      allPlacements.length = activePlacementStart;
    }
    truncation = error instanceof HtmlTableSlotWorkExceeded ? "slot-work" : "header-association-work";
  }
  return Object.freeze({
    tables,
    cells,
    columns,
    columnGroups,
    headerAssociations,
    slotWork,
    headerAssociationWork,
    truncation,
  });
}
