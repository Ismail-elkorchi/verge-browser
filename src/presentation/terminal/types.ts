import type { DocumentNodeRef, DocumentSemanticEntry, DocumentSourceRange } from "../../document/index.js";
import type { DocumentActionIdentity, FormattingNodeId } from "../formatting/index.js";
import type {
  CssEdges, CssPixelLength, CssRect, LayoutFragmentId,
  LayoutFragmentTree, LayoutPaintStyle, LayoutScrollAttachment, LayoutTextCluster
} from "../layout/index.js";
import type { TextSearchMatchId } from "../search/index.js";

export interface TerminalCellRect {
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalCellMeasurer {
  width(text: string): number;
}

export interface TerminalPaintBudgets {
  readonly maxDisplayListCommands: number;
  readonly maxGeneratedPaintUnits: number;
  readonly maxRetainedPaintCells: number;
  readonly maxRetainedCellBufferRows: number;
  readonly maxRetainedCellBufferColumns: number;
  readonly maxRetainedHitTestRegions: number;
  readonly maxRetainedFocusRectangles: number;
  readonly maxRetainedAccessibilityRectangles: number;
  readonly maxRetainedDocumentRectangles: number;
  readonly maxRetainedScrollAnchors: number;
  readonly maxRetainedSearchCellSpans: number;
  readonly maxLogicalSearchMatches: number;
}

export interface TerminalRenderContext {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidthCssPx: CssPixelLength;
  readonly rowHeightCssPx: CssPixelLength;
  readonly unicode: boolean;
  readonly ambiguousWidth: 1 | 2;
  readonly colorDepth: 0 | 4 | 8 | 24;
  readonly cellMeasurer: TerminalCellMeasurer;
  readonly budgets?: Partial<TerminalPaintBudgets>;
}

export interface TerminalStyle {
  readonly foreground: LayoutPaintStyle["foreground"];
  readonly background: LayoutPaintStyle["background"];
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
}

interface TerminalPaintCommandBase {
  readonly id: string;
  readonly layoutFragment: LayoutFragmentId;
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly rect: CssRect;
  readonly clipRect: CssRect;
  readonly paintOrder: number;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly style: LayoutPaintStyle;
}

export interface TerminalTextPaintCommand extends TerminalPaintCommandBase {
  readonly kind: "text";
  readonly text: string;
  readonly clusters: readonly TerminalPaintTextCluster[];
}

export type TerminalPaintTextCluster = LayoutTextCluster;

export interface TerminalBackgroundPaintCommand extends TerminalPaintCommandBase {
  readonly kind: "background";
}

export interface TerminalBorderSidePaintCommand extends TerminalPaintCommandBase {
  readonly kind: "border-side";
  readonly side: "top" | "right" | "bottom" | "left";
  readonly borderRect: CssRect;
  readonly borderWidths: CssEdges;
}

export type TerminalPaintCommand = TerminalBackgroundPaintCommand | TerminalBorderSidePaintCommand | TerminalTextPaintCommand;

export type DocumentDisplayListOutcome =
  | { readonly status: "complete"; readonly commands: number }
  | {
      readonly status: "truncated";
      readonly commands: number;
      readonly budget: "maxDisplayListCommands";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-context" | "invalid-budget" };

/** Retained CSS-pixel paint commands for one scroll-independent document layout. */
export interface DocumentDisplayList {
  readonly layout: LayoutFragmentTree;
  readonly context: TerminalRenderContext;
  /** Layout fragments in the CSS paint order used to build this display list. */
  readonly fragmentPaintOrder: readonly LayoutFragmentId[];
  readonly commands: readonly TerminalPaintCommand[];
  readonly outcome: DocumentDisplayListOutcome;
}

export interface DisplayListSpatialQueryMetrics {
  readonly visitedIntervals: number;
  readonly returnedCommands: number;
}

export interface DisplayListSpatialQuery {
  readonly commands: readonly TerminalPaintCommand[];
  readonly metrics: DisplayListSpatialQueryMetrics;
}

export interface DisplayListSpatialIndex {
  readonly commandCount: number;
  readonly attachmentCommandCount: number;
  readonly fixedAttachmentGroups: readonly DisplayListAttachmentGroup[];
  query(rect: CssRect, signal?: AbortSignal): DisplayListSpatialQuery;
  queryStickyAttachments(rect: CssRect, signal?: AbortSignal): DisplayListAttachmentSpatialQuery;
}

export interface DisplayListAttachmentGroup {
  readonly attachment: LayoutScrollAttachment;
  readonly commands: readonly TerminalPaintCommand[];
}

export interface DisplayListAttachmentSpatialQuery {
  readonly groups: readonly DisplayListAttachmentGroup[];
  readonly metrics: DisplayListSpatialQueryMetrics;
}

export interface ViewportWindow {
  readonly scrollRow: number;
  readonly viewportRows: number;
  readonly overscanBefore: number;
  readonly overscanAfter: number;
}

export interface ViewportDisplayList {
  readonly documentDisplayList: DocumentDisplayList;
  readonly context: TerminalRenderContext;
  readonly window: ViewportWindow;
  readonly viewportRect: CssRect;
  readonly windowRect: CssRect;
  readonly commands: readonly TerminalPaintCommand[];
  readonly spatialQuery: DisplayListSpatialQueryMetrics;
  readonly outcome: DocumentDisplayListOutcome;
}

export interface TerminalCell {
  readonly column: number;
  readonly text: string;
  readonly width: number;
  readonly style: TerminalStyle;
  readonly command: string;
  readonly layoutFragment: LayoutFragmentId;
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly paintOrder: number;
}

export interface TerminalCellSpan {
  readonly command: string;
  readonly layoutFragment: LayoutFragmentId;
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly action: DocumentActionIdentity | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly column: number;
  readonly width: number;
}

export interface TerminalCellStyleSpan {
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly style: TerminalStyle;
}

export interface TerminalCellRow {
  readonly row: number;
  readonly text: string;
  readonly cells: readonly TerminalCell[];
  readonly spans: readonly TerminalCellSpan[];
  readonly styles: readonly TerminalCellStyleSpan[];
}

export type ViewportCellBufferOutcome =
  | { readonly status: "complete"; readonly cells: number; readonly rows: number }
  | {
      readonly status: "truncated";
      readonly cells: number;
      readonly rows: number;
      readonly truncations: readonly TerminalTruncation[];
    }
  | {
      readonly status: "rejected";
      readonly reason: "invalid-context" | "invalid-budget" | "invalid-cell-measurement";
    };

export type TerminalTruncation = {
  readonly budget:
    | "maxDisplayListCommands"
    | "maxGeneratedPaintUnits"
    | "maxRetainedPaintCells"
    | "maxRetainedCellBufferRows"
    | "maxRetainedCellBufferColumns"
    | "maxRetainedHitTestRegions"
    | "maxRetainedFocusRectangles"
    | "maxRetainedAccessibilityRectangles"
    | "maxRetainedDocumentRectangles"
    | "maxRetainedScrollAnchors"
    | "maxRetainedSearchCellSpans";
  readonly limit: number;
};

/** Cell rows retained only for the requested viewport window and overscan. */
export interface ViewportCellBuffer {
  readonly columns: number;
  readonly documentRowCount: number;
  readonly windowStartRow: number;
  readonly viewportRows: number;
  readonly overscanBefore: number;
  readonly overscanAfter: number;
  readonly rows: readonly TerminalCellRow[];
  readonly outcome: ViewportCellBufferOutcome;
}

export interface ViewportCellRasterizationResult {
  readonly cellBuffer: ViewportCellBuffer;
  readonly truncations: readonly TerminalTruncation[];
}

export interface TerminalHitRegion {
  readonly id: string;
  readonly action: DocumentActionIdentity;
  readonly layoutFragment: LayoutFragmentId;
  readonly rect: TerminalCellRect;
}

export interface TerminalHitTestIndex {
  readonly regions: readonly TerminalHitRegion[];
  at(row: number, column: number): TerminalHitRegion | null;
}

export interface TerminalFocusTarget {
  readonly node: DocumentNodeRef;
  readonly action: DocumentActionIdentity;
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly rects: readonly TerminalCellRect[];
  readonly label: string;
}

export interface TerminalFocusMap {
  readonly targets: readonly TerminalFocusTarget[];
  forNode(node: DocumentNodeRef): TerminalFocusTarget | null;
}

export interface TerminalAccessibilityBound {
  readonly documentNode: DocumentNodeRef;
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly role: DocumentSemanticEntry["role"];
  readonly name: string;
  readonly description: string;
  readonly rect: TerminalCellRect;
}

export interface TerminalSearchRange {
  readonly match: TextSearchMatchId;
  readonly row: number;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly layoutFragment: LayoutFragmentId | null;
  readonly documentNode: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
}

export interface TerminalSearchMatch {
  readonly id: TextSearchMatchId;
  readonly ranges: readonly TerminalSearchRange[];
}

export interface TerminalSearchResult {
  readonly query: string;
  readonly matches: readonly TerminalSearchMatch[];
  readonly ranges: readonly TerminalSearchRange[];
  readonly truncated: boolean;
}

export interface DocumentGeometryEntry {
  readonly documentNode: DocumentNodeRef;
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly rects: readonly CssRect[];
}

export interface DocumentFocusGeometry {
  readonly node: DocumentNodeRef;
  readonly action: DocumentActionIdentity;
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly rects: readonly CssRect[];
  readonly label: string;
}

export interface DocumentAccessibilityGeometry {
  readonly documentNode: DocumentNodeRef;
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly role: DocumentSemanticEntry["role"];
  readonly name: string;
  readonly description: string;
  readonly rect: CssRect;
  readonly rects: readonly CssRect[];
  readonly rectFragments: readonly LayoutFragmentId[];
}

export interface DocumentScrollAnchorGeometry {
  readonly id: string;
  readonly documentNode: DocumentNodeRef;
  readonly layoutFragment: LayoutFragmentId;
  readonly blockOffsetCssPx: number;
}

export interface DocumentGeometryIndex {
  readonly documentExtent: CssRect;
  readonly focusOrder: readonly DocumentFocusGeometry[];
  readonly accessibility: readonly DocumentAccessibilityGeometry[];
  readonly scrollAnchors: readonly DocumentScrollAnchorGeometry[];
  readonly retainedRectangles: number;
  readonly truncations: readonly TerminalTruncation[];
  forDocumentNode(node: DocumentNodeRef): DocumentGeometryEntry | null;
  anchorForNode(node: DocumentNodeRef): DocumentScrollAnchorGeometry | null;
  focusForNode(node: DocumentNodeRef): DocumentFocusGeometry | null;
  accessibilityForNode(node: DocumentNodeRef): DocumentAccessibilityGeometry | null;
  focusIntersecting(rect: CssRect, signal?: AbortSignal): readonly DocumentFocusGeometry[];
  accessibilityIntersecting(rect: CssRect, signal?: AbortSignal): readonly DocumentAccessibilityGeometry[];
}

export interface ViewportTerminalResult {
  readonly cellBuffer: ViewportCellBuffer;
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly search: TerminalSearchResult | null;
  readonly commandById: ReadonlyMap<string, TerminalPaintCommand>;
  readonly cellRectsByDocumentNode: ReadonlyMap<DocumentNodeRef, readonly TerminalCellRect[]>;
  readonly truncations: readonly TerminalTruncation[];
}

export interface BuildDocumentDisplayListInput {
  readonly layout: LayoutFragmentTree;
  readonly context: TerminalRenderContext;
  readonly signal?: AbortSignal;
}

export interface RasterizeViewportDisplayListInput {
  readonly displayList: ViewportDisplayList;
  readonly signal?: AbortSignal;
}
