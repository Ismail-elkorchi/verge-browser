import type { LayoutTextClusters } from "./text-clusters.js";
import type { CssOverflow } from "../style/types.js";
import type {
  DocumentNodeRef,
  DocumentFormControl, DocumentState, IndexedWebDocumentSnapshot,
  DocumentSemanticEntry,
  DocumentSourceRange
} from "../../document/index.js";
import type {
  DocumentActionIdentity,
  FormattingNodeId,
  FormattingTree
} from "../formatting/index.js";
import type { CssBorderColors, CssBorderStyles, CssColor, PseudoElementIdentity } from "../style/index.js";
import type { InlineItemStreamSet } from "../text/index.js";
import type { CssEdges, CssPixelLength, CssRect, CssSize } from "./fixed.js";

export type LayoutFragmentId = string & { readonly __layoutFragmentId: unique symbol };
export type LineBoxId = string & { readonly __lineBoxId: unique symbol };

export interface UsedFontMetrics {
  /** Resolved CSS size; the output device may use fixed-size glyphs. */
  readonly fontSize: CssPixelLength;
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly lineGap: CssPixelLength;
  readonly baseline: CssPixelLength;
  readonly xHeight: CssPixelLength;
  readonly chAdvance: CssPixelLength;
}

export interface CssTextMeasurer {
  /** Advance of the actual output glyphs in CSS coordinates. */
  measure(text: string, fontSize: CssPixelLength): CssPixelLength;
  fontMetrics(fontSize: CssPixelLength): UsedFontMetrics;
  defaultFontMetrics(): UsedFontMetrics;
}

export interface LayoutBudgets {
  readonly maxFragments: number;
  readonly maxLineBoxes: number;
  readonly maxTextFragments: number;
  readonly maxLineFragments: number;
  readonly maxCodePointsPerBidiParagraph: number;
  readonly maxBidiItems: number;
  readonly maxBidiEmbeddingDepth: number;
  readonly maxBidiRuns: number;
  readonly maxGraphemeClusters: number;
  readonly maxBreakOpportunities: number;
  readonly maxVisualRuns: number;
  readonly maxFlexSizingWork: number;
  /** Shared sizing records: intrinsic contributions plus natural flex plan headers, lines, and item allocations. */
  readonly maxIntrinsicContributionCacheEntries: number;
  readonly maxGridItems: number;
  readonly maxExplicitGridTracks: number;
  readonly maxImplicitGridTracks: number;
  readonly maxGridOccupancyIntervals: number;
  readonly maxGridPlacementSteps: number;
  readonly maxGridNamedLineResolutions: number;
  readonly maxGridAutoRepeatTracks: number;
  readonly maxGridTrackSizingWork: number;
  readonly maxTableRoots: number;
  readonly maxTableRowGroups: number;
  readonly maxTableRows: number;
  readonly maxTableColumnGroups: number;
  readonly maxTableColumns: number;
  readonly maxTableCells: number;
  readonly maxTableSlotIntervals: number;
  readonly maxTableColspanWork: number;
  readonly maxTableRowspanWork: number;
  readonly maxTableAnonymousMissingCells: number;
  readonly maxTableIntrinsicMeasureWork: number;
  readonly maxTableColumnDistributionWork: number;
  readonly maxTableRowDistributionWork: number;
  readonly maxTableCollapsedBorderCandidates: number;
  readonly maxTableCollapsedBorderSegments: number;
  readonly maxTableHeaderAssociations: number;
  readonly maxDepth: number;
}

/** A native single-line baseline is relative to the content origin; null requests synthesis. */
export interface CssControlMetrics extends CssSize {
  readonly baseline: CssPixelLength | null;
}

/** Native control metrics are supplied by the output adapter in CSS units. */
export interface CssControlMeasurer {
  readonly identity: string;
  measure(control: DocumentFormControl, document: IndexedWebDocumentSnapshot, state: DocumentState): CssControlMetrics;
}

export interface LayoutContext {
  readonly viewport: CssSize;
  readonly textMeasurer: CssTextMeasurer;
  readonly controlMeasurer: CssControlMeasurer;
  readonly initialContainingBlock: CssRect;
  /** The visible CSS-pixel scrollport in document coordinates. */
  readonly scrollport: CssRect;
  readonly budgets?: Partial<LayoutBudgets>;
}

export interface LayoutPaintStyle {
  readonly visible: boolean;
  readonly foreground: CssColor | null;
  readonly background: CssColor | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly borderColors: CssBorderColors;
  readonly borderStyles: CssBorderStyles;
}

