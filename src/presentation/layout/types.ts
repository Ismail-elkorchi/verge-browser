import type {
  DocumentNodeRef,
  DocumentSemanticEntry,
  DocumentSourceRange
} from "../../document/index.js";
import type { FormattingNodeId, FormattingTree } from "../formatting/index.js";
import type { TextSearchIndex, TextSearchMatchId } from "../search/index.js";
import type { CssColor, PseudoElementIdentity } from "../style/index.js";
import type { BidiLevel } from "../text/index.js";
import type { CssPixelLength, CssRect, CssSize } from "./fixed.js";

export type LayoutFragmentId = string & { readonly __layoutFragmentId: unique symbol };
export type LineBoxId = string & { readonly __lineBoxId: unique symbol };

export interface UsedFontMetrics {
  readonly fontSize: CssPixelLength;
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly lineGap: CssPixelLength;
  readonly baseline: CssPixelLength;
  readonly xHeight: CssPixelLength;
  readonly chAdvance: CssPixelLength;
}

export interface CssTextMeasurer {
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
  readonly maxDepth: number;
}

export interface LayoutContext {
  readonly viewport: CssSize;
  readonly textMeasurer: CssTextMeasurer;
  readonly initialContainingBlock: CssRect;
  readonly budgets?: Partial<LayoutBudgets>;
}

export type DocumentActionIdentity =
  | { readonly kind: "link"; readonly node: DocumentNodeRef; readonly destination: string }
  | { readonly kind: "form-control"; readonly node: DocumentNodeRef; readonly form: DocumentNodeRef | null }
  | { readonly kind: "disclosure"; readonly node: DocumentNodeRef; readonly open: boolean };

export interface LayoutPaintStyle {
  readonly visible: boolean;
  readonly foreground: CssColor | null;
  readonly background: CssColor | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly borderColor: CssColor | null;
  readonly borderStyle: "none" | "solid";
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
  readonly visualClusters: readonly LayoutTextCluster[];
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
  readonly minContentContribution: CssPixelLength;
  readonly maxContentContribution: CssPixelLength;
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
  readonly baseline: CssPixelLength | null;
  readonly visualOrder: number;
  readonly paintOrder: number;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly style: LayoutPaintStyle;
  readonly minContentContribution: CssPixelLength;
  readonly maxContentContribution: CssPixelLength;
  readonly inlineContinuations?: readonly InlineContinuationGeometry[];
  readonly controlLabel?: string;
  readonly controlValue?: string;
  readonly controlText?: string;
  readonly replacedText?: string;
  readonly visualClusters?: readonly LayoutTextCluster[];
}

export type LayoutFragment = LayoutTextFragment | LayoutBoxFragment;

export interface LineBox {
  readonly id: LineBoxId;
  readonly containingFragment: LayoutFragmentId;
  readonly rect: CssRect;
  readonly baseline: CssPixelLength;
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly usedInlineAdvance: CssPixelLength;
  readonly fragments: readonly LayoutFragmentId[];
  readonly textFragments: readonly LayoutFragmentId[];
  readonly visualOrder: readonly LayoutFragmentId[];
  readonly logicalItemStart: number;
  readonly logicalItemEnd: number;
  readonly embeddingLevels: readonly (BidiLevel | null)[];
  readonly sourceRanges: readonly DocumentSourceRange[];
  readonly actions: readonly DocumentActionIdentity[];
  readonly semantics: readonly DocumentSemanticEntry[];
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

export interface LayoutSearchSpan {
  readonly match: TextSearchMatchId;
  readonly fragment: LayoutFragmentId;
  readonly documentNode: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
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
      readonly reason: "invalid-context" | "invalid-fixed-point-input" | "invalid-budget";
    }
  | { readonly status: "unsupported"; readonly feature: string };

export interface BuildLayoutFragmentTreeInput {
  readonly formatting: FormattingTree;
  readonly context: LayoutContext;
  readonly searchIndex: TextSearchIndex;
  readonly signal?: AbortSignal;
}

export interface LayoutFragmentTree {
  readonly formatting: FormattingTree;
  readonly context: LayoutContext;
  readonly rootFontMetrics: UsedFontMetrics;
  readonly searchIndex: TextSearchIndex;
  readonly root: LayoutFragmentId;
  readonly lineBoxes: readonly LineBox[];
  readonly outcome: LayoutOutcome;
  fragment(id: LayoutFragmentId): LayoutFragment;
  parent(id: LayoutFragmentId): LayoutFragment | null;
  children(id: LayoutFragmentId): readonly LayoutFragment[];
  forFormattingNode(node: FormattingNodeId): readonly LayoutFragment[];
  forDocumentNode(node: DocumentNodeRef): readonly LayoutFragment[];
  searchSpans(query: string, limit: number): readonly LayoutSearchSpan[];
}
