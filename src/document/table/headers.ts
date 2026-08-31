import type { DocumentNodeRef } from "../types.js";
import type { HtmlTableHeaderCellPlacement } from "./types.js";

function overlaps(start: number, span: number, otherStart: number, otherSpan: number): boolean {
  return start < otherStart + otherSpan && otherStart < start + span;
}

/** Resolve HTML table header relationships from logical table slots, never painted text. */
export function associateTableHeaders(
  cells: readonly HtmlTableHeaderCellPlacement[],
  consumeWork: () => void,
): ReadonlyMap<DocumentNodeRef, readonly DocumentNodeRef[]> {
  const headersByNode = new Map(cells.filter((cell) => cell.header).map((cell) => [cell.node, cell] as const));
  const result = new Map<DocumentNodeRef, readonly DocumentNodeRef[]>();
  for (const cell of cells) {
    if (cell.header) continue;
    const associated: DocumentNodeRef[] = [];
    const seen = new Set<DocumentNodeRef>();
    const append = (node: DocumentNodeRef): void => {
      if (seen.has(node)) return;
      seen.add(node);
      associated.push(node);
    };
    if (cell.explicitHeaders.length > 0) {
      for (const node of cell.explicitHeaders) {
        consumeWork();
        const header = headersByNode.get(node);
        if (header?.table === cell.table) append(node);
      }
      result.set(cell.node, Object.freeze(associated));
      continue;
    }
    for (const header of headersByNode.values()) {
      consumeWork();
      if (header.table !== cell.table) continue;
      const scope = header.scope;
      if (scope === "row" && overlaps(header.row, header.rowSpan, cell.row, cell.rowSpan)) append(header.node);
      else if (scope === "col" && overlaps(header.column, header.columnSpan, cell.column, cell.columnSpan)) append(header.node);
      else if (scope === "rowgroup" && header.rowGroup !== null && header.rowGroup === cell.rowGroup) append(header.node);
      else if (scope === "colgroup" && header.columnGroup !== null && header.columnGroup === cell.columnGroup) append(header.node);
      else if (scope === "auto") {
        if (header.row === cell.row && header.column < cell.column) append(header.node);
        else if (overlaps(header.column, header.columnSpan, cell.column, cell.columnSpan)
          && header.row < cell.row) append(header.node);
      }
    }
    result.set(cell.node, Object.freeze(associated));
  }
  return result;
}