export interface InlineContinuationGeometry {
  readonly contentRect: CssRect;
  readonly paddingRect: CssRect;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
}

export interface LayoutTextCluster {
  readonly text: string;
  readonly visualStartCodeUnit: number;
  readonly visualEndCodeUnit: number;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly sourceRange: DocumentSourceRange | null;
  readonly advance: CssPixelLength;
}

export interface LayoutControlTextLine {
  readonly text: string;
  readonly clusters: LayoutTextClusters;
  readonly blockOffset: CssPixelLength;
  readonly height: CssPixelLength;
}

export interface LayoutTextFragment {
  readonly id: LayoutFragmentId;
  readonly kind: "text";
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly pseudoElement: PseudoElementIdentity | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly text: string;
  readonly visualText: string;
  readonly visualClusters: LayoutTextClusters;
  readonly bidiParagraph: number;
  readonly embeddingLevel: number;
  readonly contentRect: CssRect;
  readonly paddingRect: CssRect;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
  readonly overflowRect: CssRect;
  readonly clipRect: CssRect;
  readonly children: readonly LayoutFragmentId[];
  readonly lineBoxes: readonly LineBox[];
  readonly usedFontMetrics: UsedFontMetrics;
  readonly baseline: CssPixelLength;
  readonly visualOrder: number;
  readonly paintOrder: number;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly style: LayoutPaintStyle;
}

export interface LayoutTableCollapsedBorderSegment {
  readonly id: string;
  readonly edge: Readonly<{
    axis: "horizontal" | "vertical";
    line: number;
    start: number;
    end: number;
  }>;
  readonly paintPhase: "collapsed-border";
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly borderRect: CssRect;
  readonly borderWidths: CssEdges;
  readonly clipRect: CssRect;
  readonly style: LayoutPaintStyle;
}

export interface LayoutBoxFragment {
  readonly id: LayoutFragmentId;
  readonly kind: "box" | "control" | "replaced";
  readonly formattingNode: FormattingNodeId;
  readonly documentNode: DocumentNodeRef | null;
  readonly pseudoElement: PseudoElementIdentity | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly contentRect: CssRect;
  readonly paddingRect: CssRect;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
  readonly overflowRect: CssRect;
  readonly clipRect: CssRect;
  readonly children: readonly LayoutFragmentId[];
  readonly lineBoxes: readonly LineBox[];
  readonly usedFontMetrics: UsedFontMetrics | null;
  /** Exported baseline relative to this fragment's border-box block start. */
  readonly baseline: CssPixelLength | null;
  readonly visualOrder: number;
  readonly paintOrder: number;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly style: LayoutPaintStyle;
  readonly inlineContinuations?: readonly InlineContinuationGeometry[];
  /** Natural native block footprint, independent of the CSS outer box and line strut. */
  readonly nativeControlMetrics?: CssControlMetrics;
  readonly controlLabel?: string;
  readonly controlValue?: string;
  readonly controlText?: string;
  readonly controlLines?: readonly LayoutControlTextLine[];
  readonly replacedText?: string;
  readonly visualClusters?: LayoutTextClusters;
  readonly tableCollapsedBorderSegments?: readonly LayoutTableCollapsedBorderSegment[];
}

export type LayoutFragment = LayoutTextFragment | LayoutBoxFragment;

export type LayoutPaintPhase =
  | "context-background-border"
  | "negative-stack-level"
  | "in-flow-block"
  | "float"
  | "inline"
  | "positioned-auto-zero"
  | "positive-stack-level";

export interface LayoutStackingMetadata {
  readonly establishesStackingContext: boolean;
  readonly stackLevel: number | null;
  readonly sourceOrder: number;
  readonly containingStackingContext: LayoutFragmentId | null;
  readonly positionedDescendantsRemainInAncestor: boolean;
  readonly paintPhase: LayoutPaintPhase;
}

export type LayoutScrollAttachment = Readonly<{
  readonly kind: "fixed";
  readonly root: LayoutFragmentId;
  /** Geometry is viewport-relative until translated into a document viewport window. */
  readonly normalBorderRect: CssRect;
}> | Readonly<{
  readonly kind: "sticky";
  readonly root: LayoutFragmentId;
  readonly normalBorderRect: CssRect;
  readonly containingBlock: CssRect;
  readonly containingFragment: LayoutFragmentId | null;
  readonly top: CssPixelLength | null;
  readonly right: CssPixelLength | null;
  readonly bottom: CssPixelLength | null;
  readonly left: CssPixelLength | null;
}>;

