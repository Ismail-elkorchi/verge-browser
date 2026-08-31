import type {
  DocumentNodeRef,
  DocumentSourceRange,
} from "../../document/index.js";
import type {
  FormattingFormControlNode,
  FormattingNode,
  FormattingNodeId,
  FormattingReplacedNode,
  FormattingTextNode,
  FormattingTree,
  ControlDisplayTextSegment,
  DocumentActionIdentity,
} from "../formatting/index.js";
import {
  controlDisplayText,
  documentActionIdentity,
  isAtomicInlineBox,
  isInlineFormattingNode,
} from "../formatting/index.js";
import {
  bidiClass,
  bidiVisualOrderForLine,
  buildLineBreakMap,
  mirroredBidiText,
  resolveBidiParagraphs,
  type BidiClass,
  type BidiItem,
  type BidiParagraphCollection,
  type BreakOpportunityKind,
} from "../../unicode/index.js";
import type { InlineItemStream, ProcessedCssText } from "../text/index.js";
import type {
  ComputedStyle,
  CssGap,
  CssLength,
  CssLengthPercentageExpression,
} from "../style/index.js";
import {
  cssAdd,
  cssCoordinate,
  cssCoordinateAdd,
  cssCoordinateDifference,
  cssCoordinateFromFixed,
  cssDivide,
  cssIntersection,
  cssLengthFromFixed,
  cssMax,
  cssMin,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  cssRect,
  cssUnion,
  type CssCoordinate,
  type CssEdges,
  type CssNonNegativeLength,
  type CssPixelLength,
  type CssRect,
  type CssSignedEdges,
} from "./fixed.js";
import type {
  BuildLayoutFragmentTreeInput,
  LayoutBoxFragment,
  LayoutBudgets,
  LayoutFragment,
  LayoutFragmentId,
  LayoutFragmentTree,
  InlineContinuationGeometry,
  LayoutOutcome,
  LayoutPaintStyle,
  LayoutStackingMetadata,
  LayoutTableCollapsedBorderSegment,
  LayoutTextCluster,
  LayoutTextFragment,
  LineBox,
  LineBoxId,
  UsedFontMetrics,
} from "./types.js";
import {
  FlexSizingBudgetExceeded,
  resolveFlexLines,
  type FlexItemInput,
  type ResolvedFlexItem,
} from "./flex.js";
import { selectLogicalLines } from "./line-selection.js";
import {
  GridWorkBudgetExceeded,
  intrinsicGridBlockSize,
  intrinsicGridInlineSize,
  layoutGridContainer,
  type GridIntrinsicSizingHost,
} from "./grid/index.js";
import {
  IntrinsicContributionCache,
  IntrinsicSizingCycleError,
  intrinsicContributions,
  type IntrinsicSizeContributions,
} from "./intrinsic/index.js";
import {
  intrinsicTableBlockSize,
  intrinsicTableInlineSizes,
  layoutTableContainer,
  buildTableSlotGrid,
  TableWorkBudgetExceeded,
  type TableBorderOverride,
  type TableBudgetName,
  type TableIntrinsicInlineSizingHost,
  type TableSlotGrid,
  type TableSlotGridHost,
  type TableWrapperFormattingNode,
} from "./table/index.js";

const DEFAULT_LAYOUT_BUDGETS: LayoutBudgets = Object.freeze({
  maxFragments: 100_000,
  maxLineBoxes: 50_000,
  maxTextFragments: 100_000,
  maxLineFragments: 100_000,
  maxCodePointsPerBidiParagraph: 1_000_000,
  maxBidiItems: 1_000_000,
  maxBidiEmbeddingDepth: 125,
  maxBidiRuns: 250_000,
  maxGraphemeClusters: 1_000_000,
  maxBreakOpportunities: 1_000_001,
  maxVisualRuns: 250_000,
  maxFlexSizingWork: 2_000_000,
  maxIntrinsicContributionCacheEntries: 100_000,
  maxGridItems: 100_000,
  maxExplicitGridTracks: 2_048,
  maxImplicitGridTracks: 4_096,
  maxGridOccupancyIntervals: 250_000,
  maxGridPlacementSteps: 2_000_000,
  maxGridNamedLineResolutions: 250_000,
  maxGridAutoRepeatTracks: 2_048,
  maxGridTrackSizingWork: 2_000_000,
  maxTableRoots: 1_024,
  maxTableRowGroups: 25_000,
  maxTableRows: 100_000,
  maxTableColumnGroups: 25_000,
  maxTableColumns: 4_096,
  maxTableCells: 100_000,
  maxTableSlotIntervals: 250_000,
  maxTableColspanWork: 1_000_000,
  maxTableRowspanWork: 1_000_000,
  maxTableAnonymousMissingCells: 250_000,
  maxTableIntrinsicMeasureWork: 2_000_000,
  maxTableColumnDistributionWork: 2_000_000,
  maxTableRowDistributionWork: 2_000_000,
  maxTableCollapsedBorderCandidates: 2_000_000,
  maxTableCollapsedBorderSegments: 500_000,
  maxTableHeaderAssociations: 1_000_000,
  maxDepth: 512,
});

const ZERO = cssNonNegativeLength(cssPx(0));
const TABLE_INTERNAL_MARGINLESS_KINDS = new Set<FormattingNode["kind"]>([
  "table-column-group",
  "table-column",
  "table-header-group",
  "table-body-group",
  "table-footer-group",
  "table-row",
  "table-cell",
]);
type PhysicalSide = "top" | "right" | "bottom" | "left";

interface FlexAxes {
  readonly row: boolean;
  readonly mainStart: PhysicalSide;
  readonly mainEnd: PhysicalSide;
  readonly crossStart: PhysicalSide;
  readonly crossEnd: PhysicalSide;
  readonly mainReverse: boolean;
  readonly crossReverse: boolean;
}

interface FloatExclusion {
  readonly side: "left" | "right";
  readonly marginRect: CssRect;
  readonly sourceOrder: number;
  readonly containingBlock: CssRect;
  readonly clearanceEdge: CssCoordinate;
}

class FloatExclusionManager {
  readonly #exclusions: FloatExclusion[] = [];

  public get exclusions(): readonly FloatExclusion[] {
    return this.#exclusions;
  }

  public availableLineRange(
    blockStart: CssCoordinate,
    lineHeight: CssPixelLength,
    inlineStart: CssCoordinate,
    inlineEnd: CssCoordinate,
  ): { readonly start: CssCoordinate; readonly end: CssCoordinate } {
    let start = inlineStart;
    let end = inlineEnd;
    const blockEnd = point(blockStart, lineHeight);
    for (const exclusion of this.#exclusions) {
      const floatBottom = cssCoordinateAdd(
        exclusion.marginRect.y,
        exclusion.marginRect.height,
      );
      if (floatBottom <= blockStart || exclusion.marginRect.y >= blockEnd)
        continue;
      if (exclusion.side === "left") {
        start = cssCoordinateFromFixed(
          Math.max(
            start,
            cssCoordinateAdd(
              exclusion.marginRect.x,
              exclusion.marginRect.width,
            ),
          ),
        );
      } else
        end = cssCoordinateFromFixed(Math.min(end, exclusion.marginRect.x));
    }
    if (end < start) end = start;
    return Object.freeze({ start, end });
  }

  public clearedBlockStart(
    current: CssCoordinate,
    clear: "none" | "left" | "right" | "both",
  ): CssCoordinate {
    if (clear === "none") return current;
    let result = current;
    for (const exclusion of this.#exclusions) {
      if (clear !== "both" && clear !== exclusion.side) continue;
      result = cssCoordinateFromFixed(
        Math.max(result, exclusion.clearanceEdge),
      );
    }
    return result;
  }

  public add(
    side: "left" | "right",
    marginRect: CssRect,
    containingBlock: CssRect,
  ): void {
    this.#exclusions.push(
      Object.freeze({
        side,
        marginRect,
        sourceOrder: this.#exclusions.length,
        containingBlock,
        clearanceEdge: cssCoordinateAdd(marginRect.y, marginRect.height),
      }),
    );
  }

  public finalizeContainingBlock(containingBlock: CssRect): void {
    for (const [index, exclusion] of this.#exclusions.entries()) {
      this.#exclusions[index] = Object.freeze({
        ...exclusion,
        containingBlock,
      });
    }
  }

  public maximumBlockEnd(initial: CssCoordinate): CssCoordinate {
    let result = initial;
    for (const exclusion of this.#exclusions) {
      result = cssCoordinateFromFixed(
        Math.max(result, exclusion.clearanceEdge),
      );
    }
    return result;
  }
}

function oppositeSide(side: PhysicalSide): PhysicalSide {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

function flexAxes(style: ComputedStyle): FlexAxes {
  const row =
    style.box.flexDirection === "row" ||
    style.box.flexDirection === "row-reverse";
  const baseMainStart: PhysicalSide = row
    ? style.text.direction === "rtl"
      ? "right"
      : "left"
    : "top";
  const directionReverse =
    style.box.flexDirection === "row-reverse" ||
    style.box.flexDirection === "column-reverse";
  const mainStart = directionReverse
    ? oppositeSide(baseMainStart)
    : baseMainStart;
  const baseCrossStart: PhysicalSide = row
    ? "top"
    : style.text.direction === "rtl"
      ? "right"
      : "left";
  const crossStart =
    style.box.flexWrap === "wrap-reverse"
      ? oppositeSide(baseCrossStart)
      : baseCrossStart;
  return Object.freeze({
    row,
    mainStart,
    mainEnd: oppositeSide(mainStart),
    crossStart,
    crossEnd: oppositeSide(crossStart),
    mainReverse: mainStart === "right" || mainStart === "bottom",
    crossReverse: crossStart === "right" || crossStart === "bottom",
  });
}

function singleFlexItemAlignmentOffset(
  freeSpace: CssPixelLength,
  alignment: ComputedStyle["box"]["justifyContent"],
): CssPixelLength {
  const value = alignment.value;
  if (
    value === "normal" ||
    value === "stretch" ||
    value === "start" ||
    value === "space-between"
  )
    return ZERO;
  if (freeSpace < 0 && alignment.overflow === "safe") return ZERO;
  if (value === "end") return freeSpace;
  return cssDivide(freeSpace, 2);
}

function usedGridContentAlignment(
  alignment: ComputedStyle["box"]["justifyContent"],
): ComputedStyle["box"]["justifyContent"] {
  return alignment.value === "normal"
    ? Object.freeze({ value: "stretch", overflow: alignment.overflow })
    : alignment;
}

function usedItemAlignment(
  alignment: ComputedStyle["box"]["alignSelf"],
): "start" | "end" | "center" | "stretch" | "baseline" {
  return alignment.position === "normal" || alignment.position === "auto" ? "stretch" : alignment.position;
}

function percentageDependent(value: CssLength): boolean {
  return (
    (value.kind === "length" && value.unit === "%") ||
    (value.kind === "calculation" &&
      value.calculation.percentageDependence !== "none")
  );
}
const REJECTED_FONT_METRICS: UsedFontMetrics = Object.freeze({
  fontSize: cssPx(16),
  ascent: cssPx(12),
  descent: cssPx(4),
  lineGap: ZERO,
  baseline: cssPx(12),
  xHeight: cssPx(8),
  chAdvance: cssPx(8),
});

class LayoutBudgetExhausted extends Error {}

interface LayoutResult {
  readonly fragment: LayoutFragmentId;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
}

interface InlineLineEntry {
  readonly fragment: LayoutFragmentId;
  readonly metrics: UsedFontMetrics;
  readonly lineHeight: CssPixelLength;
  readonly verticalAlign: ComputedStyle["text"]["verticalAlign"];
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly baselineShift: CssPixelLength;
  readonly bidiParagraph: number;
  readonly bidiItemStart: number;
  readonly bidiItemEnd: number;
}

interface InlineTextIdentity {
  readonly formattingNode: FormattingNodeId | null;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly kind:
    "text" | "atomic-inline" | "structural-control" | "forced-break";
}

interface InlineBidiPosition {
  readonly paragraph: number;
  readonly item: number;
}

interface InlineTextNodeAnalysis {
  readonly units: readonly InlineLogicalUnit[];
}

interface InlineLogicalUnit {
  readonly logicalIndex: number;
  readonly kind:
    | "text"
    | "tab"
    | "soft-hyphen"
    | "atomic-inline"
    | "forced-break"
    | "break-opportunity";
  readonly formattingNode: FormattingNodeId;
  readonly text: string;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly bidiItemStart: number;
  readonly bidiItemEnd: number;
  readonly lineStartCodeUnit: number;
  readonly lineEndCodeUnit: number;
  readonly collapsibleSpace: boolean;
}

interface InlineTextAnalysis {
  readonly bidi: BidiParagraphCollection<InlineTextIdentity>;
  readonly textNodes: ReadonlyMap<FormattingNodeId, InlineTextNodeAnalysis>;
  readonly atomicItems: ReadonlyMap<FormattingNodeId, number>;
  readonly firstUnitByFormatting: ReadonlyMap<FormattingNodeId, number>;
  readonly positions: readonly InlineBidiPosition[];
  readonly logicalUnits: readonly InlineLogicalUnit[];
  readonly unitsByBidiItem: readonly (InlineLogicalUnit | undefined)[];
  readonly breaksBefore: readonly BreakOpportunityKind[];
  readonly resourceCounts: {
    readonly bidiItems: number;
    readonly bidiRuns: number;
    readonly graphemeClusters: number;
    readonly breakOpportunities: number;
  };
}

const INLINE_TEXT_ANALYSIS_CACHE = new WeakMap<
  InlineItemStream,
  Map<string, InlineTextAnalysis>
>();
const PAINT_STYLE_CACHE = new WeakMap<
  FormattingTree,
  Map<FormattingNodeId, LayoutPaintStyle>
>();
const DOCUMENT_SEMANTIC_ANCESTOR_CACHE = new WeakMap<
  FormattingTree,
  Map<DocumentNodeRef, readonly NonNullable<LayoutFragment["semantic"]>[]>
>();

function formattingCache<K, V>(
  caches: WeakMap<FormattingTree, Map<K, V>>,
  formatting: FormattingTree,
): Map<K, V> {
  const cached = caches.get(formatting);
  if (cached !== undefined) return cached;
  const created = new Map<K, V>();
  caches.set(formatting, created);
  return created;
}

interface InlineFormattingCursor {
  readonly containingFragment: LayoutFragmentId;
  readonly containingFormattingNode: FormattingNodeId;
  continuationX: CssCoordinate;
  continuationMaxX: CssCoordinate;
  readonly lineRange?: (
    blockStart: CssCoordinate,
    lineHeight: CssPixelLength,
  ) => {
    readonly start: CssCoordinate;
    readonly end: CssCoordinate;
  };
  maxX: CssCoordinate;
  readonly textAlign: ComputedStyle["text"]["textAlign"];
  readonly direction: "ltr" | "rtl";
  readonly strutMetrics: UsedFontMetrics;
  readonly strutLineHeight: CssPixelLength;
  readonly clipRect: CssRect;
  readonly textAnalysis: InlineTextAnalysis;
  readonly selectedLineBreaks: Set<number>;
  readonly suppressedUnits: Set<number>;
  readonly usedUnitAdvances: Map<number, CssPixelLength>;
  logicalUnitLimit: number;
  lineSelectionStopped: boolean;
  lineStartX: CssCoordinate;
  x: CssCoordinate;
  y: CssCoordinate;
  collapsedSpace: boolean;
  lineReserved: boolean;
  readonly entries: InlineLineEntry[];
  readonly lineBoxes: LineBox[];
}

interface UsedDimensions {
  readonly margin: CssSignedEdges;
  readonly padding: CssEdges;
  readonly border: CssEdges;
  readonly contentWidth: CssPixelLength;
  readonly specifiedHeight: CssPixelLength | null;
  readonly minHeight: CssPixelLength;
  readonly maxHeight: CssPixelLength | null;
  readonly marginLeft: CssPixelLength;
  readonly marginRight: CssPixelLength;
}

interface CollapsibleMarginProfile {
  readonly before: CssPixelLength;
  readonly after: CssPixelLength;
  readonly through: boolean;
}

function normalizeBudgets(
  value: Partial<LayoutBudgets> | undefined,
): LayoutBudgets | null {
  const integer = (
    candidate: number | undefined,
    fallback: number,
    minimum = 0,
  ): number | null => {
    if (candidate === undefined) return fallback;
    if (Number.isSafeInteger(candidate) && candidate >= minimum)
      return candidate;
    return null;
  };
  const result = {
    maxFragments: integer(
      value?.maxFragments,
      DEFAULT_LAYOUT_BUDGETS.maxFragments,
      1,
    ),
    maxLineBoxes: integer(
      value?.maxLineBoxes,
      DEFAULT_LAYOUT_BUDGETS.maxLineBoxes,
    ),
    maxTextFragments: integer(
      value?.maxTextFragments,
      DEFAULT_LAYOUT_BUDGETS.maxTextFragments,
    ),
    maxLineFragments: integer(
      value?.maxLineFragments,
      DEFAULT_LAYOUT_BUDGETS.maxLineFragments,
    ),
    maxCodePointsPerBidiParagraph: integer(
      value?.maxCodePointsPerBidiParagraph,
      DEFAULT_LAYOUT_BUDGETS.maxCodePointsPerBidiParagraph,
    ),
    maxBidiItems: integer(
      value?.maxBidiItems,
      DEFAULT_LAYOUT_BUDGETS.maxBidiItems,
    ),
    maxBidiEmbeddingDepth: integer(
      value?.maxBidiEmbeddingDepth,
      DEFAULT_LAYOUT_BUDGETS.maxBidiEmbeddingDepth,
    ),
    maxBidiRuns: integer(
      value?.maxBidiRuns,
      DEFAULT_LAYOUT_BUDGETS.maxBidiRuns,
    ),
    maxGraphemeClusters: integer(
      value?.maxGraphemeClusters,
      DEFAULT_LAYOUT_BUDGETS.maxGraphemeClusters,
    ),
    maxBreakOpportunities: integer(
      value?.maxBreakOpportunities,
      DEFAULT_LAYOUT_BUDGETS.maxBreakOpportunities,
    ),
    maxVisualRuns: integer(
      value?.maxVisualRuns,
      DEFAULT_LAYOUT_BUDGETS.maxVisualRuns,
    ),
    maxFlexSizingWork: integer(
      value?.maxFlexSizingWork,
      DEFAULT_LAYOUT_BUDGETS.maxFlexSizingWork,
    ),
    maxIntrinsicContributionCacheEntries: integer(
      value?.maxIntrinsicContributionCacheEntries,
      DEFAULT_LAYOUT_BUDGETS.maxIntrinsicContributionCacheEntries,
    ),
    maxGridItems: integer(
      value?.maxGridItems,
      DEFAULT_LAYOUT_BUDGETS.maxGridItems,
    ),
    maxExplicitGridTracks: integer(
      value?.maxExplicitGridTracks,
      DEFAULT_LAYOUT_BUDGETS.maxExplicitGridTracks,
    ),
    maxImplicitGridTracks: integer(
      value?.maxImplicitGridTracks,
      DEFAULT_LAYOUT_BUDGETS.maxImplicitGridTracks,
    ),
    maxGridOccupancyIntervals: integer(
      value?.maxGridOccupancyIntervals,
      DEFAULT_LAYOUT_BUDGETS.maxGridOccupancyIntervals,
    ),
    maxGridPlacementSteps: integer(
      value?.maxGridPlacementSteps,
      DEFAULT_LAYOUT_BUDGETS.maxGridPlacementSteps,
    ),
    maxGridNamedLineResolutions: integer(
      value?.maxGridNamedLineResolutions,
      DEFAULT_LAYOUT_BUDGETS.maxGridNamedLineResolutions,
    ),
    maxGridAutoRepeatTracks: integer(
      value?.maxGridAutoRepeatTracks,
      DEFAULT_LAYOUT_BUDGETS.maxGridAutoRepeatTracks,
    ),
    maxGridTrackSizingWork: integer(
      value?.maxGridTrackSizingWork,
      DEFAULT_LAYOUT_BUDGETS.maxGridTrackSizingWork,
    ),
    maxTableRoots: integer(value?.maxTableRoots, DEFAULT_LAYOUT_BUDGETS.maxTableRoots),
    maxTableRowGroups: integer(value?.maxTableRowGroups, DEFAULT_LAYOUT_BUDGETS.maxTableRowGroups),
    maxTableRows: integer(value?.maxTableRows, DEFAULT_LAYOUT_BUDGETS.maxTableRows),
    maxTableColumnGroups: integer(value?.maxTableColumnGroups, DEFAULT_LAYOUT_BUDGETS.maxTableColumnGroups),
    maxTableColumns: integer(value?.maxTableColumns, DEFAULT_LAYOUT_BUDGETS.maxTableColumns),
    maxTableCells: integer(value?.maxTableCells, DEFAULT_LAYOUT_BUDGETS.maxTableCells),
    maxTableSlotIntervals: integer(value?.maxTableSlotIntervals, DEFAULT_LAYOUT_BUDGETS.maxTableSlotIntervals),
    maxTableColspanWork: integer(value?.maxTableColspanWork, DEFAULT_LAYOUT_BUDGETS.maxTableColspanWork),
    maxTableRowspanWork: integer(value?.maxTableRowspanWork, DEFAULT_LAYOUT_BUDGETS.maxTableRowspanWork),
    maxTableAnonymousMissingCells: integer(value?.maxTableAnonymousMissingCells, DEFAULT_LAYOUT_BUDGETS.maxTableAnonymousMissingCells),
    maxTableIntrinsicMeasureWork: integer(value?.maxTableIntrinsicMeasureWork, DEFAULT_LAYOUT_BUDGETS.maxTableIntrinsicMeasureWork),
    maxTableColumnDistributionWork: integer(value?.maxTableColumnDistributionWork, DEFAULT_LAYOUT_BUDGETS.maxTableColumnDistributionWork),
    maxTableRowDistributionWork: integer(value?.maxTableRowDistributionWork, DEFAULT_LAYOUT_BUDGETS.maxTableRowDistributionWork),
    maxTableCollapsedBorderCandidates: integer(value?.maxTableCollapsedBorderCandidates, DEFAULT_LAYOUT_BUDGETS.maxTableCollapsedBorderCandidates),
    maxTableCollapsedBorderSegments: integer(value?.maxTableCollapsedBorderSegments, DEFAULT_LAYOUT_BUDGETS.maxTableCollapsedBorderSegments),
    maxTableHeaderAssociations: integer(value?.maxTableHeaderAssociations, DEFAULT_LAYOUT_BUDGETS.maxTableHeaderAssociations),
    maxDepth: integer(value?.maxDepth, DEFAULT_LAYOUT_BUDGETS.maxDepth),
  };
  for (const candidate of Object.values(result))
    if (candidate === null) return null;
  if ((result.maxBidiEmbeddingDepth ?? 126) > 125) return null;
  return Object.freeze(result as LayoutBudgets);
}

function fragmentId(value: string): LayoutFragmentId {
  return value as LayoutFragmentId;
}

function lineBoxId(value: string): LineBoxId {
  return value as LineBoxId;
}

function point(value: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return cssCoordinateAdd(value, offset);
}

function nonNegative(value: CssPixelLength): CssNonNegativeLength {
  return cssNonNegativeLength(value);
}

function negate(value: CssPixelLength): CssPixelLength {
  return cssMultiply(value, -1);
}

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  let total: CssPixelLength = ZERO;
  for (const value of values) total = cssAdd(total, value);
  return total;
}

function unionOverflowRect(base: CssRect, candidate: CssRect): CssRect {
  if (candidate.width === 0 || candidate.height === 0) return base;
  if (base.width === 0 || base.height === 0) return candidate;
  const baseEdge = cssCoordinateAdd(base.x, base.width);
  const baseBottom = cssCoordinateAdd(base.y, base.height);
  const candidateEdge = cssCoordinateAdd(candidate.x, candidate.width);
  const candidateBottom = cssCoordinateAdd(candidate.y, candidate.height);
  if (
    candidate.x >= base.x &&
    candidate.y >= base.y &&
    candidateEdge <= baseEdge &&
    candidateBottom <= baseBottom
  )
    return base;
  return cssUnion([base, candidate], base);
}

function collapseMargins(...values: readonly CssPixelLength[]): CssPixelLength {
  return collapseMarginValues(values);
}

function collapseMarginValues(
  values: Iterable<CssPixelLength>,
): CssPixelLength {
  let positive: CssPixelLength = ZERO;
  let negative: CssPixelLength = ZERO;
  for (const value of values) {
    if (value > positive) positive = value;
    if (value < negative) negative = value;
  }
  return cssAdd(positive, negative);
}

function constrainedSize(
  automatic: CssPixelLength,
  specified: CssPixelLength | null,
  minimum: CssPixelLength,
  maximum: CssPixelLength | null,
): CssNonNegativeLength {
  let used = specified ?? automatic;
  if (maximum !== null) used = cssMin(used, maximum);
  return nonNegative(cssMax(used, minimum));
}

function emptyEdges(edges: CssEdges | CssSignedEdges): boolean {
  return (
    edges.top === 0 &&
    edges.right === 0 &&
    edges.bottom === 0 &&
    edges.left === 0
  );
}

function checkedFontMetrics(metrics: UsedFontMetrics): UsedFontMetrics {
  for (const value of [
    metrics.fontSize,
    metrics.ascent,
    metrics.descent,
    metrics.lineGap,
    metrics.baseline,
    metrics.xHeight,
    metrics.chAdvance,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "CSS text metrics must be non-negative safe fixed-point integers.",
      );
    }
  }
  return metrics;
}

function rootFontMetrics(input: BuildLayoutFragmentTreeInput): UsedFontMetrics {
  const initial = checkedFontMetrics(
    input.context.textMeasurer.defaultFontMetrics(),
  );
  const root = input.formatting.document.documentElement;
  if (root === null) return initial;
  const style = input.formatting.styles.style(root);
  const value = style.text.fontSize;
  const size =
    value.kind === "length" && value.unit === "px"
      ? cssPx(value.value)
      : initial.fontSize;
  return checkedFontMetrics(input.context.textMeasurer.fontMetrics(size));
}

class LayoutBuilder {
  readonly #input: BuildLayoutFragmentTreeInput;
  readonly #formatting: FormattingTree;
  readonly #budgets: LayoutBudgets;
  readonly #rootFontMetrics: UsedFontMetrics;
  readonly #fontMetricsCache = new Map<CssPixelLength, UsedFontMetrics>();
  readonly #textAdvanceCache = new Map<string, CssNonNegativeLength>();
  readonly #fragments = new Map<LayoutFragmentId, LayoutFragment>();
  readonly #parentIndex = new Map<LayoutFragmentId, LayoutFragmentId>();
  readonly #formattingIndex = new Map<FormattingNodeId, LayoutFragmentId[]>();
  readonly #documentIndex = new Map<DocumentNodeRef, LayoutFragmentId[]>();
  readonly #lineBoxes: LineBox[] = [];
  readonly #lineBoxPositions = new Map<LineBoxId, number>();
  readonly #inlineDecorations = new Map<
    LayoutFragmentId,
    {
      readonly margin: CssSignedEdges;
      readonly padding: CssEdges;
      readonly border: CssEdges;
    }
  >();
  readonly #ordinals = new Map<string, number>();
  readonly #decorationCache = new Map<
    FormattingNodeId,
    { readonly underline: boolean; readonly lineThrough: boolean }
  >();
  readonly #paintStyleCache: Map<FormattingNodeId, LayoutPaintStyle>;
  readonly #documentSemanticAncestorCache: Map<
    DocumentNodeRef,
    readonly NonNullable<LayoutFragment["semantic"]>[]
  >;
  readonly #marginProfileCache = new Map<string, CollapsibleMarginProfile>();
  readonly #intrinsicContributionCache: IntrinsicContributionCache;
  readonly #tableSlotGridCache = new Map<FormattingNodeId, TableSlotGrid>();
  readonly #positionedContainingBlocks = new Map<FormattingNodeId, CssRect>();
  readonly #principalFragments = new Map<FormattingNodeId, LayoutFragmentId>();
  readonly #stackingMetadata = new Map<
    LayoutFragmentId,
    LayoutStackingMetadata
  >();
  readonly #floatManagers: FloatExclusionManager[] = [];
  readonly #tableWork = new Map<TableBudgetName, number>();
  readonly #tableBorderOverrides = new Map<FormattingNodeId, TableBorderOverride>();
  readonly #tableCollapsedBorderSegments = new Map<
    FormattingNodeId,
    readonly LayoutTableCollapsedBorderSegment[]
  >();
  #reserved = 0;
  #reservedLineBoxes = 0;
  #textFragments = 0;
  #lineFragments = 0;
  #visualRuns = 0;
  #bidiItems = 0;
  #bidiRuns = 0;
  #graphemeClusters = 0;
  #breakOpportunities = 0;
  #visualOrder = 0;
  #paintOrder = 0;
  #hasInFlowPositioning = false;
  #truncated: keyof LayoutBudgets | null = null;

