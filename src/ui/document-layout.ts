import type { Rect } from "@ismail-elkorchi/terminal-ui/renderer";

import type { DocumentForm, DocumentFormControl, DocumentLink, DocumentNodeRef } from "../document/index.js";
import type { DocumentState } from "../document/index.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import { renderDocument, type RenderPipelineResult } from "../presentation/pipeline.js";
import {
  cssCoordinate, cssLengthFromFixed, cssNonNegativeLength, cssPixels, cssPx, cssRect,
  type DocumentActionIdentity
} from "../presentation/layout/index.js";
import type { MediaEnvironment } from "../presentation/style/index.js";
import type { TerminalRenderResult } from "../presentation/terminal/index.js";
import type { BrowserDocumentState } from "./model.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "./terminal-measure.js";

const MAX_DOCUMENT_COLUMNS = 120;
const MAX_RENDER_PIPELINE_CACHE_ENTRIES = 4;
const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

export interface BrowserRenderPreferences {
  readonly colorScheme: "light" | "dark";
  readonly reducedMotion: boolean;
  readonly unicode: boolean;
  readonly ambiguousWidth: 1 | 2;
  readonly colorDepth: 0 | 4 | 8 | 24;
  readonly hover: "none" | "hover";
  readonly pointer: "none" | "coarse" | "fine";
}

/** Derives the shared interactive and one-shot rendering preferences from the terminal environment. */
export function browserRenderPreferences(
  environment: Readonly<Record<string, string | undefined>> =
    (globalThis as { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } })
      .process?.env ?? {}
): BrowserRenderPreferences {
  const requestedScheme = environment.VERGE_COLOR_SCHEME?.trim().toLowerCase();
  const colorFgbg = environment.COLORFGBG?.split(/[;:]/u).at(-1);
  const background = colorFgbg === undefined ? Number.NaN : Number.parseInt(colorFgbg, 10);
  const colorScheme = requestedScheme === "light" || requestedScheme === "dark"
    ? requestedScheme
    : Number.isFinite(background) && background >= 7 ? "light" : "dark";
  const reducedMotion = /^(?:1|true|reduce)$/iu.test(environment.VERGE_REDUCED_MOTION?.trim() ?? "");
  const unicode = environment.VERGE_UNICODE !== "0" && environment.TERM !== "dumb";
  const ambiguousWidth = environment.VERGE_AMBIGUOUS_WIDTH === "2" ? 2 : 1;
  const colorDepth = environment.NO_COLOR !== undefined ? 0
    : /^(?:truecolor|24bit)$/iu.test(environment.COLORTERM ?? "") ? 24
      : /(?:256color)/iu.test(environment.TERM ?? "") ? 8 : 4;
  const requestedPointer = environment.VERGE_POINTER?.trim().toLowerCase();
  const pointer = requestedPointer === "none" || requestedPointer === "coarse" || requestedPointer === "fine"
    ? requestedPointer : "fine";
  const hover = environment.VERGE_HOVER === "none" || pointer === "none" ? "none" : "hover";
  return Object.freeze({ colorScheme, reducedMotion, unicode, ambiguousWidth, colorDepth, hover, pointer });
}

const SHARED_RENDER_PREFERENCES = browserRenderPreferences();
const TERMINAL_CELL_MEASURER = terminalCellMeasurer(SHARED_RENDER_PREFERENCES.ambiguousWidth);
const CSS_TEXT_MEASURER = terminalCssTextMeasurer(
  CELL_WIDTH,
  ROW_HEIGHT,
  SHARED_RENDER_PREFERENCES.ambiguousWidth
);

