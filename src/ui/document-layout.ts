import type { Rect } from "@ismail-elkorchi/terminal-ui/renderer";

import { documentContentColumns, layoutPageContent } from "../app/render.js";
import type { PageAction, PageLayout } from "../app/types.js";
import type { BrowserDocumentState } from "./model.js";

export function documentLayout(document: BrowserDocumentState, columns: number): PageLayout {
  return layoutPageContent(document.snapshot.content, documentContentColumns(columns));
}

export function documentContentBounds(bounds: Rect): Rect {
  const width = documentContentColumns(bounds.width);
  return {
    row: bounds.row,
    column: bounds.column + Math.floor((bounds.width - width) / 2),
    width,
    height: bounds.height
  };
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
  requestedRow: number,
  viewportRows = 1
): BrowserDocumentState {
  if (layout.rows.length === 0) return document;
  const normalizedViewportRows = Math.max(1, Math.floor(viewportRows));
  const rowIndex = Math.max(
    0,
    Math.min(Math.max(0, layout.rows.length - normalizedViewportRows), requestedRow)
  );
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

export function activeSearchMatch(document: BrowserDocumentState) {
  const search = document.search;
  return search?.matches[search.activeMatchIndex];
}

export function scrollToBlock(
  document: BrowserDocumentState,
  blockId: string | undefined
): BrowserDocumentState {
  return blockId === undefined
    ? document
    : { ...document, scrollAnchor: { blockId, rowOffset: 0 } };
}