  public constructor(
    input: BuildLayoutFragmentTreeInput,
    budgets: LayoutBudgets,
  ) {
    this.#input = input;
    this.#formatting = input.formatting;
    this.#budgets = budgets;
    this.#paintStyleCache = formattingCache(
      PAINT_STYLE_CACHE,
      input.formatting,
    );
    this.#documentSemanticAncestorCache = formattingCache(
      DOCUMENT_SEMANTIC_ANCESTOR_CACHE,
      input.formatting,
    );
    this.#rootFontMetrics = rootFontMetrics(input);
    this.#intrinsicContributionCache = new IntrinsicContributionCache(
      budgets.maxIntrinsicContributionCacheEntries,
    );
    this.#fontMetricsCache.set(
      this.#rootFontMetrics.fontSize,
      this.#rootFontMetrics,
    );
  }

  #newId(formatting: FormattingNodeId, occurrence = "box"): LayoutFragmentId {
    const key = `${formatting}:${occurrence}`;
    const ordinal = (this.#ordinals.get(key) ?? 0) + 1;
    this.#ordinals.set(key, ordinal);
    return fragmentId(`layout-fragment:${key}:${String(ordinal)}`);
  }

  #reserve(): void {
    if (this.#fragments.size + this.#reserved >= this.#budgets.maxFragments) {
      this.#truncated ??= "maxFragments";
      throw new LayoutBudgetExhausted();
    }
    this.#reserved += 1;
  }

  #store<T extends LayoutFragment>(value: T, reserved = false): T {
    const outstanding = this.#reserved - (reserved ? 1 : 0);
    if (this.#fragments.size + outstanding >= this.#budgets.maxFragments) {
      this.#truncated ??= "maxFragments";
      throw new LayoutBudgetExhausted();
    }
    if (value.kind === "text") {
      if (this.#textFragments >= this.#budgets.maxTextFragments) {
        this.#truncated ??= "maxTextFragments";
        throw new LayoutBudgetExhausted();
      }
      this.#textFragments += 1;
    }
    this.#fragments.set(value.id, value);
    for (const child of value.children) this.#parentIndex.set(child, value.id);
    const byFormatting = this.#formattingIndex.get(value.formattingNode) ?? [];
    byFormatting.push(value.id);
    this.#formattingIndex.set(value.formattingNode, byFormatting);
    if (value.documentNode !== null) {
      const byDocument = this.#documentIndex.get(value.documentNode) ?? [];
      byDocument.push(value.id);
      this.#documentIndex.set(value.documentNode, byDocument);
    }
    return value;
  }

  #computed(node: FormattingNode): ComputedStyle | null {
    if (node.styleNode === null) return null;
    return node.pseudo === null
      ? this.#formatting.styles.style(node.styleNode)
      : (this.#formatting.styles.pseudo(node.styleNode, node.pseudo) ??
          this.#formatting.styles.style(node.styleNode));
  }

  #reserveInlineTextAnalysis(analysis: InlineTextAnalysis): void {
    const counts = analysis.resourceCounts;
    const checks = [
      ["maxBidiItems", this.#bidiItems, counts.bidiItems],
      ["maxBidiRuns", this.#bidiRuns, counts.bidiRuns],
      ["maxGraphemeClusters", this.#graphemeClusters, counts.graphemeClusters],
      [
        "maxBreakOpportunities",
        this.#breakOpportunities,
        counts.breakOpportunities,
      ],
    ] as const;
    for (const [budget, retained, added] of checks) {
      if (added > this.#budgets[budget] - retained) {
        this.#truncated ??= budget;
        throw new LayoutBudgetExhausted();
      }
    }
    this.#bidiItems += counts.bidiItems;
    this.#bidiRuns += counts.bidiRuns;
    this.#graphemeClusters += counts.graphemeClusters;
    this.#breakOpportunities += counts.breakOpportunities;
  }

  #inlineTextAnalysis(
    containingFormattingBox: FormattingNodeId,
    ids: readonly FormattingNodeId[],
    direction: "ltr" | "rtl" | "auto",
  ): InlineTextAnalysis {
    const stream = this.#input.inlineItemStreams.stream(
      containingFormattingBox,
      ids,
    );
    let cache = INLINE_TEXT_ANALYSIS_CACHE.get(stream);
    if (cache === undefined) {
      cache = new Map<string, InlineTextAnalysis>();
      INLINE_TEXT_ANALYSIS_CACHE.set(stream, cache);
    }
    const cacheKey = [
      direction,
      this.#budgets.maxCodePointsPerBidiParagraph,
      this.#budgets.maxBidiItems,
      this.#budgets.maxBidiEmbeddingDepth,
      this.#budgets.maxBidiRuns,
      this.#budgets.maxGraphemeClusters,
      this.#budgets.maxBreakOpportunities,
    ].join("\u0000");
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      this.#reserveInlineTextAnalysis(cached);
      return cached;
    }
    const items: BidiItem<InlineTextIdentity>[] = [];
    const textNodeRecords = new Map<
      FormattingNodeId,
      {
        readonly units: InlineLogicalUnit[];
      }
    >();
    const atomicItems = new Map<FormattingNodeId, number>();
    const firstUnitByFormatting = new Map<FormattingNodeId, number>();
    const logicalUnits: InlineLogicalUnit[] = [];
    let logicalText = "";
    const graphemeClusters = stream.graphemeClusters;
    if (
      graphemeClusters >
      this.#budgets.maxGraphemeClusters - this.#graphemeClusters
    ) {
      this.#truncated ??= "maxGraphemeClusters";
      throw new LayoutBudgetExhausted();
    }
    let paragraphCodePoints = 0;
    const append = (
      bidiType: BidiClass,
      text: string,
      codePoint: number | null,
      identity: InlineTextIdentity,
    ): number => {
      if (items.length >= this.#budgets.maxBidiItems - this.#bidiItems) {
        this.#truncated ??= "maxBidiItems";
        throw new LayoutBudgetExhausted();
      }
      if (
        codePoint !== null &&
        paragraphCodePoints >= this.#budgets.maxCodePointsPerBidiParagraph
      ) {
        this.#truncated ??= "maxCodePointsPerBidiParagraph";
        throw new LayoutBudgetExhausted();
      }
      const logicalIndex = items.length;
      items.push(
        Object.freeze({
          logicalIndex,
          kind:
            identity.kind === "text"
              ? "code-point"
              : identity.kind === "atomic-inline"
                ? "atomic-inline"
                : "structural-control",
          text,
          codePoint,
          bidiClass: bidiType,
          sourceStartCodeUnit: identity.contentStartCodeUnit,
          sourceEndCodeUnit: identity.contentEndCodeUnit,
          identity,
        }),
      );
      if (codePoint !== null) paragraphCodePoints += 1;
      if (bidiType === "B") paragraphCodePoints = 0;
      return logicalIndex;
    };
    const appendUnit = (
      node: FormattingNode,
      kind: InlineLogicalUnit["kind"],
      text: string,
      contentStartCodeUnit: number,
      contentEndCodeUnit: number,
      collapsibleSpace: boolean,
    ): InlineLogicalUnit => {
      const bidiItemStart = items.length;
      if (kind === "forced-break") {
        append("B", "", null, {
          formattingNode: node.id,
          contentStartCodeUnit,
          contentEndCodeUnit,
          kind: "forced-break",
        });
      } else if (kind === "break-opportunity") {
        append("BN", "", null, {
          formattingNode: node.id,
          contentStartCodeUnit,
          contentEndCodeUnit,
          kind: "structural-control",
        });
      } else if (kind === "atomic-inline") {
        append("ON", text, 0xfffc, {
          formattingNode: node.id,
          contentStartCodeUnit,
          contentEndCodeUnit,
          kind,
        });
      } else {
        for (const character of text) {
          const codePoint = character.codePointAt(0);
          if (codePoint === undefined) continue;
          append(bidiClass(codePoint), character, codePoint, {
            formattingNode: node.id,
            contentStartCodeUnit,
            contentEndCodeUnit,
            kind: "text",
          });
        }
      }
      const lineValue =
        kind === "forced-break"
          ? "\n"
          : kind === "break-opportunity"
            ? "\u200b"
            : text;
      const unit = Object.freeze({
        logicalIndex: logicalUnits.length,
        kind,
        formattingNode: node.id,
        text,
        contentStartCodeUnit,
        contentEndCodeUnit,
        bidiItemStart,
        bidiItemEnd: items.length,
        lineStartCodeUnit: logicalText.length,
        lineEndCodeUnit: logicalText.length + lineValue.length,
        collapsibleSpace,
      });
      logicalUnits.push(unit);
      if (!firstUnitByFormatting.has(node.id))
        firstUnitByFormatting.set(node.id, unit.logicalIndex);
      logicalText += lineValue;
      return unit;
    };
    const control = (type: BidiClass): void => {
      append(type, "", null, {
        formattingNode: null,
        contentStartCodeUnit: 0,
        contentEndCodeUnit: 0,
        kind: "structural-control",
      });
    };
    for (const item of stream.items) {
      this.#input.signal?.throwIfAborted();
      if (item.kind === "structural-bidi-control") {
        control(item.bidiClass);
        continue;
      }
      if (item.kind === "block-boundary") {
        control("B");
        continue;
      }
      if (item.formattingNode === null) continue;
      const node = this.#formatting.node(item.formattingNode);
      if (item.kind === "atomic-inline") {
        const unit = appendUnit(node, "atomic-inline", "\ufffc", 0, 0, false);
        atomicItems.set(node.id, unit.bidiItemStart);
        continue;
      }
      if (item.kind === "forced-line-break") {
        const record = textNodeRecords.get(node.id) ?? {
          units: [] as InlineLogicalUnit[],
        };
        textNodeRecords.set(node.id, record);
        record.units.push(
          appendUnit(
            node,
            "forced-break",
            "",
            item.contentStartCodeUnit,
            item.contentEndCodeUnit,
            false,
          ),
        );
        continue;
      }
      if (item.kind === "break-opportunity") {
        appendUnit(node, "break-opportunity", "", 0, 0, false);
        continue;
      }
      const record = textNodeRecords.get(node.id) ?? {
        units: [] as InlineLogicalUnit[],
      };
      textNodeRecords.set(node.id, record);
      record.units.push(
        appendUnit(
          node,
          item.kind === "soft-hyphen"
            ? "soft-hyphen"
            : item.kind === "tab"
              ? "tab"
              : "text",
          item.text,
          item.contentStartCodeUnit,
          item.contentEndCodeUnit,
          item.collapsibleSpace,
        ),
      );
    }
    const graphemeClusterBoundaries = [
      0,
      ...logicalUnits.map((unit) => unit.lineEndCodeUnit),
    ];
    let tailoringUnit = 0;
    const lineBreakMap = buildLineBreakMap(
      logicalText,
      ({ codeUnitOffset }) => {
        while (
          tailoringUnit + 1 < logicalUnits.length &&
          (logicalUnits[tailoringUnit + 1]?.lineStartCodeUnit ??
            Number.MAX_SAFE_INTEGER) <= codeUnitOffset
        ) {
          tailoringUnit += 1;
        }
        let unit = logicalUnits[tailoringUnit];
        if (unit !== undefined && unit.lineEndCodeUnit <= codeUnitOffset) {
          unit = logicalUnits[tailoringUnit + 1] ?? unit;
        }
        const formattingNode =
          unit === undefined
            ? null
            : this.#formatting.node(unit.formattingNode);
        const style =
          formattingNode === null ? null : this.#computed(formattingNode);
        const breakWord = style?.text.wordBreak === "break-word";
        return {
          lineBreak: style?.text.lineBreak ?? "auto",
          wordBreak: breakWord ? "normal" : (style?.text.wordBreak ?? "normal"),
          overflowWrap: breakWord
            ? "anywhere"
            : (style?.text.overflowWrap ?? "normal"),
          hyphens: style?.text.hyphens ?? "manual",
          language:
            formattingNode === null ? null : this.#language(formattingNode),
          preserveGraphemeClusters: true,
        };
      },
      {
        maxBreakOpportunities: Math.max(
          0,
          this.#budgets.maxBreakOpportunities - this.#breakOpportunities,
        ),
        graphemeClusterBoundaries,
      },
      this.#input.signal,
    );
    if (lineBreakMap.outcome.status === "rejected")
      throw new RangeError("Line-break input was rejected.");
    if (lineBreakMap.outcome.status === "truncated") {
      this.#truncated ??= "maxBreakOpportunities";
      throw new LayoutBudgetExhausted();
    }
    const paragraphDirection = (
      itemStart: number,
      itemEnd: number,
    ): "ltr" | "rtl" | "auto" => {
      for (let item = itemStart; item < itemEnd; item += 1) {
        const formattingNode = items[item]?.identity.formattingNode;
        if (
          formattingNode !== null &&
          formattingNode !== undefined &&
          this.#computed(this.#formatting.node(formattingNode))?.text
            .unicodeBidi === "plaintext"
        )
          return "auto";
      }
      return direction;
    };
    const bidi = resolveBidiParagraphs(
      items,
      paragraphDirection,
      {
        maxCodePointsPerParagraph: this.#budgets.maxCodePointsPerBidiParagraph,
        maxBidiItems: this.#budgets.maxBidiItems,
        maxEmbeddingDepth: this.#budgets.maxBidiEmbeddingDepth,
        maxBidiRuns: Math.max(0, this.#budgets.maxBidiRuns - this.#bidiRuns),
      },
      this.#input.signal,
    );
    const positions: InlineBidiPosition[] = [];
    let bidiRuns = 0;
    for (const [paragraphIndex, slice] of bidi.paragraphs.entries()) {
      if (slice.paragraph.outcome.status === "rejected")
        throw new RangeError("Bidi paragraph input was rejected.");
      if (slice.paragraph.outcome.status === "truncated") {
        const budget =
          slice.paragraph.outcome.budget === "maxCodePointsPerParagraph"
            ? "maxCodePointsPerBidiParagraph"
            : slice.paragraph.outcome.budget === "maxEmbeddingDepth"
              ? "maxBidiEmbeddingDepth"
              : slice.paragraph.outcome.budget;
        this.#truncated ??= budget;
        throw new LayoutBudgetExhausted();
      }
      bidiRuns += slice.paragraph.outcome.runs;
      for (let item = 0; item < slice.paragraph.items.length; item += 1) {
        const globalItem = slice.itemStart + item;
        positions[globalItem] = Object.freeze({
          paragraph: paragraphIndex,
          item,
        });
      }
    }
    const textNodes = new Map<FormattingNodeId, InlineTextNodeAnalysis>();
    for (const [id, record] of textNodeRecords) {
      textNodes.set(
        id,
        Object.freeze({
          units: Object.freeze(record.units),
        }),
      );
    }
    const unitsByBidiItem = new Array<InlineLogicalUnit | undefined>(
      items.length,
    ).fill(undefined);
    for (const unit of logicalUnits) {
      for (let item = unit.bidiItemStart; item < unit.bidiItemEnd; item += 1)
        unitsByBidiItem[item] = unit;
    }
    const breaksBefore: BreakOpportunityKind[] = [];
    let opportunityIndex = 0;
    for (const unit of logicalUnits) {
      while (
        (lineBreakMap.opportunities[opportunityIndex]?.codeUnitOffset ??
          Number.MAX_SAFE_INTEGER) < unit.lineStartCodeUnit
      )
        opportunityIndex += 1;
      const opportunity = lineBreakMap.opportunities[opportunityIndex];
      breaksBefore.push(
        opportunity?.codeUnitOffset === unit.lineStartCodeUnit
          ? opportunity.kind
          : "prohibited",
      );
    }
    const analysis = Object.freeze({
      bidi,
      textNodes,
      atomicItems,
      firstUnitByFormatting,
      positions: Object.freeze(positions),
      logicalUnits: Object.freeze(logicalUnits),
      unitsByBidiItem: Object.freeze(unitsByBidiItem),
      breaksBefore: Object.freeze(breaksBefore),
      resourceCounts: Object.freeze({
        bidiItems: items.length,
        bidiRuns,
        graphemeClusters,
        breakOpportunities: lineBreakMap.opportunities.length,
      }),
    });
    this.#reserveInlineTextAnalysis(analysis);
    cache.set(cacheKey, analysis);
    return analysis;
  }

  #language(node: FormattingNode): string | null {
    let current =
      node.styleNode === null
        ? null
        : this.#formatting.document.node(node.styleNode);
    while (current !== null) {
      if (current.kind === "element") {
        const language =
          this.#formatting.document.attribute(current.ref, "lang") ??
          this.#formatting.document.attribute(
            current.ref,
            "lang",
            "http://www.w3.org/XML/1998/namespace",
          );
        if (language !== null && language.trim().length > 0)
          return language.trim().toLowerCase();
      }
      current = this.#formatting.document.parent(current.ref);
    }
    return null;
  }

  #boxComputed(node: FormattingNode): ComputedStyle | null {
    return node.appliesBoxStyle ? this.#computed(node) : null;
  }

  #fontSize(style: ComputedStyle | null): CssPixelLength {
    const value = style?.text.fontSize;
    return value?.kind === "length" && value.unit === "px"
      ? cssPx(value.value)
      : this.#rootFontMetrics.fontSize;
  }

  #metrics(style: ComputedStyle | null): UsedFontMetrics {
    const fontSize = this.#fontSize(style);
    const cached = this.#fontMetricsCache.get(fontSize);
    if (cached !== undefined) return cached;
    const metrics = checkedFontMetrics(
      this.#input.context.textMeasurer.fontMetrics(fontSize),
    );
    this.#fontMetricsCache.set(fontSize, metrics);
    return metrics;
  }

  #measure(text: string, fontSize: CssPixelLength): CssNonNegativeLength {
    const cacheKey = text.length <= 32 ? `${String(fontSize)}:${text}` : null;
    const cached =
      cacheKey === null ? undefined : this.#textAdvanceCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const advance = this.#input.context.textMeasurer.measure(text, fontSize);
    if (!Number.isSafeInteger(advance) || advance < 0) {
      throw new RangeError(
        "CSS text advance must be a non-negative safe fixed-point integer.",
      );
    }
    const checked = nonNegative(advance);
    if (cacheKey !== null && this.#textAdvanceCache.size < 4_096)
      this.#textAdvanceCache.set(cacheKey, checked);
    return checked;
  }

  #usedLength(
    value: CssLength,
    percentageBasis: CssPixelLength | null,
    style: ComputedStyle | null,
  ): CssPixelLength | null {
    if (value.kind === "auto" || value.kind === "none") return null;
    if (value.kind === "zero") return ZERO;
    if (value.kind === "calculation") {
      if (
        value.calculation.percentageDependence !== "none" &&
        percentageBasis === null
      )
        return null;
      return this.#usedMath(
        value.calculation.expression,
        percentageBasis ?? ZERO,
        style,
      );
    }
    if (!Number.isFinite(value.value))
      throw new RangeError("Non-finite computed CSS length.");
    if (value.unit === "px") return cssPx(value.value);
    if (value.unit === "%")
      return percentageBasis === null
        ? null
        : cssMultiply(percentageBasis, value.value / 100);
    if (value.unit === "vw")
      return cssMultiply(this.#input.context.viewport.width, value.value / 100);
    if (value.unit === "vh")
      return cssMultiply(
        this.#input.context.viewport.height,
        value.value / 100,
      );
    if (value.unit === "rem")
      return cssMultiply(this.#rootFontMetrics.fontSize, value.value);
    if (value.unit === "em")
      return cssMultiply(this.#fontSize(style), value.value);
    return cssMultiply(this.#metrics(style).chAdvance, value.value);
  }

  #usedGap(
    value: CssGap,
    percentageBasis: CssPixelLength | null,
    style: ComputedStyle,
  ): CssPixelLength | null {
    return value.kind === "normal"
      ? ZERO
      : this.#usedLength(value, percentageBasis, style);
  }

  #usedMath(
    expression: CssLengthPercentageExpression,
    percentageBasis: CssPixelLength,
    style: ComputedStyle | null,
  ): CssPixelLength {
    if (expression.kind === "value") {
      return (
        this.#usedLength(
          { kind: "length", value: expression.value, unit: expression.unit },
          percentageBasis,
          style,
        ) ?? ZERO
      );
    }
    if (expression.kind === "negate")
      return negate(this.#usedMath(expression.value, percentageBasis, style));
    if (expression.kind === "sum")
      return cssAdd(
        this.#usedMath(expression.left, percentageBasis, style),
        this.#usedMath(expression.right, percentageBasis, style),
      );
    if (expression.kind === "product") {
      return cssMultiply(
        this.#usedMath(expression.value, percentageBasis, style),
        expression.factor,
      );
    }
    if (expression.kind === "minimum" || expression.kind === "maximum") {
      let result: CssPixelLength | null = null;
      for (const value of expression.values) {
        const candidate = this.#usedMath(value, percentageBasis, style);
        result =
          result === null
            ? candidate
            : expression.kind === "minimum"
              ? cssMin(result, candidate)
              : cssMax(result, candidate);
      }
      if (result === null)
        throw new RangeError("CSS min/max calculation has no arguments.");
      return result;
    }
    const minimum = this.#usedMath(expression.minimum, percentageBasis, style);
    const preferred = this.#usedMath(
      expression.preferred,
      percentageBasis,
      style,
    );
    const maximum = this.#usedMath(expression.maximum, percentageBasis, style);
    return cssMax(minimum, cssMin(preferred, maximum));
  }

  #edges(
    style: ComputedStyle | null,
    containingWidth: CssPixelLength,
    formattingNode?: FormattingNodeId,
  ): {
    readonly margin: CssSignedEdges;
    readonly padding: CssEdges;
    readonly border: CssEdges;
  } {
    const used = (value: CssLength): CssPixelLength =>
      this.#usedLength(value, containingWidth, style) ?? ZERO;
    const computedMargin =
      style === null
        ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
        : {
            top: used(style.box.margin.top),
            right: used(style.box.margin.right),
            bottom: used(style.box.margin.bottom),
            left: used(style.box.margin.left),
          };
    const margin = formattingNode !== undefined
      && TABLE_INTERNAL_MARGINLESS_KINDS.has(this.#formatting.node(formattingNode).kind)
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : computedMargin;
    const computedPadding =
      style === null
        ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
        : {
            top: nonNegative(used(style.box.padding.top)),
            right: nonNegative(used(style.box.padding.right)),
            bottom: nonNegative(used(style.box.padding.bottom)),
            left: nonNegative(used(style.box.padding.left)),
          };
    const padding = formattingNode !== undefined
      && this.#tableBorderOverrides.get(formattingNode)?.suppressPadding === true
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : computedPadding;
    const computedBorder = style === null
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : {
          top: style.box.borderStyles.top === "solid" ? nonNegative(used(style.box.borderWidths.top)) : ZERO,
          right: style.box.borderStyles.right === "solid" ? nonNegative(used(style.box.borderWidths.right)) : ZERO,
          bottom: style.box.borderStyles.bottom === "solid" ? nonNegative(used(style.box.borderWidths.bottom)) : ZERO,
          left: style.box.borderStyles.left === "solid" ? nonNegative(used(style.box.borderWidths.left)) : ZERO,
        };
    const border = formattingNode === undefined
      ? computedBorder
      : (this.#tableBorderOverrides.get(formattingNode)?.widths ?? computedBorder);
    return { margin, padding, border };
  }

  #dimensions(
    node: FormattingNode,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null = null,
    distributeForcedAutoMargins = false,
  ): UsedDimensions {
    const style = this.#boxComputed(node);
    const { margin, padding, border } = this.#edges(style, containingWidth, node.id);
    const horizontalChrome = sum(
      padding.left,
      padding.right,
      border.left,
      border.right,
    );
    const fixedLeft =
      style?.box.margin.left.kind === "auto" ? ZERO : margin.left;
    const fixedRight =
      style?.box.margin.right.kind === "auto" ? ZERO : margin.right;
    const availableBorderBox = nonNegative(
      sum(containingWidth, negate(fixedLeft), negate(fixedRight)),
    );
    const specified =
      style === null
        ? null
        : this.#usedLength(style.box.width, containingWidth, style);
    const minimum =
      style === null
        ? ZERO
        : (this.#usedLength(style.box.minWidth, containingWidth, style) ??
          ZERO);
    const maximum =
      style === null
        ? null
        : this.#usedLength(style.box.maxWidth, containingWidth, style);
    const toContent = (candidate: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(candidate, negate(horizontalChrome)))
        : nonNegative(candidate);
    const availableContent = nonNegative(
      sum(availableBorderBox, negate(horizontalChrome)),
    );
    let contentWidth =
      forcedContentWidth ??
      (specified === null ? availableContent : toContent(specified));
    if (forcedContentWidth === null) {
      if (maximum !== null)
        contentWidth = cssMin(contentWidth, toContent(maximum));
      contentWidth = cssMax(toContent(minimum), contentWidth);
    }
    const borderBoxWidth = sum(contentWidth, horizontalChrome);
    const remaining = sum(
      containingWidth,
      negate(fixedLeft),
      negate(fixedRight),
      negate(borderBoxWidth),
    );
    const autoLeft = style?.box.margin.left.kind === "auto";
    const autoRight = style?.box.margin.right.kind === "auto";
    let marginLeft = fixedLeft;
    let marginRight = fixedRight;
    if (forcedContentWidth !== null && !distributeForcedAutoMargins) {
      marginLeft = autoLeft ? ZERO : fixedLeft;
      marginRight = autoRight ? ZERO : fixedRight;
    } else if (remaining >= 0 && autoLeft && autoRight) {
      marginLeft = cssDivide(remaining, 2);
      marginRight = sum(remaining, negate(marginLeft));
    } else if (remaining >= 0 && autoLeft) marginLeft = remaining;
    else if (remaining >= 0 && autoRight) marginRight = remaining;
    else marginRight = cssAdd(fixedRight, remaining);
    const resolvedHeight =
      style === null
        ? null
        : this.#usedLength(style.box.height, containingHeight, style);
    const minHeight =
      style === null
        ? ZERO
        : (this.#usedLength(style.box.minHeight, containingHeight, style) ??
          ZERO);
    const maxHeight =
      style === null
        ? null
        : this.#usedLength(style.box.maxHeight, containingHeight, style);
    const verticalChrome = sum(
      padding.top,
      padding.bottom,
      border.top,
      border.bottom,
    );
    const heightToContent = (candidate: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(candidate, negate(verticalChrome)))
        : nonNegative(candidate);
    return {
      margin,
      padding,
      border,
      contentWidth,
      specifiedHeight:
        resolvedHeight === null ? null : heightToContent(resolvedHeight),
      minHeight: heightToContent(minHeight),
      maxHeight: maxHeight === null ? null : heightToContent(maxHeight),
      marginLeft,
      marginRight,
    };
  }

  #normalBlockFlow(node: FormattingNode): boolean {
    if (node.outer !== "block") return false;
    const style = this.#boxComputed(node);
    if (
      style !== null &&
      (style.box.float !== "none" ||
        style.box.position === "absolute" ||
        style.box.position === "fixed")
    ) {
      return false;
    }
    if (
      node.kind === "table-wrapper" ||
      node.kind.startsWith("table-") ||
      node.kind === "table" ||
      node.kind === "flex-container" ||
      node.kind === "grid-container" ||
      node.kind === "flex-item" ||
      node.kind === "grid-item"
    )
      return false;
    const display = this.#boxComputed(node)?.display;
    return display?.box !== "principal" || display.inner !== "flow-root";
  }

  #outOfFlow(node: FormattingNode): boolean {
    const position = this.#boxComputed(node)?.box.position;
    return position === "absolute" || position === "fixed";
  }

  #createsLineContent(node: FormattingNode): boolean {
    if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker"
    ) {
      return node.whiteSpace === "pre" ||
        node.whiteSpace === "pre-wrap" ||
        node.whiteSpace === "break-spaces"
        ? node.text.length > 0
        : /\S/u.test(node.text);
    }
    if (
      node.kind === "forced-line-break" ||
      node.kind === "form-control" ||
      node.kind === "replaced-element" ||
      node.kind === "image-fallback"
    )
      return true;
    return node.children.some((child) =>
      this.#createsLineContent(this.#formatting.node(child)),
    );
  }

  #collapsibleMargins(
    id: FormattingNodeId,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null,
    depth = 0,
  ): CollapsibleMarginProfile {
    const key = `${id}:${String(containingWidth)}:${String(containingHeight ?? "auto")}`;
    const cached = this.#marginProfileCache.get(key);
    if (cached !== undefined) return cached;
    const node = this.#formatting.node(id);
    const dimensions = this.#dimensions(
      node,
      containingWidth,
      containingHeight,
    );
    const boundary =
      !this.#normalBlockFlow(node) ||
      (this.#boxComputed(node)?.box.overflowY ?? "visible") !== "visible" ||
      depth >= this.#budgets.maxDepth;
    if (boundary) {
      const profile = Object.freeze({
        before: dimensions.margin.top,
        after: dimensions.margin.bottom,
        through: false,
      });
      this.#marginProfileCache.set(key, profile);
      return profile;
    }
    const children = node.children.map((child) => this.#formatting.node(child));
    const hasInlineContent = children.some(
      (child) =>
        isInlineFormattingNode(child) && this.#createsLineContent(child),
    );
    const blockChildren = hasInlineContent
      ? []
      : children.filter((child) => {
          if (isInlineFormattingNode(child) || this.#outOfFlow(child))
            return false;
          return (this.#boxComputed(child)?.box.float ?? "none") === "none";
        });
    const profiles = blockChildren.map((child) =>
      this.#collapsibleMargins(
        child.id,
        dimensions.contentWidth,
        dimensions.specifiedHeight,
        depth + 1,
      ),
    );
    const canCollapseBefore =
      dimensions.border.top === 0 &&
      dimensions.padding.top === 0 &&
      blockChildren.length > 0;
    const canCollapseAfter =
      dimensions.border.bottom === 0 &&
      dimensions.padding.bottom === 0 &&
      dimensions.specifiedHeight === null &&
      dimensions.minHeight === 0 &&
      blockChildren.length > 0;
    let before = dimensions.margin.top;
    let after = dimensions.margin.bottom;
    if (canCollapseBefore)
      before = collapseMargins(before, profiles[0]?.before ?? ZERO);
    if (canCollapseAfter)
      after = collapseMargins(after, profiles.at(-1)?.after ?? ZERO);
    const through =
      !hasInlineContent &&
      dimensions.specifiedHeight === null &&
      dimensions.minHeight === 0 &&
      dimensions.border.top === 0 &&
      dimensions.border.bottom === 0 &&
      dimensions.padding.top === 0 &&
      dimensions.padding.bottom === 0 &&
      profiles.every((profile) => profile.through);
    if (through) {
      const adjoining = collapseMarginValues(
        (function* (): Generator<CssPixelLength> {
          yield before;
          yield after;
          for (const profile of profiles) {
            yield profile.before;
            yield profile.after;
          }
        })(),
      );
      before = adjoining;
      after = adjoining;
    }
    const profile = Object.freeze({ before, after, through });
    this.#marginProfileCache.set(key, profile);
    return profile;
  }

  #paintStyle(node: FormattingNode): LayoutPaintStyle {
    const cachedPaintStyle = this.#paintStyleCache.get(node.id);
    if (cachedPaintStyle !== undefined) return cachedPaintStyle;
    const style = this.#computed(node);
    let underline = false;
    let lineThrough = false;
    const path: FormattingNode[] = [];
    let current: FormattingNode | null = node;
    while (current !== null) {
      const cached = this.#decorationCache.get(current.id);
      if (cached !== undefined) {
        underline ||= cached.underline;
        lineThrough ||= cached.lineThrough;
        break;
      }
      path.push(current);
      current = this.#formatting.parent(current.id);
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index];
      if (entry === undefined) continue;
      const computed = this.#computed(entry);
      underline ||= computed?.text.underline === true;
      lineThrough ||= computed?.text.lineThrough === true;
      this.#decorationCache.set(entry.id, { underline, lineThrough });
    }
    const tableBorder = this.#tableBorderOverrides.get(node.id);
    const hideEmptyCell = node.kind === "table-cell" && style?.box.emptyCells === "hide"
      && style.box.borderCollapse === "separate" && !this.#tableCellHasContent(node);
    const paintStyle = Object.freeze({
      visible: style?.visibility === "visible",
      foreground: style?.text.color ?? null,
      background: node.appliesBoxStyle && !hideEmptyCell
        ? (style?.text.background ?? null)
        : null,
      bold: (style?.text.fontWeight ?? 400) >= 600,
      italic:
        style?.text.fontStyle !== undefined &&
        style.text.fontStyle !== "normal",
      underline,
      strikethrough: lineThrough,
      borderColors: hideEmptyCell ? { top: null, right: null, bottom: null, left: null } : tableBorder?.colors ?? (node.appliesBoxStyle && style !== null
        ? {
            top: style.box.borderColors.top ?? style.text.color,
            right: style.box.borderColors.right ?? style.text.color,
            bottom: style.box.borderColors.bottom ?? style.text.color,
            left: style.box.borderColors.left ?? style.text.color,
          }
        : { top: null, right: null, bottom: null, left: null }),
      borderStyles: hideEmptyCell ? { top: "none" as const, right: "none" as const, bottom: "none" as const, left: "none" as const } : tableBorder?.styles ?? (node.appliesBoxStyle && style !== null
        ? style.box.borderStyles
        : { top: "none" as const, right: "none" as const, bottom: "none" as const, left: "none" as const }),
    });
    this.#paintStyleCache.set(node.id, paintStyle);
    return paintStyle;
  }

  #tableCellHasContent(node: FormattingNode): boolean {
    const pending = [...node.children];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const child = this.#formatting.node(id);
      if (this.#outOfFlow(child)) continue;
      if (child.kind === "form-control" || child.kind === "replaced-element" || child.kind === "image-fallback" || child.kind === "forced-line-break") return true;
      if (child.kind === "text-sequence" || child.kind === "generated-text" || child.kind === "marker") {
        if (/[^\t\n\f\r ]/u.test(child.text)) return true;
        const whiteSpace = this.#computed(child)?.text.whiteSpace ?? "normal";
        if (child.text.length > 0 && (whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces")) return true;
      }
      const style = child.appliesBoxStyle ? this.#computed(child) : null;
      if ((style?.text.background?.a ?? 0) > 0
        || (style !== null && Object.values(style.box.borderStyles).some((value) => value === "solid"))) return true;
      pending.push(...child.children);
    }
    return false;
  }

  #action(node: FormattingNode): DocumentActionIdentity | null {
    if (this.#computed(node)?.visibility !== "visible" || node.source === null)
      return null;
    return documentActionIdentity(this.#formatting, node.source);
  }

  #documentSemanticAncestors(
    source: DocumentNodeRef,
  ): readonly NonNullable<LayoutFragment["semantic"]>[] {
    const cached = this.#documentSemanticAncestorCache.get(source);
    if (cached !== undefined) return cached;
    const result: NonNullable<LayoutFragment["semantic"]>[] = [];
    let current: DocumentNodeRef | null = source;
    while (current !== null) {
      const semantic = this.#formatting.document.semantic(current);
      if (semantic?.accessibilityHidden === true) {
        result.length = 0;
        break;
      }
      if (semantic !== null) result.push(semantic);
      current = this.#formatting.document.parent(current)?.ref ?? null;
    }
    const immutable = Object.freeze(result);
    this.#documentSemanticAncestorCache.set(source, immutable);
    return immutable;
  }

  #clip(
    node: FormattingNode,
    paddingRect: CssRect,
    borderRect: CssRect,
    inherited: CssRect,
  ): CssRect {
    const style = this.#boxComputed(node);
    if (style === null) return inherited;
    let result = inherited;
    if (
      style.box.overflowX !== "visible" ||
      style.box.overflowY !== "visible"
    ) {
      const xRect =
        style.box.overflowX === "visible"
          ? cssRect(
              inherited.x,
              paddingRect.y,
              inherited.width,
              paddingRect.height,
            )
          : paddingRect;
      const yRect =
        style.box.overflowY === "visible"
          ? cssRect(
              paddingRect.x,
              inherited.y,
              paddingRect.width,
              inherited.height,
            )
          : paddingRect;
      result = cssIntersection(
        result,
        cssRect(xRect.x, yRect.y, xRect.width, yRect.height),
      );
    }
    if (
      (style.box.position === "absolute" || style.box.position === "fixed") &&
      style.box.legacyClip.kind === "rect"
    ) {
      const top =
        this.#usedLength(
          style.box.legacyClip.edges.top,
          borderRect.height,
          style,
        ) ?? ZERO;
      const right =
        this.#usedLength(
          style.box.legacyClip.edges.right,
          borderRect.width,
          style,
        ) ?? borderRect.width;
      const bottom =
        this.#usedLength(
          style.box.legacyClip.edges.bottom,
          borderRect.height,
          style,
        ) ?? borderRect.height;
      const left =
        this.#usedLength(
          style.box.legacyClip.edges.left,
          borderRect.width,
          style,
        ) ?? ZERO;
      result = cssIntersection(
        result,
        cssRect(
          point(borderRect.x, left),
          point(borderRect.y, top),
          nonNegative(cssAdd(right, negate(left))),
          nonNegative(cssAdd(bottom, negate(top))),
        ),
      );
    }
    if (style.box.clipPath.kind === "inset") {
      const top =
        this.#usedLength(
          style.box.clipPath.offsets.top,
          borderRect.height,
          style,
        ) ?? ZERO;
      const right =
        this.#usedLength(
          style.box.clipPath.offsets.right,
          borderRect.width,
          style,
        ) ?? ZERO;
      const bottom =
        this.#usedLength(
          style.box.clipPath.offsets.bottom,
          borderRect.height,
          style,
        ) ?? ZERO;
      const left =
        this.#usedLength(
          style.box.clipPath.offsets.left,
          borderRect.width,
          style,
        ) ?? ZERO;
      result = cssIntersection(
        result,
        cssRect(
          point(borderRect.x, left),
          point(borderRect.y, top),
          nonNegative(sum(borderRect.width, negate(left), negate(right))),
          nonNegative(sum(borderRect.height, negate(top), negate(bottom))),
        ),
      );
    }
    return result;
  }

  #visuallyClipped(
    node: FormattingNode,
    containingWidth: CssPixelLength,
  ): boolean {
    const style = this.#boxComputed(node);
    if (
      style === null ||
      (style.box.position !== "absolute" && style.box.position !== "fixed")
    )
      return false;
    if (style.box.overflowX === "visible" && style.box.overflowY === "visible")
      return false;
    const width = this.#usedLength(style.box.width, containingWidth, style);
    const height = this.#usedLength(
      style.box.height,
      this.#input.context.viewport.height,
      style,
    );
    if (
      width === null ||
      height === null ||
      width > cssPx(1) ||
      height > cssPx(1)
    )
      return false;
    if (style.box.legacyClip.kind === "rect") {
      const top = this.#usedLength(
        style.box.legacyClip.edges.top,
        height,
        style,
      );
      const right = this.#usedLength(
        style.box.legacyClip.edges.right,
        width,
        style,
      );
      const bottom = this.#usedLength(
        style.box.legacyClip.edges.bottom,
        height,
        style,
      );
      const left = this.#usedLength(
        style.box.legacyClip.edges.left,
        width,
        style,
      );
      if (
        top !== null &&
        right !== null &&
        bottom !== null &&
        left !== null &&
        (bottom <= top || right <= left)
      )
        return true;
    }
    if (style.box.clipPath.kind === "inset") {
      const top =
        this.#usedLength(style.box.clipPath.offsets.top, height, style) ?? ZERO;
      const right =
        this.#usedLength(style.box.clipPath.offsets.right, width, style) ??
        ZERO;
      const bottom =
        this.#usedLength(style.box.clipPath.offsets.bottom, height, style) ??
        ZERO;
      const left =
        this.#usedLength(style.box.clipPath.offsets.left, width, style) ?? ZERO;
      if (sum(top, bottom) >= height || sum(left, right) >= width) return true;
    }
    return false;
  }

  #lineHeight(
    style: ComputedStyle | null,
    metrics: UsedFontMetrics,
  ): CssPixelLength {
    const value = style?.text.lineHeight;
    if (value === undefined || value.kind === "normal") {
      return sum(metrics.ascent, metrics.descent, metrics.lineGap);
    }
    if (value.kind === "number")
      return cssMultiply(metrics.fontSize, value.value);
    return nonNegative(
      this.#usedLength(value.value, metrics.fontSize, style) ?? ZERO,
    );
  }

  #parentMetrics(node: FormattingNode): UsedFontMetrics {
    const parent = this.#formatting.parent(node.id);
    return parent === null
      ? this.#rootFontMetrics
      : this.#metrics(this.#computed(parent));
  }

  #verticalShift(
    node: FormattingNode,
    align: ComputedStyle["text"]["verticalAlign"],
    metrics: UsedFontMetrics,
  ): CssPixelLength {
    const style = this.#computed(node);
    if (align.kind === "keyword" && align.value === "baseline") return ZERO;
    if (align.kind === "length")
      return (
        this.#usedLength(
          align.value,
          this.#lineHeight(style, metrics),
          style,
        ) ?? ZERO
      );
    if (align.value === "super") return cssMultiply(metrics.fontSize, 0.33);
    if (align.value === "sub") return cssMultiply(metrics.fontSize, -0.2);
    if (align.value === "middle") {
      return sum(
        cssDivide(this.#parentMetrics(node).xHeight, 2),
        cssDivide(this.#lineHeight(style, metrics), 2),
        negate(metrics.ascent),
      );
    }
    return ZERO;
  }

  #inlineExtents(
    metrics: UsedFontMetrics,
    lineHeight: CssPixelLength,
  ): {
    readonly ascent: CssPixelLength;
    readonly descent: CssPixelLength;
  } {
    const leading = nonNegative(
      sum(lineHeight, negate(metrics.ascent), negate(metrics.descent)),
    );
    const before = cssDivide(leading, 2);
    return {
      ascent: cssAdd(metrics.ascent, before),
      descent: cssAdd(metrics.descent, sum(leading, negate(before))),
    };
  }

  #ensureLineCapacity(cursor: InlineFormattingCursor): void {
    if (cursor.entries.length > 0 || cursor.lineReserved) return;
    if (
      this.#lineBoxes.length + this.#reservedLineBoxes >=
      this.#budgets.maxLineBoxes
    ) {
      this.#truncated ??= "maxLineBoxes";
      throw new LayoutBudgetExhausted();
    }
    this.#reservedLineBoxes += 1;
    cursor.lineReserved = true;
  }

  #ensureLineFragmentCapacity(cursor: InlineFormattingCursor): void {
    if (
      this.#lineFragments + cursor.entries.length >=
      this.#budgets.maxLineFragments
    ) {
      this.#truncated ??= "maxLineFragments";
      throw new LayoutBudgetExhausted();
    }
  }

  #releaseLineReservation(cursor: InlineFormattingCursor): void {
    if (!cursor.lineReserved) return;
    cursor.lineReserved = false;
    this.#reservedLineBoxes -= 1;
  }

  #translateInlineSubtree(
    root: LayoutFragmentId,
    inlineOffset: CssPixelLength,
    blockOffset: CssPixelLength,
    containingClip: CssRect,
    rootY: CssCoordinate,
    rootTextHeight: CssPixelLength,
    rootBaseline: CssPixelLength,
  ): void {
    const pending = [root];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      for (const child of fragment.children) pending.push(child);
      const move = (rect: CssRect): CssRect =>
        cssRect(
          point(rect.x, inlineOffset),
          point(rect.y, blockOffset),
          rect.width,
          rect.height,
        );
      const movedContent =
        id === root && fragment.kind === "text"
          ? cssRect(
              point(fragment.contentRect.x, inlineOffset),
              rootY,
              fragment.contentRect.width,
              rootTextHeight,
            )
          : move(fragment.contentRect);
      const lineBoxes = fragment.lineBoxes.map((line) => {
        const moved = Object.freeze({
          ...line,
          rect: move(line.rect),
          baseline: cssAdd(line.baseline, blockOffset),
        });
        const position = this.#lineBoxPositions.get(line.id);
        if (position !== undefined) this.#lineBoxes[position] = moved;
        return moved;
      });
      const movedOverflow =
        id === root && fragment.kind === "text"
          ? movedContent
          : move(fragment.overflowRect);
      this.#fragments.set(id, {
        ...fragment,
        contentRect: movedContent,
        paddingRect:
          id === root && fragment.kind === "text"
            ? movedContent
            : move(fragment.paddingRect),
        borderRect:
          id === root && fragment.kind === "text"
            ? movedContent
            : move(fragment.borderRect),
        marginRect:
          id === root && fragment.kind === "text"
            ? movedContent
            : move(fragment.marginRect),
        overflowRect: movedOverflow,
        clipRect: cssIntersection(move(fragment.clipRect), containingClip),
        lineBoxes: Object.freeze(lineBoxes),
        ...(id === root ? { baseline: rootBaseline } : {}),
      });
    }
  }

  #finalizeLine(
    cursor: InlineFormattingCursor,
    force = false,
    breakCause: LineBox["breakCause"] = force ? "forced" : "wrap",
  ): void {
    if (cursor.entries.length === 0 && !force) return;
    if (cursor.entries.length === 0) this.#ensureLineCapacity(cursor);
    this.#releaseLineReservation(cursor);
    if (this.#lineBoxes.length >= this.#budgets.maxLineBoxes) {
      this.#truncated ??= "maxLineBoxes";
      throw new LayoutBudgetExhausted();
    }
    const logicalEntries = [...cursor.entries];
    const paragraphIndex = logicalEntries[0]?.bidiParagraph ?? 0;
    let logicalItemStart = logicalEntries[0]?.bidiItemStart ?? 0;
    let logicalItemEnd = logicalEntries[0]?.bidiItemEnd ?? logicalItemStart;
    for (const entry of logicalEntries) {
      logicalItemStart = Math.min(logicalItemStart, entry.bidiItemStart);
      logicalItemEnd = Math.max(logicalItemEnd, entry.bidiItemEnd);
    }
    const paragraph =
      cursor.textAnalysis.bidi.paragraphs[paragraphIndex]?.paragraph;
    while (
      paragraph !== undefined &&
      logicalItemStart > 0 &&
      paragraph.items[logicalItemStart - 1]?.identity.kind ===
        "structural-control"
    ) {
      logicalItemStart -= 1;
    }
    while (
      paragraph !== undefined &&
      logicalItemEnd < paragraph.items.length &&
      paragraph.items[logicalItemEnd]?.identity.kind === "structural-control"
    ) {
      logicalItemEnd += 1;
    }
    const remainingVisualRuns = Math.max(
      0,
      this.#budgets.maxVisualRuns - this.#visualRuns,
    );
    this.#input.signal?.throwIfAborted();
    const bidiOrder =
      paragraph === undefined
        ? Object.freeze({
            itemIndices: Object.freeze([]),
            runs: Object.freeze([]),
          })
        : logicalItemStart === 0 && logicalItemEnd === paragraph.items.length
          ? paragraph.visualOrder
        : bidiVisualOrderForLine(
            paragraph,
            logicalItemStart,
            logicalItemEnd,
            Math.min(Number.MAX_SAFE_INTEGER, remainingVisualRuns + 1),
            this.#input.signal,
          );
    if (bidiOrder.runs.length > remainingVisualRuns) {
      this.#truncated ??= "maxVisualRuns";
      throw new LayoutBudgetExhausted();
    }
    let entries = logicalEntries;
    if (logicalEntries.length > 1) {
      const visualRank = new Int32Array(
        Math.max(0, logicalItemEnd - logicalItemStart),
      ).fill(-1);
      for (const [rank, item] of bidiOrder.itemIndices.entries()) {
        const local = item - logicalItemStart;
        if (local >= 0 && local < visualRank.length) visualRank[local] = rank;
      }
      const entryRank = (entry: InlineLineEntry): number => {
        let rank = Number.POSITIVE_INFINITY;
        for (
          let item = entry.bidiItemStart;
          item < entry.bidiItemEnd;
          item += 1
        ) {
          const candidate = visualRank[item - logicalItemStart] ?? -1;
          if (candidate >= 0) rank = Math.min(rank, candidate);
        }
        return rank;
      };
      entries = [...logicalEntries].sort(
        (left, right) => entryRank(left) - entryRank(right),
      );
    }
    const strut = this.#inlineExtents(
      cursor.strutMetrics,
      cursor.strutLineHeight,
    );
    let ascent = strut.ascent;
    let descent = strut.descent;
    let specified: CssPixelLength = ZERO;
    let contentRight = cursor.lineStartX;
    for (const entry of entries) {
      ascent = cssMax(ascent, sum(entry.ascent, entry.baselineShift));
      descent = cssMax(
        descent,
        sum(entry.descent, negate(entry.baselineShift)),
      );
      specified = cssMax(specified, entry.lineHeight);
      const fragment = this.#fragments.get(entry.fragment);
      if (fragment !== undefined) {
        contentRight = cssCoordinateFromFixed(
          Math.max(
            contentRight,
            cssCoordinateAdd(fragment.borderRect.x, fragment.borderRect.width),
          ),
        );
      }
    }
    const height = cssMax(
      sum(ascent, descent),
      specified,
      cursor.strutLineHeight,
    );
    const baseline = cssAdd(cssLengthFromFixed(cursor.y), ascent);
    const usedWidth = nonNegative(
      cssCoordinateDifference(contentRight, cursor.lineStartX),
    );
    const freeInlineSize = nonNegative(
      sum(
        cssCoordinateDifference(cursor.maxX, cursor.lineStartX),
        negate(usedWidth),
      ),
    );
    const lineDirection =
      paragraph === undefined
        ? cursor.direction
        : (paragraph.baseLevel & 1) === 0
          ? "ltr"
          : "rtl";
    const physicalAlign =
      cursor.textAlign === "start"
        ? lineDirection === "rtl"
          ? "right"
          : "left"
        : cursor.textAlign === "end"
          ? lineDirection === "rtl"
            ? "left"
            : "right"
          : cursor.textAlign;
    const inlineOffset =
      physicalAlign === "center"
        ? cssDivide(freeInlineSize, 2)
        : physicalAlign === "right"
          ? freeInlineSize
          : ZERO;
    const usedIds: LayoutFragmentId[] = [];
    let visualX = cursor.lineStartX;
    for (const entry of entries) {
      const fragment = this.#fragments.get(entry.fragment);
      if (fragment === undefined) continue;
      const align = entry.verticalAlign;
      let y = point(
        cssCoordinate(baseline),
        sum(negate(entry.ascent), negate(entry.baselineShift)),
      );
      if (align.kind === "keyword" && align.value === "top") y = cursor.y;
      if (align.kind === "keyword" && align.value === "bottom") {
        y = point(cursor.y, sum(height, negate(entry.lineHeight)));
      }
      if (align.kind === "keyword" && align.value === "text-top") {
        const formattingNode = this.#formatting.node(fragment.formattingNode);
        y = point(
          cssCoordinate(baseline),
          negate(this.#parentMetrics(formattingNode).ascent),
        );
      }
      if (align.kind === "keyword" && align.value === "text-bottom") {
        const formattingNode = this.#formatting.node(fragment.formattingNode);
        y = point(
          cssCoordinate(baseline),
          sum(
            this.#parentMetrics(formattingNode).descent,
            negate(entry.lineHeight),
          ),
        );
      }
      const referenceY =
        fragment.kind === "text"
          ? fragment.contentRect.y
          : fragment.marginRect.y;
      const deltaY = cssCoordinateDifference(y, referenceY);
      const horizontalReference =
        fragment.kind === "text"
          ? fragment.contentRect.x
          : fragment.marginRect.x;
      const entryWidth =
        fragment.kind === "text"
          ? fragment.contentRect.width
          : fragment.marginRect.width;
      const visualOffset = cssCoordinateDifference(
        visualX,
        horizontalReference,
      );
      this.#translateInlineSubtree(
        fragment.id,
        sum(inlineOffset, visualOffset),
        deltaY,
        cursor.clipRect,
        y,
        entry.lineHeight,
        cssCoordinateDifference(cssCoordinate(baseline), y),
      );
      visualX = point(visualX, entryWidth);
      usedIds.push(fragment.id);
    }
    const fragmentsForRun = (
      logicalStart: number,
      logicalEnd: number,
    ): readonly LayoutFragmentId[] => {
      let low = 0;
      let high = logicalEntries.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if ((logicalEntries[middle]?.bidiItemEnd ?? 0) <= logicalStart)
          low = middle + 1;
        else high = middle;
      }
      const fragments: LayoutFragmentId[] = [];
      for (let index = low; index < logicalEntries.length; index += 1) {
        const entry = logicalEntries[index];
        if (entry === undefined || entry.bidiItemStart >= logicalEnd) break;
        if (entry.bidiItemEnd > logicalStart) fragments.push(entry.fragment);
      }
      return Object.freeze(fragments);
    };
    const fragmentIds: LayoutFragmentId[] = [];
    const textFragmentIds: LayoutFragmentId[] = [];
    const lineFragments: LayoutFragment[] = [];
    const sourceRanges: DocumentSourceRange[] = [];
    const actions = new Set<DocumentActionIdentity>();
    for (const entry of logicalEntries) {
      fragmentIds.push(entry.fragment);
      const fragment = this.#fragments.get(entry.fragment);
      if (fragment === undefined) continue;
      lineFragments.push(fragment);
      if (fragment.kind === "text") textFragmentIds.push(fragment.id);
      if (fragment.sourceRange !== null) sourceRanges.push(fragment.sourceRange);
      if (fragment.action !== null) actions.add(fragment.action);
    }
    const lineSemantics = new Map<
      DocumentNodeRef,
      NonNullable<LayoutFragment["semantic"]>
    >();
    for (const fragment of lineFragments) {
      if (fragment.semantic !== null)
        lineSemantics.set(fragment.semantic.node, fragment.semantic);
      if (fragment.documentNode === null) continue;
      for (const semantic of this.#documentSemanticAncestors(
        fragment.documentNode,
      )) {
        lineSemantics.set(semantic.node, semantic);
      }
    }
    const line = Object.freeze({
      id: lineBoxId(
        `line-box:${cursor.containingFragment}:${String(this.#lineBoxes.length + 1)}`,
      ),
      containingFragment: cursor.containingFragment,
      rect: cssRect(
        cursor.continuationX,
        cursor.y,
        nonNegative(cssCoordinateDifference(cursor.maxX, cursor.continuationX)),
        height,
      ),
      baseline,
      ascent,
      descent,
      usedInlineAdvance: usedWidth,
      fragments: Object.freeze(fragmentIds),
      textFragments: Object.freeze(textFragmentIds),
      visualOrder: Object.freeze(usedIds),
      logicalItemStart,
      logicalItemEnd,
      embeddingLevels: Object.freeze(
        paragraph?.embeddingLevels.slice(logicalItemStart, logicalItemEnd) ??
          [],
      ),
      sourceRanges: Object.freeze(sourceRanges),
      actions: Object.freeze([...actions]),
      semantics: Object.freeze([...lineSemantics.values()]),
      breakCause,
      visualRuns: Object.freeze(
        bidiOrder.runs.map((run) =>
          Object.freeze({
            embeddingLevel: run.level,
            direction: run.direction,
            logicalItemStart: run.logicalStart,
            logicalItemEnd: run.logicalEnd,
            fragments: fragmentsForRun(run.logicalStart, run.logicalEnd),
          }),
        ),
      ),
    });
    this.#lineBoxPositions.set(line.id, this.#lineBoxes.length);
    this.#lineBoxes.push(line);
    this.#lineFragments += logicalEntries.length;
    this.#visualRuns += bidiOrder.runs.length;
    cursor.lineBoxes.push(line);
    cursor.entries.length = 0;
    cursor.y = point(cursor.y, height);
    const nextRange = cursor.lineRange?.(cursor.y, cursor.strutLineHeight);
    if (nextRange !== undefined) {
      cursor.continuationX = nextRange.start;
      cursor.continuationMaxX = nextRange.end;
    }
    cursor.x = cursor.continuationX;
    cursor.lineStartX = cursor.continuationX;
    cursor.maxX = cursor.continuationMaxX;
    cursor.collapsedSpace = false;
  }

  #textFragment(
    node: FormattingNode,
    cursor: InlineFormattingCursor,
    unit: InlineLogicalUnit,
    clip: CssRect,
    logicalUnitEnd = unit.logicalIndex + 1,
  ): LayoutTextFragment | null {
    const style = this.#computed(node);
    if (style === null) return null;
    const metrics = this.#metrics(style);
    const text = unit.kind === "soft-hyphen" ? "-" : unit.text;
    if (text.length === 0) return null;
    this.#ensureLineCapacity(cursor);
    this.#ensureLineFragmentCapacity(cursor);
    const usedLineHeight = this.#lineHeight(style, metrics);
    const visible = style.visibility === "visible";
    const globalStart = unit.bidiItemStart;
    const globalEnd = unit.bidiItemEnd;
    const position =
      globalStart < 0 ? undefined : cursor.textAnalysis.positions[globalStart];
    const paragraphSlice =
      position === undefined
        ? undefined
        : cursor.textAnalysis.bidi.paragraphs[position.paragraph];
    const bidiItemStart = position?.item ?? 0;
    const bidiItemEnd =
      globalEnd >= globalStart && position !== undefined
        ? bidiItemStart + globalEnd - globalStart
        : bidiItemStart;
    const embeddingLevel =
      paragraphSlice?.paragraph.embeddingLevels[bidiItemStart] ?? 0;
    let advance: CssPixelLength = ZERO;
    for (let index = unit.logicalIndex; index < logicalUnitEnd; index += 1) {
      const candidate = cursor.textAnalysis.logicalUnits[index];
      if (candidate === undefined || candidate.bidiItemStart >= globalEnd)
        break;
      if (
        (candidate.kind === "text" ||
          candidate.kind === "tab" ||
          candidate.kind === "soft-hyphen") &&
        candidate.bidiItemStart >= globalStart &&
        candidate.bidiItemEnd <= globalEnd
      ) {
        const candidateText =
          candidate.kind === "soft-hyphen"
            ? "-"
            : candidate.kind === "tab"
              ? " "
              : candidate.text;
        advance = cssAdd(
          advance,
          cursor.usedUnitAdvances.get(candidate.logicalIndex) ??
            this.#measure(candidateText, metrics.fontSize),
        );
      }
    }
    const box = cssRect(cursor.x, cursor.y, advance, usedLineHeight);
    // Text fragments are grouped only across adjacent units with one resolved
    // embedding level. UAX #9 L2 therefore reverses their grapheme-unit order
    // exactly when that level is odd; line-wide run reordering remains owned by
    // #finalizeLine().
    const visualClusters: LayoutTextCluster[] = [];
    let visualText = "";
    const reverse = (embeddingLevel & 1) !== 0;
    const unitCount = logicalUnitEnd - unit.logicalIndex;
    for (let offset = 0; offset < unitCount; offset += 1) {
      const logicalIndex = reverse
        ? logicalUnitEnd - 1 - offset
        : unit.logicalIndex + offset;
      const candidate = cursor.textAnalysis.logicalUnits[logicalIndex];
      if (
        candidate === undefined ||
        candidate.bidiItemStart < globalStart ||
        candidate.bidiItemEnd > globalEnd ||
        (candidate.kind !== "text" &&
          candidate.kind !== "tab" &&
          candidate.kind !== "soft-hyphen")
      )
        continue;
      let clusterText =
        candidate.kind === "soft-hyphen"
          ? "-"
          : candidate.kind === "tab"
            ? " "
            : candidate.text;
      if (
        paragraphSlice !== undefined &&
        candidate.kind !== "soft-hyphen" &&
        candidate.kind !== "tab"
      ) {
        clusterText = "";
        const localStart = candidate.bidiItemStart - paragraphSlice.itemStart;
        const localEnd = candidate.bidiItemEnd - paragraphSlice.itemStart;
        for (let item = localStart; item < localEnd; item += 1) {
          clusterText += mirroredBidiText(paragraphSlice.paragraph, item);
        }
      }
      const visualStartCodeUnit = visualText.length;
      visualText += clusterText;
      const clusterSourceRange =
        node.kind !== "text-sequence" ||
        node.source === null ||
        node.sourceRange === null
          ? node.sourceRange
          : this.#formatting.document.textSourceRange(
              node.source,
              candidate.contentStartCodeUnit,
              candidate.contentEndCodeUnit,
            );
      visualClusters.push(
        Object.freeze({
          text: clusterText,
          visualStartCodeUnit,
          visualEndCodeUnit: visualText.length,
          contentStartCodeUnit: candidate.contentStartCodeUnit,
          contentEndCodeUnit: candidate.contentEndCodeUnit,
          sourceRange: clusterSourceRange,
          advance:
            cursor.usedUnitAdvances.get(candidate.logicalIndex) ??
            this.#measure(clusterText, metrics.fontSize),
        }),
      );
    }
    if (visualText.length === 0) visualText = text;
    const sourceRange =
      visualClusters.length === 1
        ? (visualClusters[0]?.sourceRange ?? null)
        : node.kind !== "text-sequence" ||
            node.source === null ||
            node.sourceRange === null
          ? node.sourceRange
          : this.#formatting.document.textSourceRange(
              node.source,
              unit.contentStartCodeUnit,
              unit.contentEndCodeUnit,
            );
    const fragment = this.#store<LayoutTextFragment>({
      id: this.#newId(
        node.id,
        `text:${String(unit.contentStartCodeUnit)}:${String(unit.logicalIndex)}`,
      ),
      kind: "text",
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange,
      contentStartCodeUnit: unit.contentStartCodeUnit,
      contentEndCodeUnit: unit.contentEndCodeUnit,
      text: visible ? text : "",
      visualText: visible ? visualText : "",
      visualClusters: visible
        ? Object.freeze(visualClusters)
        : Object.freeze([]),
      bidiParagraph: position?.paragraph ?? 0,
      embeddingLevel,
      contentRect: box,
      paddingRect: box,
      borderRect: box,
      marginRect: box,
      overflowRect: box,
      clipRect: clip,
      children: Object.freeze([]),
      lineBoxes: Object.freeze([]),
      usedFontMetrics: metrics,
      baseline: metrics.baseline,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic:
        visible && node.semantic?.accessibilityHidden !== true
          ? node.semantic
          : null,
      style: this.#paintStyle(node),
      minContentContribution: advance,
      maxContentContribution: advance,
    });
    const verticalAlign =
      this.#formatting.parent(node.id)?.id === cursor.containingFormattingNode
        ? ({ kind: "keyword", value: "baseline" } as const)
        : style.text.verticalAlign;
    const extents = this.#inlineExtents(metrics, usedLineHeight);
    cursor.entries.push({
      fragment: fragment.id,
      metrics,
      lineHeight: usedLineHeight,
      verticalAlign,
      ascent: extents.ascent,
      descent: extents.descent,
      baselineShift: this.#verticalShift(node, verticalAlign, metrics),
      bidiParagraph: position?.paragraph ?? 0,
      bidiItemStart,
      bidiItemEnd,
    });
    cursor.x = point(cursor.x, advance);
    return fragment;
  }

  #breakBeforeUnit(
    cursor: InlineFormattingCursor,
    unit: InlineLogicalUnit,
  ): BreakOpportunityKind {
    return cursor.textAnalysis.breaksBefore[unit.logicalIndex] ?? "prohibited";
  }

  #logicalUnitAdvance(
    cursor: InlineFormattingCursor,
    unit: InlineLogicalUnit,
  ): CssPixelLength {
    const node = this.#formatting.node(unit.formattingNode);
    if (unit.kind === "text")
      return this.#measure(unit.text, this.#fontSize(this.#computed(node)));
    if (unit.kind === "soft-hyphen") return ZERO;
    if (unit.kind === "tab") return ZERO;
    if (unit.kind === "atomic-inline") {
      return this.#atomicInlineAdvance(
        node,
        nonNegative(cssCoordinateDifference(cursor.maxX, cursor.continuationX)),
      );
    }
    return ZERO;
  }

  #logicalUnitForBidiItem(
    cursor: InlineFormattingCursor,
    item: number,
  ): InlineLogicalUnit | undefined {
    return cursor.textAnalysis.unitsByBidiItem[item];
  }

  #selectInlineLineBreaks(cursor: InlineFormattingCursor): void {
    const selection = selectLogicalLines(
      cursor.textAnalysis.logicalUnits.map((unit) => {
        const node = this.#formatting.node(unit.formattingNode);
        const wrappingAllowed =
          node.kind !== "text-sequence" &&
          node.kind !== "generated-text" &&
          node.kind !== "marker"
            ? true
            : node.whiteSpace !== "nowrap" && node.whiteSpace !== "pre";
        return Object.freeze({
          logicalIndex: unit.logicalIndex,
          advance: this.#logicalUnitAdvance(cursor, unit),
          tabInterval:
            unit.kind === "tab"
              ? cssMultiply(
                  this.#metrics(this.#computed(node)).chAdvance,
                  this.#computed(node)?.text.tabSize ?? 8,
                )
              : null,
          breakBefore: this.#breakBeforeUnit(cursor, unit),
          forcedBreak: unit.kind === "forced-break",
          collapsibleSpace: unit.collapsibleSpace,
          wrappingAllowed,
        });
      }),
      nonNegative(cssCoordinateDifference(cursor.maxX, cursor.lineStartX)),
      nonNegative(
        cssCoordinateDifference(cursor.continuationMaxX, cursor.continuationX),
      ),
      {
        maxSelectedLines: Math.max(
          0,
          this.#budgets.maxLineBoxes - this.#lineBoxes.length,
        ),
      },
      this.#input.signal,
    );
    if (selection.outcome.status === "rejected")
      throw new RangeError("Logical line-selection input was rejected.");
    if (selection.outcome.status === "truncated") {
      this.#truncated ??= "maxLineBoxes";
    }
    cursor.logicalUnitLimit = selection.retainedItems;
    for (const [index, advance] of selection.usedAdvances)
      cursor.usedUnitAdvances.set(index, advance);
    for (const index of selection.breaksBefore)
      cursor.selectedLineBreaks.add(index);
    for (const index of selection.suppressed) cursor.suppressedUnits.add(index);
  }

  #atomicVisualClusters(
    node: FormattingNode,
    processed: ProcessedCssText,
    baseDirection: "ltr" | "rtl" | "auto",
    directionalSegments: readonly ControlDisplayTextSegment[],
    metrics: UsedFontMetrics,
  ): readonly LayoutTextCluster[] {
    const items: BidiItem<number>[] = [];
    const ranges: {
      readonly unit: ProcessedCssText["units"][number];
      readonly start: number;
      readonly end: number;
    }[] = [];
    const graphemeClusters =
      processed.outcome.status === "complete"
        ? processed.outcome.graphemeClusters
        : 0;
    if (
      graphemeClusters >
      this.#budgets.maxGraphemeClusters - this.#graphemeClusters
    ) {
      this.#truncated ??= "maxGraphemeClusters";
      throw new LayoutBudgetExhausted();
    }
    let paragraphCodePoints = 0;
    const append = (item: BidiItem<number>): void => {
      if (items.length >= this.#budgets.maxBidiItems - this.#bidiItems) {
        this.#truncated ??= "maxBidiItems";
        throw new LayoutBudgetExhausted();
      }
      if (
        item.kind === "code-point" &&
        paragraphCodePoints >= this.#budgets.maxCodePointsPerBidiParagraph
      ) {
        this.#truncated ??= "maxCodePointsPerBidiParagraph";
        throw new LayoutBudgetExhausted();
      }
      items.push(Object.freeze(item));
      if (item.kind === "code-point") paragraphCodePoints += 1;
      if (item.bidiClass === "B") paragraphCodePoints = 0;
    };
    let activeSegment = -1;
    let segmentIndex = 0;
    const structuralControl = (
      bidiType: "LRI" | "RLI" | "PDI",
      contentOffset: number,
    ): void => {
      append({
        logicalIndex: items.length,
        kind: "structural-control",
        text: "",
        codePoint: null,
        bidiClass: bidiType,
        sourceStartCodeUnit: contentOffset,
        sourceEndCodeUnit: contentOffset,
        identity: ranges.length,
      });
    };
    for (const unit of processed.units) {
      this.#input.signal?.throwIfAborted();
      while (
        (directionalSegments[segmentIndex]?.contentEndCodeUnit ??
          Number.MAX_SAFE_INTEGER) <= unit.contentStartCodeUnit
      )
        segmentIndex += 1;
      const segment = directionalSegments[segmentIndex];
      if (
        segmentIndex !== activeSegment &&
        segment !== undefined &&
        unit.contentStartCodeUnit >= segment.contentStartCodeUnit &&
        unit.contentStartCodeUnit < segment.contentEndCodeUnit
      ) {
        if (activeSegment >= 0)
          structuralControl("PDI", unit.contentStartCodeUnit);
        structuralControl(
          segment.direction === "rtl" ? "RLI" : "LRI",
          unit.contentStartCodeUnit,
        );
        activeSegment = segmentIndex;
      }
      const start = items.length;
      if (unit.kind === "forced-break") {
        append({
          logicalIndex: items.length,
          kind: "structural-control",
          text: "",
          codePoint: null,
          bidiClass: "B",
          sourceStartCodeUnit: unit.contentStartCodeUnit,
          sourceEndCodeUnit: unit.contentEndCodeUnit,
          identity: ranges.length,
        });
      } else {
        for (const character of unit.text) {
          const codePoint = character.codePointAt(0);
          if (codePoint === undefined) continue;
          append({
            logicalIndex: items.length,
            kind: "code-point",
            text: character,
            codePoint,
            bidiClass: bidiClass(codePoint),
            sourceStartCodeUnit: unit.contentStartCodeUnit,
            sourceEndCodeUnit: unit.contentEndCodeUnit,
            identity: ranges.length,
          });
        }
      }
      ranges.push(Object.freeze({ unit, start, end: items.length }));
    }
    if (activeSegment >= 0)
      structuralControl("PDI", processed.transformed.value.length);
    const paragraphs = resolveBidiParagraphs(
      items,
      baseDirection,
      {
        maxCodePointsPerParagraph: this.#budgets.maxCodePointsPerBidiParagraph,
        maxBidiItems: this.#budgets.maxBidiItems,
        maxEmbeddingDepth: this.#budgets.maxBidiEmbeddingDepth,
        maxBidiRuns: Math.max(0, this.#budgets.maxBidiRuns - this.#bidiRuns),
      },
      this.#input.signal,
    );
    const clusters: LayoutTextCluster[] = [];
    let visualCodeUnitOffset = 0;
    let visualAdvance: CssPixelLength = ZERO;
    let bidiRuns = 0;
    let visualRuns = 0;
    for (const slice of paragraphs.paragraphs) {
      if (slice.paragraph.outcome.status === "rejected")
        throw new RangeError("Atomic inline bidi input was rejected.");
      if (slice.paragraph.outcome.status === "truncated") {
        this.#truncated ??=
          slice.paragraph.outcome.budget === "maxCodePointsPerParagraph"
            ? "maxCodePointsPerBidiParagraph"
            : slice.paragraph.outcome.budget === "maxEmbeddingDepth"
              ? "maxBidiEmbeddingDepth"
              : slice.paragraph.outcome.budget;
        throw new LayoutBudgetExhausted();
      }
      bidiRuns += slice.paragraph.outcome.runs;
      const remainingVisualRuns = Math.max(
        0,
        this.#budgets.maxVisualRuns - this.#visualRuns - visualRuns,
      );
      const order = bidiVisualOrderForLine(
        slice.paragraph,
        0,
        slice.paragraph.items.length,
        Math.min(Number.MAX_SAFE_INTEGER, remainingVisualRuns + 1),
        this.#input.signal,
      );
      if (order.runs.length > remainingVisualRuns) {
        this.#truncated ??= "maxVisualRuns";
        throw new LayoutBudgetExhausted();
      }
      visualRuns += order.runs.length;
      const rank = new Map<number, number>();
      for (const [visualIndex, item] of order.itemIndices.entries())
        rank.set(item, visualIndex);
      const paragraphRanges = ranges.filter(
        (range) =>
          range.start >= slice.itemStart &&
          range.end <= slice.itemEnd &&
          range.unit.kind === "text",
      );
      paragraphRanges.sort(
        (left, right) =>
          (rank.get(left.start - slice.itemStart) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.start - slice.itemStart) ?? Number.MAX_SAFE_INTEGER),
      );
      for (const range of paragraphRanges) {
        let text = "";
        for (
          let item = range.start - slice.itemStart;
          item < range.end - slice.itemStart;
          item += 1
        ) {
          text += mirroredBidiText(slice.paragraph, item);
        }
        const clusterText = range.unit.kind === "tab" ? " " : text;
        const tabInterval = cssMultiply(
          metrics.chAdvance,
          this.#computed(node)?.text.tabSize ?? 8,
        );
        const remainder = tabInterval === 0 ? 0 : visualAdvance % tabInterval;
        const advance =
          range.unit.kind === "tab"
            ? tabInterval === 0
              ? ZERO
              : ((remainder === 0
                  ? tabInterval
                  : tabInterval - remainder) as CssPixelLength)
            : this.#measure(range.unit.text, metrics.fontSize);
        clusters.push(
          Object.freeze({
            text: clusterText,
            visualStartCodeUnit: visualCodeUnitOffset,
            visualEndCodeUnit: visualCodeUnitOffset + clusterText.length,
            contentStartCodeUnit: range.unit.contentStartCodeUnit,
            contentEndCodeUnit: range.unit.contentEndCodeUnit,
            sourceRange: node.sourceRange,
            advance,
          }),
        );
        visualCodeUnitOffset += clusterText.length;
        visualAdvance = cssAdd(visualAdvance, advance);
      }
    }
    this.#bidiItems += items.length;
    this.#bidiRuns += bidiRuns;
    this.#graphemeClusters += graphemeClusters;
    this.#visualRuns += visualRuns;
    return Object.freeze(clusters);
  }

  #placeText(
    node: FormattingTextNode,
    cursor: InlineFormattingCursor,
    clip: CssRect,
  ): LayoutResult {
    const children: LayoutFragmentId[] = [];
    const analyzed = cursor.textAnalysis.textNodes.get(node.id);
    const units = analyzed?.units ?? [];
    for (let index = 0; index < units.length;) {
      this.#input.signal?.throwIfAborted();
      const unit = units[index];
      if (unit === undefined) break;
      if (unit.logicalIndex >= cursor.logicalUnitLimit) {
        cursor.lineSelectionStopped = true;
        break;
      }
      if (unit.kind === "forced-break") {
        this.#finalizeLine(cursor, true, "forced");
        index += 1;
        continue;
      }
      if (unit.kind === "soft-hyphen") {
        const following =
          cursor.textAnalysis.logicalUnits[unit.logicalIndex + 1];
        if (
          following !== undefined &&
          cursor.selectedLineBreaks.has(following.logicalIndex) &&
          this.#computed(node)?.text.hyphens === "manual"
        ) {
          const placed = this.#textFragment(node, cursor, unit, clip);
          if (placed !== null) children.push(placed.id);
        }
        index += 1;
        continue;
      }
      if (
        cursor.selectedLineBreaks.has(unit.logicalIndex) &&
        cursor.entries.length > 0
      ) {
        this.#finalizeLine(cursor, false, "wrap");
      }
      if (cursor.suppressedUnits.has(unit.logicalIndex)) {
        index += 1;
        continue;
      }
      const firstPosition = cursor.textAnalysis.positions[unit.bidiItemStart];
      const firstParagraph =
        firstPosition === undefined
          ? undefined
          : cursor.textAnalysis.bidi.paragraphs[firstPosition.paragraph]
              ?.paragraph;
      const firstLevel =
        firstPosition === undefined
          ? null
          : (firstParagraph?.embeddingLevels[firstPosition.item] ?? null);
      let end = index + 1;
      while (unit.kind === "text" && end < units.length) {
        const candidate = units[end];
        if (
          candidate === undefined ||
          candidate.kind !== "text" ||
          candidate.collapsibleSpace !== unit.collapsibleSpace ||
          cursor.suppressedUnits.has(candidate.logicalIndex) ||
          cursor.selectedLineBreaks.has(candidate.logicalIndex)
        )
          break;
        const position = cursor.textAnalysis.positions[candidate.bidiItemStart];
        const paragraph =
          position === undefined
            ? undefined
            : cursor.textAnalysis.bidi.paragraphs[position.paragraph]
                ?.paragraph;
        const level =
          position === undefined
            ? null
            : (paragraph?.embeddingLevels[position.item] ?? null);
        if (
          position?.paragraph !== firstPosition?.paragraph ||
          level !== firstLevel
        )
          break;
        end += 1;
      }
      const last = units[end - 1] ?? unit;
      let text = "";
      for (let cursorIndex = index; cursorIndex < end; cursorIndex += 1)
        text += units[cursorIndex]?.text ?? "";
      const grouped = Object.freeze({
        ...unit,
        text,
        contentEndCodeUnit: last.contentEndCodeUnit,
        bidiItemEnd: last.bidiItemEnd,
        lineEndCodeUnit: last.lineEndCodeUnit,
      });
      const placed = this.#textFragment(
        node,
        cursor,
        grouped,
        clip,
        last.logicalIndex + 1,
      );
      if (placed !== null) children.push(placed.id);
      cursor.collapsedSpace = unit.collapsibleSpace;
      index = end;
    }
    const fallback = cssRect(cursor.x, cursor.y, ZERO, ZERO);
    return this.#container(
      node,
      fallback,
      fallback,
      fallback,
      fallback,
      clip,
      children,
      [],
    );
  }

  #atomic(
    node: FormattingFormControlNode | FormattingReplacedNode,
    cursor: InlineFormattingCursor,
    clip: CssRect,
  ): LayoutResult {
    this.#ensureLineCapacity(cursor);
    this.#ensureLineFragmentCapacity(cursor);
    const control =
      node.kind === "form-control"
        ? controlDisplayText(node, this.#formatting)
        : null;
    const logicalText =
      node.kind === "form-control" ? (control?.text ?? "") : node.fallbackText;
    const processedText = this.#input.inlineItemStreams.textForFormattingNode(
      node.id,
    );
    if (processedText === null || processedText.outcome.status !== "complete") {
      throw new RangeError(
        "Inline item streams do not contain logical text for an atomic inline box.",
      );
    }
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const metrics = this.#metrics(style);
    const controlDirectionText =
      node.kind !== "form-control"
        ? logicalText
        : control?.value ||
          (node.control.kind === "text" || node.control.kind === "textarea"
            ? (node.control.placeholder ?? "")
            : "");
    const htmlDirection =
      node.source === null
        ? (style?.text.direction ?? "ltr")
        : this.#formatting.document.directionForRenderedText(
            node.source,
            controlDirectionText,
          );
    const baseDirection =
      style?.text.unicodeBidi === "plaintext"
        ? htmlDirection
        : (style?.text.direction ?? "ltr");
    const directionalSegments =
      style?.text.unicodeBidi === "plaintext"
        ? Object.freeze([])
        : (control?.segments ??
          (logicalText.length === 0
            ? Object.freeze([])
            : Object.freeze([
                {
                  kind: "control-value" as const,
                  text: logicalText,
                  contentStartCodeUnit: 0,
                  contentEndCodeUnit: logicalText.length,
                  direction: htmlDirection,
                },
              ])));
    const visualClusters = this.#atomicVisualClusters(
      node,
      processedText,
      baseDirection,
      directionalSegments,
      metrics,
    );
    const text = visualClusters.map((cluster) => cluster.text).join("");
    const lineHeight = this.#lineHeight(style, metrics);
    const containingWidth = nonNegative(
      cssCoordinateDifference(cursor.maxX, cursor.continuationX),
    );
    const { margin, padding, border } = this.#edges(style, containingWidth, node.id);
    const horizontalChrome = sum(
      padding.left,
      padding.right,
      border.left,
      border.right,
    );
    const verticalChrome = sum(
      padding.top,
      padding.bottom,
      border.top,
      border.bottom,
    );
    const intrinsicWidth =
      node.kind !== "form-control" && node.intrinsicWidth !== null
        ? cssPx(node.intrinsicWidth)
        : visualClusters.reduce<CssPixelLength>(
            (advance, cluster) => cssAdd(advance, cluster.advance),
            ZERO,
          );
    const specifiedWidth =
      style === null
        ? null
        : this.#usedLength(style.box.width, containingWidth, style);
    const toContentWidth = (value: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(value, negate(horizontalChrome)))
        : value;
    let contentWidth = cssMax(
      metrics.chAdvance,
      specifiedWidth === null ? intrinsicWidth : toContentWidth(specifiedWidth),
    );
    const minimum =
      style === null
        ? ZERO
        : (this.#usedLength(style.box.minWidth, containingWidth, style) ??
          ZERO);
    const maximum =
      style === null
        ? null
        : this.#usedLength(style.box.maxWidth, containingWidth, style);
    if (maximum !== null)
      contentWidth = cssMin(contentWidth, toContentWidth(maximum));
    contentWidth = cssMax(contentWidth, toContentWidth(minimum));
    const intrinsicHeight =
      node.kind !== "form-control" && node.intrinsicHeight !== null
        ? cssPx(node.intrinsicHeight)
        : lineHeight;
    const indefiniteHeight = (value: CssLength): CssPixelLength | null =>
      this.#usedLength(value, null, style);
    const toContentHeight = (value: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(value, negate(verticalChrome)))
        : nonNegative(value);
    const specifiedHeight =
      style === null ? null : indefiniteHeight(style.box.height);
    const minimumHeight =
      style === null ? ZERO : (indefiniteHeight(style.box.minHeight) ?? ZERO);
    const maximumHeight =
      style === null ? null : indefiniteHeight(style.box.maxHeight);
    const contentHeight = constrainedSize(
      intrinsicHeight,
      specifiedHeight === null ? null : toContentHeight(specifiedHeight),
      toContentHeight(minimumHeight),
      maximumHeight === null ? null : toContentHeight(maximumHeight),
    );
    const advance = sum(
      margin.left,
      border.left,
      padding.left,
      contentWidth,
      padding.right,
      border.right,
      margin.right,
    );
    const globalItem = cursor.textAnalysis.atomicItems.get(node.id) ?? -1;
    const atomicUnit = this.#logicalUnitForBidiItem(cursor, globalItem);
    if (
      atomicUnit !== undefined &&
      cursor.selectedLineBreaks.has(atomicUnit.logicalIndex) &&
      cursor.entries.length > 0
    )
      this.#finalizeLine(cursor, false, "wrap");
    const marginRect = cssRect(
      cursor.x,
      cursor.y,
      advance,
      sum(margin.top, verticalChrome, contentHeight, margin.bottom),
    );
    const borderRect = cssRect(
      point(cursor.x, margin.left),
      point(cursor.y, margin.top),
      nonNegative(sum(advance, negate(margin.left), negate(margin.right))),
      sum(verticalChrome, contentHeight),
    );
    const paddingRect = cssRect(
      point(borderRect.x, border.left),
      point(borderRect.y, border.top),
      nonNegative(
        sum(borderRect.width, negate(border.left), negate(border.right)),
      ),
      nonNegative(
        sum(borderRect.height, negate(border.top), negate(border.bottom)),
      ),
    );
    const contentRect = cssRect(
      point(paddingRect.x, padding.left),
      point(paddingRect.y, padding.top),
      nonNegative(
        sum(paddingRect.width, negate(padding.left), negate(padding.right)),
      ),
      nonNegative(
        sum(paddingRect.height, negate(padding.top), negate(padding.bottom)),
      ),
    );
    const visible = style?.visibility === "visible";
    const common = {
      id: this.#newId(node.id),
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange: node.sourceRange,
      contentStartCodeUnit: 0,
      contentEndCodeUnit: logicalText.length,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      overflowRect: borderRect,
      clipRect: this.#clip(node, paddingRect, borderRect, clip),
      children: Object.freeze([]),
      lineBoxes: Object.freeze([]),
      usedFontMetrics: metrics,
      baseline: metrics.baseline,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic:
        visible && node.semantic?.accessibilityHidden !== true
          ? node.semantic
          : null,
      style: this.#paintStyle(node),
      minContentContribution: intrinsicWidth,
      maxContentContribution: intrinsicWidth,
    } as const;
    const fragment: LayoutBoxFragment =
      node.kind === "form-control" && control !== null
        ? {
            ...common,
            kind: "control",
            controlLabel: control.label,
            controlValue: control.value,
            controlText: visible ? text : "",
            visualClusters: visible
              ? Object.freeze(visualClusters)
              : Object.freeze([]),
          }
        : {
            ...common,
            kind: "replaced",
            replacedText: visible ? text : "",
            visualClusters: visible
              ? Object.freeze(visualClusters)
              : Object.freeze([]),
          };
    this.#store(fragment, true);
    const atomicLineHeight = cssMax(lineHeight, borderRect.height);
    const bidiPosition =
      globalItem < 0 ? undefined : cursor.textAnalysis.positions[globalItem];
    const verticalAlign = style?.text.verticalAlign ?? {
      kind: "keyword",
      value: "baseline",
    };
    const extents = this.#inlineExtents(metrics, atomicLineHeight);
    cursor.entries.push({
      fragment: fragment.id,
      metrics,
      lineHeight: atomicLineHeight,
      verticalAlign,
      ascent: extents.ascent,
      descent: extents.descent,
      baselineShift: this.#verticalShift(node, verticalAlign, metrics),
      bidiParagraph: bidiPosition?.paragraph ?? 0,
      bidiItemStart: bidiPosition?.item ?? 0,
      bidiItemEnd: (bidiPosition?.item ?? 0) + 1,
    });
    cursor.x = point(cursor.x, advance);
    cursor.collapsedSpace = false;
    return { fragment: fragment.id, borderRect, marginRect };
  }

  #atomicInlineAdvance(
    node: FormattingNode,
    containingWidth: CssPixelLength,
  ): CssPixelLength {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const { margin, padding, border } = this.#edges(style, containingWidth, node.id);
    const horizontalChrome = sum(
      padding.left,
      padding.right,
      border.left,
      border.right,
    );
    const intrinsic = this.#intrinsicWidth(
      node.id,
      cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
    );
    const specified =
      style === null
        ? null
        : this.#usedLength(style.box.width, containingWidth, style);
    const toContent = (candidate: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(cssAdd(candidate, negate(horizontalChrome)))
        : nonNegative(candidate);
    const minimum =
      style === null
        ? ZERO
        : (this.#usedLength(style.box.minWidth, containingWidth, style) ??
          ZERO);
    const maximum =
      style === null
        ? null
        : this.#usedLength(style.box.maxWidth, containingWidth, style);
    let content = specified === null ? intrinsic : toContent(specified);
    if (maximum !== null) content = cssMin(content, toContent(maximum));
    content = cssMax(content, toContent(minimum));
    return nonNegative(
      sum(
        margin.left,
        border.left,
        padding.left,
        content,
        padding.right,
        border.right,
        margin.right,
      ),
    );
  }

  #atomicFormattingContext(
    node: FormattingNode,
    cursor: InlineFormattingCursor,
    clip: CssRect,
    depth: number,
  ): LayoutResult {
    this.#ensureLineCapacity(cursor);
    this.#ensureLineFragmentCapacity(cursor);
    const containingWidth = nonNegative(
      cssCoordinateDifference(cursor.maxX, cursor.continuationX),
    );
    const expectedAdvance = this.#atomicInlineAdvance(node, containingWidth);
    const globalItem = cursor.textAnalysis.atomicItems.get(node.id) ?? -1;
    const atomicUnit = this.#logicalUnitForBidiItem(cursor, globalItem);
    if (
      atomicUnit !== undefined &&
      cursor.selectedLineBreaks.has(atomicUnit.logicalIndex) &&
      cursor.entries.length > 0
    )
      this.#finalizeLine(cursor, false, "wrap");
    const firstInnerLine = this.#lineBoxes.length;
    const result = this.#layoutNode(
      node.id,
      cursor.x,
      cursor.y,
      expectedAdvance,
      clip,
      depth + 1,
    );
    const fragment = this.#fragments.get(result.fragment);
    if (fragment === undefined) return result;
    const style = this.#computed(node);
    const baseMetrics = this.#metrics(style);
    const chosenLine =
      this.#lineBoxes.length === firstInnerLine
        ? undefined
        : node.kind === "table-wrapper"
          ? this.#lineBoxes[firstInnerLine]
          : this.#lineBoxes.at(-1);
    const baseline =
      chosenLine === undefined
        ? fragment.marginRect.height
        : nonNegative(
            cssCoordinateDifference(
              cssCoordinate(chosenLine.baseline),
              fragment.marginRect.y,
            ),
          );
    const atomicMetrics: UsedFontMetrics = Object.freeze({
      ...baseMetrics,
      ascent: cssMin(fragment.marginRect.height, baseline),
      descent: nonNegative(
        cssAdd(fragment.marginRect.height, negate(baseline)),
      ),
      lineGap: ZERO,
      baseline: cssMin(fragment.marginRect.height, baseline),
    });
    this.#fragments.set(fragment.id, {
      ...fragment,
      baseline: atomicMetrics.baseline,
      usedFontMetrics: atomicMetrics,
    });
    const bidiPosition =
      globalItem < 0 ? undefined : cursor.textAnalysis.positions[globalItem];
    const verticalAlign = style?.text.verticalAlign ?? {
      kind: "keyword",
      value: "baseline",
    };
    const extents = this.#inlineExtents(
      atomicMetrics,
      fragment.marginRect.height,
    );
    cursor.entries.push({
      fragment: fragment.id,
      metrics: atomicMetrics,
      lineHeight: fragment.marginRect.height,
      verticalAlign,
      ascent: extents.ascent,
      descent: extents.descent,
      baselineShift: this.#verticalShift(node, verticalAlign, atomicMetrics),
      bidiParagraph: bidiPosition?.paragraph ?? 0,
      bidiItemStart: bidiPosition?.item ?? 0,
      bidiItemEnd: (bidiPosition?.item ?? 0) + 1,
    });
    cursor.x = point(cursor.x, fragment.marginRect.width);
    cursor.collapsedSpace = false;
    return result;
  }

  #container(
    node: FormattingNode,
    contentRect: CssRect,
    paddingRect: CssRect,
    borderRect: CssRect,
    marginRect: CssRect,
    clipRect: CssRect,
    children: readonly LayoutFragmentId[],
    lineBoxes: readonly LineBox[],
    reservedId?: LayoutFragmentId,
    inlineContinuations: readonly InlineContinuationGeometry[] = [],
  ): LayoutResult {
    const style = this.#computed(node);
    const visible = style?.visibility === "visible";
    const tableCollapsedBorderSegments =
      this.#tableCollapsedBorderSegments.get(node.id);
    const onlyChild =
      children.length === 1 && children[0] !== undefined
        ? this.#fragments.get(children[0])
        : undefined;
    const overflowRect =
      children.length === 0
        ? borderRect
        : onlyChild !== undefined
          ? unionOverflowRect(borderRect, onlyChild.overflowRect)
          : cssUnion(
              (function* (builder: LayoutBuilder): Generator<CssRect> {
                yield borderRect;
                for (const id of children) {
                  const overflow = builder.#fragments.get(id)?.overflowRect;
                  if (overflow !== undefined) yield overflow;
                }
              })(this),
              borderRect,
            );
    const minContentContribution =
      onlyChild?.minContentContribution ??
      (children.length === 0
        ? ZERO
        : children.reduce<CssPixelLength>(
            (maximum, child) =>
              cssMax(
                maximum,
                this.#fragments.get(child)?.minContentContribution ?? ZERO,
              ),
            ZERO,
          ));
    const maxContentContribution =
      onlyChild?.maxContentContribution ??
      (children.length === 0
        ? ZERO
        : children.reduce<CssPixelLength>(
            (total, child) =>
              cssAdd(
                total,
                this.#fragments.get(child)?.maxContentContribution ?? ZERO,
              ),
            ZERO,
          ));
    const firstLine = lineBoxes[0];
    const absoluteBaseline =
      firstLine === undefined
        ? onlyChild !== undefined && onlyChild.baseline !== null &&
          (onlyChild.kind === "text" ||
            onlyChild.kind === "control" ||
            onlyChild.kind === "replaced")
          ? point(onlyChild.borderRect.y, onlyChild.baseline)
          : children.length === 0
            ? null
            : this.#firstDescendantBaseline(children)
        : cssCoordinate(firstLine.baseline);
    const baseline =
      absoluteBaseline === null
        ? null
        : nonNegative(cssCoordinateDifference(absoluteBaseline, borderRect.y));
    const fragment = this.#store<LayoutBoxFragment>(
      {
        id: reservedId ?? this.#newId(node.id),
        kind: "box",
        formattingNode: node.id,
        documentNode: node.source,
        pseudoElement: node.pseudo,
        sourceRange: node.sourceRange,
        contentStartCodeUnit: null,
        contentEndCodeUnit: null,
        contentRect,
        paddingRect,
        borderRect,
        marginRect,
        overflowRect,
        clipRect: cssIntersection(
          clipRect,
          borderRect.width === 0 || borderRect.height === 0
            ? clipRect
            : overflowRect,
        ),
        children: Object.freeze([...children]),
        lineBoxes: Object.freeze([...lineBoxes]),
        usedFontMetrics: null,
        baseline,
        visualOrder: ++this.#visualOrder,
        paintOrder: ++this.#paintOrder,
        action: visible ? this.#action(node) : null,
        semantic:
          visible && node.semantic?.accessibilityHidden !== true
            ? node.semantic
            : null,
        style: this.#paintStyle(node),
        minContentContribution,
        maxContentContribution,
        ...(inlineContinuations.length === 0
          ? {}
          : {
              inlineContinuations: Object.freeze(
                inlineContinuations.map((entry) => Object.freeze(entry)),
              ),
            }),
        ...(tableCollapsedBorderSegments === undefined
          ? {}
          : {
              tableCollapsedBorderSegments,
            }),
      },
      true,
    );
    this.#principalFragments.set(node.id, fragment.id);
    const position = this.#boxComputed(node)?.box.position;
    if (position !== undefined && position !== "static") {
      this.#positionedContainingBlocks.set(node.id, paddingRect);
    }
    if (position === "relative" || position === "sticky")
      this.#hasInFlowPositioning = true;
    return { fragment: fragment.id, borderRect, marginRect };
  }

  #firstDescendantBaseline(
    children: readonly LayoutFragmentId[],
  ): CssCoordinate | null {
    const pending = [...children].reverse();
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      const node = this.#formatting.node(fragment.formattingNode);
      const float = this.#boxComputed(node)?.box.float;
      if (this.#outOfFlow(node) || (float !== undefined && float !== "none"))
        continue;
      if (fragment.baseline !== null)
        return point(fragment.borderRect.y, fragment.baseline);
      for (let index = fragment.children.length - 1; index >= 0; index -= 1) {
        const child = fragment.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return null;
  }

  #inline(
    id: FormattingNodeId,
    cursor: InlineFormattingCursor,
    clip: CssRect,
    depth: number,
  ): LayoutResult {
    const node = this.#formatting.node(id);
    if (
      isAtomicInlineBox(this.#formatting, node) &&
      node.kind !== "form-control" &&
      node.kind !== "replaced-element" &&
      node.kind !== "image-fallback"
    ) {
      return this.#atomicFormattingContext(node, cursor, clip, depth);
    }
    this.#reserve();
    try {
      return this.#inlineReserved(id, cursor, clip, depth);
    } finally {
      this.#reserved -= 1;
    }
  }

  #inlineLeafRectangles(
    children: readonly LayoutFragmentId[],
  ): readonly CssRect[] {
    const leafRectangles: CssRect[] = [];
    const pending = [...children];
    while (pending.length > 0) {
      const fragmentId = pending.pop();
      if (fragmentId === undefined) continue;
      const fragment = this.#fragments.get(fragmentId);
      if (fragment === undefined) continue;
      if (
        fragment.kind !== "text" &&
        fragment.inlineContinuations !== undefined
      ) {
        for (const continuation of fragment.inlineContinuations)
          leafRectangles.push(continuation.marginRect);
        continue;
      }
      if (
        fragment.kind === "text" ||
        fragment.kind === "control" ||
        fragment.kind === "replaced" ||
        fragment.children.length === 0
      ) {
        if (fragment.marginRect.width > 0 || fragment.marginRect.height > 0)
          leafRectangles.push(fragment.marginRect);
        continue;
      }
      for (let index = fragment.children.length - 1; index >= 0; index -= 1) {
        const child = fragment.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return leafRectangles;
  }

  #singleInlineLeafRectangle(
    children: readonly LayoutFragmentId[],
  ): CssRect | undefined {
    if (children.length !== 1 || children[0] === undefined) return undefined;
    let fragment = this.#fragments.get(children[0]);
    while (fragment !== undefined) {
      if (
        fragment.kind !== "text" &&
        fragment.inlineContinuations !== undefined
      ) {
        return fragment.inlineContinuations.length === 1
          ? fragment.inlineContinuations[0]?.marginRect
          : undefined;
      }
      if (
        fragment.kind === "text" ||
        fragment.kind === "control" ||
        fragment.kind === "replaced" ||
        fragment.children.length === 0
      )
        return fragment.marginRect;
      if (fragment.children.length !== 1 || fragment.children[0] === undefined)
        return undefined;
      fragment = this.#fragments.get(fragment.children[0]);
    }
    return undefined;
  }

  #inlineContinuationGeometry(
    decoration: {
      readonly margin: CssSignedEdges;
      readonly padding: CssEdges;
      readonly border: CssEdges;
    },
    children: readonly LayoutFragmentId[],
  ): readonly InlineContinuationGeometry[] {
    const undecorated =
      emptyEdges(decoration.margin) &&
      emptyEdges(decoration.padding) &&
      emptyEdges(decoration.border);
    const directRectangle = this.#singleInlineLeafRectangle(children);
    if (
      undecorated &&
      directRectangle !== undefined &&
      (directRectangle.width > 0 || directRectangle.height > 0)
    ) {
      return [
        Object.freeze({
          contentRect: directRectangle,
          paddingRect: directRectangle,
          borderRect: directRectangle,
          marginRect: directRectangle,
        }),
      ];
    }
    const lineContent: CssRect[] = [];
    for (const rectangle of this.#inlineLeafRectangles(children)) {
      const previous = lineContent.at(-1);
      if (
        previous !== undefined &&
        previous.y === rectangle.y &&
        previous.height === rectangle.height
      ) {
        lineContent[lineContent.length - 1] = cssUnion(
          [previous, rectangle],
          previous,
        );
      } else lineContent.push(rectangle);
    }
    if (undecorated)
      return lineContent.map((contentRect) =>
        Object.freeze({
          contentRect,
          paddingRect: contentRect,
          borderRect: contentRect,
          marginRect: contentRect,
        }),
      );
    return lineContent.map((contentRect, index): InlineContinuationGeometry => {
      const first = index === 0;
      const last = index === lineContent.length - 1;
      const paddingLeft = first ? decoration.padding.left : ZERO;
      const paddingRight = last ? decoration.padding.right : ZERO;
      const borderLeft = first ? decoration.border.left : ZERO;
      const borderRight = last ? decoration.border.right : ZERO;
      const marginLeft = first ? decoration.margin.left : ZERO;
      const marginRight = last ? decoration.margin.right : ZERO;
      const paddingRect = cssRect(
        point(contentRect.x, negate(paddingLeft)),
        point(contentRect.y, negate(decoration.padding.top)),
        sum(contentRect.width, paddingLeft, paddingRight),
        sum(
          contentRect.height,
          decoration.padding.top,
          decoration.padding.bottom,
        ),
      );
      const borderRect = cssRect(
        point(paddingRect.x, negate(borderLeft)),
        point(paddingRect.y, negate(decoration.border.top)),
        sum(paddingRect.width, borderLeft, borderRight),
        sum(
          paddingRect.height,
          decoration.border.top,
          decoration.border.bottom,
        ),
      );
      const marginRect = cssRect(
        point(borderRect.x, negate(marginLeft)),
        point(borderRect.y, negate(decoration.margin.top)),
        sum(borderRect.width, marginLeft, marginRight),
        sum(borderRect.height, decoration.margin.top, decoration.margin.bottom),
      );
      return Object.freeze({
        contentRect,
        paddingRect,
        borderRect,
        marginRect,
      });
    });
  }

  #unionContinuationRectangles(
    continuations: readonly InlineContinuationGeometry[],
    field: keyof InlineContinuationGeometry,
    fallback: CssRect,
  ): CssRect {
    const first = continuations[0];
    if (first === undefined) return fallback;
    if (continuations.length === 1) return first[field];
    return cssUnion(
      (function* (): Generator<CssRect> {
        for (const entry of continuations) yield entry[field];
      })(),
      fallback,
    );
  }

  #inlineReserved(
    id: FormattingNodeId,
    cursor: InlineFormattingCursor,
    clip: CssRect,
    depth: number,
  ): LayoutResult {
    const node = this.#formatting.node(id);
    if (
      this.#visuallyClipped(
        node,
        nonNegative(cssCoordinateDifference(cursor.maxX, cursor.continuationX)),
      )
    ) {
      const empty = cssRect(cursor.x, cursor.y, ZERO, ZERO);
      return this.#container(node, empty, empty, empty, empty, empty, [], []);
    }
    if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker"
    )
      return this.#placeText(node, cursor, clip);
    if (node.kind === "forced-line-break") {
      const box = cssRect(cursor.x, cursor.y, ZERO, ZERO);
      this.#finalizeLine(cursor, true);
      return this.#container(node, box, box, box, box, clip, [], []);
    }
    if (node.kind === "line-break-opportunity") {
      const box = cssRect(cursor.x, cursor.y, ZERO, ZERO);
      return this.#container(node, box, box, box, box, clip, [], []);
    }
    if (
      node.kind === "form-control" ||
      node.kind === "replaced-element" ||
      node.kind === "image-fallback"
    ) {
      return this.#atomic(node, cursor, clip);
    }
    if (!isInlineFormattingNode(node)) {
      if (cursor.x > cursor.continuationX) this.#finalizeLine(cursor);
      const result = this.#layoutNode(
        id,
        cursor.continuationX,
        cursor.y,
        nonNegative(cssCoordinateDifference(cursor.maxX, cursor.continuationX)),
        clip,
        depth + 1,
      );
      cursor.y = cssCoordinateAdd(
        result.marginRect.y,
        result.marginRect.height,
      );
      cursor.x = cursor.continuationX;
      return result;
    }
    const style = this.#boxComputed(node);
    const containingWidth = nonNegative(
      cssCoordinateDifference(cursor.maxX, cursor.continuationX),
    );
    const decoration = this.#edges(style, containingWidth, node.id);
    const leading = sum(
      decoration.margin.left,
      decoration.border.left,
      decoration.padding.left,
    );
    const trailing = sum(
      decoration.padding.right,
      decoration.border.right,
      decoration.margin.right,
    );
    if (
      cursor.x > cursor.continuationX &&
      point(cursor.x, leading) > cursor.maxX
    )
      this.#finalizeLine(cursor);
    cursor.x = point(cursor.x, leading);
    const children: LayoutFragmentId[] = [];
    const start = cssRect(cursor.x, cursor.y, ZERO, ZERO);
    for (const child of node.children) {
      const result = this.#tryInline(child, cursor, clip, depth + 1);
      if (result === null) break;
      children.push(result.fragment);
    }
    cursor.x = point(cursor.x, trailing);
    const result = this.#container(
      node,
      start,
      start,
      start,
      start,
      clip,
      children,
      [],
      undefined,
      [],
    );
    this.#inlineDecorations.set(result.fragment, decoration);
    return result;
  }

  #tryInline(
    id: FormattingNodeId,
    cursor: InlineFormattingCursor,
    clip: CssRect,
    depth: number,
  ): LayoutResult | null {
    if (cursor.lineSelectionStopped) return null;
    const firstUnit = cursor.textAnalysis.firstUnitByFormatting.get(id);
    if (firstUnit !== undefined && firstUnit >= cursor.logicalUnitLimit) {
      cursor.lineSelectionStopped = true;
      return null;
    }
    try {
      return this.#inline(id, cursor, clip, depth);
    } catch (error) {
      if (error instanceof LayoutBudgetExhausted) return null;
      throw error;
    }
  }

  #intrinsicWidth(
    id: FormattingNodeId,
    maximum: CssPixelLength,
  ): CssPixelLength {
    const pending = [id];
    let total: CssPixelLength = ZERO;
    let trailingCollapsibleAdvance: CssPixelLength = ZERO;
    const appendProcessed = (
      processed: ProcessedCssText,
      style: ComputedStyle | null,
    ): void => {
      if (processed.outcome.status !== "complete") {
        throw new RangeError(
          "Inline item stream contains incomplete logical text.",
        );
      }
      const metrics = this.#metrics(style);
      const tabInterval = cssMultiply(
        metrics.chAdvance,
        style?.text.tabSize ?? 8,
      );
      for (const unit of processed.units) {
        this.#input.signal?.throwIfAborted();
        if (unit.kind === "forced-break") {
          total = nonNegative(
            cssAdd(total, negate(trailingCollapsibleAdvance)),
          );
          trailingCollapsibleAdvance = ZERO;
          continue;
        }
        if (unit.kind === "soft-hyphen") continue;
        let advance: CssPixelLength;
        if (unit.kind === "tab") {
          const remainder = tabInterval === 0 ? 0 : total % tabInterval;
          advance =
            tabInterval === 0
              ? ZERO
              : ((remainder === 0
                  ? tabInterval
                  : tabInterval - remainder) as CssPixelLength);
        } else advance = this.#measure(unit.text, metrics.fontSize);
        total = cssAdd(total, advance);
        if (unit.collapsibleSpace)
          trailingCollapsibleAdvance = cssAdd(
            trailingCollapsibleAdvance,
            advance,
          );
        else trailingCollapsibleAdvance = ZERO;
      }
    };
    while (pending.length > 0 && total <= maximum) {
      const current = pending.pop();
      if (current === undefined) continue;
      const node = this.#formatting.node(current);
      const style = this.#computed(node);
      if (
        node.kind === "text-sequence" ||
        node.kind === "generated-text" ||
        node.kind === "marker"
      ) {
        const processed = this.#input.inlineItemStreams.textForFormattingNode(
          node.id,
        );
        if (processed === null)
          throw new RangeError(
            "Inline item streams do not contain logical text for intrinsic sizing.",
          );
        appendProcessed(processed, style);
      } else if (node.kind === "form-control") {
        const processed = this.#input.inlineItemStreams.textForFormattingNode(
          node.id,
        );
        if (processed === null)
          throw new RangeError(
            "Inline item streams do not contain control text for intrinsic sizing.",
          );
        appendProcessed(processed, style);
      } else if (
        node.kind === "replaced-element" ||
        node.kind === "image-fallback"
      ) {
        const intrinsic =
          node.intrinsicWidth === null ? null : cssPx(node.intrinsicWidth);
        const processed =
          intrinsic === null
            ? this.#input.inlineItemStreams.textForFormattingNode(node.id)
            : null;
        if (intrinsic === null && processed === null) {
          throw new RangeError(
            "Inline item streams do not contain replaced fallback text for intrinsic sizing.",
          );
        }
        if (intrinsic === null)
          appendProcessed(processed as ProcessedCssText, style);
        else {
          total = cssAdd(total, intrinsic);
          trailingCollapsibleAdvance = ZERO;
        }
      } else
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) pending.push(child);
        }
    }
    total = nonNegative(cssAdd(total, negate(trailingCollapsibleAdvance)));
    return cssMin(maximum, cssMax(this.#metrics(null).chAdvance, total));
  }

  #intrinsicMinimumWidth(
    id: FormattingNodeId,
    maximum: CssPixelLength,
  ): CssPixelLength {
    const pending = [id];
    let segment: CssPixelLength = ZERO;
    let widest: CssPixelLength = ZERO;
    let trailingCollapsibleAdvance: CssPixelLength = ZERO;
    const finishSegment = (): void => {
      widest = cssMax(
        widest,
        nonNegative(sum(segment, negate(trailingCollapsibleAdvance))),
      );
      segment = ZERO;
      trailingCollapsibleAdvance = ZERO;
    };
    const appendProcessed = (
      processed: ProcessedCssText,
      style: ComputedStyle | null,
    ): void => {
      if (processed.outcome.status !== "complete") {
        throw new RangeError(
          "Inline item stream contains incomplete logical text.",
        );
      }
      const metrics = this.#metrics(style);
      const breaks = buildLineBreakMap(
        processed.transformed.value,
        {
          lineBreak: style?.text.lineBreak ?? "auto",
          wordBreak:
            style?.text.wordBreak === "break-word"
              ? "normal"
              : (style?.text.wordBreak ?? "normal"),
          overflowWrap: style?.text.overflowWrap ?? "normal",
          hyphens: style?.text.hyphens ?? "manual",
          language: null,
          preserveGraphemeClusters: true,
        },
        {},
        this.#input.signal,
      );
      if (breaks.outcome.status !== "complete")
        throw new RangeError("Intrinsic line-break analysis was incomplete.");
      const tabInterval = cssMultiply(
        metrics.chAdvance,
        style?.text.tabSize ?? 8,
      );
      for (const unit of processed.units) {
        this.#input.signal?.throwIfAborted();
        const opportunity =
          unit.transformedStartCodeUnit === 0
            ? null
            : breaks.atCodeUnit(unit.transformedStartCodeUnit);
        if (
          opportunity?.kind === "allowed" ||
          opportunity?.kind === "mandatory"
        )
          finishSegment();
        if (unit.kind === "forced-break") {
          finishSegment();
          continue;
        }
        if (unit.kind === "soft-hyphen") continue;
        const advance =
          unit.kind === "tab"
            ? tabInterval
            : this.#measure(unit.text, metrics.fontSize);
        segment = cssAdd(segment, advance);
        if (unit.collapsibleSpace)
          trailingCollapsibleAdvance = cssAdd(
            trailingCollapsibleAdvance,
            advance,
          );
        else trailingCollapsibleAdvance = ZERO;
      }
    };
    while (pending.length > 0 && widest <= maximum) {
      const current = pending.pop();
      if (current === undefined) continue;
      const node = this.#formatting.node(current);
      const style = this.#computed(node);
      if (
        node.kind === "text-sequence" ||
        node.kind === "generated-text" ||
        node.kind === "marker" ||
        node.kind === "form-control"
      ) {
        const processed = this.#input.inlineItemStreams.textForFormattingNode(
          node.id,
        );
        if (processed === null)
          throw new RangeError(
            "Inline item streams do not contain logical text for intrinsic sizing.",
          );
        appendProcessed(processed, style);
      } else if (
        node.kind === "replaced-element" ||
        node.kind === "image-fallback"
      ) {
        finishSegment();
        const intrinsic =
          node.intrinsicWidth === null ? null : cssPx(node.intrinsicWidth);
        const processed =
          intrinsic === null
            ? this.#input.inlineItemStreams.textForFormattingNode(node.id)
            : null;
        if (intrinsic === null && processed === null) {
          throw new RangeError(
            "Inline item streams do not contain replaced fallback text for intrinsic sizing.",
          );
        }
        if (intrinsic === null)
          appendProcessed(processed as ProcessedCssText, style);
        else widest = cssMax(widest, intrinsic);
        finishSegment();
      } else
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) pending.push(child);
        }
    }
    finishSegment();
    return cssMin(maximum, cssMax(this.#metrics(null).chAdvance, widest));
  }

  #intrinsicInlineContribution(
    id: FormattingNodeId,
    mode: "min-content" | "max-content",
    maximum: CssPixelLength,
    depth = 0,
  ): CssPixelLength {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) return ZERO;
    const node = this.#formatting.node(id);
    if (
      (node.kind === "flex-item" || node.kind === "grid-item") &&
      !node.appliesBoxStyle &&
      node.children.length === 1 &&
      node.children[0] !== undefined
    ) {
      return this.#intrinsicInlineContribution(
        node.children[0],
        mode,
        maximum,
        depth + 1,
      );
    }
    if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker" ||
      node.kind === "form-control" ||
      node.kind === "replaced-element" ||
      node.kind === "image-fallback"
    ) {
      return mode === "min-content"
        ? this.#intrinsicMinimumWidth(id, maximum)
        : this.#intrinsicWidth(id, maximum);
    }
    if (
      node.kind === "forced-line-break" ||
      node.kind === "line-break-opportunity"
    )
      return ZERO;
    if (node.kind === "grid-container")
      return intrinsicGridInlineSize(this.#gridIntrinsicSizingHost(), node, mode, maximum);
    if (node.kind === "table" || node.kind === "table-wrapper") {
      return mode === "min-content"
        ? this.#intrinsicMinimumWidth(id, maximum)
        : this.#intrinsicWidth(id, maximum);
    }
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const inlineFormatting =
      node.outer === "inline" || node.kind === "anonymous-inline";
    const rowFlex =
      node.kind === "flex-container" &&
      style !== null &&
      (style.box.flexDirection === "row" ||
        style.box.flexDirection === "row-reverse");
    let result: CssPixelLength = ZERO;
    let inFlowChildren = 0;
    for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (this.#outOfFlow(child)) continue;
      inFlowChildren += 1;
      const contribution = this.#intrinsicContributions(childId, null);
      const childStyle = this.#boxComputed(child) ?? this.#computed(child);
      const edges = this.#edges(childStyle, ZERO);
      const outer = sum(
        mode === "min-content"
          ? contribution.borderBox.minContentInlineSize
          : contribution.borderBox.maxContentInlineSize,
        edges.margin.left,
        edges.margin.right,
      );
      if (inlineFormatting || rowFlex) result = cssAdd(result, outer);
      else result = cssMax(result, outer);
    }
    if (rowFlex && inFlowChildren > 1) {
      const gap = this.#usedGap(style.box.columnGap, null, style) ?? ZERO;
      result = cssAdd(result, cssMultiply(gap, inFlowChildren - 1));
    }
    return cssMin(maximum, result);
  }

  #intrinsicContributions(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength | null,
  ): IntrinsicSizeContributions {
    const outcome = this.#intrinsicContributionCache.resolve(
      { formattingNode: id, availableInlineSize },
      () => {
        const maximum = cssLengthFromFixed(Number.MAX_SAFE_INTEGER);
        const inlineSize = availableInlineSize ?? maximum;
        const node = this.#formatting.node(id);
        const tableSizes = node.kind === "table" || node.kind === "table-wrapper"
          ? this.#tableBudget(() => intrinsicTableInlineSizes(this.#tableIntrinsicSizingHost(), node))
          : null;
        let minimumInline = tableSizes?.minContent ?? this.#intrinsicInlineContribution(
          id,
          "min-content",
          maximum,
        );
        let maximumInline = tableSizes?.maxContent ?? this.#intrinsicInlineContribution(
          id,
          "max-content",
          maximum,
        );
        const block = this.#intrinsicBlockSize(id, inlineSize);
        const style = this.#boxComputed(node) ?? this.#computed(node);
        const edges = this.#edges(style, availableInlineSize ?? ZERO, node.id);
        const inlineBorderPadding = sum(
          edges.border.left,
          edges.padding.left,
          edges.padding.right,
          edges.border.right,
        );
        if (style !== null) {
          const toContent = (value: CssPixelLength): CssPixelLength =>
            style.box.boxSizing === "border-box"
              ? nonNegative(sum(value, negate(inlineBorderPadding)))
              : nonNegative(value);
          const specified = this.#usedLength(
            style.box.width,
            availableInlineSize,
            style,
          );
          const minimum = this.#usedLength(
            style.box.minWidth,
            availableInlineSize,
            style,
          );
          const maximumValue = this.#usedLength(
            style.box.maxWidth,
            availableInlineSize,
            style,
          );
          if (specified !== null)
            minimumInline = maximumInline = toContent(specified);
          if (maximumValue !== null) {
            minimumInline = cssMin(minimumInline, toContent(maximumValue));
            maximumInline = cssMin(maximumInline, toContent(maximumValue));
          }
          if (minimum !== null) {
            minimumInline = cssMax(minimumInline, toContent(minimum));
            maximumInline = cssMax(maximumInline, toContent(minimum));
          }
        }
        return Object.freeze({
          status: "complete" as const,
          contributions: intrinsicContributions(
            {
              minContentInlineSize: minimumInline,
              maxContentInlineSize: maximumInline,
              minimumBlockContribution: block,
              maximumBlockContribution: block,
            },
            {
              inline: inlineBorderPadding,
              block: sum(
                edges.border.top,
                edges.padding.top,
                edges.padding.bottom,
                edges.border.bottom,
              ),
            },
            {
              inline:
                style !== null &&
                [
                  style.box.width,
                  style.box.minWidth,
                  style.box.maxWidth,
                  style.box.padding.left,
                  style.box.padding.right,
                ].some(percentageDependent),
              block:
                style !== null &&
                [
                  style.box.height,
                  style.box.minHeight,
                  style.box.maxHeight,
                  style.box.padding.top,
                  style.box.padding.bottom,
                ].some(percentageDependent),
            },
            this.#intrinsicFirstBaseline(id, inlineSize),
          ),
        });
      },
    );
    if (outcome.status === "complete") return outcome.contributions;
    if (outcome.status === "truncated") {
      this.#truncated ??= "maxIntrinsicContributionCacheEntries";
      throw new LayoutBudgetExhausted();
    }
    throw new IntrinsicSizingCycleError({
      formattingNode: id,
      availableInlineSize,
    });
  }

  #gridItemMinimumInlineContribution(
    id: FormattingNodeId,
    contributions: IntrinsicSizeContributions,
  ): CssNonNegativeLength {
    const node = this.#formatting.node(id);
    const style = this.#boxComputed(node) ?? this.#computed(node);
    if (
      style?.box.minWidth.kind !== "auto" ||
      style.box.overflowX !== "hidden"
    )
      return contributions.borderBox.minContentInlineSize;
    return nonNegative(
      sum(
        contributions.borderBox.minContentInlineSize,
        negate(contributions.contentBox.minContentInlineSize),
      ),
    );
  }

  #intrinsicBlockSize(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth = 0,
  ): CssNonNegativeLength {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) return ZERO;
    const node = this.#formatting.node(id);
    if (
      (node.kind === "flex-item" || node.kind === "grid-item") &&
      !node.appliesBoxStyle &&
      node.children.length === 1 &&
      node.children[0] !== undefined
    ) {
      return this.#intrinsicBlockSize(
        node.children[0],
        availableInlineSize,
        depth + 1,
      );
    }
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const specified =
      style === null ? null : this.#usedLength(style.box.height, null, style);
    if (specified !== null) return nonNegative(specified);
    let automatic: CssPixelLength;
    if (node.kind === "replaced-element" || node.kind === "image-fallback") {
      automatic =
        node.intrinsicHeight === null
          ? this.#lineHeight(style, this.#metrics(style))
          : cssPx(node.intrinsicHeight);
    } else if (node.kind === "form-control") {
      automatic = this.#lineHeight(style, this.#metrics(style));
    } else if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker" ||
      node.kind === "forced-line-break" ||
      node.kind === "line-break-opportunity"
    ) {
      const advance =
        node.kind === "forced-line-break" ||
        node.kind === "line-break-opportunity"
          ? ZERO
          : this.#intrinsicWidth(
              id,
              cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
            );
      const lines =
        availableInlineSize <= 0
          ? 1
          : Math.max(1, Math.ceil(advance / availableInlineSize));
      automatic = cssMultiply(
        this.#lineHeight(style, this.#metrics(style)),
        lines,
      );
    } else if (node.kind === "flex-container") {
      automatic = this.#intrinsicFlexBlockSize(
        node,
        availableInlineSize,
        depth + 1,
      );
    } else if (node.kind === "grid-container") {
      automatic = intrinsicGridBlockSize(
        this.#gridIntrinsicSizingHost(),
        node,
        availableInlineSize,
        depth + 1,
      );
    } else if (node.kind === "table" || node.kind === "table-wrapper") {
      automatic = this.#tableBudget(() => intrinsicTableBlockSize(
        {
          budgets: this.#budgets,
          signal: this.#input.signal,
          formattingNode: (candidate) => this.#formatting.node(candidate),
          computed: (candidate) => this.#computed(candidate),
          htmlTableCell: (candidate) => this.#formatting.document.htmlTableCell(candidate),
          htmlTableColumn: (candidate) => this.#formatting.document.htmlTableColumn(candidate),
          htmlTableColumnGroup: (candidate) => this.#formatting.document.htmlTableColumnGroup(candidate),
          isOutOfFlow: (candidate) => this.#outOfFlow(candidate),
          usedLength: (value, basis, computed) => this.#usedLength(value, basis, computed),
          intrinsicOuterBlockSize: (candidate, inlineSize, candidateDepth) =>
            this.#intrinsicOuterBlockSize(candidate, inlineSize, candidateDepth),
          tableSlotGrid: (candidate) => this.#tableSlotGrid(candidate),
          consume: (budget, amount) => {
            this.#consumeTableWork(budget, amount);
          },
        },
        node,
        availableInlineSize,
        depth,
      ));
    } else if (node.kind === "table-row") {
      automatic = ZERO;
      for (const child of node.children) {
        automatic = cssMax(
          automatic,
          this.#intrinsicOuterBlockSize(child, availableInlineSize, depth + 1),
        );
      }
    } else if (node.outer === "inline" || node.kind === "anonymous-inline") {
      const advance = this.#intrinsicWidth(
        id,
        cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
      );
      const lines =
        availableInlineSize <= 0
          ? 1
          : Math.max(1, Math.ceil(advance / availableInlineSize));
      automatic = cssMultiply(
        this.#lineHeight(style, this.#metrics(style)),
        lines,
      );
    } else {
      automatic = ZERO;
      for (const childId of node.children) {
        const child = this.#formatting.node(childId);
        if (this.#outOfFlow(child)) continue;
        automatic = sum(
          automatic,
          this.#intrinsicOuterBlockSize(
            childId,
            availableInlineSize,
            depth + 1,
          ),
        );
      }
    }
    if (style === null) return nonNegative(automatic);
    const minimum = this.#usedLength(style.box.minHeight, null, style) ?? ZERO;
    const maximum = this.#usedLength(style.box.maxHeight, null, style);
    return constrainedSize(
      nonNegative(automatic),
      null,
      nonNegative(minimum),
      maximum,
    );
  }

  #intrinsicFirstBaseline(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth = 0,
  ): CssNonNegativeLength | null {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) return null;
    const node = this.#formatting.node(id);
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const edges = this.#edges(style, availableInlineSize, node.id);
    const contentStart = sum(edges.border.top, edges.padding.top);
    if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker" ||
      node.kind === "forced-line-break" ||
      node.kind === "line-break-opportunity" ||
      node.kind === "form-control"
    ) {
      const metrics = this.#metrics(style);
      return nonNegative(sum(
        contentStart,
        this.#inlineExtents(metrics, this.#lineHeight(style, metrics)).ascent,
      ));
    }
    if (node.kind === "replaced-element" || node.kind === "image-fallback") {
      return nonNegative(sum(
        contentStart,
        this.#intrinsicBlockSize(id, availableInlineSize, depth + 1),
        edges.padding.bottom,
        edges.border.bottom,
      ));
    }
    const children = node.children
      .map((child) => this.#formatting.node(child))
      .filter((child) => !this.#outOfFlow(child));
    if (children.length === 0) return null;
    if (children.every((child) => isInlineFormattingNode(child))) {
      let baseline: CssPixelLength | null = null;
      for (const child of children) {
        const candidate = this.#intrinsicFirstBaseline(child.id, availableInlineSize, depth + 1);
        if (candidate !== null) baseline = baseline === null ? candidate : cssMax(baseline, candidate);
      }
      return baseline === null ? null : nonNegative(sum(contentStart, baseline));
    }
    let offset: CssPixelLength = contentStart;
    for (const child of children) {
      const childStyle = this.#boxComputed(child) ?? this.#computed(child);
      const childEdges = this.#edges(childStyle, availableInlineSize);
      const baseline = this.#intrinsicFirstBaseline(child.id, availableInlineSize, depth + 1);
      if (baseline !== null) return nonNegative(sum(offset, childEdges.margin.top, baseline));
      offset = sum(
        offset,
        this.#intrinsicOuterBlockSize(child.id, availableInlineSize, depth + 1),
      );
    }
    return null;
  }

  #intrinsicOuterBlockSize(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth: number,
    itemStyle = false,
  ): CssNonNegativeLength {
    const node = this.#formatting.node(id);
    const style = itemStyle
      ? (this.#boxComputed(node) ?? this.#computed(node))
      : this.#boxComputed(node);
    const edges = this.#edges(style, availableInlineSize, node.id);
    return nonNegative(
      sum(
        this.#intrinsicBlockSize(id, availableInlineSize, depth),
        edges.margin.top,
        edges.border.top,
        edges.padding.top,
        edges.padding.bottom,
        edges.border.bottom,
        edges.margin.bottom,
      ),
    );
  }

  #intrinsicFlexBlockSize(
    node: FormattingNode,
    availableInlineSize: CssPixelLength,
    depth: number,
  ): CssNonNegativeLength {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    if (style === null) return ZERO;
    const axes = flexAxes(style);
    const items = node.children.filter(
      (child) => !this.#outOfFlow(this.#formatting.node(child)),
    );
    if (items.length === 0) return ZERO;
    const mainGap =
      this.#usedGap(
        axes.row ? style.box.columnGap : style.box.rowGap,
        availableInlineSize,
        style,
      ) ?? ZERO;
    if (!axes.row) {
      let total = cssMultiply(mainGap, Math.max(0, items.length - 1));
      for (const item of items)
        total = sum(
          total,
          this.#intrinsicOuterBlockSize(item, availableInlineSize, depth, true),
        );
      return nonNegative(total);
    }
    const crossGap =
      this.#usedGap(style.box.rowGap, availableInlineSize, style) ?? ZERO;
    const wrapping = style.box.flexWrap !== "nowrap";
    let lineMain: CssPixelLength = ZERO;
    let lineCross: CssPixelLength = ZERO;
    let totalCross: CssPixelLength = ZERO;
    let lineCount = 0;
    for (const [index, item] of items.entries()) {
      const input = this.#flexItemInput(
        item,
        index,
        axes,
        availableInlineSize,
        availableInlineSize,
      );
      const itemMain = sum(
        input.hypotheticalMainSize,
        input.mainBorderPadding,
        input.autoMarginMainStart ? ZERO : input.marginMainStart,
        input.autoMarginMainEnd ? ZERO : input.marginMainEnd,
      );
      const required =
        lineMain === 0 ? itemMain : sum(lineMain, mainGap, itemMain);
      if (wrapping && lineMain > 0 && required > availableInlineSize) {
        totalCross = sum(
          totalCross,
          lineCount === 0 ? ZERO : crossGap,
          lineCross,
        );
        lineCount += 1;
        lineMain = itemMain;
        lineCross = this.#intrinsicOuterBlockSize(
          item,
          availableInlineSize,
          depth,
          true,
        );
      } else {
        lineMain = required;
        lineCross = cssMax(
          lineCross,
          this.#intrinsicOuterBlockSize(item, availableInlineSize, depth, true),
        );
      }
    }
    return nonNegative(
      sum(totalCross, lineCount === 0 ? ZERO : crossGap, lineCross),
    );
  }

  #gridBudget<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof GridWorkBudgetExceeded)) throw error;
      this.#truncated ??= error.budget;
      throw new LayoutBudgetExhausted();
    }
  }

  #consumeTableWork(budget: TableBudgetName, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Table work amount must be a non-negative safe integer.");
    this.#input.signal?.throwIfAborted();
    const retained = this.#tableWork.get(budget) ?? 0;
    const limit = this.#budgets[budget];
    if (amount > limit - retained) throw new TableWorkBudgetExceeded(budget);
    this.#tableWork.set(budget, retained + amount);
  }

  #tableSlotGrid(table: FormattingNode): TableSlotGrid {
    const cached = this.#tableSlotGridCache.get(table.id);
    if (cached !== undefined) return cached;
    const host: TableSlotGridHost = {
      budgets: this.#budgets,
      signal: this.#input.signal,
      formattingNode: (id) => this.#formatting.node(id),
      computed: (node) => this.#computed(node),
      htmlTableCell: (node) => this.#formatting.document.htmlTableCell(node),
      htmlTableColumn: (node) => this.#formatting.document.htmlTableColumn(node),
      htmlTableColumnGroup: (node) => this.#formatting.document.htmlTableColumnGroup(node),
      isOutOfFlow: (node) => this.#outOfFlow(node),
      consume: (budget, amount) => {
        this.#consumeTableWork(budget, amount);
      },
    };
    const grid = buildTableSlotGrid(host, table);
    this.#tableSlotGridCache.set(table.id, grid);
    return grid;
  }

  #tableBudget<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof TableWorkBudgetExceeded)) throw error;
      this.#truncated ??= error.budget;
      throw new LayoutBudgetExhausted();
    }
  }

  #translateFragmentChildren(
    result: LayoutResult,
    blockOffset: CssPixelLength,
    containingClip: CssRect,
  ): void {
    if (blockOffset === 0) return;
    const fragment = this.#fragments.get(result.fragment);
    if (fragment === undefined) return;
    for (const child of fragment.children) {
      const childFragment = this.#fragments.get(child);
      if (childFragment === undefined) continue;
      this.#translate(
        { fragment: child, borderRect: childFragment.borderRect, marginRect: childFragment.marginRect },
        ZERO,
        blockOffset,
        containingClip,
      );
    }
  }

  #tableFormattingContext(
    wrapper: TableWrapperFormattingNode,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
  ): LayoutResult {
    return layoutTableContainer(
      {
        budgets: this.#budgets,
        signal: this.#input.signal,
        formattingNode: (id) => this.#formatting.node(id),
        computed: (node) => this.#computed(node),
        boxComputed: (node) => this.#boxComputed(node),
        htmlTableCell: (node) => this.#formatting.document.htmlTableCell(node),
        htmlTableColumn: (node) => this.#formatting.document.htmlTableColumn(node),
        htmlTableColumnGroup: (node) => this.#formatting.document.htmlTableColumnGroup(node),
        isOutOfFlow: (node) => this.#outOfFlow(node),
        consume: (budget, amount) => {
          this.#consumeTableWork(budget, amount);
        },
        usedLength: (value, basis, style) => this.#usedLength(value, basis, style),
        inlineBoxOffsets: (node, basis) => {
          const edges = this.#edges(this.#boxComputed(node) ?? this.#computed(node), basis);
          return nonNegative(sum(
            edges.padding.left,
            edges.padding.right,
            edges.border.left,
            edges.border.right,
          ));
        },
        tableSlotGrid: (node) => this.#tableSlotGrid(node),
        dimensions: (node, containingWidth, containingHeight, forcedWidth) =>
          this.#dimensions(node, containingWidth, containingHeight, forcedWidth, node.kind === "table"),
        intrinsicContributions: (id, availableInlineSize) =>
          this.#intrinsicContributions(id, availableInlineSize),
        layoutChild: (
          id,
          childX,
          childY,
          childWidth,
          childClip,
          childDepth,
          containingHeight,
          forcedWidth,
          forcedHeight,
        ) => this.#tryLayoutNode(
          id,
          childX,
          childY,
          childWidth,
          childClip,
          childDepth,
          containingHeight,
          forcedWidth,
          forcedHeight,
        ),
        layoutOutOfFlow: (node, staticX, staticY, inheritedClip, childDepth, containingBlock) =>
          this.#layoutOutOfFlow(node, staticX, staticY, inheritedClip, childDepth, containingBlock),
        translate: (result, inlineOffset, blockOffset, containingClip) =>
          this.#translate(result, inlineOffset, blockOffset, containingClip),
        translateChildren: (result, blockOffset, containingClip) => {
          this.#translateFragmentChildren(result, blockOffset, containingClip);
        },
        fragment: (id) => this.#fragments.get(id),
        clip: (node, paddingRect, borderRect, inheritedClip) =>
          this.#clip(node, paddingRect, borderRect, inheritedClip),
        registerPositionedContainingBlock: (id, rect) => {
          this.#positionedContainingBlocks.set(id, rect);
        },
        registerCollapsedBorderOverride: (id, value) => {
          this.#tableBorderOverrides.set(id, value);
          this.#paintStyleCache.delete(id);
          this.#intrinsicContributionCache.clear();
        },
        paintStyle: (node) => this.#paintStyle(node),
        registerCollapsedBorderSegments: (id, segments) => {
          this.#tableCollapsedBorderSegments.set(id, segments);
        },
        container: (node, contentRect, paddingRect, borderRect, marginRect, clipRect, children, lines) =>
          this.#container(node, contentRect, paddingRect, borderRect, marginRect, clipRect, children, lines),
        withContainerReservation: (operation) => {
          this.#reserve();
          try {
            return operation();
          } finally {
            this.#reserved -= 1;
          }
        },
        tryContainerReservation: (operation) => {
          try {
            this.#reserve();
          } catch (error) {
            if (error instanceof LayoutBudgetExhausted) return null;
            throw error;
          }
          try {
            return operation();
          } catch (error) {
            if (error instanceof LayoutBudgetExhausted) return null;
            throw error;
          } finally {
            this.#reserved -= 1;
          }
        },
        withTableBudget: (operation) => this.#tableBudget(operation),
      },
      { wrapper, x, y, width, clip, depth },
    );
  }

  #tableIntrinsicSizingHost(): TableIntrinsicInlineSizingHost {
    const host: TableIntrinsicInlineSizingHost = {
      budgets: this.#budgets,
      signal: this.#input.signal,
      formattingNode: (id) => this.#formatting.node(id),
      computed: (node) => this.#computed(node),
      boxComputed: (node) => this.#boxComputed(node),
      htmlTableCell: (node) => this.#formatting.document.htmlTableCell(node),
      htmlTableColumn: (node) => this.#formatting.document.htmlTableColumn(node),
      htmlTableColumnGroup: (node) => this.#formatting.document.htmlTableColumnGroup(node),
      isOutOfFlow: (node) => this.#outOfFlow(node),
      consume: (budget, amount) => {
        this.#consumeTableWork(budget, amount);
      },
      usedLength: (value, basis, style) => this.#usedLength(value, basis, style),
      inlineBoxOffsets: (node, basis) => {
        const edges = this.#edges(this.#boxComputed(node) ?? this.#computed(node), basis);
        return nonNegative(sum(
          edges.padding.left,
          edges.padding.right,
          edges.border.left,
          edges.border.right,
        ));
      },
      intrinsicContributions: (id, availableInlineSize) =>
        this.#intrinsicContributions(id, availableInlineSize),
      tableSlotGrid: (node) => this.#tableSlotGrid(node),
      registerCollapsedBorderOverride: (id, value) => {
        this.#tableBorderOverrides.set(id, value);
        this.#paintStyleCache.delete(id);
      },
    };
    return Object.freeze(host);
  }

  #gridIntrinsicSizingHost(): GridIntrinsicSizingHost {
    const host: GridIntrinsicSizingHost = {
      budgets: this.#budgets,
      signal: this.#input.signal,
      formattingNode: (id) => this.#formatting.node(id),
      computed: (node) => this.#computed(node),
      boxComputed: (node) => this.#boxComputed(node),
      isOutOfFlow: (node) => this.#outOfFlow(node),
      usedGap: (value, basis, style) => this.#usedGap(value, basis, style),
      usedLength: (value, basis, style) => this.#usedLength(value, basis, style),
      edges: (style, containingWidth) => this.#edges(style, containingWidth),
      intrinsicContributions: (id, availableInlineSize) =>
        this.#intrinsicContributions(id, availableInlineSize),
      gridItemMinimumInlineContribution: (id, contributions) =>
        this.#gridItemMinimumInlineContribution(id, contributions),
      intrinsicOuterBlockSize: (id, availableInlineSize, depth, itemStyle) =>
        this.#intrinsicOuterBlockSize(id, availableInlineSize, depth, itemStyle),
      withGridBudget: <T>(operation: () => T): T => this.#gridBudget(operation),
    };
    return Object.freeze(host);
  }

  #translate(
    result: LayoutResult,
    inlineOffset: CssPixelLength,
    blockOffset: CssPixelLength,
    containingClip: CssRect,
  ): LayoutResult {
    if (inlineOffset === 0 && blockOffset === 0) return result;
    const move = (rect: CssRect): CssRect =>
      cssRect(
        point(rect.x, inlineOffset),
        point(rect.y, blockOffset),
        rect.width,
        rect.height,
      );
    const pending = [result.fragment];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      for (const child of fragment.children) pending.push(child);
      const lineBoxes = fragment.lineBoxes.map((line) => {
        const moved = Object.freeze({
          ...line,
          rect: move(line.rect),
          baseline: cssAdd(line.baseline, blockOffset),
        });
        const position = this.#lineBoxPositions.get(line.id);
        if (position !== undefined) this.#lineBoxes[position] = moved;
        return moved;
      });
      this.#fragments.set(id, {
        ...fragment,
        contentRect: move(fragment.contentRect),
        paddingRect: move(fragment.paddingRect),
        borderRect: move(fragment.borderRect),
        marginRect: move(fragment.marginRect),
        overflowRect: move(fragment.overflowRect),
        clipRect: cssIntersection(move(fragment.clipRect), containingClip),
        lineBoxes: Object.freeze(lineBoxes),
        ...(fragment.kind === "box" &&
        fragment.inlineContinuations !== undefined
          ? {
              inlineContinuations: Object.freeze(
                fragment.inlineContinuations.map((continuation) =>
                  Object.freeze({
                    contentRect: move(continuation.contentRect),
                    paddingRect: move(continuation.paddingRect),
                    borderRect: move(continuation.borderRect),
                    marginRect: move(continuation.marginRect),
                  }),
                ),
              ),
            }
          : {}),
        ...(fragment.kind === "box" &&
        fragment.tableCollapsedBorderSegments !== undefined
          ? {
              tableCollapsedBorderSegments: Object.freeze(
                fragment.tableCollapsedBorderSegments.map((segment) =>
                  Object.freeze({
                    ...segment,
                    borderRect: move(segment.borderRect),
                    clipRect: cssIntersection(
                      move(segment.clipRect),
                      containingClip,
                    ),
                  }),
                ),
              ),
            }
          : {}),
      });
      if (this.#positionedContainingBlocks.has(fragment.formattingNode)) {
        this.#positionedContainingBlocks.set(
          fragment.formattingNode,
          move(fragment.paddingRect),
        );
      }
    }
    const moved = this.#fragments.get(result.fragment);
    return moved === undefined
      ? result
      : {
          fragment: result.fragment,
          borderRect: moved.borderRect,
          marginRect: moved.marginRect,
        };
  }

  #usedInset(
    style: ComputedStyle | null,
    side: keyof ComputedStyle["box"]["inset"],
    basis: CssPixelLength,
  ): CssPixelLength | null {
    const value = style?.box.inset[side];
    return value === undefined || value.kind === "auto" || value.kind === "none"
      ? null
      : this.#usedLength(value, basis, style);
  }

  #positionedContainingBlock(node: FormattingNode, fixed: boolean): CssRect {
    if (fixed) return this.#input.context.scrollport;
    let parent = this.#formatting.parent(node.id);
    while (parent !== null) {
      const containingBlock = this.#positionedContainingBlocks.get(parent.id);
      if (containingBlock !== undefined) return containingBlock;
      parent = this.#formatting.parent(parent.id);
    }
    return this.#input.context.initialContainingBlock;
  }

  #inFlowContainingBlock(node: FormattingNode): CssRect {
    let parent = this.#formatting.parent(node.id);
    while (parent !== null) {
      const fragmentId = this.#principalFragments.get(parent.id);
      const fragment =
        fragmentId === undefined ? undefined : this.#fragments.get(fragmentId);
      if (fragment !== undefined && fragment.kind !== "text")
        return fragment.contentRect;
      parent = this.#formatting.parent(parent.id);
    }
    return this.#input.context.initialContainingBlock;
  }

  #layoutOutOfFlow(
    node: FormattingNode,
    staticX: CssCoordinate,
    staticY: CssCoordinate,
    inheritedClip: CssRect,
    depth: number,
    containingBlockOverride?: CssRect,
  ): LayoutResult | null {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const containingBlock =
      containingBlockOverride ??
      this.#positionedContainingBlock(node, style?.box.position === "fixed");
    const left = this.#usedInset(style, "left", containingBlock.width);
    const right = this.#usedInset(style, "right", containingBlock.width);
    const top = this.#usedInset(style, "top", containingBlock.height);
    const bottom = this.#usedInset(style, "bottom", containingBlock.height);
    const edges = this.#edges(style, containingBlock.width);
    const horizontalChrome = sum(
      edges.border.left,
      edges.padding.left,
      edges.padding.right,
      edges.border.right,
    );
    const verticalChrome = sum(
      edges.border.top,
      edges.padding.top,
      edges.padding.bottom,
      edges.border.bottom,
    );
    const autoWidth =
      style?.box.width.kind === "auto" ||
      style?.box.width.kind === "none" ||
      style === null;
    const autoHeight =
      style?.box.height.kind === "auto" ||
      style?.box.height.kind === "none" ||
      style === null;
    let forcedWidth = autoWidth
      ? left !== null && right !== null
        ? nonNegative(
            sum(
              containingBlock.width,
              negate(left),
              negate(right),
              negate(edges.margin.left),
              negate(edges.margin.right),
              negate(horizontalChrome),
            ),
          )
        : (() => {
            const available = nonNegative(
              sum(
                containingBlock.width,
                negate(
                  left ??
                    (right === null
                      ? nonNegative(
                          cssCoordinateDifference(staticX, containingBlock.x),
                        )
                      : ZERO),
                ),
                negate(right ?? ZERO),
                negate(edges.margin.left),
                negate(edges.margin.right),
                negate(horizontalChrome),
              ),
            );
            const preferredMinimum = this.#intrinsicMinimumWidth(
              node.id,
              containingBlock.width,
            );
            const preferred = this.#intrinsicWidth(
              node.id,
              containingBlock.width,
            );
            return cssMax(preferredMinimum, cssMin(available, preferred));
          })()
      : null;
    if (forcedWidth !== null) {
      const toContent = (value: CssPixelLength): CssPixelLength =>
        style?.box.boxSizing === "border-box"
          ? nonNegative(sum(value, negate(horizontalChrome)))
          : nonNegative(value);
      const minimum =
        style === null
          ? ZERO
          : toContent(
              this.#usedLength(
                style.box.minWidth,
                containingBlock.width,
                style,
              ) ?? ZERO,
            );
      const maximumValue =
        style === null
          ? null
          : this.#usedLength(style.box.maxWidth, containingBlock.width, style);
      if (maximumValue !== null)
        forcedWidth = cssMin(forcedWidth, toContent(maximumValue));
      forcedWidth = cssMax(forcedWidth, minimum);
    }
    const forcedHeight =
      autoHeight && top !== null && bottom !== null
        ? nonNegative(
            sum(
              containingBlock.height,
              negate(top),
              negate(bottom),
              negate(edges.margin.top),
              negate(edges.margin.bottom),
              negate(verticalChrome),
            ),
          )
        : null;
    const dimensions = this.#dimensions(
      node,
      containingBlock.width,
      containingBlock.height,
      forcedWidth,
    );
    const borderBoxWidth = sum(
      dimensions.contentWidth,
      dimensions.padding.left,
      dimensions.padding.right,
      dimensions.border.left,
      dimensions.border.right,
    );
    const useLeftInset =
      left !== null &&
      !(right !== null && !autoWidth && style.text.direction === "rtl");
    const borderX = useLeftInset
      ? point(containingBlock.x, sum(left, edges.margin.left))
      : right !== null
        ? point(
            cssCoordinateAdd(containingBlock.x, containingBlock.width),
            sum(
              negate(right),
              negate(edges.margin.right),
              negate(borderBoxWidth),
            ),
          )
        : point(staticX, edges.margin.left);
    const borderY =
      top !== null
        ? point(containingBlock.y, sum(top, edges.margin.top))
        : bottom !== null && forcedHeight !== null
          ? point(
              cssCoordinateAdd(containingBlock.y, containingBlock.height),
              sum(
                negate(bottom),
                negate(edges.margin.bottom),
                negate(forcedHeight),
                negate(verticalChrome),
              ),
            )
          : point(staticY, edges.margin.top);
    const result = this.#tryLayoutNode(
      node.id,
      point(borderX, negate(dimensions.marginLeft)),
      borderY,
      containingBlock.width,
      style?.box.position === "fixed"
        ? this.#input.context.scrollport
        : inheritedClip,
      depth,
      containingBlock.height,
      forcedWidth,
      forcedHeight,
    );
    if (result === null) return null;
    // Finalize the used block position from the laid-out border-box size for
    // every inset combination, including an automatic height with bottom.
    const targetBorderY =
      top !== null
        ? point(containingBlock.y, sum(top, edges.margin.top))
        : bottom !== null
          ? point(
              cssCoordinateAdd(containingBlock.y, containingBlock.height),
              sum(
                negate(bottom),
                negate(edges.margin.bottom),
                negate(result.borderRect.height),
              ),
            )
          : borderY;
    return this.#translate(
      result,
      ZERO,
      cssCoordinateDifference(targetBorderY, result.borderRect.y),
      style?.box.position === "fixed"
        ? this.#input.context.scrollport
        : inheritedClip,
    );
  }

  #applyInFlowPosition(
    node: FormattingNode,
    result: LayoutResult,
    containingClip: CssRect,
  ): LayoutResult {
    // Position the generated CSS box once. Its text fragments and anonymous
    // formatting wrappers move with that box and must not receive the offset
    // independently.
    const style = this.#boxComputed(node);
    if (
      style === null ||
      (style.box.position !== "relative" && style.box.position !== "sticky")
    )
      return result;
    const containingBlock = this.#inFlowContainingBlock(node);
    const insetBasis =
      style.box.position === "sticky"
        ? this.#input.context.scrollport
        : containingBlock;
    const left = this.#usedInset(style, "left", insetBasis.width);
    const right = this.#usedInset(style, "right", insetBasis.width);
    const top = this.#usedInset(style, "top", insetBasis.height);
    const bottom = this.#usedInset(style, "bottom", insetBasis.height);
    let inlineOffset =
      left !== null && right !== null
        ? style.text.direction === "rtl"
          ? negate(right)
          : left
        : (left ?? (right === null ? ZERO : negate(right)));
    let blockOffset = top ?? (bottom === null ? ZERO : negate(bottom));
    if (style.box.position === "sticky") {
      const scrollport = this.#input.context.scrollport;
      const movedX = point(result.borderRect.x, inlineOffset);
      const movedY = point(result.borderRect.y, blockOffset);
      if (left !== null && movedX < point(scrollport.x, left)) {
        inlineOffset = cssCoordinateDifference(
          point(scrollport.x, left),
          result.borderRect.x,
        );
      } else if (right !== null) {
        const maximum = point(
          cssCoordinateAdd(scrollport.x, scrollport.width),
          sum(negate(right), negate(result.borderRect.width)),
        );
        if (movedX > maximum)
          inlineOffset = cssCoordinateDifference(maximum, result.borderRect.x);
      }
      if (top !== null && movedY < point(scrollport.y, top)) {
        blockOffset = cssCoordinateDifference(
          point(scrollport.y, top),
          result.borderRect.y,
        );
      } else if (bottom !== null) {
        const maximum = point(
          cssCoordinateAdd(scrollport.y, scrollport.height),
          sum(negate(bottom), negate(result.borderRect.height)),
        );
        if (movedY > maximum)
          blockOffset = cssCoordinateDifference(maximum, result.borderRect.y);
      }
      const minimumX = containingBlock.x;
      const maximumX = point(
        cssCoordinateAdd(containingBlock.x, containingBlock.width),
        negate(result.borderRect.width),
      );
      const minimumY = containingBlock.y;
      const maximumY = point(
        cssCoordinateAdd(containingBlock.y, containingBlock.height),
        negate(result.borderRect.height),
      );
      const constrainedX = cssCoordinateFromFixed(
        Math.max(
          minimumX,
          Math.min(maximumX, point(result.borderRect.x, inlineOffset)),
        ),
      );
      const constrainedY = cssCoordinateFromFixed(
        Math.max(
          minimumY,
          Math.min(maximumY, point(result.borderRect.y, blockOffset)),
        ),
      );
      inlineOffset = cssCoordinateDifference(constrainedX, result.borderRect.x);
      blockOffset = cssCoordinateDifference(constrainedY, result.borderRect.y);
    }
    this.#translate(result, inlineOffset, blockOffset, containingClip);
    // Relative and sticky positioning move the painted box without changing
    // the position it occupies in normal flow.
    return result;
  }

  #flow(
    node: FormattingNode,
    containingX: CssCoordinate,
    borderY: CssCoordinate,
    containingWidth: CssPixelLength,
    inheritedClip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
  ): LayoutResult {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const ownsFloatManager =
      this.#floatManagers.length === 0 ||
      !this.#normalBlockFlow(node) ||
      style?.box.overflowX !== "visible" ||
      style.box.overflowY !== "visible";
    const manager = ownsFloatManager
      ? new FloatExclusionManager()
      : (this.#floatManagers.at(-1) ?? new FloatExclusionManager());
    this.#floatManagers.push(manager);
    try {
      return this.#flowWithFloatManager(
        node,
        containingX,
        borderY,
        containingWidth,
        inheritedClip,
        depth,
        containingHeight,
        forcedContentWidth,
        forcedContentHeight,
        manager,
        ownsFloatManager,
      );
    } finally {
      this.#floatManagers.pop();
    }
  }

  #flowWithFloatManager(
    node: FormattingNode,
    containingX: CssCoordinate,
    borderY: CssCoordinate,
    containingWidth: CssPixelLength,
    inheritedClip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null,
    floatManager: FloatExclusionManager,
    ownsFloatManager: boolean,
  ): LayoutResult {
    const containerId = this.#newId(node.id);
    const dimensions = this.#dimensions(
      node,
      containingWidth,
      containingHeight,
      forcedContentWidth,
    );
    const borderX = point(containingX, dimensions.marginLeft);
    const contentX = point(
      borderX,
      sum(dimensions.border.left, dimensions.padding.left),
    );
    const contentY = point(
      borderY,
      sum(dimensions.border.top, dimensions.padding.top),
    );
    const specifiedContentHeight =
      forcedContentHeight ?? dimensions.specifiedHeight;
    const definiteContentHeight =
      specifiedContentHeight === null
        ? null
        : constrainedSize(
            specifiedContentHeight,
            specifiedContentHeight,
            dimensions.minHeight,
            dimensions.maxHeight,
          );
    // The final block size is not known until in-flow layout finishes. Descendant
    // clips are recomputed from the final rectangles before the tree is exposed.
    const childClip = inheritedClip;
    const nodeStyle = this.#boxComputed(node);
    const children: LayoutFragmentId[] = [];
    const deferredOutOfFlow: {
      readonly node: FormattingNode;
      readonly insertionIndex: number;
      readonly staticX: CssCoordinate;
      readonly staticY: CssCoordinate;
    }[] = [];
    let inFlowChildren = 0;
    let currentBottom = contentY;
    let pendingBottomMargin: CssPixelLength = ZERO;
    let inlineRun: FormattingNodeId[] = [];
    let firstInline = true;
    let layoutStopped = false;
    const ownedLineBoxes: LineBox[] = [];
    const floatRange = (
      lineY: CssCoordinate,
      lineHeight: CssPixelLength,
    ): {
      readonly start: CssCoordinate;
      readonly end: CssCoordinate;
    } => {
      return floatManager.availableLineRange(
        lineY,
        lineHeight,
        contentX,
        point(contentX, dimensions.contentWidth),
      );
    };
    const clearance = (value: ComputedStyle["box"]["clear"]): void => {
      if (value === "none") return;
      currentBottom = floatManager.clearedBlockStart(currentBottom, value);
    };
    const flushInline = (): boolean => {
      if (inlineRun.length === 0) return !layoutStopped;
      const style = this.#boxComputed(node) ?? this.#computed(node);
      const metrics = this.#metrics(style);
      const range = floatRange(currentBottom, this.#lineHeight(style, metrics));
      const indent =
        firstInline && style !== null
          ? (this.#usedLength(
              style.text.textIndent,
              dimensions.contentWidth,
              style,
            ) ?? ZERO)
          : ZERO;
      const continuationMaxX = range.end;
      const startX =
        style?.text.direction === "rtl"
          ? range.start
          : point(range.start, indent);
      const firstLineMaxX =
        style?.text.direction === "rtl"
          ? point(continuationMaxX, negate(indent))
          : continuationMaxX;
      let textAnalysis: InlineTextAnalysis;
      const paragraphDirection =
        style?.text.unicodeBidi === "plaintext"
          ? "auto"
          : (style?.text.direction ?? "ltr");
      try {
        textAnalysis = this.#inlineTextAnalysis(
          node.id,
          inlineRun,
          paragraphDirection,
        );
      } catch (error) {
        if (!(error instanceof LayoutBudgetExhausted)) throw error;
        inlineRun = [];
        layoutStopped = true;
        return false;
      }
      const cursor: InlineFormattingCursor = {
        containingFragment: containerId,
        containingFormattingNode: node.id,
        continuationX: range.start,
        continuationMaxX,
        lineRange: floatRange,
        maxX: firstLineMaxX,
        textAlign: style?.text.textAlign ?? "start",
        direction: style?.text.direction ?? "ltr",
        strutMetrics: metrics,
        strutLineHeight: this.#lineHeight(style, metrics),
        clipRect: childClip,
        textAnalysis,
        selectedLineBreaks: new Set<number>(),
        suppressedUnits: new Set<number>(),
        usedUnitAdvances: new Map<number, CssPixelLength>(),
        logicalUnitLimit: Number.MAX_SAFE_INTEGER,
        lineSelectionStopped: false,
        lineStartX: startX,
        x: startX,
        y: currentBottom,
        collapsedSpace: false,
        lineReserved: false,
        entries: [],
        lineBoxes: [],
      };
      this.#selectInlineLineBreaks(cursor);
      for (const child of inlineRun) {
        const result = this.#tryInline(child, cursor, childClip, depth + 1);
        if (result === null) {
          layoutStopped = true;
          break;
        }
        children.push(result.fragment);
      }
      try {
        this.#finalizeLine(cursor, false, "end-of-paragraph");
      } catch (error) {
        if (!(error instanceof LayoutBudgetExhausted)) throw error;
      }
      this.#releaseLineReservation(cursor);
      for (const line of cursor.lineBoxes) ownedLineBoxes.push(line);
      currentBottom = cursor.y;
      pendingBottomMargin = ZERO;
      inlineRun = [];
      firstInline = false;
      layoutStopped ||= cursor.lineSelectionStopped;
      return !layoutStopped;
    };
    for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (isInlineFormattingNode(child)) {
        inlineRun.push(childId);
        continue;
      }
      if (!flushInline()) break;
      const childStyle = this.#boxComputed(child);
      if (
        childStyle?.box.position === "absolute" ||
        childStyle?.box.position === "fixed"
      ) {
        deferredOutOfFlow.push({
          node: child,
          insertionIndex: children.length,
          staticX: contentX,
          staticY: currentBottom,
        });
        continue;
      }
      if (childStyle !== null && childStyle.box.float !== "none") {
        clearance(childStyle.box.clear);
        const floatEdges = this.#edges(childStyle, dimensions.contentWidth);
        const horizontalChrome = sum(
          floatEdges.padding.left,
          floatEdges.padding.right,
          floatEdges.border.left,
          floatEdges.border.right,
        );
        const toContent = (value: CssPixelLength): CssNonNegativeLength =>
          nonNegative(
            childStyle.box.boxSizing === "border-box"
              ? sum(value, negate(horizontalChrome))
              : value,
          );
        const specified = this.#usedLength(
          childStyle.box.width,
          dimensions.contentWidth,
          childStyle,
        );
        const preferred = this.#intrinsicWidth(
          childId,
          cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
        );
        const preferredMinimum = this.#intrinsicMinimumWidth(
          childId,
          cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
        );
        const available = nonNegative(
          sum(
            dimensions.contentWidth,
            negate(floatEdges.margin.left),
            negate(floatEdges.margin.right),
            negate(horizontalChrome),
          ),
        );
        let floatContentWidth =
          specified === null
            ? cssMin(preferred, cssMax(preferredMinimum, available))
            : toContent(specified);
        const minimum =
          this.#usedLength(
            childStyle.box.minWidth,
            dimensions.contentWidth,
            childStyle,
          ) ?? ZERO;
        const maximum = this.#usedLength(
          childStyle.box.maxWidth,
          dimensions.contentWidth,
          childStyle,
        );
        floatContentWidth = cssMax(floatContentWidth, toContent(minimum));
        if (maximum !== null)
          floatContentWidth = cssMin(floatContentWidth, toContent(maximum));
        const childDimensions = this.#dimensions(
          child,
          dimensions.contentWidth,
          definiteContentHeight,
          floatContentWidth,
        );
        let floatY = currentBottom;
        let range = floatRange(
          floatY,
          this.#lineHeight(childStyle, this.#metrics(childStyle)),
        );
        for (const area of floatManager.exclusions) {
          const available = nonNegative(
            cssCoordinateDifference(range.end, range.start),
          );
          const required = sum(
            childDimensions.marginLeft,
            childDimensions.contentWidth,
            childDimensions.padding.left,
            childDimensions.padding.right,
            childDimensions.border.left,
            childDimensions.border.right,
            childDimensions.marginRight,
          );
          if (required <= available) break;
          floatY = cssCoordinateFromFixed(
            Math.max(
              floatY,
              cssCoordinateAdd(area.marginRect.y, area.marginRect.height),
            ),
          );
          range = floatRange(
            floatY,
            this.#lineHeight(childStyle, this.#metrics(childStyle)),
          );
        }
        const initialX =
          childStyle.box.float === "left"
            ? range.start
            : point(
                range.end,
                negate(
                  sum(
                    childDimensions.marginLeft,
                    childDimensions.contentWidth,
                    childDimensions.padding.left,
                    childDimensions.padding.right,
                    childDimensions.border.left,
                    childDimensions.border.right,
                    childDimensions.marginRight,
                  ),
                ),
              );
        const result = this.#tryLayoutNode(
          childId,
          initialX,
          point(floatY, childDimensions.margin.top),
          dimensions.contentWidth,
          childClip,
          depth + 1,
          definiteContentHeight,
          floatContentWidth,
        );
        if (result === null) break;
        children.push(result.fragment);
        floatManager.add(
          childStyle.box.float,
          result.marginRect,
          cssRect(
            contentX,
            contentY,
            dimensions.contentWidth,
            definiteContentHeight ?? ZERO,
          ),
        );
        pendingBottomMargin = ZERO;
        continue;
      }
      clearance(childStyle?.box.clear ?? "none");
      const childMargins = this.#collapsibleMargins(
        childId,
        dimensions.contentWidth,
        definiteContentHeight,
      );
      const topMargin = childMargins.before;
      const collapseWithParent =
        inFlowChildren === 0 &&
        dimensions.border.top === 0 &&
        dimensions.padding.top === 0 &&
        this.#normalBlockFlow(node) &&
        (this.#boxComputed(node)?.box.overflowY ?? "visible") === "visible";
      const collapsed = collapseWithParent
        ? ZERO
        : collapseMargins(pendingBottomMargin, topMargin);
      const previousBorderBottom = currentBottom;
      let childY = point(currentBottom, collapsed);
      let childX = contentX;
      const sizedItem = node.kind === "flex-item" || node.kind === "grid-item";
      let childForcedWidth: CssPixelLength | null = sizedItem
        ? dimensions.contentWidth
        : null;
      const childEstablishesBlockFormattingContext =
        !this.#normalBlockFlow(child) ||
        (childStyle?.box.overflowX ?? "visible") !== "visible" ||
        (childStyle?.box.overflowY ?? "visible") !== "visible";
      if (
        childEstablishesBlockFormattingContext &&
        floatManager.exclusions.length > 0
      ) {
        const childMetrics = this.#metrics(childStyle);
        let range = floatRange(
          childY,
          this.#lineHeight(childStyle, childMetrics),
        );
        let availableWidth = nonNegative(
          cssCoordinateDifference(range.end, range.start),
        );
        const childDimensions = this.#dimensions(
          child,
          dimensions.contentWidth,
          definiteContentHeight,
        );
        const horizontalChrome = sum(
          childDimensions.padding.left,
          childDimensions.padding.right,
          childDimensions.border.left,
          childDimensions.border.right,
        );
        const specifiedOuterWidth =
          childStyle?.box.width.kind === "auto" ||
          childStyle?.box.width.kind === "none" ||
          childStyle === null
            ? null
            : sum(
                childDimensions.marginLeft,
                childDimensions.contentWidth,
                horizontalChrome,
                childDimensions.marginRight,
              );
        if (
          specifiedOuterWidth !== null &&
          specifiedOuterWidth > availableWidth
        ) {
          childY = floatManager.clearedBlockStart(childY, "both");
          range = floatRange(
            childY,
            this.#lineHeight(childStyle, childMetrics),
          );
          availableWidth = nonNegative(
            cssCoordinateDifference(range.end, range.start),
          );
        }
        childX = range.start;
        if (specifiedOuterWidth === null) {
          childForcedWidth = nonNegative(
            sum(
              availableWidth,
              negate(childDimensions.marginLeft),
              negate(childDimensions.marginRight),
              negate(horizontalChrome),
            ),
          );
        }
      }
      const result = this.#tryLayoutNode(
        childId,
        childX,
        childY,
        dimensions.contentWidth,
        childClip,
        depth + 1,
        definiteContentHeight,
        childForcedWidth,
        sizedItem ? forcedContentHeight : null,
      );
      if (result === null) break;
      children.push(result.fragment);
      inFlowChildren += 1;
      const collapsesThrough =
        childMargins.through && result.borderRect.height === 0;
      if (collapsesThrough) {
        currentBottom = previousBorderBottom;
        pendingBottomMargin = collapseMargins(
          pendingBottomMargin,
          topMargin,
          childMargins.after,
        );
      } else {
        currentBottom = cssCoordinateAdd(
          result.borderRect.y,
          result.borderRect.height,
        );
        pendingBottomMargin = childMargins.after;
      }
    }
    flushInline();
    const collapseLast =
      dimensions.border.bottom === 0 &&
      dimensions.padding.bottom === 0 &&
      dimensions.specifiedHeight === null &&
      dimensions.minHeight === 0 &&
      this.#normalBlockFlow(node) &&
      (this.#boxComputed(node)?.box.overflowY ?? "visible") === "visible";
    if (!collapseLast)
      currentBottom = point(currentBottom, pendingBottomMargin);
    if (ownsFloatManager)
      currentBottom = floatManager.maximumBlockEnd(currentBottom);
    const contentHeight =
      forcedContentHeight === null
        ? constrainedSize(
            nonNegative(cssCoordinateDifference(currentBottom, contentY)),
            dimensions.specifiedHeight,
            dimensions.minHeight,
            dimensions.maxHeight,
          )
        : nonNegative(forcedContentHeight);
    const contentRect = cssRect(
      contentX,
      contentY,
      dimensions.contentWidth,
      contentHeight,
    );
    if (ownsFloatManager) floatManager.finalizeContainingBlock(contentRect);
    const paddingRect = cssRect(
      point(contentX, negate(dimensions.padding.left)),
      point(contentY, negate(dimensions.padding.top)),
      sum(
        dimensions.contentWidth,
        dimensions.padding.left,
        dimensions.padding.right,
      ),
      sum(contentHeight, dimensions.padding.top, dimensions.padding.bottom),
    );
    const borderRect = cssRect(
      point(paddingRect.x, negate(dimensions.border.left)),
      point(paddingRect.y, negate(dimensions.border.top)),
      sum(paddingRect.width, dimensions.border.left, dimensions.border.right),
      sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom),
    );
    const marginRect = cssRect(
      point(borderRect.x, negate(dimensions.marginLeft)),
      point(borderRect.y, negate(dimensions.margin.top)),
      sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight),
      sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom),
    );
    const finalClip = this.#clip(node, paddingRect, borderRect, inheritedClip);
    if (nodeStyle?.box.position !== "static")
      this.#positionedContainingBlocks.set(node.id, paddingRect);
    let insertedOutOfFlow = 0;
    for (const deferred of deferredOutOfFlow) {
      const positioned = this.#layoutOutOfFlow(
        deferred.node,
        deferred.staticX,
        deferred.staticY,
        finalClip,
        depth + 1,
      );
      if (positioned === null) break;
      children.splice(
        deferred.insertionIndex + insertedOutOfFlow,
        0,
        positioned.fragment,
      );
      insertedOutOfFlow += 1;
    }
    return this.#container(
      node,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      finalClip,
      children,
      ownedLineBoxes,
      containerId,
    );
  }

  #gridFormattingContext(
    node: FormattingNode,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
  ): LayoutResult {
    return layoutGridContainer(
      {
        budgets: this.#budgets,
        signal: this.#input.signal,
        formattingNode: (id) => this.#formatting.node(id),
        computed: (candidate) => this.#computed(candidate),
        boxComputed: (candidate) => this.#boxComputed(candidate),
        dimensions: (
          candidate,
          containingWidth,
          containingHeight,
          forcedWidth,
        ) =>
          this.#dimensions(
            candidate,
            containingWidth,
            containingHeight,
            forcedWidth,
          ),
        usedGap: (value, basis, computed) =>
          this.#usedGap(value, basis, computed),
        usedLength: (value, basis, computed) =>
          this.#usedLength(value, basis, computed),
        isOutOfFlow: (candidate) => this.#outOfFlow(candidate),
        intrinsicContributions: (id, availableInlineSize) =>
          this.#intrinsicContributions(id, availableInlineSize),
        gridItemMinimumInlineContribution: (id, contributions) =>
          this.#gridItemMinimumInlineContribution(id, contributions),
        edges: (computed, containingWidth) =>
          this.#edges(computed, containingWidth),
        clip: (candidate, paddingRect, borderRect, inheritedClip) =>
          this.#clip(candidate, paddingRect, borderRect, inheritedClip),
        registerPositionedContainingBlock: (id, paddingRect) => {
          this.#positionedContainingBlocks.set(id, paddingRect);
        },
        layoutChild: (
          id,
          childX,
          childY,
          childWidth,
          childClip,
          childDepth,
          containingHeight,
          forcedWidth,
          forcedHeight,
        ) =>
          this.#tryLayoutNode(
            id,
            childX,
            childY,
            childWidth,
            childClip,
            childDepth,
            containingHeight,
            forcedWidth,
            forcedHeight,
          ),
        translate: (result, inlineOffset, blockOffset, containingClip) =>
          this.#translate(result, inlineOffset, blockOffset, containingClip),
        fragment: (id) => this.#fragments.get(id),
        layoutOutOfFlow: (
          candidate,
          staticX,
          staticY,
          inheritedClip,
          childDepth,
          containingBlock,
        ) =>
          this.#layoutOutOfFlow(
            candidate,
            staticX,
            staticY,
            inheritedClip,
            childDepth,
            containingBlock,
          ),
        container: (
          candidate,
          contentRect,
          paddingRect,
          borderRect,
          marginRect,
          clipRect,
          children,
          lineBoxes,
        ) =>
          this.#container(
            candidate,
            contentRect,
            paddingRect,
            borderRect,
            marginRect,
            clipRect,
            children,
            lineBoxes,
          ),
        withGridBudget: (operation) => this.#gridBudget(operation),
      },
      {
        node,
        x,
        y,
        width,
        clip,
        depth,
        forcedContentWidth,
        forcedContentHeight,
      },
    );
  }

  #flexItemInput(
    childId: FormattingNodeId,
    sourceIndex: number,
    axes: FlexAxes,
    containingWidth: CssPixelLength,
    definiteMainSize: CssPixelLength | null,
  ): FlexItemInput<FormattingNodeId> {
    const child = this.#formatting.node(childId);
    const style = this.#boxComputed(child) ?? this.#computed(child);
    const edges = this.#edges(style, containingWidth);
    const horizontalChrome = sum(
      edges.padding.left,
      edges.padding.right,
      edges.border.left,
      edges.border.right,
    );
    const verticalChrome = sum(
      edges.padding.top,
      edges.padding.bottom,
      edges.border.top,
      edges.border.bottom,
    );
    const rowAxis = axes.row;
    const toContent = (value: CssPixelLength): CssNonNegativeLength =>
      nonNegative(
        style?.box.boxSizing === "border-box"
          ? sum(value, negate(rowAxis ? horizontalChrome : verticalChrome))
          : value,
      );
    const intrinsic = rowAxis
      ? this.#intrinsicWidth(
          childId,
          cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
        )
      : this.#intrinsicBlockSize(childId, containingWidth);
    const basisValue = style?.box.flexBasis;
    const basisFromProperty =
      basisValue === undefined ||
      basisValue.kind === "auto" ||
      basisValue.kind === "none"
        ? null
        : basisValue.kind === "content"
          ? intrinsic
          : this.#usedLength(basisValue, definiteMainSize, style);
    const preferred = rowAxis ? style?.box.width : style?.box.height;
    const preferredValue =
      preferred === undefined ||
      preferred.kind === "auto" ||
      preferred.kind === "none"
        ? null
        : this.#usedLength(
            preferred,
            rowAxis ? containingWidth : definiteMainSize,
            style,
          );
    const base = toContent(basisFromProperty ?? preferredValue ?? intrinsic);
    const minimumProperty = rowAxis
      ? style?.box.minWidth
      : style?.box.minHeight;
    const automaticMinimum = rowAxis
      ? cssMin(
          this.#intrinsicMinimumWidth(
            childId,
            cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
          ),
          preferredValue === null ? intrinsic : toContent(preferredValue),
        )
      : intrinsic;
    const minimum =
      minimumProperty === undefined || minimumProperty.kind === "auto"
        ? nonNegative(automaticMinimum)
        : toContent(
            this.#usedLength(
              minimumProperty,
              rowAxis ? containingWidth : definiteMainSize,
              style,
            ) ?? ZERO,
          );
    const maximumProperty = rowAxis
      ? style?.box.maxWidth
      : style?.box.maxHeight;
    const maximumValue =
      maximumProperty === undefined ||
      maximumProperty.kind === "none" ||
      maximumProperty.kind === "auto"
        ? null
        : this.#usedLength(
            maximumProperty,
            rowAxis ? containingWidth : definiteMainSize,
            style,
          );
    const maximum = maximumValue === null ? null : toContent(maximumValue);
    const hypothetical = constrainedSize(base, null, minimum, maximum);
    const mainStart = edges.margin[axes.mainStart];
    const mainEnd = edges.margin[axes.mainEnd];
    const marginStartProperty = style?.box.margin[axes.mainStart];
    const marginEndProperty = style?.box.margin[axes.mainEnd];
    return Object.freeze({
      identity: childId,
      sourceIndex,
      order: style?.box.order ?? 0,
      flexBaseSize: base,
      hypotheticalMainSize: hypothetical,
      minimumMainSize: minimum,
      maximumMainSize: maximum,
      mainBorderPadding: nonNegative(
        rowAxis ? horizontalChrome : verticalChrome,
      ),
      flexGrow: style?.box.flexGrow ?? 0,
      flexShrink: style?.box.flexShrink ?? 1,
      marginMainStart: mainStart,
      marginMainEnd: mainEnd,
      autoMarginMainStart: marginStartProperty?.kind === "auto",
      autoMarginMainEnd: marginEndProperty?.kind === "auto",
    });
  }

  #flexCrossOffset(
    item: ResolvedFlexItem<FormattingNodeId>,
    outerCrossSize: CssPixelLength,
    lineCrossSize: CssPixelLength,
    axes: FlexAxes,
    containerStyle: ComputedStyle | null,
    baselineOffset: CssPixelLength,
    lineBaseline: CssPixelLength,
  ): CssPixelLength {
    const child = this.#formatting.node(item.identity);
    const style = this.#boxComputed(child) ?? this.#computed(child);
    const startProperty = style?.box.margin[axes.crossStart];
    const endProperty = style?.box.margin[axes.crossEnd];
    const free = sum(lineCrossSize, negate(outerCrossSize));
    const autoStart = startProperty?.kind === "auto";
    const autoEnd = endProperty?.kind === "auto";
    if (free > 0 && autoStart && autoEnd) return cssDivide(free, 2);
    if (free > 0 && autoStart) return free;
    if (autoEnd) return ZERO;
    const alignment =
      style?.box.alignSelf.position === "auto" || style?.box.alignSelf === undefined
        ? (containerStyle?.box.alignItems ?? Object.freeze({ position: "stretch" as const, overflow: "default" as const }))
        : style.box.alignSelf;
    const align = alignment.position === "normal" || alignment.position === "auto"
      ? "stretch"
      : alignment.position;
    if (align === "baseline" && axes.row)
      return cssMax(ZERO, sum(lineBaseline, negate(baselineOffset)));
    const safe = free < 0 && alignment.overflow === "safe";
    const logical = safe ? ZERO
      : align === "center" ? cssDivide(free, 2)
        : align === "end" ? free : ZERO;
    return axes.crossReverse ? sum(free, negate(logical)) : logical;
  }

  #discardLayoutSubtree(root: LayoutFragmentId): void {
    const discarded = new Set<LayoutFragmentId>();
    const affectedFormattingNodes = new Set<FormattingNodeId>();
    const affectedDocumentNodes = new Set<DocumentNodeRef>();
    const pending = [root];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || discarded.has(id)) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      discarded.add(id);
      affectedFormattingNodes.add(fragment.formattingNode);
      if (fragment.documentNode !== null)
        affectedDocumentNodes.add(fragment.documentNode);
      pending.push(...fragment.children);
      if (fragment.kind === "text") this.#textFragments -= 1;
      for (const line of fragment.lineBoxes) {
        this.#lineFragments = Math.max(
          0,
          this.#lineFragments - line.fragments.length,
        );
        this.#visualRuns = Math.max(
          0,
          this.#visualRuns - line.visualRuns.length,
        );
      }
      this.#fragments.delete(id);
      this.#parentIndex.delete(id);
      this.#inlineDecorations.delete(id);
      this.#stackingMetadata.delete(id);
      if (this.#principalFragments.get(fragment.formattingNode) === id) {
        this.#principalFragments.delete(fragment.formattingNode);
      }
    }
    for (const formatting of affectedFormattingNodes) {
      const ids = this.#formattingIndex.get(formatting);
      if (ids === undefined) continue;
      const retained = ids.filter((id) => !discarded.has(id));
      if (retained.length === 0) this.#formattingIndex.delete(formatting);
      else this.#formattingIndex.set(formatting, retained);
    }
    for (const documentNode of affectedDocumentNodes) {
      const ids = this.#documentIndex.get(documentNode);
      if (ids === undefined) continue;
      const retained = ids.filter((id) => !discarded.has(id));
      if (retained.length === 0) this.#documentIndex.delete(documentNode);
      else this.#documentIndex.set(documentNode, retained);
    }
    const retainedLines = this.#lineBoxes.filter(
      (line) =>
        !discarded.has(line.containingFragment) &&
        line.fragments.every((id) => !discarded.has(id)),
    );
    this.#lineBoxes.splice(0, this.#lineBoxes.length, ...retainedLines);
    this.#lineBoxPositions.clear();
    for (const [index, line] of this.#lineBoxes.entries())
      this.#lineBoxPositions.set(line.id, index);
  }

  #layoutFlex(
    node: FormattingNode,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
  ): LayoutResult {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    if (style === null)
      throw new Error("A flex formatting context requires a computed style.");
    const dimensions = this.#dimensions(node, width, null, forcedContentWidth);
    const borderX = point(x, dimensions.marginLeft);
    const contentX = point(
      borderX,
      sum(dimensions.border.left, dimensions.padding.left),
    );
    const contentY = point(
      y,
      sum(dimensions.border.top, dimensions.padding.top),
    );
    const axes = flexAxes(style);
    const rowAxis = axes.row;
    const mainGap =
      this.#usedGap(
        rowAxis ? style.box.columnGap : style.box.rowGap,
        dimensions.contentWidth,
        style,
      ) ?? ZERO;
    const crossGap =
      this.#usedGap(
        rowAxis ? style.box.rowGap : style.box.columnGap,
        dimensions.contentWidth,
        style,
      ) ?? ZERO;
    const definiteBlockSize = forcedContentHeight ?? dimensions.specifiedHeight;
    const flexItems = node.children.filter(
      (child) => !this.#outOfFlow(this.#formatting.node(child)),
    );
    const outOfFlow = node.children.filter((child) =>
      this.#outOfFlow(this.#formatting.node(child)),
    );
    const preliminary = flexItems.map((child, sourceIndex) =>
      this.#flexItemInput(
        child,
        sourceIndex,
        axes,
        dimensions.contentWidth,
        rowAxis ? dimensions.contentWidth : definiteBlockSize,
      ),
    );
    let mainSize: CssNonNegativeLength;
    if (rowAxis) mainSize = nonNegative(dimensions.contentWidth);
    else if (definiteBlockSize !== null)
      mainSize = nonNegative(definiteBlockSize);
    else {
      let automatic: CssPixelLength = cssMultiply(
        mainGap,
        Math.max(0, preliminary.length - 1),
      );
      for (const item of preliminary)
        automatic = sum(
          automatic,
          item.hypotheticalMainSize,
          item.mainBorderPadding,
          item.autoMarginMainStart ? ZERO : item.marginMainStart,
          item.autoMarginMainEnd ? ZERO : item.marginMainEnd,
        );
      mainSize = nonNegative(automatic);
    }
    let lines;
    try {
      lines = resolveFlexLines({
        items: preliminary,
        containerMainSize: mainSize,
        gap: nonNegative(mainGap),
        wrap: style.box.flexWrap,
        reverse: axes.mainReverse,
        justifyContent: style.box.justifyContent,
        maxSizingWork: this.#budgets.maxFlexSizingWork,
        ...(this.#input.signal === undefined
          ? {}
          : { signal: this.#input.signal }),
      });
    } catch (error) {
      if (!(error instanceof FlexSizingBudgetExceeded)) throw error;
      this.#truncated ??= "maxFlexSizingWork";
      throw new LayoutBudgetExhausted();
    }
    const children: LayoutFragmentId[] = [];
    const laidOutLines: {
      readonly results: {
        readonly item: ResolvedFlexItem<FormattingNodeId>;
        result: LayoutResult;
        outerCross: CssPixelLength;
        baseline: CssPixelLength;
        readonly stretches: boolean;
        readonly containingX: CssCoordinate;
        readonly borderY: CssCoordinate;
        readonly crossWidth: CssPixelLength;
        readonly childIndex: number;
      }[];
      readonly naturalCrossStart: CssPixelLength;
      crossSize: CssNonNegativeLength;
    }[] = [];
    let crossCursor: CssPixelLength = ZERO;
    for (const line of lines) {
      const laidOut: {
        readonly item: ResolvedFlexItem<FormattingNodeId>;
        result: LayoutResult;
        outerCross: CssPixelLength;
        baseline: CssPixelLength;
        readonly stretches: boolean;
        readonly containingX: CssCoordinate;
        readonly borderY: CssCoordinate;
        readonly crossWidth: CssPixelLength;
        readonly childIndex: number;
      }[] = [];
      let lineCross: CssPixelLength = ZERO;
      for (const item of line.items) {
        const child = this.#formatting.node(item.identity);
        const childStyle = this.#boxComputed(child) ?? this.#computed(child);
        const childEdges = this.#edges(childStyle, dimensions.contentWidth);
        const alignment = usedItemAlignment(
          childStyle?.box.alignSelf.position === "auto" ||
            childStyle?.box.alignSelf === undefined
            ? style.box.alignItems
            : childStyle.box.alignSelf,
        );
        const crossProperty = rowAxis
          ? childStyle?.box.height
          : childStyle?.box.width;
        const crossMarginStart = rowAxis
          ? childStyle?.box.margin.top
          : childStyle?.box.margin.left;
        const crossMarginEnd = rowAxis
          ? childStyle?.box.margin.bottom
          : childStyle?.box.margin.right;
        const stretches =
          alignment === "stretch" &&
          (crossProperty === undefined ||
            crossProperty.kind === "auto" ||
            crossProperty.kind === "none") &&
          crossMarginStart?.kind !== "auto" &&
          crossMarginEnd?.kind !== "auto";
        const crossWidth = rowAxis
          ? item.targetMainSize
          : this.#intrinsicWidth(item.identity, dimensions.contentWidth);
        const containingX = rowAxis
          ? point(
              contentX,
              sum(item.mainOffset, negate(childEdges.margin.left)),
            )
          : point(contentX, crossCursor);
        const borderY = rowAxis
          ? point(contentY, sum(crossCursor, childEdges.margin.top))
          : point(contentY, item.mainOffset);
        const result = this.#tryLayoutNode(
          item.identity,
          containingX,
          borderY,
          crossWidth,
          clip,
          depth + 1,
          rowAxis ? null : mainSize,
          rowAxis ? item.targetMainSize : crossWidth,
          rowAxis ? null : item.targetMainSize,
        );
        if (result === null) break;
        const childIndex = children.length;
        children.push(result.fragment);
        const fragment = this.#fragments.get(result.fragment);
        const outerCross = rowAxis
          ? result.marginRect.height
          : result.marginRect.width;
        const baseline =
          rowAxis &&
          fragment?.baseline !== null &&
          fragment?.baseline !== undefined
            ? sum(
                cssCoordinateDifference(
                  fragment.borderRect.y,
                  result.marginRect.y,
                ),
                fragment.baseline,
              )
            : outerCross;
        laidOut.push({
          item,
          result,
          outerCross,
          baseline,
          stretches,
          containingX,
          borderY,
          crossWidth,
          childIndex,
        });
        lineCross = cssMax(lineCross, outerCross);
      }
      let lineBaseline: CssPixelLength = ZERO;
      for (const entry of laidOut)
        lineBaseline = cssMax(lineBaseline, entry.baseline);
      laidOutLines.push({
        results: laidOut,
        naturalCrossStart: crossCursor,
        crossSize: nonNegative(lineCross),
      });
      crossCursor = sum(crossCursor, lineCross, crossGap);
    }
    if (laidOutLines.length > 0)
      crossCursor = sum(crossCursor, negate(crossGap));
    const automaticContentHeight = rowAxis
      ? nonNegative(crossCursor)
      : mainSize;
    const contentHeight =
      forcedContentHeight === null
        ? constrainedSize(
            automaticContentHeight,
            dimensions.specifiedHeight,
            dimensions.minHeight,
            dimensions.maxHeight,
          )
        : nonNegative(forcedContentHeight);
    const availableCrossSize = rowAxis
      ? contentHeight
      : dimensions.contentWidth;
    let usedCrossSize = crossCursor;
    if (
      laidOutLines.length > 0 &&
      availableCrossSize > usedCrossSize &&
      (laidOutLines.length === 1 ||
        style.box.alignContent.value === "stretch" ||
        style.box.alignContent.value === "normal")
    ) {
      let free = sum(availableCrossSize, negate(usedCrossSize));
      let remainingLines = laidOutLines.length;
      for (const line of laidOutLines) {
        const addition = cssDivide(free, remainingLines);
        line.crossSize = nonNegative(sum(line.crossSize, addition));
        free = sum(free, negate(addition));
        remainingLines -= 1;
      }
      usedCrossSize = availableCrossSize;
    }
    if (laidOutLines.length > 0) {
      const free = sum(availableCrossSize, negate(usedCrossSize));
      const count = laidOutLines.length;
      const contentAlignment = usedGridContentAlignment(style.box.alignContent);
      const align = free < 0 && contentAlignment.overflow === "safe"
        ? "start"
        : contentAlignment.value;
      const leading =
        align === "end"
          ? free
          : align === "center"
            ? cssDivide(free, 2)
            : free > 0 && align === "space-around"
              ? cssDivide(free, count * 2)
              : free > 0 && align === "space-evenly"
                ? cssDivide(free, count + 1)
                : ZERO;
      const between =
        free > 0 && align === "space-between" && count > 1
          ? cssDivide(free, count - 1)
          : free > 0 && align === "space-around"
            ? cssDivide(free, count)
            : free > 0 && align === "space-evenly"
              ? cssDivide(free, count + 1)
              : ZERO;
      let expandedCrossStart: CssPixelLength = ZERO;
      for (const [index, line] of laidOutLines.entries()) {
        const logicalLinePosition = sum(
          expandedCrossStart,
          leading,
          cssMultiply(between, index),
        );
        const linePosition = axes.crossReverse
          ? sum(
              availableCrossSize,
              negate(logicalLinePosition),
              negate(line.crossSize),
            )
          : logicalLinePosition;
        const lineOffset = sum(linePosition, negate(line.naturalCrossStart));
        for (const entry of line.results) {
          if (entry.stretches) {
            const child = this.#formatting.node(entry.item.identity);
            const childStyle =
              this.#boxComputed(child) ?? this.#computed(child);
            const childEdges = this.#edges(childStyle, dimensions.contentWidth);
            const crossChrome = rowAxis
              ? sum(
                  childEdges.margin.top,
                  childEdges.border.top,
                  childEdges.padding.top,
                  childEdges.padding.bottom,
                  childEdges.border.bottom,
                  childEdges.margin.bottom,
                )
              : sum(
                  childEdges.margin.left,
                  childEdges.border.left,
                  childEdges.padding.left,
                  childEdges.padding.right,
                  childEdges.border.right,
                  childEdges.margin.right,
                );
            const forcedCrossSize = nonNegative(
              sum(line.crossSize, negate(crossChrome)),
            );
            const previous = entry.result.fragment;
            const previousFragment = this.#fragments.get(previous);
            const previousCrossSize = rowAxis
              ? previousFragment?.contentRect.height
              : previousFragment?.contentRect.width;
            if (previousCrossSize === forcedCrossSize) continue;
            this.#discardLayoutSubtree(previous);
            const relaid = this.#tryLayoutNode(
              entry.item.identity,
              entry.containingX,
              entry.borderY,
              rowAxis ? entry.crossWidth : dimensions.contentWidth,
              clip,
              depth + 1,
              rowAxis ? null : mainSize,
              rowAxis ? entry.item.targetMainSize : forcedCrossSize,
              rowAxis ? forcedCrossSize : entry.item.targetMainSize,
            );
            if (relaid === null) continue;
            entry.result = relaid;
            children[entry.childIndex] = relaid.fragment;
            entry.outerCross = rowAxis
              ? entry.result.marginRect.height
              : entry.result.marginRect.width;
            const fragment = this.#fragments.get(relaid.fragment);
            entry.baseline =
              rowAxis &&
              fragment?.baseline !== null &&
              fragment?.baseline !== undefined
                ? sum(
                    cssCoordinateDifference(
                      fragment.borderRect.y,
                      relaid.marginRect.y,
                    ),
                    fragment.baseline,
                  )
                : entry.outerCross;
          }
        }
        let lineBaseline: CssPixelLength = ZERO;
        for (const entry of line.results)
          lineBaseline = cssMax(lineBaseline, entry.baseline);
        for (const entry of line.results) {
          const itemOffset = this.#flexCrossOffset(
            entry.item,
            entry.outerCross,
            line.crossSize,
            axes,
            style,
            entry.baseline,
            lineBaseline,
          );
          if (rowAxis)
            this.#translate(
              entry.result,
              ZERO,
              sum(lineOffset, itemOffset),
              clip,
            );
          else
            this.#translate(
              entry.result,
              sum(lineOffset, itemOffset),
              ZERO,
              clip,
            );
        }
        expandedCrossStart = sum(expandedCrossStart, line.crossSize, crossGap);
      }
    }
    const contentRect = cssRect(
      contentX,
      contentY,
      dimensions.contentWidth,
      contentHeight,
    );
    const paddingRect = cssRect(
      point(contentX, negate(dimensions.padding.left)),
      point(contentY, negate(dimensions.padding.top)),
      sum(
        dimensions.contentWidth,
        dimensions.padding.left,
        dimensions.padding.right,
      ),
      sum(contentHeight, dimensions.padding.top, dimensions.padding.bottom),
    );
    const borderRect = cssRect(
      point(paddingRect.x, negate(dimensions.border.left)),
      point(paddingRect.y, negate(dimensions.border.top)),
      sum(paddingRect.width, dimensions.border.left, dimensions.border.right),
      sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom),
    );
    const marginRect = cssRect(
      point(borderRect.x, negate(dimensions.marginLeft)),
      point(borderRect.y, negate(dimensions.margin.top)),
      sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight),
      sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom),
    );
    const finalClip = this.#clip(node, paddingRect, borderRect, clip);
    if (this.#boxComputed(node)?.box.position !== "static") {
      this.#positionedContainingBlocks.set(node.id, paddingRect);
    }
    for (const child of outOfFlow) {
      const outOfFlowNode = this.#formatting.node(child);
      const childStyle =
        this.#boxComputed(outOfFlowNode) ?? this.#computed(outOfFlowNode);
      const childEdges = this.#edges(childStyle, dimensions.contentWidth);
      const childDimensions = this.#dimensions(
        outOfFlowNode,
        dimensions.contentWidth,
        contentHeight,
      );
      const staticContentWidth =
        childStyle?.box.width.kind === "auto" ||
        childStyle?.box.width.kind === "none"
          ? this.#intrinsicWidth(child, dimensions.contentWidth)
          : childDimensions.contentWidth;
      const staticContentHeight =
        childStyle?.box.height.kind === "auto" ||
        childStyle?.box.height.kind === "none"
          ? this.#intrinsicBlockSize(child, staticContentWidth)
          : (childDimensions.specifiedHeight ?? ZERO);
      const outerWidth = sum(
        staticContentWidth,
        childEdges.padding.left,
        childEdges.padding.right,
        childEdges.border.left,
        childEdges.border.right,
        childEdges.margin.left,
        childEdges.margin.right,
      );
      const outerHeight = sum(
        staticContentHeight,
        childEdges.padding.top,
        childEdges.padding.bottom,
        childEdges.border.top,
        childEdges.border.bottom,
        childEdges.margin.top,
        childEdges.margin.bottom,
      );
      const outerMain = rowAxis ? outerWidth : outerHeight;
      const mainFree = sum(mainSize, negate(outerMain));
      const leadingMain = singleFlexItemAlignmentOffset(
        mainFree,
        style.box.justifyContent,
      );
      const mainOffset = axes.mainReverse
        ? sum(mainSize, negate(leadingMain), negate(outerMain))
        : leadingMain;
      const alignment = usedItemAlignment(
        childStyle?.box.alignSelf.position === "auto" ||
          childStyle?.box.alignSelf === undefined
          ? style.box.alignItems
          : childStyle.box.alignSelf,
      );
      const outerCross = rowAxis ? outerHeight : outerWidth;
      const crossFree = sum(availableCrossSize, negate(outerCross));
      const crossAlignment =
        childStyle?.box.alignSelf.position === "auto" || childStyle?.box.alignSelf === undefined
          ? style.box.alignItems
          : childStyle.box.alignSelf;
      const safeCross = crossFree < 0 && crossAlignment.overflow === "safe";
      const logicalCrossOffset =
        safeCross
          ? ZERO
          : alignment === "center"
          ? cssDivide(crossFree, 2)
          : alignment === "end"
            ? crossFree
            : ZERO;
      const crossOffset = axes.crossReverse
        ? sum(crossFree, negate(logicalCrossOffset))
        : logicalCrossOffset;
      const staticX = rowAxis
        ? point(contentX, mainOffset)
        : point(contentX, crossOffset);
      const staticY = rowAxis
        ? point(contentY, crossOffset)
        : point(contentY, mainOffset);
      const result = this.#layoutOutOfFlow(
        outOfFlowNode,
        staticX,
        staticY,
        finalClip,
        depth + 1,
      );
      if (result === null) break;
      children.push(result.fragment);
    }
    return this.#container(
      node,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      finalClip,
      children,
      [],
    );
  }

  #layoutNode(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null = null,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
  ): LayoutResult {
    this.#reserve();
    try {
      this.#input.signal?.throwIfAborted();
      const node = this.#formatting.node(id);
      if (depth > this.#budgets.maxDepth) {
        this.#truncated ??= "maxDepth";
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(node, empty, empty, empty, empty, clip, [], []);
      }
      if (this.#visuallyClipped(node, width)) {
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(node, empty, empty, empty, empty, empty, [], []);
      }
      if (
        node.kind === "text-sequence" ||
        node.kind === "generated-text" ||
        node.kind === "marker" ||
        node.kind === "forced-line-break" ||
        node.kind === "line-break-opportunity" ||
        node.kind === "form-control" ||
        node.kind === "replaced-element" ||
        node.kind === "image-fallback"
      ) {
        const cursor: InlineFormattingCursor = {
          containingFragment: this.#newId(node.id, "atomic-context"),
          containingFormattingNode: node.id,
          continuationX: x,
          continuationMaxX: point(x, width),
          maxX: point(x, width),
          x,
          y,
          textAlign: this.#computed(node)?.text.textAlign ?? "start",
          direction: this.#computed(node)?.text.direction ?? "ltr",
          strutMetrics: this.#metrics(this.#computed(node)),
          strutLineHeight: this.#lineHeight(
            this.#computed(node),
            this.#metrics(this.#computed(node)),
          ),
          clipRect: clip,
          textAnalysis: this.#inlineTextAnalysis(
            node.id,
            [id],
            this.#computed(node)?.text.unicodeBidi === "plaintext"
              ? "auto"
              : (this.#computed(node)?.text.direction ?? "ltr"),
          ),
          selectedLineBreaks: new Set<number>(),
          suppressedUnits: new Set<number>(),
          lineStartX: x,
          collapsedSpace: false,
          lineReserved: false,
          logicalUnitLimit: Number.MAX_SAFE_INTEGER,
          lineSelectionStopped: false,
          usedUnitAdvances: new Map<number, CssPixelLength>(),
          entries: [],
          lineBoxes: [],
        };
        this.#selectInlineLineBreaks(cursor);
        const result = this.#inlineReserved(id, cursor, clip, depth + 1);
        try {
          this.#finalizeLine(cursor, false, "end-of-paragraph");
        } catch (error) {
          if (!(error instanceof LayoutBudgetExhausted)) throw error;
        }
        this.#releaseLineReservation(cursor);
        return result;
      }
      if (node.kind === "table-wrapper") {
        return this.#tableFormattingContext(
          node as TableWrapperFormattingNode,
          x,
          y,
          width,
          clip,
          depth,
        );
      }
      if (
        node.kind === "table-column" ||
        node.kind === "table-column-group" ||
        node.kind === "table-header-group" ||
        node.kind === "table-body-group" ||
        node.kind === "table-footer-group" ||
        node.kind === "table-row"
      ) {
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(
          node,
          empty,
          empty,
          empty,
          empty,
          clip,
          [],
          [],
        );
      }
      if (node.kind === "flex-container") {
        return this.#layoutFlex(
          node,
          x,
          y,
          width,
          clip,
          depth,
          forcedContentWidth,
          forcedContentHeight,
        );
      }
      if (node.kind === "grid-container") {
        return this.#gridFormattingContext(
          node,
          x,
          y,
          width,
          clip,
          depth,
          forcedContentWidth,
          forcedContentHeight,
        );
      }
      return this.#flow(
        node,
        x,
        y,
        width,
        clip,
        depth,
        containingHeight,
        forcedContentWidth,
        forcedContentHeight,
      );
    } finally {
      this.#reserved -= 1;
    }
  }

  #tryLayoutNode(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null = null,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
  ): LayoutResult | null {
    try {
      const result = this.#layoutNode(
        id,
        x,
        y,
        width,
        clip,
        depth,
        containingHeight,
        forcedContentWidth,
        forcedContentHeight,
      );
      return result;
    } catch (error) {
      if (error instanceof LayoutBudgetExhausted) return null;
      throw error;
    }
  }

  #applyFinalInFlowPositions(root: LayoutFragmentId): void {
    const pending = [root];
    while (pending.length > 0) {
      this.#input.signal?.throwIfAborted();
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      const node = this.#formatting.node(fragment.formattingNode);
      const positioned = this.#applyInFlowPosition(
        node,
        {
          fragment: id,
          borderRect: fragment.borderRect,
          marginRect: fragment.marginRect,
        },
        this.#documentCanvasClip(),
      );
      const current = this.#fragments.get(positioned.fragment);
      if (current === undefined) continue;
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
  }

  #buildStackingMetadata(root: LayoutFragmentId): void {
    let sourceOrder = 0;
    const pending: {
      readonly id: LayoutFragmentId;
      readonly containingContext: LayoutFragmentId | null;
      readonly root: boolean;
    }[] = [{ id: root, containingContext: null, root: true }];
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) continue;
      const fragment = this.#fragments.get(entry.id);
      if (fragment === undefined) continue;
      const text = fragment.kind === "text";
      const node = text
        ? null
        : this.#formatting.node(fragment.formattingNode);
      const boxStyle = node === null ? null : this.#boxComputed(node);
      const flexOrGridItem =
        node?.kind === "flex-item" || node?.kind === "grid-item";
      // A generated flex/grid-item record carries its principal box's
      // z-index participation, but it is not independently positioned.
      const itemStyle = flexOrGridItem ? this.#computed(node) : boxStyle;
      const position = boxStyle?.box.position ?? "static";
      const positioned = position !== "static";
      const integerLevel = itemStyle?.box.zIndex ?? null;
      const establishes =
        entry.root ||
        position === "fixed" ||
        position === "sticky" ||
        ((position === "relative" || position === "absolute") &&
          integerLevel !== null) ||
        (flexOrGridItem && integerLevel !== null);
      const stackLevel = establishes
        ? (integerLevel ?? 0)
        : positioned
          ? (integerLevel ?? 0)
          : null;
      const phase = entry.root
        ? "context-background-border"
        : establishes && (stackLevel ?? 0) < 0
          ? "negative-stack-level"
          : establishes && (stackLevel ?? 0) > 0
            ? "positive-stack-level"
            : establishes || positioned
              ? "positioned-auto-zero"
              : boxStyle?.box.float !== undefined &&
                  boxStyle.box.float !== "none"
                ? "float"
                : node?.outer === "inline" || text
                  ? "inline"
                  : "in-flow-block";
      this.#stackingMetadata.set(
        entry.id,
        Object.freeze({
          establishesStackingContext: establishes,
          stackLevel,
          sourceOrder: sourceOrder++,
          containingStackingContext: entry.containingContext,
          positionedDescendantsRemainInAncestor: positioned && !establishes,
          paintPhase: phase,
        }),
      );
      const nextContext = establishes ? entry.id : entry.containingContext;
      for (let index = fragment.children.length - 1; index >= 0; index -= 1) {
        const child = fragment.children[index];
        if (child !== undefined)
          pending.push({
            id: child,
            containingContext: nextContext,
            root: false,
          });
      }
    }
  }

  #refreshInlineContinuationGeometry(root: LayoutFragmentId): void {
    const sameRect = (left: CssRect, right: CssRect): boolean =>
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height;
    // Inline decorations are registered after their descendants, so insertion
    // order is already the required bottom-up continuation-finalization order.
    for (const [id, decoration] of this.#inlineDecorations) {
      const fragment = this.#fragments.get(id);
      if (fragment === undefined || fragment.kind === "text") continue;
      const continuations = this.#inlineContinuationGeometry(
        decoration,
        fragment.children,
      );
      const contentRect = this.#unionContinuationRectangles(
        continuations,
        "contentRect",
        fragment.contentRect,
      );
      const undecorated =
        emptyEdges(decoration.margin) &&
        emptyEdges(decoration.padding) &&
        emptyEdges(decoration.border);
      const paddingRect = undecorated
        ? contentRect
        : this.#unionContinuationRectangles(
            continuations,
            "paddingRect",
            contentRect,
          );
      const borderRect = undecorated
        ? contentRect
        : this.#unionContinuationRectangles(
            continuations,
            "borderRect",
            paddingRect,
          );
      const marginRect = undecorated
        ? contentRect
        : this.#unionContinuationRectangles(
            continuations,
            "marginRect",
            borderRect,
          );
      let overflowRect = borderRect;
      for (const child of fragment.children) {
        const childOverflow = this.#fragments.get(child)?.overflowRect;
        if (childOverflow !== undefined)
          overflowRect = unionOverflowRect(overflowRect, childOverflow);
      }
      this.#fragments.set(id, {
        ...fragment,
        contentRect,
        paddingRect,
        borderRect,
        marginRect,
        overflowRect,
        inlineContinuations: Object.freeze(continuations),
      });
    }
    // Recompute every inherited clip after final block sizes, relative/sticky
    // offsets, and deferred out-of-flow descendants are known.
    const clipped: {
      readonly id: LayoutFragmentId;
      readonly inherited: CssRect;
    }[] = [
      {
        id: root,
        inherited: this.#documentCanvasClip(),
      },
    ];
    while (clipped.length > 0) {
      const entry = clipped.pop();
      if (entry === undefined) continue;
      const fragment = this.#fragments.get(entry.id);
      if (fragment === undefined) continue;
      let clipRect = entry.inherited;
      if (fragment.kind !== "text") {
        const node = this.#formatting.node(fragment.formattingNode);
        if (node.appliesBoxStyle) {
          clipRect = this.#clip(
            node,
            fragment.paddingRect,
            fragment.borderRect,
            entry.inherited,
          );
        }
      }
      if (!sameRect(fragment.clipRect, clipRect)) {
        this.#fragments.set(entry.id, { ...fragment, clipRect });
      }
      for (const child of fragment.children)
        clipped.push({ id: child, inherited: clipRect });
    }
  }

  #documentCanvasClip(): CssRect {
    const initial = this.#input.context.initialContainingBlock;
    return cssRect(
      initial.x,
      initial.y,
      initial.width,
      cssLengthFromFixed(Number.MAX_SAFE_INTEGER),
    );
  }

  public build(): LayoutFragmentTree {
    const context = this.#input.context;
    const valid =
      Number.isSafeInteger(context.viewport.width) &&
      context.viewport.width > 0 &&
      Number.isSafeInteger(context.viewport.height) &&
      context.viewport.height > 0 &&
      Number.isSafeInteger(context.initialContainingBlock.x) &&
      Number.isSafeInteger(context.initialContainingBlock.y) &&
      Number.isSafeInteger(context.initialContainingBlock.width) &&
      context.initialContainingBlock.width > 0 &&
      Number.isSafeInteger(context.initialContainingBlock.height) &&
      context.initialContainingBlock.height > 0 &&
      context.initialContainingBlock.width === context.viewport.width &&
      context.initialContainingBlock.height === context.viewport.height &&
      Number.isSafeInteger(context.scrollport.x) &&
      Number.isSafeInteger(context.scrollport.y) &&
      Number.isSafeInteger(context.scrollport.width) &&
      context.scrollport.width > 0 &&
      Number.isSafeInteger(context.scrollport.height) &&
      context.scrollport.height > 0 &&
      context.scrollport.width === context.viewport.width &&
      context.scrollport.height === context.viewport.height;
    if (!valid)
      return ImmutableLayoutFragmentTree.rejected(
        this.#input,
        "invalid-context",
      );
    let root: LayoutResult | null = null;
    try {
      root = this.#layoutNode(
        this.#formatting.root,
        context.initialContainingBlock.x,
        context.initialContainingBlock.y,
        context.initialContainingBlock.width,
        this.#documentCanvasClip(),
        0,
        context.initialContainingBlock.height,
      );
    } catch (error) {
      if (!(error instanceof LayoutBudgetExhausted)) throw error;
    }
    if (root === null)
      return ImmutableLayoutFragmentTree.rejected(
        this.#input,
        "invalid-context",
      );
    this.#refreshInlineContinuationGeometry(root.fragment);
    if (this.#hasInFlowPositioning) {
      this.#applyFinalInFlowPositions(root.fragment);
      this.#refreshInlineContinuationGeometry(root.fragment);
    }
    this.#buildStackingMetadata(root.fragment);
    const outcome: LayoutOutcome =
      this.#truncated === null
        ? {
            status: "complete",
            fragments: this.#fragments.size,
            lineBoxes: this.#lineBoxes.length,
          }
        : {
            status: "truncated",
            fragments: this.#fragments.size,
            lineBoxes: this.#lineBoxes.length,
            budget: this.#truncated,
            limit: this.#budgets[this.#truncated],
          };
    return new ImmutableLayoutFragmentTree(
      this.#input,
      root.fragment,
      this.#fragments,
      this.#formattingIndex,
      this.#documentIndex,
      this.#parentIndex,
      this.#lineBoxes,
      this.#stackingMetadata,
      outcome,
      this.#rootFontMetrics,
    );
  }
}

