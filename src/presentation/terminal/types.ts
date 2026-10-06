import type { ValueSequence } from "../../memory/packed.js";
import type { StyleSnapshot } from "../style/types.js";
import type { DocumentScrollOffset, ViewportGeometryProjection } from "./viewport-geometry.js";
import type { DocumentImageMetadata, DocumentNodeRef, DocumentSemanticEntry, DocumentSourceRange } from "../../document/index.js";
import type { DocumentActionIdentity, FormattingNodeId } from "../formatting/index.js";
import type {
  CssEdges, CssPixelLength, CssRect, LayoutFragmentId,
  LayoutFragmentTree, LayoutPaintStyle, LayoutTextCluster, LayoutTextClusters
} from "../layout/index.js";
import type { TextSearchMatchId } from "../search/index.js";
import type { LayoutArtworkFallbackReason } from "../layout/paint-artwork.js";

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
  readonly maxRetainedImagePlacements: number;
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
  /** Canonical local ink clip, independent of ancestor overflow/scroll clips. */
  readonly inkClipRect?: CssRect;
  readonly paintOrder: number;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly style: LayoutPaintStyle;
}

export interface TerminalTextPaintCommand extends TerminalPaintCommandBase {
  readonly kind: "text";
  /** Actual glyph baseline relative to rect.y; unchanged by viewport translation. */
  readonly baseline: CssPixelLength;
  readonly text: string;
  readonly clusters: LayoutTextClusters;
  /** Semantic artwork label when there are no source text clusters to paint. */
  readonly mediaFallbackLabel?: string;
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

export interface TerminalImagePaintCommand extends TerminalPaintCommandBase {
  readonly mediaFallbackLabel?: string;
  readonly hasAlpha: boolean | null;
  /** Alpha silhouette color for admitted CSS mask artwork; ordinary media omit it. */
  readonly maskTint?: NonNullable<LayoutPaintStyle["foreground"]>;
  /** Existing canonical fragment-paint ordinal, independent of command count. */
  readonly paintGroup: number;
  readonly kind: "image";
  readonly resourceId: string;
  readonly naturalWidth: number | null;
  readonly naturalHeight: number | null;
  /** Logical alternative text remains available when graphics are unsupported. */
  readonly text: string;
  readonly clusters: LayoutTextClusters;
}

export type TerminalPaintCommand = TerminalBackgroundPaintCommand | TerminalBorderSidePaintCommand | TerminalTextPaintCommand | TerminalImagePaintCommand;

/** Disjoint topmost cell coverage derived from the canonical painter's owner grid. */
export interface TerminalImagePlacement {
  readonly hasAlpha: boolean | null;
  /** Exact CSS artwork extent inside outward-rounded cell bounds, normalized 0..1. */
  readonly sourceInset?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** Snapped allocation in CSS pixels, for accurate bounded alpha-artwork padding. */
  readonly rasterSize?: { readonly width: number; readonly height: number };
  readonly maskTint?: NonNullable<LayoutPaintStyle["foreground"]>;
  /** Proven uniform opaque cell background before this image's paint phase. */
  readonly compositingBackdrop: LayoutPaintStyle["background"];
  /** Flattening transparency must not erase native glyph, control or other image ink. */
  readonly safeForTransparency: boolean;
  readonly layoutFragment: LayoutFragmentId;
  readonly paintGroup: number;
  readonly action: DocumentActionIdentity | null;
  readonly id: string;
  readonly resourceId: string;
  readonly naturalWidth: number | null;
  readonly naturalHeight: number | null;
  readonly bounds: TerminalCellRect;
  readonly clip: TerminalCellRect;
}

export type DocumentDisplayListOutcome =
  | { readonly status: "complete"; readonly commands: number }
  | {
      readonly status: "truncated";
      readonly commands: number;
      readonly budget: "maxDisplayListCommands";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-context" | "invalid-budget" };

/** Canonical command references; decoded paint records are never retained by this owner. */
export interface DocumentPaintCommands extends ValueSequence<TerminalPaintCommand> {
  layoutFragment(index: number): LayoutFragmentId;
  rect(index: number): CssRect;
  isText(index: number): boolean;
}

/** Retained CSS-pixel paint commands for one scroll-independent document layout. */
export interface DocumentDisplayList {
  readonly styles: StyleSnapshot;
  readonly layout: LayoutFragmentTree;
  readonly context: TerminalRenderContext;
  /** Layout fragments in the CSS paint order used to build this display list. */
  readonly fragmentPaintOrder: readonly LayoutFragmentId[];
  /** Effective zero-opacity owners retain all geometry and interaction identity. */
  readonly paintSuppressed: ReadonlySet<LayoutFragmentId>;
  /** Bounded artwork fallback diagnostics, aggregated by reason with one example. */
  readonly artworkFallbacks: readonly { readonly reason: LayoutArtworkFallbackReason; readonly count: number; readonly layoutFragment: LayoutFragmentId }[];
  readonly artworkFallbacksOmitted: number;
  /** Canvas paint is independent of element geometry, scroll ownership and hit testing. */
  readonly canvasBackground: { readonly source: DocumentNodeRef; readonly style: LayoutPaintStyle } | null;
  readonly commands: DocumentPaintCommands;
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
  query(rect: CssRect, signal?: AbortSignal, projection?: ViewportGeometryProjection): DisplayListSpatialQuery;
}

/** Block alignment is explicit; inline reveal always uses CSSOM nearest. */
export type ViewportRevealRequest =
  | { readonly node: DocumentNodeRef; readonly blockAlign: "start" | "nearest" }
  | { readonly query: string; readonly match: string; readonly blockAlign: "start" | "nearest" };

export interface ViewportWindow {
  readonly scrollColumn?: number;
  readonly scrollOffsets?: readonly DocumentScrollOffset[];
  readonly reveal?: ViewportRevealRequest;
  readonly scrollRow: number;
  readonly viewportRows: number;
  readonly overscanBefore: number;
  readonly overscanAfter: number;
}

export interface ViewportDisplayList {
  readonly documentDisplayList: DocumentDisplayList;
  readonly context: TerminalRenderContext;
  readonly window: ViewportWindow;
  readonly projection: ViewportGeometryProjection;
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
  /** Full logical text represented by a compact, non-literal media indicator. */
  readonly logicalText?: string;
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
    | "maxRetainedImagePlacements"
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
  readonly images: readonly TerminalImagePlacement[];
  readonly windowStartColumn?: number;
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
  /** Actual layout scroll owner; null means the root viewport. */
  readonly scrollOwner: DocumentNodeRef | null;
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

export interface DocumentControlGeometry {
  readonly paintGroup: number;
  readonly node: DocumentNodeRef;
  readonly fragment: LayoutFragmentId;
  readonly rect: CssRect;
}

export interface TerminalScrollPort {
  readonly node: DocumentNodeRef;
  readonly parent: DocumentNodeRef | null;
  readonly rect: TerminalCellRect;
  readonly inline: number;
  readonly block: number;
  readonly minInline: number;
  readonly maxInline: number;
  readonly minBlock: number;
  readonly maxBlock: number;
  readonly userScrollInline: boolean;
  readonly userScrollBlock: boolean;
}

export interface TerminalControlGeometry {
  /** Suppresses native widget ink without removing its layout or interaction. */
  readonly paintSuppressed: boolean;
  readonly paintGroup: number;
  readonly node: DocumentNodeRef;
  readonly layoutFragment: LayoutFragmentId;
  /** Full allocation, kept independent of clipping so editors retain their geometry. */
  readonly allocation: TerminalCellRect;
  /** Exact writable cell rectangle, clipped independently of native allocation. */
  readonly visible: TerminalCellRect;
  readonly outer: CssRect;
  readonly content: CssRect;
  /** Current paint colors resolved together with this geometry in the accepted viewport. */
  readonly style: TerminalStyle;
}

export interface DocumentFocusGeometry {
  readonly scrollOwner: DocumentNodeRef | null;
  readonly rectFragments: readonly LayoutFragmentId[];
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
  readonly controls: readonly DocumentControlGeometry[];
  readonly focusOrder: readonly DocumentFocusGeometry[];
  readonly accessibility: readonly DocumentAccessibilityGeometry[];
  readonly scrollAnchors: readonly DocumentScrollAnchorGeometry[];
  readonly retainedRectangles: number;
  readonly truncations: readonly TerminalTruncation[];
  forDocumentNode(node: DocumentNodeRef): DocumentGeometryEntry | null;
  anchorForNode(node: DocumentNodeRef): DocumentScrollAnchorGeometry | null;
  focusForNode(node: DocumentNodeRef): DocumentFocusGeometry | null;
  accessibilityForNode(node: DocumentNodeRef): DocumentAccessibilityGeometry | null;
  controlsIntersecting(rect: CssRect, signal?: AbortSignal, owner?: LayoutFragmentId | null): readonly DocumentControlGeometry[];
  focusIntersecting(rect: CssRect, signal?: AbortSignal, owner?: LayoutFragmentId | null): readonly DocumentFocusGeometry[];
  accessibilityIntersecting(rect: CssRect, signal?: AbortSignal, owner?: LayoutFragmentId | null): readonly DocumentAccessibilityGeometry[];
}

export interface ViewportTerminalResult {
  readonly cellBuffer: ViewportCellBuffer;
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly search: TerminalSearchResult | null;
  readonly commandById: ReadonlyMap<string, TerminalPaintCommand>;
  readonly controls: readonly TerminalControlGeometry[];
  readonly scrollPorts: readonly TerminalScrollPort[];
  readonly truncations: readonly TerminalTruncation[];
}

export interface BuildDocumentDisplayListInput {
  readonly images?: readonly DocumentImageMetadata[];
  readonly layout: LayoutFragmentTree;
  /** Current paint inputs after a verified background-only style transition. */
  readonly styles: StyleSnapshot;
  readonly context: TerminalRenderContext;
  readonly signal?: AbortSignal;
}

export interface RasterizeViewportDisplayListInput {
  readonly displayList: ViewportDisplayList;
  readonly signal?: AbortSignal;
}
