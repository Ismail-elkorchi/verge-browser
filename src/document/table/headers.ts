import type { DocumentNodeRef } from "../types.js";
import type { HtmlTableCellPlacement, HtmlTableSlotInterval } from "./types.js";

interface HtmlHeaderAssignmentInput {
  readonly cells: readonly HtmlTableCellPlacement[];
  readonly slotIntervals: readonly HtmlTableSlotInterval[];
}

function stableUnique(values: readonly DocumentNodeRef[]): readonly DocumentNodeRef[] {
  const seen = new Set<DocumentNodeRef>();
  const result: DocumentNodeRef[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

/**
 * Assign HTML table headers from the document-owned slot model.
 *
 * This follows WHATWG's directional scan, including header blocks and opaque
 * headers. Explicit `headers` references are expanded transitively because a
 * referenced `th` can itself carry the cell's higher-level header context.
 */
export function associateTableHeaders(
  input: HtmlHeaderAssignmentInput,
  consumeWork: () => void,
): ReadonlyMap<DocumentNodeRef, readonly DocumentNodeRef[]> {
  const byNode = new Map(input.cells.map((cell) => [cell.node, cell] as const));
  const headersByNode = new Map(
    input.cells.filter((cell) => cell.header).map((cell) => [cell.node, cell] as const),
  );
  if (headersByNode.size === 0) {
    const empty = Object.freeze([]) as readonly DocumentNodeRef[];
    return new Map(input.cells.map((cell) => {
      consumeWork();
      return [cell.node, empty] as const;
    }));
  }
  const rowHeadersPresent = [...headersByNode.values()].some((cell) => cell.headerRole === "row");
  const columnHeadersPresent = [...headersByNode.values()].some((cell) => cell.headerRole === "column");
  const rowGroupHeaders = new Map<DocumentNodeRef, HtmlTableCellPlacement[]>();
  const columnGroupHeaders = new Map<DocumentNodeRef, HtmlTableCellPlacement[]>();
  for (const header of headersByNode.values()) {
    if (header.scope === "rowgroup" && header.rowGroup !== null) {
      const scoped = rowGroupHeaders.get(header.rowGroup) ?? [];
      scoped.push(header);
      rowGroupHeaders.set(header.rowGroup, scoped);
    }
    if (header.scope !== "colgroup") continue;
    for (const group of header.columnGroups) {
      const scoped = columnGroupHeaders.get(group) ?? [];
      if (!scoped.some((entry) => entry.node === header.node)) scoped.push(header);
      columnGroupHeaders.set(group, scoped);
    }
  }
  const slots = new Map<string, HtmlTableCellPlacement[]>();
  for (const interval of input.slotIntervals) {
    const cell = byNode.get(interval.cell);
    if (cell === undefined) continue;
    for (let column = interval.columnStart; column < interval.columnEnd; column += 1) {
      consumeWork();
      const key = `${String(column)}:${String(interval.row)}`;
      const covering = slots.get(key) ?? [];
      if (!covering.some((entry) => entry.node === cell.node)) covering.push(cell);
      slots.set(key, covering);
    }
  }
  const explicitHeaders = (principal: HtmlTableCellPlacement): readonly DocumentNodeRef[] => {
    const result: DocumentNodeRef[] = [];
    const retained = new Set<DocumentNodeRef>();
    const active = new Set<DocumentNodeRef>([principal.node]);
    const visit = (node: DocumentNodeRef): void => {
      consumeWork();
      if (node === principal.node || active.has(node) || retained.has(node)) return;
      const header = headersByNode.get(node);
      if (header === undefined || header.table !== principal.table) return;
      retained.add(node);
      result.push(node);
      if (!header.hasExplicitHeaders) return;
      active.add(node);
      for (const ancestor of header.explicitHeaders) visit(ancestor);
      active.delete(node);
    };
    for (const node of principal.explicitHeaders) visit(node);
    return Object.freeze(result);
  };

  const scan = (
    principal: HtmlTableCellPlacement,
    initialColumn: number,
    initialRow: number,
    deltaColumn: -1 | 0,
    deltaRow: -1 | 0,
    output: DocumentNodeRef[],
  ): void => {
    let column = initialColumn;
    let row = initialRow;
    const opaque: HtmlTableCellPlacement[] = [];
    let inHeaderBlock = principal.header;
    let currentBlock: HtmlTableCellPlacement[] = principal.header ? [principal] : [];
    for (;;) {
      column += deltaColumn;
      row += deltaRow;
      if (column < 0 || row < 0) return;
      consumeWork();
      const covering = slots.get(`${String(column)}:${String(row)}`) ?? [];
      if (covering.length !== 1) continue;
      const current = covering[0];
      if (current === undefined) continue;
      if (current.header) {
        inHeaderBlock = true;
        if (!currentBlock.some((entry) => entry.node === current.node)) currentBlock.push(current);
        const blockedByOpaque = opaque.some((entry) => deltaColumn === 0
          ? entry.column === current.column && entry.columnSpan === current.columnSpan
          : entry.row === current.row && entry.rowSpan === current.rowSpan);
        const correctAxis = deltaColumn === 0 ? current.headerRole === "column" : current.headerRole === "row";
        if (!blockedByOpaque && correctAxis) output.push(current.node);
      } else if (inHeaderBlock) {
        inHeaderBlock = false;
        opaque.push(...currentBlock);
        currentBlock = [];
      }
    }
  };

  const result = new Map<DocumentNodeRef, readonly DocumentNodeRef[]>();
  for (const principal of input.cells) {
    let associated: DocumentNodeRef[];
    if (principal.hasExplicitHeaders) {
      associated = [...explicitHeaders(principal)];
    } else {
      associated = [];
      if (rowHeadersPresent) {
        for (let row = principal.row; row < principal.row + principal.rowSpan; row += 1) {
          scan(principal, principal.column, row, -1, 0, associated);
        }
      }
      if (columnHeadersPresent) {
        for (let column = principal.column; column < principal.column + principal.columnSpan; column += 1) {
          scan(principal, column, principal.row, 0, -1, associated);
        }
      }
      if (principal.rowGroup !== null) {
        for (const header of rowGroupHeaders.get(principal.rowGroup) ?? []) {
          consumeWork();
          if (header.column <= principal.column + principal.columnSpan - 1
            && header.row <= principal.row + principal.rowSpan - 1) associated.push(header.node);
        }
      }
      if (principal.columnGroups.length > 0) {
        const scoped = new Map<DocumentNodeRef, HtmlTableCellPlacement>();
        for (const group of principal.columnGroups) {
          for (const header of columnGroupHeaders.get(group) ?? []) scoped.set(header.node, header);
        }
        for (const header of scoped.values()) {
          consumeWork();
          if (header.column <= principal.column + principal.columnSpan - 1
            && header.row <= principal.row + principal.rowSpan - 1) associated.push(header.node);
        }
      }
    }
    associated = associated.filter((node) => node !== principal.node && headersByNode.get(node)?.empty !== true);
    result.set(principal.node, stableUnique(associated));
  }
  return result;
}
