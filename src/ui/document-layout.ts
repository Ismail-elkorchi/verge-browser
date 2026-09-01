import type { Rect } from "@ismail-elkorchi/terminal-ui/renderer";

import type { DocumentForm, DocumentFormControl, DocumentLink, DocumentNodeRef } from "../document/index.js";
import type { BrowserDocumentState } from "./model.js";
import type { ViewportRenderPayload } from "./render-worker/index.js";

const MAX_DOCUMENT_COLUMNS = 120;

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
export function browserMediaEnvironment(
  widthCssPx: number,
  heightCssPx: number,
  preferences: BrowserRenderPreferences = SHARED_RENDER_PREFERENCES
) {
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

export function documentContentBounds(bounds: Rect): Rect {
  const width = documentContentColumns(bounds.width);
  return {
    row: bounds.row,
    column: bounds.column + Math.floor((bounds.width - width) / 2),
    width,
    height: bounds.height
  };
}

export function documentScrollRow(document: BrowserDocumentState): number {
  const extent = document.rendering.summary?.documentRowCount ?? 1;
  if (document.scrollAnchor.source === null) {
    return Math.max(0, Math.min(extent - 1, document.scrollAnchor.rowOffset));
  }
  const anchor = document.rendering.summary?.scrollAnchorByDocumentNode.get(document.scrollAnchor.source);
  if (anchor === undefined) return 0;
  return Math.max(0, Math.min(extent - 1, anchor.row + document.scrollAnchor.rowOffset));
}

/** Row represented by the last committed viewport; pending requests keep that frame stationary. */
export function committedDocumentScrollRow(document: BrowserDocumentState): number {
  const buffer = document.rendering.viewport?.cellBuffer;
  return buffer === undefined
    ? documentScrollRow(document)
    : buffer.windowStartRow + buffer.overscanBefore;
}

export function documentWithScrollRow(
  document: BrowserDocumentState,
  requestedRow: number,
  viewportRows = 1
): BrowserDocumentState {
  const documentRows = document.rendering.summary?.documentRowCount ?? 1;
  const normalizedViewportRows = Math.max(1, Math.floor(viewportRows));
  const rowIndex = Math.max(
    0,
    Math.min(Math.max(0, documentRows - normalizedViewportRows), Math.floor(requestedRow))
  );
  const anchors = document.rendering.summary?.scrollAnchors ?? [];
  let lower = 0;
  let upper = anchors.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const anchor = anchors[middle];
    if (anchor !== undefined && anchor.row <= rowIndex) lower = middle + 1;
    else upper = middle;
  }
  const anchor = lower === 0 ? undefined : anchors[lower - 1];
  if (anchor === undefined) {
    return { ...document, scrollAnchor: { source: null, rowOffset: rowIndex } };
  }
  return {
    ...document,
    scrollAnchor: { source: anchor.documentNode, rowOffset: rowIndex - anchor.row },
  };
}

export function committedViewport(document: BrowserDocumentState): ViewportRenderPayload | null {
  return document.rendering.viewport;
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

export function formByRef(document: BrowserDocumentState, ref: DocumentNodeRef): DocumentForm | null {
  return document.snapshot.document.form(ref);
}

export function scrollToSource(
  document: BrowserDocumentState,
  source: DocumentNodeRef | undefined
): BrowserDocumentState {
  return source === undefined ? document : { ...document, scrollAnchor: { source, rowOffset: 0 } };
}