export interface LineBox {
  readonly id: LineBoxId;
  readonly containingFragment: LayoutFragmentId;
  readonly rect: CssRect;
  readonly baseline: CssPixelLength;
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly usedInlineAdvance: CssPixelLength;
  readonly fragments: readonly LayoutFragmentId[];
  readonly visualOrder: readonly LayoutFragmentId[];
  readonly logicalItemStart: number;
  readonly logicalItemEnd: number;
  readonly breakCause: "end-of-paragraph" | "forced" | "wrap";
  readonly visualRuns: readonly LayoutVisualRun[];
}

export interface LayoutVisualRun {
  readonly embeddingLevel: number;
  readonly direction: "ltr" | "rtl";
  readonly logicalItemStart: number;
  readonly logicalItemEnd: number;
  readonly fragments: readonly LayoutFragmentId[];
}

export type LayoutOutcome =
  | { readonly status: "complete"; readonly fragments: number; readonly lineBoxes: number }
  | {
      readonly status: "truncated";
      readonly fragments: number;
      readonly lineBoxes: number;
      readonly budget: keyof LayoutBudgets;
      readonly limit: number;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid-context"
        | "invalid-fixed-point-input"
        | "invalid-budget"
        | "intrinsic-sizing-cycle";
    }
  | { readonly status: "unsupported"; readonly feature: string };

export interface BuildLayoutFragmentTreeInput {
  readonly formatting: FormattingTree;
  readonly inlineItemStreams: InlineItemStreamSet;
  readonly context: LayoutContext;
  readonly signal?: AbortSignal;
}

export interface LayoutClipChain {
  readonly kind: "canvas" | "viewport" | "overflow" | "clip" | "contain";
  readonly owner: LayoutFragmentId | null;
  readonly rect: CssRect;
  readonly parent: LayoutClipChain | null;
}

/** Layout-owned immutable scrolling geometry. Offsets live in the viewport state. */
export interface LayoutScrollOwner {
  readonly fragment: LayoutFragmentId;
  readonly documentNode: DocumentNodeRef;
  readonly parent: LayoutFragmentId | null;
  readonly scrollport: CssRect;
  readonly contentExtent: CssRect;
  readonly minInline: number;
  readonly maxInline: number;
  readonly minBlock: number;
  readonly maxBlock: number;
  readonly overflowX: CssOverflow;
  readonly overflowY: CssOverflow;
  readonly direction: "ltr" | "rtl";
}

export interface LayoutFragmentTree {
  /** Whether natural metadata for this resource can change consumed sizing contributions or used geometry. */
  imageDimensionsAffectLayout(resourceId: string): boolean;
  readonly textAnalysisWork: Readonly<{ intrinsicCalls: number; intrinsicReuses: number; intrinsicAnalyzedUnits: number; inlineBuilds: number; inlineReuses: number }>;
  readonly viewportDirection: "ltr" | "rtl";
  readonly scrollExtent: CssRect;
  readonly viewportOverflow: { readonly x: CssOverflow; readonly y: CssOverflow };
  readonly scrollOwners: readonly LayoutScrollOwner[];
  scrollContainer(id: LayoutFragmentId): LayoutScrollOwner | null;
  scrollAncestor(id: LayoutFragmentId): LayoutScrollOwner | null;
  clipChain(id: LayoutFragmentId): LayoutClipChain | null;
  readonly formatting: FormattingTree;
  readonly context: LayoutContext;
  readonly rootFontMetrics: UsedFontMetrics;
  readonly root: LayoutFragmentId;
  readonly lineBoxes: readonly LineBox[];
  readonly outcome: LayoutOutcome;
  fragment(id: LayoutFragmentId): LayoutFragment;
  parent(id: LayoutFragmentId): LayoutFragment | null;
  children(id: LayoutFragmentId): readonly LayoutFragment[];
  stacking(id: LayoutFragmentId): LayoutStackingMetadata;
  /** Attachment ancestry follows the containing block for locally fixed descendants. */
  scrollAttachmentParent(id: LayoutFragmentId): LayoutFragment | null;
  /** Root attachment metadata; descendants inherit the nearest attached root. */
  scrollAttachment(id: LayoutFragmentId): LayoutScrollAttachment | null;
  forFormattingNode(node: FormattingNodeId): readonly LayoutFragment[];
  forDocumentNode(node: DocumentNodeRef): readonly LayoutFragment[];
}
