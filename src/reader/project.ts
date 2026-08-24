import type { DocumentNodeRef, WebDocumentNode, WebDocumentSnapshotView } from "../document/index.js";
import type {
  ReaderBlock,
  ReaderBudgets,
  ReaderProjection,
  ReaderTableCell,
  ReaderTableRow
} from "./types.js";

const DEFAULT_READER_BUDGETS: ReaderBudgets = Object.freeze({
  maxNodes: 100_000,
  maxBlocks: 20_000,
  maxTextCodeUnits: 2 * 1024 * 1024,
  maxTableCells: 20_000
});

function budgets(overrides: Partial<ReaderBudgets> | undefined): ReaderBudgets {
  const values = { ...DEFAULT_READER_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return values;
}

function text(document: WebDocumentSnapshotView, ref: DocumentNodeRef, remaining: number): string {
  return document.text(ref, remaining).replace(/\s+/gu, " ").trim();
}

function elementChildren(document: WebDocumentSnapshotView, node: WebDocumentNode): readonly WebDocumentNode[] {
  return node.children.map((ref) => document.node(ref)).filter((child) => child.kind === "element");
}

function listItemText(document: WebDocumentSnapshotView, ref: DocumentNodeRef, maxCodeUnits: number): string {
  const parts: string[] = [];
  let retained = 0;
  const pending = [...document.node(ref).children].reverse();
  while (pending.length > 0 && retained < maxCodeUnits) {
    const current = pending.pop();
    if (current === undefined) continue;
    const node = document.node(current);
    if (node.kind === "text") {
      const value = node.value.slice(0, maxCodeUnits - retained);
      parts.push(value);
      retained += value.length;
      continue;
    }
    if (node.kind === "element" && document.semantic(node.ref)?.role === "list") continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return parts.join("").replace(/\s+/gu, " ").trim();
}

export function projectReaderDocument(
  document: WebDocumentSnapshotView,
  options: { readonly budgets?: Partial<ReaderBudgets>; readonly signal?: AbortSignal } = {}
): ReaderProjection {
  const limits = budgets(options.budgets);
  const blocks: ReaderBlock[] = [];
  let indexedNodes = 0;
  let retainedText = 0;
  let tableCells = 0;
  let truncated = false;
  const listOrdinals = new Map<DocumentNodeRef, ReadonlyMap<DocumentNodeRef, number>>();
  const boundaryCache = new Map<DocumentNodeRef, boolean>();
  const chargedNodes = new Set<DocumentNodeRef>();

  const retain = (value: string): string => {
    const remaining = limits.maxTextCodeUnits - retainedText;
    if (remaining <= 0) {
      truncated = true;
      return "";
    }
    const result = value.slice(0, remaining);
    retainedText += result.length;
    if (result.length !== value.length) truncated = true;
    return result;
  };

  const isReaderBoundary = (ref: DocumentNodeRef): boolean => {
    const role = document.semantic(ref)?.role;
    return role === "heading" || role === "paragraph" || role === "blockquote"
      || role === "term" || role === "definition" || role === "list"
      || role === "listitem" || role === "table" || document.replaced(ref) !== null;
  };

  const charge = (ref: DocumentNodeRef): boolean => {
    if (chargedNodes.has(ref)) return true;
    if (chargedNodes.size >= limits.maxNodes) {
      truncated = true;
      return false;
    }
    chargedNodes.add(ref);
    indexedNodes = chargedNodes.size;
    return true;
  };

  const containsReaderBoundary = (ref: DocumentNodeRef): boolean => {
    const cached = boundaryCache.get(ref);
    if (cached !== undefined) return cached;
    const pending: { readonly ref: DocumentNodeRef; readonly expanded: boolean }[] = [
      { ref, expanded: false }
    ];
    while (pending.length > 0) {
      options.signal?.throwIfAborted();
      const entry = pending.pop();
      if (entry === undefined || boundaryCache.has(entry.ref)) continue;
      if (!charge(entry.ref)) {
        boundaryCache.set(entry.ref, true);
        continue;
      }
      const children = document.node(entry.ref).children;
      if (entry.expanded) {
        boundaryCache.set(entry.ref, children.some((child) =>
          isReaderBoundary(child) || boundaryCache.get(child) === true
        ));
        continue;
      }
      pending.push({ ref: entry.ref, expanded: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined && !isReaderBoundary(child) && !boundaryCache.has(child)) {
          pending.push({ ref: child, expanded: false });
        }
      }
    }
    return boundaryCache.get(ref) ?? false;
  };

  const visit = (ref: DocumentNodeRef, listDepth: number): void => {
    options.signal?.throwIfAborted();
    if (blocks.length >= limits.maxBlocks) {
      truncated = true;
      return;
    }
    if (!charge(ref)) return;
    const node = document.node(ref);
    if (node.kind !== "element") return;
    const semantic = document.semantic(ref);
    if (semantic?.accessibilityHidden === true) return;
    const value = (): string => retain(text(document, ref, limits.maxTextCodeUnits - retainedText));
    if (semantic?.role === "heading") {
      const retained = value();
      const level = document.heading(ref)?.level ?? 2;
      if (retained.length > 0) blocks.push(Object.freeze({ kind: "heading", source: ref, level, text: retained }));
      return;
    }
    if (semantic?.role === "paragraph") {
      const retained = value();
      if (retained.length > 0) blocks.push(Object.freeze({ kind: "paragraph", source: ref, text: retained }));
      return;
    }
    if (semantic?.role === "blockquote") {
      const retained = value();
      if (retained.length > 0) blocks.push(Object.freeze({ kind: "quotation", source: ref, text: retained }));
      return;
    }
    if (semantic?.role === "term" || semantic?.role === "definition") {
      const retained = value();
      if (retained.length > 0) blocks.push(Object.freeze({ kind: semantic.role, source: ref, text: retained }));
      return;
    }
    if (semantic?.role === "listitem") {
      const parent = document.parent(ref);
      let ordinals = parent === null ? undefined : listOrdinals.get(parent.ref);
      if (parent !== null && ordinals === undefined) {
        let ordinal = 0;
        const indexed = new Map<DocumentNodeRef, number>();
        for (const child of elementChildren(document, parent)) {
          if (document.semantic(child.ref)?.role !== "listitem") continue;
          indexed.set(child.ref, ++ordinal);
        }
        ordinals = indexed;
        listOrdinals.set(parent.ref, indexed);
      }
      const ordinal = ordinals?.get(ref) ?? 1;
      const ordered = parent?.kind === "element" && parent.name === "ol";
      const retained = retain(listItemText(document, ref, limits.maxTextCodeUnits - retainedText));
      if (retained.length > 0) {
        blocks.push(Object.freeze({
          kind: "list-item",
          source: ref,
          depth: listDepth,
          marker: ordered ? `${String(ordinal)}.` : "•",
          text: retained
        }));
      }
      for (const child of node.children) {
        if (document.semantic(child)?.role === "list") visit(child, listDepth);
      }
      return;
    }
    if (semantic?.role === "table") {
      const rows: ReaderTableRow[] = [];
      const pending = [...node.children].reverse();
      while (pending.length > 0 && tableCells < limits.maxTableCells) {
        options.signal?.throwIfAborted();
        const childRef = pending.pop();
        if (childRef === undefined) continue;
        if (!charge(childRef)) break;
        const child = document.node(childRef);
        if (child.kind !== "element") continue;
        if (document.semantic(child.ref)?.role === "row") {
          const cells: ReaderTableCell[] = [];
          for (const cellRef of child.children) {
            const cell = document.node(cellRef);
            if (cell.kind !== "element") continue;
            const role = document.semantic(cell.ref)?.role;
            if (role !== "cell" && role !== "columnheader" && role !== "rowheader") continue;
            if (tableCells >= limits.maxTableCells) {
              truncated = true;
              break;
            }
            tableCells += 1;
            cells.push(Object.freeze({
              source: cell.ref,
              header: role === "columnheader" || role === "rowheader",
              text: retain(text(document, cell.ref, limits.maxTextCodeUnits - retainedText))
            }));
          }
          rows.push(Object.freeze({ source: child.ref, cells: Object.freeze(cells) }));
        } else {
          for (let index = child.children.length - 1; index >= 0; index -= 1) {
            const nested = child.children[index];
            if (nested !== undefined) pending.push(nested);
          }
        }
      }
      blocks.push(Object.freeze({ kind: "table", source: ref, rows: Object.freeze(rows) }));
      return;
    }
    const replaced = document.replaced(ref);
    if (replaced !== null) {
      blocks.push(Object.freeze({ kind: "media", source: ref, text: retain(replaced.fallbackText) }));
      return;
    }
    const nextDepth = semantic?.role === "list" ? listDepth + 1 : listDepth;
    if (!containsReaderBoundary(ref)) {
      const retained = value();
      if (retained.length > 0) blocks.push(Object.freeze({ kind: "paragraph", source: ref, text: retained }));
      return;
    }
    let inlineRun: DocumentNodeRef[] = [];
    const flushInline = (): void => {
      if (inlineRun.length === 0 || blocks.length >= limits.maxBlocks) {
        if (blocks.length >= limits.maxBlocks) truncated = true;
        inlineRun = [];
        return;
      }
      const joined = inlineRun.map((child) => document.text(child, limits.maxTextCodeUnits - retainedText)).join("");
      const retained = retain(joined.replace(/\s+/gu, " ").trim());
      if (retained.length > 0) blocks.push(Object.freeze({ kind: "paragraph", source: ref, text: retained }));
      inlineRun = [];
    };
    for (const child of node.children) {
      const childNode = document.node(child);
      const boundary = childNode.kind === "element" && (isReaderBoundary(child) || containsReaderBoundary(child));
      if (!boundary) {
        inlineRun.push(child);
        continue;
      }
      flushInline();
      visit(child, nextDepth);
    }
    flushInline();
  };

  for (const child of document.node(document.body ?? document.documentElement ?? document.root).children) {
    visit(child, 0);
  }
  return Object.freeze({
    document,
    title: document.title,
    blocks: Object.freeze(blocks),
    truncated,
    indexedNodes
  });
}

export function readerLines(projection: ReaderProjection): readonly string[] {
  const lines: string[] = [projection.title, ""];
  for (const block of projection.blocks) {
    if (block.kind === "heading") lines.push(`${"#".repeat(block.level)} ${block.text}`, "");
    else if (block.kind === "list-item") lines.push(`${"  ".repeat(block.depth)}${block.marker} ${block.text}`);
    else if (block.kind === "quotation") lines.push(`> ${block.text}`, "");
    else if (block.kind === "term") lines.push(block.text);
    else if (block.kind === "definition") lines.push(`  ${block.text}`, "");
    else if (block.kind === "media") lines.push(`[${block.text}]`, "");
    else if (block.kind === "table") {
      for (const row of block.rows) lines.push(row.cells.map((cell) => cell.text).join("  │  "));
      lines.push("");
    } else lines.push(block.text, "");
  }
  return Object.freeze(lines.length > 2 ? lines : [projection.title, "", "No readable content."]);
}
