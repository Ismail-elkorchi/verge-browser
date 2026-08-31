import type { DocumentNodeRef } from "../../../document/index.js";
import type { FormattingNode, FormattingNodeId } from "../types.js";
import type { TableBoxFixupHost } from "./types.js";

const CELL_KINDS = new Set<FormattingNode["kind"]>(["table-cell"]);
const ROW_KINDS = new Set<FormattingNode["kind"]>(["table-row"]);
const GROUP_KINDS = new Set<FormattingNode["kind"]>(["table-header-group", "table-body-group", "table-footer-group"]);

function isInternal(kind: FormattingNode["kind"]): boolean {
  return CELL_KINDS.has(kind) || ROW_KINDS.has(kind) || GROUP_KINDS.has(kind)
    || kind === "table-caption" || kind === "table-column-group" || kind === "table-column";
}

/** Apply CSS table anonymous-box fixup at the box-generation boundary. */
export function fixTableChildren(
  host: TableBoxFixupHost,
  children: readonly FormattingNode[],
  parent: FormattingNode["kind"],
  styleNode: DocumentNodeRef | null,
): readonly FormattingNodeId[] {
  const hasTableInternal = children.some((child) => isInternal(child.kind));
  const normalizedChildren = hasTableInternal
    ? children.filter((child) => !host.collapsesEntireTextRun(child))
    : children;
  const expected = (kind: FormattingNode["kind"]): boolean => {
    if (parent === "table-row") return CELL_KINDS.has(kind);
    if (parent === "table-column-group") return kind === "table-column";
    if (GROUP_KINDS.has(parent)) return ROW_KINDS.has(kind);
    if (parent === "table") return GROUP_KINDS.has(kind) || kind === "table-caption" || kind === "table-column-group";
    return !isInternal(kind);
  };
  const expectedNode = (node: FormattingNode): boolean => host.isOutOfFlow(node) || expected(node.kind);
  if (normalizedChildren.every(expectedNode)) return normalizedChildren.map((child) => child.id);
  if (parent === "table-column-group") {
    return normalizedChildren
      .filter((child) => host.isOutOfFlow(child) || child.kind === "table-column")
      .map((child) => child.id);
  }
  if (parent === "table-row") {
    return normalizedChildren.map((child) => host.isOutOfFlow(child) || CELL_KINDS.has(child.kind)
      ? child.id
      : host.anonymousContainer("table-cell", styleNode, [child.id], "block").id);
  }
  if (GROUP_KINDS.has(parent)) {
    const output: FormattingNodeId[] = [];
    let cellsRun: FormattingNodeId[] = [];
    const flush = (): void => {
      if (cellsRun.length === 0) return;
      output.push(host.anonymousContainer("table-row", styleNode, cellsRun, "block").id);
      cellsRun = [];
    };
    for (const child of normalizedChildren) {
      if (host.isOutOfFlow(child)) {
        flush();
        output.push(child.id);
      } else if (child.kind === "table-row") {
        flush();
        output.push(child.id);
      } else if (child.kind === "table-cell") cellsRun.push(child.id);
      else cellsRun.push(host.anonymousContainer("table-cell", styleNode, [child.id], "block").id);
    }
    flush();
    return output;
  }
  if (parent === "table") {
    const output: FormattingNodeId[] = [];
    let rowsRun: FormattingNodeId[] = [];
    let cellsRun: FormattingNodeId[] = [];
    let columnsRun: FormattingNodeId[] = [];
    const flushCells = (): void => {
      if (cellsRun.length === 0) return;
      rowsRun.push(host.anonymousContainer("table-row", styleNode, cellsRun, "block").id);
      cellsRun = [];
    };
    const flushRows = (): void => {
      flushCells();
      if (rowsRun.length === 0) return;
      output.push(host.anonymousContainer("table-body-group", styleNode, rowsRun, "block").id);
      rowsRun = [];
    };
    const flushColumns = (): void => {
      if (columnsRun.length === 0) return;
      output.push(host.anonymousContainer("table-column-group", styleNode, columnsRun, "block").id);
      columnsRun = [];
    };
    const flushAll = (): void => {
      flushRows();
      flushColumns();
    };
    for (const child of normalizedChildren) {
      if (host.isOutOfFlow(child)) {
        flushAll();
        output.push(child.id);
      } else if (child.kind === "table-caption") {
        flushAll();
        output.push(child.id);
      } else if (child.kind === "table-column") {
        flushRows();
        columnsRun.push(child.id);
      } else if (child.kind === "table-column-group") {
        flushAll();
        output.push(child.id);
      } else if (GROUP_KINDS.has(child.kind)) {
        flushAll();
        output.push(child.id);
      } else if (child.kind === "table-row") {
        flushColumns();
        flushCells();
        rowsRun.push(child.id);
      } else if (child.kind === "table-cell") {
        flushColumns();
        cellsRun.push(child.id);
      } else {
        flushColumns();
        cellsRun.push(host.anonymousContainer("table-cell", styleNode, [child.id], "block").id);
      }
    }
    flushAll();
    return output;
  }
  const output: FormattingNodeId[] = [];
  let internalRun: FormattingNode[] = [];
  const flush = (): void => {
    if (internalRun.length === 0) return;
    const tableChildren = fixTableChildren(host, internalRun, "table", styleNode);
    const table = host.anonymousContainer("table", styleNode, tableChildren, "block");
    output.push(host.anonymousContainer("table-wrapper", styleNode, [table.id], "block").id);
    internalRun = [];
  };
  for (const child of normalizedChildren) {
    if (expectedNode(child)) {
      flush();
      output.push(child.id);
    } else internalRun.push(child);
  }
  flush();
  return output;
}
