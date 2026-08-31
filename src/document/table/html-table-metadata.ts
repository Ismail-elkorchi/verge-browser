import type { DocumentNodeRef, WebDocumentNode, WebElementNode } from "../types.js";
import { associateTableHeaders } from "./headers.js";
import type {
  HtmlTableCellMetadata,
  HtmlTableCellPlacement,
  HtmlTableCellScope,
  HtmlTableColumnGroupMetadata,
  HtmlTableColumnMetadata,
  HtmlTableGroupRange,
  HtmlTableMetadata,
  HtmlTableMetadataIndex,
  HtmlTableModelError,
  HtmlTableRowSlot,
  HtmlTableSlotInterval,
} from "./types.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_COLUMN_SPAN = 1_000;
const MAX_ROW_SPAN = 65_534;
const MAX_TABLE_COLUMN_SLOTS = 100_000_000;

function boundedUnsignedInteger(
  value: string | null,
  fallback: number,
  maximum: number,
  allowZero = false,
): number {
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

interface MutableSlotInterval {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly cell: DocumentNodeRef;
}

type MutableCellPlacement = Omit<HtmlTableCellPlacement, "rowSpan" | "headerRole"> & {
  rowSpan: number;
  headerRole: "row" | "column" | null;
};

interface RowInput {
  readonly node: WebElementNode;
  readonly rowGroup: WebElementNode | null;
}

function isHtml(element: WebElementNode, name?: string): boolean {
  return element.namespace === HTML_NAMESPACE && (name === undefined || element.name === name);
}

function elementChildren(
  input: BuildHtmlTableMetadataInput,
  parent: WebElementNode,
): WebElementNode[] {
  return parent.children.map((ref) => input.node(ref)).filter(
    (node): node is WebElementNode => node.kind === "element",
  );
}

function cellIsEmpty(input: BuildHtmlTableMetadataInput, cell: WebElementNode): boolean {
  for (const ref of cell.children) {
    const child = input.node(ref);
    if (child.kind === "element") return false;
    if (child.kind === "text" && /[^\t\n\f\r ]/u.test(child.value)) return false;
  }
  return true;
}

function groupsForRange(
  ranges: readonly HtmlTableGroupRange[],
  start: number,
  end: number,
): readonly DocumentNodeRef[] {
  return Object.freeze(
    ranges.filter((range) => range.start < end && range.end > start).map((range) => range.node),
  );
}

function insertSlotInterval(intervals: MutableSlotInterval[], interval: MutableSlotInterval): void {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((intervals[middle]?.columnStart ?? Number.MAX_SAFE_INTEGER) <= interval.columnStart) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  intervals.splice(low, 0, interval);
}

function orderedRows(
  input: BuildHtmlTableMetadataInput,
  tableChildren: readonly WebElementNode[],
): readonly RowInput[] {
  const rows: RowInput[] = [];
  const pendingFooters: WebElementNode[] = [];
  const appendGroup = (group: WebElementNode): void => {
    for (const row of elementChildren(input, group)) {
      if (isHtml(row, "tr")) rows.push(Object.freeze({ node: row, rowGroup: group }));
    }
  };
  for (const child of tableChildren) {
    if (isHtml(child, "tr")) {
      rows.push(Object.freeze({ node: child, rowGroup: null }));
    } else if (isHtml(child, "tfoot")) {
      pendingFooters.push(child);
    } else if (isHtml(child) && (child.name === "thead" || child.name === "tbody")) {
      appendGroup(child);
    }
  }
  for (const footer of pendingFooters) appendGroup(footer);
  return Object.freeze(rows);
}

function buildTableModel(
  input: BuildHtmlTableMetadataInput,
  table: WebElementNode,
  consumeSlotWork: () => void,
): {
  readonly metadata: HtmlTableMetadata;
  readonly cellMetadata: readonly HtmlTableCellMetadata[];
  readonly columnMetadata: readonly HtmlTableColumnMetadata[];
  readonly columnGroupMetadata: readonly HtmlTableColumnGroupMetadata[];
} {
  const tableChildren = elementChildren(input, table);
  const captions = tableChildren.filter((entry) => isHtml(entry, "caption")).map((entry) => entry.ref);
  const rowGroupElements = tableChildren.filter(
    (entry) => isHtml(entry) && (entry.name === "thead" || entry.name === "tbody" || entry.name === "tfoot"),
  );
  const columnGroupElements = tableChildren.filter((entry) => isHtml(entry, "colgroup"));
  const rows = orderedRows(input, tableChildren);

  const columnGroupMetadata: HtmlTableColumnGroupMetadata[] = [];
  const columnMetadata: HtmlTableColumnMetadata[] = [];
  const columnGroupRanges: HtmlTableGroupRange[] = [];
  const columnElements: WebElementNode[] = [];
  let xWidth = 0;
  for (const group of columnGroupElements) {
    const owned = elementChildren(input, group).filter((node) => isHtml(node, "col"));
    const groupStart = xWidth;
    if (owned.length === 0) {
      const span = boundedUnsignedInteger(input.attribute(group.ref, "span"), 1, MAX_COLUMN_SPAN);
      xWidth = Math.min(MAX_TABLE_COLUMN_SLOTS, xWidth + span);
    } else {
      for (const column of owned) {
        const span = boundedUnsignedInteger(input.attribute(column.ref, "span"), 1, MAX_COLUMN_SPAN);
        columnElements.push(column);
        columnMetadata.push(Object.freeze({
          node: column.ref,
          table: table.ref,
          columnGroup: group.ref,
          span,
        }));
        xWidth = Math.min(MAX_TABLE_COLUMN_SLOTS, xWidth + span);
      }
    }
    const span = xWidth - groupStart;
    columnGroupMetadata.push(Object.freeze({ node: group.ref, table: table.ref, span }));
    columnGroupRanges.push(Object.freeze({ node: group.ref, start: groupStart, end: xWidth }));
  }

  const occupied = new Map<number, MutableSlotInterval[]>();
  const placements: MutableCellPlacement[] = [];
  const cellMetadata: HtmlTableCellMetadata[] = [];
  const downwardGrowingCells: DocumentNodeRef[] = [];
  const errors: HtmlTableModelError[] = [];
  const logicalRows: HtmlTableRowSlot[] = [];
  const rowGroupRanges: HtmlTableGroupRange[] = [];
  const rowElements: WebElementNode[] = [];
  const cellElements: WebElementNode[] = [];
  const sourceOrder = new Map(input.elements.map((element, index) => [element.ref, index] as const));
  let yCurrent = 0;
  let yHeight = 0;
  let currentGroup: WebElementNode | null | undefined;
  let groupStart = 0;
  let groupHadRows = false;
  let downward: { readonly placement: number; readonly column: number; readonly width: number }[] = [];

  const ensureLogicalRow = (
    index: number,
    node: DocumentNodeRef | null,
    rowGroup: DocumentNodeRef | null,
  ): void => {
    while (logicalRows.length < index) {
      logicalRows.push(Object.freeze({ index: logicalRows.length, node: null, rowGroup }));
    }
    const existing = logicalRows[index];
    if (existing === undefined) {
      logicalRows.push(Object.freeze({ index, node, rowGroup }));
    } else if (node !== null && existing.node === null) {
      logicalRows[index] = Object.freeze({ index, node, rowGroup });
    }
  };

  const occupy = (
    row: number,
    columnStart: number,
    columnEnd: number,
    cell: DocumentNodeRef,
  ): boolean => {
    consumeSlotWork();
    const target = occupied.get(row) ?? [];
    const overlaps = target.some(
      (entry) => entry.columnStart < columnEnd && entry.columnEnd > columnStart,
    );
    insertSlotInterval(target, Object.freeze({ row, columnStart, columnEnd, cell }));
    occupied.set(row, target);
    return overlaps;
  };

  const growDownward = (rowGroup: DocumentNodeRef | null): void => {
    ensureLogicalRow(yCurrent, null, rowGroup);
    for (const entry of downward) {
      const placement = placements[entry.placement];
      if (placement === undefined) continue;
      if (occupy(yCurrent, entry.column, entry.column + entry.width, placement.node)) {
        errors.push(Object.freeze({ kind: "overlapping-cells", cell: placement.node }));
      }
      placement.rowSpan = Math.max(placement.rowSpan, yCurrent - placement.row + 1);
      xWidth = Math.max(xWidth, entry.column + entry.width);
    }
  };

  const endRowBlock = (): void => {
    if (currentGroup === undefined) return;
    const rowGroup = currentGroup?.ref ?? null;
    while (yCurrent < yHeight) {
      growDownward(rowGroup);
      yCurrent += 1;
    }
    if (currentGroup !== null && groupHadRows) {
      rowGroupRanges.push(Object.freeze({
        node: currentGroup.ref,
        start: groupStart,
        end: yHeight,
      }));
    }
    downward = [];
  };

  for (const rowInput of rows) {
    if (currentGroup !== rowInput.rowGroup) {
      endRowBlock();
      currentGroup = rowInput.rowGroup;
      groupStart = yCurrent;
      groupHadRows = false;
    }
    groupHadRows = true;
    if (yHeight === yCurrent) yHeight += 1;
    ensureLogicalRow(yCurrent, rowInput.node.ref, rowInput.rowGroup?.ref ?? null);
    growDownward(rowInput.rowGroup?.ref ?? null);
    rowElements.push(rowInput.node);
    const rowCells = elementChildren(input, rowInput.node).filter(
      (node) => isHtml(node) && (node.name === "td" || node.name === "th"),
    );
    let xCurrent = 0;
    for (const cell of rowCells) {
      const rowIntervals = occupied.get(yCurrent) ?? [];
      while (xCurrent < xWidth) {
        consumeSlotWork();
        const covering = rowIntervals.find(
          (interval) => interval.columnStart <= xCurrent && interval.columnEnd > xCurrent,
        );
        if (covering === undefined) break;
        xCurrent = covering.columnEnd;
      }
      if (xCurrent === xWidth) xWidth += 1;
      const columnSpan = boundedUnsignedInteger(
        input.attribute(cell.ref, "colspan"),
        1,
        MAX_COLUMN_SPAN,
      );
      const rawRowSpan = boundedUnsignedInteger(
        input.attribute(cell.ref, "rowspan"),
        1,
        MAX_ROW_SPAN,
        true,
      );
      const growsDownward = rawRowSpan === 0;
      const initialRowSpan = growsDownward ? 1 : rawRowSpan;
      xWidth = Math.max(xWidth, Math.min(MAX_TABLE_COLUMN_SLOTS, xCurrent + columnSpan));
      yHeight = Math.max(yHeight, yCurrent + initialRowSpan);
      const scopeValue = (input.attribute(cell.ref, "scope") ?? "auto").trim().toLowerCase();
      const scope: HtmlTableCellScope = scopeValue === "row" || scopeValue === "col"
        || scopeValue === "rowgroup" || scopeValue === "colgroup" ? scopeValue : "auto";
      const rawHeaders = input.attribute(cell.ref, "headers");
      const explicitHeaders = (rawHeaders ?? "").trim().split(/\s+/u).filter(Boolean)
        .map((id) => input.elementById(id)).filter((ref): ref is DocumentNodeRef => ref !== null);
      const columnGroups = groupsForRange(columnGroupRanges, xCurrent, xCurrent + columnSpan);
      if (columnGroups.length > 1) {
        errors.push(Object.freeze({ kind: "cell-in-multiple-column-groups", cell: cell.ref }));
      }
      let overlaps = false;
      for (let row = yCurrent; row < yCurrent + initialRowSpan; row += 1) {
        ensureLogicalRow(row, row === yCurrent ? rowInput.node.ref : null, rowInput.rowGroup?.ref ?? null);
        overlaps ||= occupy(row, xCurrent, xCurrent + columnSpan, cell.ref);
      }
      if (overlaps) errors.push(Object.freeze({ kind: "overlapping-cells", cell: cell.ref }));
      const placementIndex = placements.length;
      placements.push({
        node: cell.ref,
        table: table.ref,
        row: yCurrent,
        column: xCurrent,
        rowSpan: initialRowSpan,
        columnSpan,
        rowGroup: rowInput.rowGroup?.ref ?? null,
        columnGroups,
        scope,
        header: cell.name === "th",
        headerRole: null,
        empty: cellIsEmpty(input, cell),
        hasExplicitHeaders: rawHeaders !== null,
        explicitHeaders: Object.freeze(explicitHeaders),
        sourceOrder: sourceOrder.get(cell.ref) ?? placements.length,
      });
      cellMetadata.push(Object.freeze({
        node: cell.ref,
        table: table.ref,
        row: rowInput.node.ref,
        rowGroup: rowInput.rowGroup?.ref ?? null,
        columnSpan,
        rowSpan: growsDownward ? "remaining-row-group" : rawRowSpan,
        scope,
        hasExplicitHeaders: rawHeaders !== null,
        explicitHeaders: Object.freeze(explicitHeaders),
        abbreviation: input.attribute(cell.ref, "abbr"),
        header: cell.name === "th",
        headerRole: null,
      }));
      cellElements.push(cell);
      if (growsDownward) {
        downwardGrowingCells.push(cell.ref);
        downward.push(Object.freeze({
          placement: placementIndex,
          column: xCurrent,
          width: columnSpan,
        }));
      }
      xCurrent += columnSpan;
    }
    yCurrent += 1;
  }
  endRowBlock();

  const slotIntervals: HtmlTableSlotInterval[] = [];
  for (const row of [...occupied.keys()].sort((left, right) => left - right)) {
    for (const interval of occupied.get(row) ?? []) slotIntervals.push(Object.freeze(interval));
  }
  const rowsWithData = new Set<number>();
  const columnsWithData = new Set<number>();
  for (const placement of placements) {
    if (placement.header) continue;
    for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
      rowsWithData.add(row);
    }
    for (let column = placement.column; column < placement.column + placement.columnSpan; column += 1) {
      columnsWithData.add(column);
    }
  }
  const headerRole = (placement: MutableCellPlacement): "row" | "column" | null => {
    if (!placement.header) return null;
    if (placement.scope === "row") return "row";
    if (placement.scope === "col") return "column";
    if (placement.scope === "rowgroup" || placement.scope === "colgroup") return null;
    let hasDataRow = false;
    for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
      hasDataRow ||= rowsWithData.has(row);
    }
    if (!hasDataRow) return "column";
    let hasDataColumn = false;
    for (let column = placement.column; column < placement.column + placement.columnSpan; column += 1) {
      hasDataColumn ||= columnsWithData.has(column);
    }
    return hasDataColumn ? null : "row";
  };
  const finalizedPlacements = placements.map((placement) => Object.freeze({
    ...placement,
    headerRole: headerRole(placement),
  }));
  const semanticRole = (placement: HtmlTableCellPlacement): "row" | "column" | null => {
    if (placement.scope === "rowgroup") return "row";
    if (placement.scope === "colgroup") return "column";
    return placement.headerRole;
  };
  const semanticRolesByNode = new Map(
    finalizedPlacements.map((placement) => [placement.node, semanticRole(placement)] as const),
  );
  const finalizedCellMetadata = cellMetadata.map((metadata) => Object.freeze({
    ...metadata,
    headerRole: semanticRolesByNode.get(metadata.node) ?? null,
  }));
  return {
    metadata: Object.freeze({
      node: table.ref,
      captions: Object.freeze(captions),
      rowGroups: Object.freeze(rowGroupElements.map((entry) => entry.ref)),
      rows: Object.freeze(rowElements.map((entry) => entry.ref)),
      columnGroups: Object.freeze(columnGroupElements.map((entry) => entry.ref)),
      columns: Object.freeze(columnElements.map((entry) => entry.ref)),
      cells: Object.freeze([...cellElements]
        .sort((left, right) => (sourceOrder.get(left.ref) ?? 0) - (sourceOrder.get(right.ref) ?? 0))
        .map((entry) => entry.ref)),
      logicalRows: Object.freeze(logicalRows),
      columnCount: xWidth,
      rowGroupRanges: Object.freeze(rowGroupRanges),
      columnGroupRanges: Object.freeze(columnGroupRanges),
      cellPlacements: Object.freeze(finalizedPlacements),
      slotIntervals: Object.freeze(slotIntervals),
      downwardGrowingCells: Object.freeze(downwardGrowingCells),
      errors: Object.freeze(errors),
    }),
    cellMetadata: Object.freeze(finalizedCellMetadata),
    columnMetadata: Object.freeze(columnMetadata),
    columnGroupMetadata: Object.freeze(columnGroupMetadata),
  };
}

