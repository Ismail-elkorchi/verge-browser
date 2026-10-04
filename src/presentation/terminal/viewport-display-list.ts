import type { TextSearchLayoutProjection } from "../search/index.js";
import { ViewportGeometryProjection, reconcileScrollOffsets, revealDocumentNode, revealLayoutRect, logicalRangeRect, scrollRevealDelta, viewportInlineRange } from "./viewport-geometry.js";
import {
  cssCoordinateFromFixed,
  cssLengthFromFixed,
  cssRect,
} from "../layout/index.js";
import type {
  DisplayListSpatialIndex,
  DocumentDisplayList,
  TerminalRenderContext,
  ViewportDisplayList,
  ViewportWindow,
} from "./types.js";

function normalizedWindow(window: ViewportWindow): ViewportWindow {
  const integer = (value: number, minimum: number): number => {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError("Viewport window values must be bounded integers.");
    return value;
  };
  return Object.freeze({
    ...(window.scrollOffsets === undefined ? {} : { scrollOffsets: Object.freeze(window.scrollOffsets.map((entry) => Object.freeze({ ...entry }))) }),
    scrollRow: integer(window.scrollRow, 0),
    scrollColumn: integer(window.scrollColumn ?? 0, Number.MIN_SAFE_INTEGER),
    viewportRows: integer(window.viewportRows, 1),
    overscanBefore: integer(window.overscanBefore, 0),
    overscanAfter: integer(window.overscanAfter, 0),
  });
}

export interface BuildViewportDisplayListInput {
  readonly documentDisplayList: DocumentDisplayList;
  readonly spatialIndex: DisplayListSpatialIndex;
  readonly searchProjection?: TextSearchLayoutProjection | null;
  readonly context: TerminalRenderContext;
  readonly window: ViewportWindow;
  readonly signal?: AbortSignal;
  readonly instrumentation?: {
    record(stage: "spatial-query", elapsedMilliseconds: number): void;
  };
}

/** Selects and resolves only commands intersecting one viewport and bounded overscan window. */
export function buildViewportDisplayList(input: BuildViewportDisplayListInput): ViewportDisplayList {
  let window = normalizedWindow(input.window);
  const layout = input.documentDisplayList.layout;
  const cellWidth = input.context.cellWidthCssPx;
  const inlineRange = viewportInlineRange(layout,input.context.columns*cellWidth);
  const minColumn = Math.floor(inlineRange.minInline/cellWidth);
  const maxColumn = Math.ceil(inlineRange.maxInline/cellWidth);
  const clampColumn = (column: number) => Math.max(minColumn, Math.min(maxColumn, column));
  window = { ...window, scrollColumn: clampColumn(window.scrollColumn ?? 0) };
  let offsets = reconcileScrollOffsets(layout, window.scrollOffsets ?? []);
  const requestedReveal = input.window.reveal;
  if (requestedReveal !== undefined) {
    const rootViewport = cssRect(cssCoordinateFromFixed((window.scrollColumn ?? 0) * cellWidth), cssCoordinateFromFixed(window.scrollRow * input.context.rowHeightCssPx),
      cssLengthFromFixed(input.context.columns * input.context.cellWidthCssPx), cssLengthFromFixed(window.viewportRows * input.context.rowHeightCssPx));
    const span = "node" in requestedReveal || input.searchProjection?.query !== requestedReveal.query
      ? undefined : input.searchProjection.spans.find((entry) => entry.match === requestedReveal.match);
    const range = span === undefined ? null : logicalRangeRect(layout, span.fragment, span.contentStartCodeUnit, span.contentEndCodeUnit);
    const revealed = "node" in requestedReveal
      ? revealDocumentNode(layout, rootViewport, offsets, requestedReveal.node, requestedReveal.blockAlign, input.signal)
      : span !== undefined && range !== null
        ? revealLayoutRect(layout, rootViewport, offsets, span.fragment, range, requestedReveal.blockAlign)
        : { offsets, rect: null };
    offsets = revealed.offsets;
    if (revealed.rect !== null) {
      const inlineDelta = scrollRevealDelta(revealed.rect.x, revealed.rect.width, rootViewport.x, rootViewport.width, "nearest");
      const exactColumn = (rootViewport.x + inlineDelta) / cellWidth;
      const column = inlineDelta > 0 ? Math.ceil(exactColumn) : Math.floor(exactColumn);
      window = { ...window, scrollColumn: clampColumn(column) };
      const delta = scrollRevealDelta(revealed.rect.y, revealed.rect.height, rootViewport.y, rootViewport.height, requestedReveal.blockAlign);
      const exactRow = (rootViewport.y+delta)/input.context.rowHeightCssPx;
      // A block-start anchor must keep the cell containing its first painted line.
      const row = requestedReveal.blockAlign === "start" || delta <= 0 ? Math.floor(exactRow) : Math.ceil(exactRow);
      const extent = Math.ceil(layout.scrollExtent.height / input.context.rowHeightCssPx);
      window = { ...window, scrollRow: Math.max(0, Math.min(row, Math.max(0, extent - window.viewportRows))) };
    }
  }
  window = Object.freeze({ ...window, scrollOffsets: offsets });
  const startRow = Math.max(0, window.scrollRow - window.overscanBefore);
  const retainedRows = window.viewportRows + Math.min(window.scrollRow, window.overscanBefore) + window.overscanAfter;
  const viewport = cssRect(
    cssCoordinateFromFixed((window.scrollColumn ?? 0) * cellWidth),
    cssCoordinateFromFixed(window.scrollRow * input.context.rowHeightCssPx),
    cssLengthFromFixed(input.context.columns * input.context.cellWidthCssPx),
    cssLengthFromFixed(window.viewportRows * input.context.rowHeightCssPx),
  );
  const windowRect = cssRect(
    viewport.x,
    cssCoordinateFromFixed(startRow * input.context.rowHeightCssPx),
    viewport.width,
    cssLengthFromFixed(retainedRows * input.context.rowHeightCssPx),
  );
  const queryStarted = input.instrumentation === undefined ? 0 : performance.now();
  const projection = new ViewportGeometryProjection(input.documentDisplayList.layout, viewport, window.scrollOffsets);
  const queried = input.spatialIndex.query(windowRect, input.signal, projection);
  input.instrumentation?.record("spatial-query", performance.now() - queryStarted);
  return Object.freeze({
    documentDisplayList: input.documentDisplayList,
    context: Object.freeze({ ...input.context, rows: window.viewportRows }),
    window,
    projection,
    viewportRect: viewport,
    windowRect,
    commands: queried.commands,
    spatialQuery: queried.metrics,
    outcome: input.documentDisplayList.outcome,
  });
}
