import type { Rect } from "@ismail-elkorchi/terminal-ui/renderer";

import { documentContentColumns, layoutPageContent } from "../app/render.js";
import { pageContent } from "../app/page-content.js";
import type { PageAction, PageContent, PageLayout } from "../app/types.js";
import type { BrowserDocumentState } from "./model.js";

export function documentLayout(document: BrowserDocumentState, columns: number): PageLayout {
  return pageContentLayout(pageContent(document.snapshot), columns);
}

export function pageContentLayout(content: PageContent, columns: number): PageLayout {
  return layoutPageContent(content, documentContentColumns(columns));
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
  const rows = layout.rows.flatMap((row, index) =>
    row.fragments.some((fragment) => fragment.blockId === document.scrollAnchor.blockId)
      ? [index]
      : []
  );
  if (rows.length === 0) return 0;
  return rows[Math.min(document.scrollAnchor.rowOffset, rows.length - 1)] ?? 0;
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
  const blockId = row.fragments[0]?.blockId;
  if (blockId === undefined) {
    const next = layout.rows.slice(rowIndex).find((candidate) => candidate.fragments.length > 0)
      ?? [...layout.rows.slice(0, rowIndex)].reverse().find(
        (candidate) => candidate.fragments.length > 0
      );
    const nextBlockId = next?.fragments[0]?.blockId;
    return nextBlockId === undefined
      ? document
      : { ...document, scrollAnchor: { blockId: nextBlockId, rowOffset: 0 } };
  }
  const matchingRows = layout.rows.flatMap((candidate, index) =>
    candidate.fragments.some((fragment) => fragment.blockId === blockId) ? [index] : []
  );
  return {
    ...document,
    scrollAnchor: {
      blockId,
      rowOffset: Math.max(0, matchingRows.indexOf(rowIndex))
    }
  };
}

export function actionById(
  document: BrowserDocumentState,
  actionId: string | null
): PageAction | undefined {
  return actionId === null
    ? undefined
    : pageContent(document.snapshot).actions.find((action) => action.id === actionId);
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