export function browserMediaEnvironment(
  widthCssPx: number,
  heightCssPx: number,
  preferences: BrowserRenderPreferences = SHARED_RENDER_PREFERENCES
): MediaEnvironment {
  return Object.freeze({
    viewportWidthCssPx: widthCssPx,
    viewportHeightCssPx: heightCssPx,
    mediaType: "screen",
    prefersColorScheme: preferences.colorScheme,
    reducedMotion: preferences.reducedMotion,
    hover: preferences.hover,
    pointer: preferences.pointer
  });
}

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
      mediaEnvironment: browserMediaEnvironment(
        cssPixels(cssLengthFromFixed(viewportColumns * CELL_WIDTH)),
        cssPixels(cssLengthFromFixed(viewportRows * ROW_HEIGHT))
      ),
      layoutContext: {
        viewport: {
          width: cssNonNegativeLength(cssLengthFromFixed(viewportColumns * CELL_WIDTH)),
          height: cssNonNegativeLength(cssLengthFromFixed(viewportRows * ROW_HEIGHT))
        },
        textMeasurer: CSS_TEXT_MEASURER,
        initialContainingBlock: cssRect(
          cssCoordinate(cssPx(0)),
          cssCoordinate(cssPx(0)),
          cssLengthFromFixed(viewportColumns * CELL_WIDTH),
          cssLengthFromFixed(viewportRows * ROW_HEIGHT)
        )
      },
      terminalContext: {
        columns: viewportColumns,
        rows: viewportRows,
        cellWidthCssPx: CELL_WIDTH,
        rowHeightCssPx: ROW_HEIGHT,
        colorDepth: SHARED_RENDER_PREFERENCES.colorDepth,
        unicode: SHARED_RENDER_PREFERENCES.unicode,
        ambiguousWidth: SHARED_RENDER_PREFERENCES.ambiguousWidth,
        cellMeasurer: TERMINAL_CELL_MEASURER
      }
    });
    this.#entries.push({ key, snapshot, state, result });
    if (this.#entries.length > MAX_RENDER_PIPELINE_CACHE_ENTRIES) this.#entries.shift();
    return result;
  }
}

/** Exact typed causes when a rendering stage did not produce a complete result. */
export function renderPipelineIncompleteCauses(result: RenderPipelineResult): readonly string[] {
  const causes: string[] = [];
  const stage = (
    name: string,
    outcome: { readonly status: string; readonly budget?: string; readonly limit?: number;
      readonly reason?: string; readonly feature?: string }
  ): void => {
    if (outcome.status === "complete") return;
    if (outcome.status === "truncated" && outcome.budget !== undefined && outcome.limit !== undefined) {
      causes.push(`${name}.${outcome.budget}=${String(outcome.limit)}`);
      return;
    }
    if (outcome.status === "rejected" && outcome.reason !== undefined) {
      causes.push(`${name}.${outcome.reason}`);
      return;
    }
    if (outcome.status === "unsupported" && outcome.feature !== undefined) {
      causes.push(`${name}.unsupported:${outcome.feature}`);
    }
  };
  stage("style", result.styles.outcome);
  stage("box-tree", result.formatting.outcome);
  stage("layout", result.layout.outcome);
  if (result.displayList.outcome.status === "rejected") stage("display-list", result.displayList.outcome);
  if (result.terminal.cellBuffer.outcome.status === "rejected") {
    stage("cell-buffer", result.terminal.cellBuffer.outcome);
  }
  for (const truncation of result.terminal.truncations) {
    causes.push(`terminal.${truncation.budget}=${String(truncation.limit)}`);
  }
  return Object.freeze(causes);
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

function rowsForSource(render: TerminalRenderResult, source: DocumentNodeRef | null): readonly number[] {
  if (source === null) return [];
  const rows = new Set<number>();
  for (const rect of render.cellRectsForDocumentNode(source)) {
    const end = Math.min(render.cellBuffer.rows.length, rect.row + rect.height);
    for (let row = rect.row; row < end; row += 1) rows.add(row);
  }
  if (rows.size === 0) {
    const anchor = render.scrollAnchors.find((entry) => entry.documentNode === source);
    if (anchor !== undefined) rows.add(anchor.row);
  }
  return [...rows].sort((left, right) => left - right);
}

export function documentScrollRow(document: BrowserDocumentState, render: TerminalRenderResult): number {
  if (document.scrollAnchor.source === null) {
    return Math.max(
      0,
      Math.min(Math.max(0, render.cellBuffer.rows.length - 1), document.scrollAnchor.rowOffset)
    );
  }
  const rows = rowsForSource(render, document.scrollAnchor.source);
  if (rows.length === 0) return 0;
  return rows[Math.min(document.scrollAnchor.rowOffset, rows.length - 1)] ?? 0;
}

export function documentWithScrollRow(
  document: BrowserDocumentState,
  render: TerminalRenderResult,
  requestedRow: number,
  viewportRows = 1
): BrowserDocumentState {
  if (render.cellBuffer.rows.length === 0) return document;
  const normalizedViewportRows = Math.max(1, Math.floor(viewportRows));
  const rowIndex = Math.max(
    0,
    Math.min(Math.max(0, render.cellBuffer.rows.length - normalizedViewportRows), Math.floor(requestedRow))
  );
  const row = render.cellBuffer.rows[rowIndex];
  const source = row?.spans.find((span) => span.documentNode !== null)?.documentNode ?? null;
  if (source === null) return { ...document, scrollAnchor: { source: null, rowOffset: rowIndex } };
  const matchingRows = rowsForSource(render, source);
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

export function actionId(action: DocumentActionIdentity): string {
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
