import type { DocumentNodeRef } from "../document/index.js";
import { documentScrollRow, documentWithScrollRow } from "./document-layout.js";
import type { BrowserDocumentState } from "./model.js";

/** Consumes user deltas inner-to-outer using the latest controlled offsets, never a stale frame's offset. */
export function scrollDocument(
  document: BrowserDocumentState, rows: number, columns: number, viewportRows: number,
  requestedOwner?: DocumentNodeRef | null,
): BrowserDocumentState {
  const viewport = document.rendering.viewport;
  if (viewport === null) return document;
  const ports = new Map(viewport.scrollPorts.map((port) => [port.node, port]));
  const offsets = new Map(document.scrollOffsets.map((offset) => [offset.node, offset]));
  const focusedNode = document.documentState.focus;
  const focusedTarget = requestedOwner !== undefined || focusedNode === null ? undefined
    : viewport.focusTargets.find(target => target.node === focusedNode)
      ?? document.rendering.summary?.focusOrder.find(target => target.node === focusedNode);
  let node = requestedOwner === undefined ? focusedTarget?.scrollOwner ?? null : requestedOwner;
  let inline = columns * viewport.cellInline;
  let block = rows * viewport.cellBlock;
  const visited = new Set<DocumentNodeRef>();
  while (node !== null && !visited.has(node)) {
    visited.add(node);
    const port = ports.get(node);
    if (port === undefined) break;
    const current = offsets.get(node) ?? { node, inline: port.inline, block: port.block };
    const nextInline = port.userScrollInline ? Math.max(port.minInline, Math.min(port.maxInline, current.inline + inline)) : current.inline;
    const nextBlock = port.userScrollBlock ? Math.max(port.minBlock, Math.min(port.maxBlock, current.block + block)) : current.block;
    inline -= nextInline - current.inline;
    block -= nextBlock - current.block;
    if (nextInline !== current.inline || nextBlock !== current.block) offsets.set(node, { node, inline: nextInline, block: nextBlock });
    node = port.parent;
  }
  const rootInlineAllowed = viewport.viewportOverflow.x !== "hidden" && viewport.viewportOverflow.x !== "clip";
  const scrollColumn = rootInlineAllowed ? Math.max(viewport.minScrollColumn ?? 0,
    Math.min(viewport.maxScrollColumn ?? 0, Math.floor((document.scrollColumn ?? 0) + inline / viewport.cellInline))) : document.scrollColumn ?? 0;
  const updated = { ...document, scrollColumn, scrollOffsets: Object.freeze([...offsets.values()]), rendering: { ...document.rendering, pendingReveal: null, pendingFocus: null } };
  const overflow = viewport.viewportOverflow.y;
  return overflow === "hidden" || overflow === "clip" ? updated
    : documentWithScrollRow(updated, documentScrollRow(document) + block / viewport.cellBlock, viewportRows);
}