/** Build one bounded immutable HTML table model per admitted HTML table. */
export function buildHtmlTableMetadata(input: BuildHtmlTableMetadataInput): HtmlTableMetadataIndex {
  const tables = new Map<DocumentNodeRef, HtmlTableMetadata>();
  const cells = new Map<DocumentNodeRef, HtmlTableCellMetadata>();
  const columns = new Map<DocumentNodeRef, HtmlTableColumnMetadata>();
  const columnGroups = new Map<DocumentNodeRef, HtmlTableColumnGroupMetadata>();
  const headerAssociations = new Map<DocumentNodeRef, readonly DocumentNodeRef[]>();
  let slotWork = 0;
  let headerAssociationWork = 0;
  let truncation: HtmlTableMetadataIndex["truncation"] = null;
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
      const model = buildTableModel(input, table, consumeSlotWork);
      const associations = associateTableHeaders(
        { cells: model.metadata.cellPlacements, slotIntervals: model.metadata.slotIntervals },
        consumeHeaderAssociationWork,
      );
      tables.set(table.ref, model.metadata);
      for (const metadata of model.cellMetadata) cells.set(metadata.node, metadata);
      for (const metadata of model.columnMetadata) columns.set(metadata.node, metadata);
      for (const metadata of model.columnGroupMetadata) columnGroups.set(metadata.node, metadata);
      for (const [cell, associated] of associations) headerAssociations.set(cell, associated);
    }
  } catch (error) {
    if (!(error instanceof HtmlTableSlotWorkExceeded)
      && !(error instanceof HtmlTableHeaderAssociationWorkExceeded)) throw error;
    truncation = error instanceof HtmlTableSlotWorkExceeded
      ? "slot-work"
      : "header-association-work";
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
