import { layoutPageContent } from "../app/render.js";
import type { PageAction, PageLayout } from "../app/types.js";
import type { BrowserDocumentState } from "./model.js";

export function documentLayout(document: BrowserDocumentState, columns: number): PageLayout {
  return layoutPageContent(document.snapshot.content, columns);
}

export function documentScrollRow(document: BrowserDocumentState, layout: PageLayout): number {
  const first = layout.rows.findIndex((row) => row.blockId === document.scrollAnchor.blockId);
  if (first < 0) return 0;
  let blockRowCount = 0;
  for (let index = first; index < layout.rows.length; index += 1) {
    if (layout.rows[index]?.blockId !== document.scrollAnchor.blockId) break;
    blockRowCount += 1;
  }
  return first + Math.min(document.scrollAnchor.rowOffset, Math.max(0, blockRowCount - 1));
}

export function documentWithScrollRow(
  document: BrowserDocumentState,
  layout: PageLayout,
  requestedRow: number
): BrowserDocumentState {
  if (layout.rows.length === 0) return document;
  const rowIndex = Math.max(0, Math.min(layout.rows.length - 1, requestedRow));
  const row = layout.rows[rowIndex];
  if (!row) return document;
  const first = layout.rows.findIndex((candidate) => candidate.blockId === row.blockId);
  return {
    ...document,
    scrollAnchor: {
      blockId: row.blockId,
      rowOffset: Math.max(0, rowIndex - Math.max(0, first))
    }
  };
}

export function actionById(
  document: BrowserDocumentState,
  actionId: string | null
): PageAction | undefined {
  return actionId === null
    ? undefined
    : document.snapshot.content.actions.find((action) => action.id === actionId);
}

export function scrollToAction(
  document: BrowserDocumentState,
  layout: PageLayout,
  actionId: string
): BrowserDocumentState {
  const placement = layout.actionPlacements.find((candidate) => candidate.actionId === actionId);
  return placement === undefined
    ? document
    : documentWithScrollRow(document, layout, placement.rowIndex);
}

export function blockSearch(
  document: BrowserDocumentState,
  query: string
): NonNullable<BrowserDocumentState["search"]> {
  const normalized = query.trim().toLocaleLowerCase();
  const blockIds = normalized.length === 0
    ? []
    : document.snapshot.content.blocks
      .filter((block) => block.text.toLocaleLowerCase().includes(normalized))
      .map((block) => block.id);
  return { query, blockIds, activeMatchIndex: 0 };
}

export function activeSearchBlockId(document: BrowserDocumentState): string | undefined {
  const search = document.search;
  return search?.blockIds[search.activeMatchIndex];
}

export function scrollToBlock(
  document: BrowserDocumentState,
  blockId: string | undefined
): BrowserDocumentState {
  return blockId === undefined
    ? document
    : { ...document, scrollAnchor: { blockId, rowOffset: 0 } };
}