class ImmutableLayoutFragmentTree implements LayoutFragmentTree {
  readonly formatting: FormattingTree;
  readonly context: BuildLayoutFragmentTreeInput["context"];
  readonly rootFontMetrics: UsedFontMetrics;
  readonly root: LayoutFragmentId;
  readonly lineBoxes: readonly LineBox[];
  readonly outcome: LayoutOutcome;
  readonly #fragments: ReadonlyMap<LayoutFragmentId, LayoutFragment>;
  readonly #parents: ReadonlyMap<LayoutFragmentId, LayoutFragmentId>;
  readonly #formattingIndex: ReadonlyMap<
    FormattingNodeId,
    readonly LayoutFragmentId[]
  >;
  readonly #documentIndex: ReadonlyMap<
    DocumentNodeRef,
    readonly LayoutFragmentId[]
  >;
  readonly #stackingMetadata: ReadonlyMap<
    LayoutFragmentId,
    LayoutStackingMetadata
  >;

  public constructor(
    input: BuildLayoutFragmentTreeInput,
    root: LayoutFragmentId,
    fragments: ReadonlyMap<LayoutFragmentId, LayoutFragment>,
    formattingIndex: ReadonlyMap<FormattingNodeId, readonly LayoutFragmentId[]>,
    documentIndex: ReadonlyMap<DocumentNodeRef, readonly LayoutFragmentId[]>,
    parentIndex: ReadonlyMap<LayoutFragmentId, LayoutFragmentId>,
    lineBoxes: readonly LineBox[],
    stackingMetadata: ReadonlyMap<LayoutFragmentId, LayoutStackingMetadata>,
    outcome: LayoutOutcome,
    rootMetrics: UsedFontMetrics,
  ) {
    this.formatting = input.formatting;
    this.context = Object.freeze({
      ...input.context,
      viewport: Object.freeze({ ...input.context.viewport }),
      initialContainingBlock: Object.freeze({
        ...input.context.initialContainingBlock,
      }),
      scrollport: Object.freeze({ ...input.context.scrollport }),
    });
    this.rootFontMetrics = Object.freeze({ ...rootMetrics });
    this.root = root;
    const complete = outcome.status === "complete";
    const reachable = new Set<LayoutFragmentId>();
    if (!complete) {
      const pending = [root];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || reachable.has(id)) continue;
        const fragment = fragments.get(id);
        if (fragment === undefined) continue;
        reachable.add(id);
        for (const child of fragment.children) pending.push(child);
      }
    }
    if (complete) {
      for (const fragment of fragments.values()) Object.freeze(fragment);
      for (const ids of formattingIndex.values()) Object.freeze(ids);
      for (const ids of documentIndex.values()) Object.freeze(ids);
      this.#fragments = fragments;
      this.#formattingIndex = formattingIndex;
      this.#documentIndex = documentIndex;
    } else {
      const immutableFragments = new Map<LayoutFragmentId, LayoutFragment>();
      for (const [id, fragment] of fragments) {
        if (reachable.has(id))
          immutableFragments.set(id, Object.freeze(fragment));
      }
      this.#fragments = immutableFragments;
      const retainedFormatting = new Map<
        FormattingNodeId,
        readonly LayoutFragmentId[]
      >();
      for (const [node, ids] of formattingIndex) {
        const retained = ids.filter((id) => reachable.has(id));
        if (retained.length > 0)
          retainedFormatting.set(node, Object.freeze(retained));
      }
      this.#formattingIndex = retainedFormatting;
      const retainedDocument = new Map<
        DocumentNodeRef,
        readonly LayoutFragmentId[]
      >();
      for (const [node, ids] of documentIndex) {
        const retained = ids.filter((id) => reachable.has(id));
        if (retained.length > 0)
          retainedDocument.set(node, Object.freeze(retained));
      }
      this.#documentIndex = retainedDocument;
    }
    const retainedLines = complete
      ? lineBoxes
      : lineBoxes.filter(
          (line) =>
            reachable.has(line.containingFragment) &&
            line.fragments.every((id) => reachable.has(id)),
        );
    this.lineBoxes = Object.freeze(retainedLines);
    this.#stackingMetadata = complete
      ? stackingMetadata
      : new Map([...stackingMetadata].filter(([id]) => reachable.has(id)));
    this.outcome = Object.freeze(
      outcome.status === "complete"
        ? {
            ...outcome,
            fragments: fragments.size,
            lineBoxes: retainedLines.length,
          }
        : outcome.status === "truncated"
          ? {
              ...outcome,
              fragments: reachable.size,
              lineBoxes: retainedLines.length,
            }
          : outcome,
    );
    this.#parents = complete
      ? parentIndex
      : new Map(
          [...parentIndex].filter(
            ([child, parent]) => reachable.has(child) && reachable.has(parent),
          ),
        );
    Object.freeze(this);
  }

  public static rejected(
    input: BuildLayoutFragmentTreeInput,
    reason: Extract<LayoutOutcome, { readonly status: "rejected" }>["reason"],
  ): LayoutFragmentTree {
    const id = fragmentId("layout-fragment:rejected");
    const empty = cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), ZERO, ZERO);
    const fragment: LayoutBoxFragment = Object.freeze({
      id,
      kind: "box",
      formattingNode: input.formatting.root,
      documentNode: null,
      pseudoElement: null,
      sourceRange: null,
      contentStartCodeUnit: null,
      contentEndCodeUnit: null,
      contentRect: empty,
      paddingRect: empty,
      borderRect: empty,
      marginRect: empty,
      overflowRect: empty,
      clipRect: empty,
      children: Object.freeze([]),
      lineBoxes: Object.freeze([]),
      usedFontMetrics: null,
      baseline: null,
      visualOrder: 0,
      paintOrder: 0,
      action: null,
      semantic: null,
      style: Object.freeze({
        visible: false,
        foreground: null,
        background: null,
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        borderColors: { top: null, right: null, bottom: null, left: null },
        borderStyles: { top: "none" as const, right: "none" as const, bottom: "none" as const, left: "none" as const },
      }),
      minContentContribution: ZERO,
      maxContentContribution: ZERO,
    });
    return new ImmutableLayoutFragmentTree(
      input,
      id,
      new Map([[id, fragment]]),
      new Map(),
      new Map(),
      new Map(),
      [],
      new Map([
        [
          id,
          Object.freeze({
            establishesStackingContext: true,
            stackLevel: 0,
            sourceOrder: 0,
            containingStackingContext: null,
            positionedDescendantsRemainInAncestor: false,
            paintPhase: "context-background-border",
          }),
        ],
      ]),
      { status: "rejected", reason },
      REJECTED_FONT_METRICS,
    );
  }

  public fragment(id: LayoutFragmentId): LayoutFragment {
    const fragment = this.#fragments.get(id);
    if (fragment === undefined)
      throw new RangeError(`Unknown layout fragment: ${id}`);
    return fragment;
  }

  public parent(id: LayoutFragmentId): LayoutFragment | null {
    const parent = this.#parents.get(id);
    return parent === undefined ? null : this.fragment(parent);
  }

  public children(id: LayoutFragmentId): readonly LayoutFragment[] {
    return this.fragment(id).children.map((child) => this.fragment(child));
  }

  public stacking(id: LayoutFragmentId): LayoutStackingMetadata {
    const metadata = this.#stackingMetadata.get(id);
    if (metadata === undefined)
      throw new RangeError(`Unknown layout stacking metadata: ${id}`);
    return metadata;
  }

  public forFormattingNode(node: FormattingNodeId): readonly LayoutFragment[] {
    return (this.#formattingIndex.get(node) ?? []).map((id) =>
      this.fragment(id),
    );
  }

  public forDocumentNode(node: DocumentNodeRef): readonly LayoutFragment[] {
    return (this.#documentIndex.get(node) ?? []).map((id) => this.fragment(id));
  }
}

export function buildLayoutFragmentTree(
  input: BuildLayoutFragmentTreeInput,
): LayoutFragmentTree {
  if (input.inlineItemStreams.formatting !== input.formatting) {
    return ImmutableLayoutFragmentTree.rejected(input, "invalid-context");
  }
  const budgets = normalizeBudgets(input.context.budgets);
  if (budgets === null)
    return ImmutableLayoutFragmentTree.rejected(input, "invalid-budget");
  try {
    return new LayoutBuilder(input, budgets).build();
  } catch (error) {
    if (error instanceof IntrinsicSizingCycleError) {
      return ImmutableLayoutFragmentTree.rejected(
        input,
        "intrinsic-sizing-cycle",
      );
    }
    if (error instanceof RangeError) {
      return ImmutableLayoutFragmentTree.rejected(
        input,
        "invalid-fixed-point-input",
      );
    }
    throw error;
  }
}
