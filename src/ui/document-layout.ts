import type { Rect } from "@ismail-elkorchi/terminal-ui/renderer";

import type { DocumentForm, DocumentFormControl, DocumentLink, DocumentNodeRef } from "../document/index.js";
import type { DocumentState } from "../document/index.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import { renderDocument, type RenderPipelineResult } from "../presentation/pipeline.js";
import type { FragmentTree, TerminalAction } from "../presentation/terminal/index.js";
import type { BrowserDocumentState } from "./model.js";
import { terminalTextMeasurer } from "./terminal-measure.js";

const MAX_DOCUMENT_COLUMNS = 120;
const MAX_RENDER_PIPELINE_CACHE_ENTRIES = 4;
const TERMINAL_MEASURER = terminalTextMeasurer();

interface CachedRenderPipeline {
  readonly key: string;
  readonly snapshot: IndexedPageSnapshot;
  readonly state: DocumentState;
  readonly result: RenderPipelineResult;
}

/** Explicit, bounded UI-owned cache for viewport-derived render-pipeline work. */
export class RenderPipelineCache {
  readonly #entries: CachedRenderPipeline[] = [];

  public get(
    snapshot: IndexedPageSnapshot,
    state: DocumentState,
    columns: number,
    rows: number
  ): RenderPipelineResult {
    const viewportColumns = documentContentColumns(columns);
    const viewportRows = Math.max(1, Math.floor(rows));
    const key = `${String(viewportColumns)}x${String(viewportRows)}`;
    const existingIndex = this.#entries.findIndex((entry) =>
      entry.key === key && entry.snapshot === snapshot && entry.state === state
    );
    if (existingIndex >= 0) {
      const existing = this.#entries.splice(existingIndex, 1)[0];
      if (existing !== undefined) {
        this.#entries.push(existing);
        return existing.result;
      }
    }
    const result = renderDocument({
      document: snapshot.document,
      state,
      resources: snapshot.stylesheets,
      styleDiagnostics: snapshot.styleDiagnostics,
      viewport: { columns: viewportColumns, rows: viewportRows },
      measurer: TERMINAL_MEASURER,
      profile: {
        cellWidthPx: 8,
        rowHeightPx: 16,
        colorDepth: 24,
        unicode: true,
        ambiguousWidth: 1
      }
    });
    this.#entries.push({ key, snapshot, state, result });
    if (this.#entries.length > MAX_RENDER_PIPELINE_CACHE_ENTRIES) this.#entries.shift();
    return result;
  }
}

export type BrowserDocumentAction = {
  readonly id: string;
  readonly kind: "link";
  readonly node: DocumentNodeRef;
  readonly index: number;
  readonly label: string;
  readonly destination: string;
} | {
  readonly id: string;
  readonly kind: "form-control";
  readonly node: DocumentNodeRef;
  readonly form: DocumentNodeRef | null;
  readonly control: DocumentFormControl;
} | {
  readonly id: string;
  readonly kind: "disclosure";
  readonly node: DocumentNodeRef;
  readonly open: boolean;
};

export function documentContentColumns(columns: number): number {
  return Math.max(1, Math.min(MAX_DOCUMENT_COLUMNS, Math.floor(columns)));
}

export function renderDocumentForViewport(
  document: BrowserDocumentState,
  columns: number,
  viewportRows = 24
): RenderPipelineResult {
  return document.renderPipelineCache.get(document.snapshot, document.documentState, columns, viewportRows);
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

function rowsForSource(layout: FragmentTree, source: DocumentNodeRef | null): readonly number[] {
  if (source === null) return [];
  const rows = new Set<number>();
  for (const fragment of layout.forSource(source)) {
    const end = Math.min(layout.rows.length, fragment.rect.row + fragment.rect.height);
    for (let row = fragment.rect.row; row < end; row += 1) rows.add(row);
  }
  if (rows.size === 0) {
    const anchor = layout.scrollAnchors.find((entry) => entry.source === source);
    if (anchor !== undefined) rows.add(anchor.row);
  }
  return [...rows].sort((left, right) => left - right);
}

export function documentScrollRow(document: BrowserDocumentState, layout: FragmentTree): number {
  if (document.scrollAnchor.source === null) {
    return Math.max(
      0,
      Math.min(Math.max(0, layout.rows.length - 1), document.scrollAnchor.rowOffset)
    );
  }
  const rows = rowsForSource(layout, document.scrollAnchor.source);
  if (rows.length === 0) return 0;
  return rows[Math.min(document.scrollAnchor.rowOffset, rows.length - 1)] ?? 0;
}

export function documentWithScrollRow(
  document: BrowserDocumentState,
  layout: FragmentTree,
  requestedRow: number,
  viewportRows = 1
): BrowserDocumentState {
  if (layout.rows.length === 0) return document;
  const normalizedViewportRows = Math.max(1, Math.floor(viewportRows));
  const rowIndex = Math.max(
    0,
    Math.min(Math.max(0, layout.rows.length - normalizedViewportRows), Math.floor(requestedRow))
  );
  const row = layout.rows[rowIndex];
  const source = row?.fragments.find((fragment) => fragment.source !== null)?.source ?? null;
  if (source === null) return { ...document, scrollAnchor: { source: null, rowOffset: rowIndex } };
  const matchingRows = rowsForSource(layout, source);
  return {
    ...document,
    scrollAnchor: {
      source,
      rowOffset: Math.max(0, matchingRows.indexOf(rowIndex))
    }
  };
}

function linkAction(link: DocumentLink): BrowserDocumentAction {
  return {
    id: `link:${link.node}`,
    kind: "link",
    node: link.node,
    index: link.index,
    label: link.label,
    destination: link.destination
  };
}

export function actionById(
  document: BrowserDocumentState,
  actionId: string | null
): BrowserDocumentAction | undefined {
  if (actionId === null) return undefined;
  if (actionId.startsWith("link:")) {
    const node = actionId.slice("link:".length) as DocumentNodeRef;
    const link = document.snapshot.document.link(node);
    return link === null ? undefined : linkAction(link);
  }
  if (actionId.startsWith("control:")) {
    const node = actionId.slice("control:".length) as DocumentNodeRef;
    const control = document.snapshot.document.control(node);
    return control === null
      ? undefined
      : { id: actionId, kind: "form-control", node, form: control.form, control };
  }
  if (actionId.startsWith("disclosure:")) {
    const node = actionId.slice("disclosure:".length) as DocumentNodeRef;
    const disclosure = document.snapshot.document.disclosure(node);
    return disclosure?.kind !== "details"
      ? undefined
      : { id: actionId, kind: "disclosure", node, open: document.documentState.open.has(node) };
  }
  return undefined;
}

export function actionId(action: TerminalAction): string {
  if (action.kind === "link") return `link:${action.node}`;
  if (action.kind === "form-control") return `control:${action.node}`;
  return `disclosure:${action.node}`;
}

export function formByRef(document: BrowserDocumentState, ref: DocumentNodeRef): DocumentForm | null {
  return document.snapshot.document.form(ref);
}

export function scrollToSource(
  document: BrowserDocumentState,
  source: DocumentNodeRef | undefined
): BrowserDocumentState {
  return source === undefined ? document : { ...document, scrollAnchor: { source, rowOffset: 0 } };
}
