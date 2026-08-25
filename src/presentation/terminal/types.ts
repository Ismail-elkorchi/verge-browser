import type { DocumentNodeRef, DocumentSemanticEntry, DocumentSourceRange } from "../../document/index.js";
import type { FormattingNodeId } from "../formatting/index.js";
import type {
  CssEdges, CssPixelLength, CssRect, DocumentActionIdentity, LayoutFragmentId,
  LayoutFragmentTree, LayoutPaintStyle, LayoutTextCluster
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

export type TerminalDisplayListOutcome =
  | { readonly status: "complete"; readonly commands: number }
  | {
      readonly status: "truncated";
      readonly commands: number;
      readonly budget: "maxDisplayListCommands";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-context" | "invalid-budget" };

export interface TerminalDisplayList {
  readonly layout: LayoutFragmentTree;
  readonly context: TerminalRenderContext;
  readonly commands: readonly TerminalPaintCommand[];
  readonly outcome: TerminalDisplayListOutcome;
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

export type TerminalCellBufferOutcome =
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

export interface TerminalCellBuffer {
  readonly columns: number;
  readonly viewportRows: number;
  readonly rows: readonly TerminalCellRow[];
  readonly outcome: TerminalCellBufferOutcome;
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

export interface TerminalScrollAnchor {
  readonly id: string;
  readonly documentNode: DocumentNodeRef;
  readonly layoutFragment: LayoutFragmentId;
  readonly row: number;
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

export interface TerminalRenderResult {
  readonly layout: LayoutFragmentTree;
  readonly displayList: TerminalDisplayList;
  readonly cellBuffer: TerminalCellBuffer;
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
  readonly truncations: readonly TerminalTruncation[];
  cellRectsForDocumentNode(node: DocumentNodeRef): readonly TerminalCellRect[];
  search(query: string): TerminalSearchResult;
}

export interface TerminalCellRasterizationResult {
  readonly cellBuffer: TerminalCellBuffer;
  readonly truncations: readonly TerminalTruncation[];
}

export interface TerminalIndexConstructionResult {
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
  readonly truncations: readonly TerminalTruncation[];
  cellRectsForDocumentNode(node: DocumentNodeRef): readonly TerminalCellRect[];
}

export interface BuildTerminalDisplayListInput {
  readonly layout: LayoutFragmentTree;
  readonly context: TerminalRenderContext;
  readonly signal?: AbortSignal;
}

export interface RasterizeTerminalDisplayListInput {
  readonly displayList: TerminalDisplayList;
  readonly signal?: AbortSignal;
}
