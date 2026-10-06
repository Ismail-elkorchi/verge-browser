import type { LayoutContainingBlock } from "./containing-block.js";
import { LayoutTextClusters, EMPTY_TEXT_CLUSTERS } from "./text-clusters.js";
import { PackedRows, ValueSequence, checkPackedCapacity, checkPackedMetadata } from "../../memory/packed.js";
import { createPaintStyleSharing, formattingComputedStyle, computedPaintBackground } from "./paint-style.js";
import { evaluateUsedCssMath } from "./length-math.js";
import type { CssOverflow } from "../style/types.js";
import { clipsOverflow, isScrollableOverflow } from "../style/overflow.js";
import { registerRetainedOwner, registerRetainedCache, RetainedCacheMap } from "../../memory/retained-cost.js";
import type {
  DocumentNodeRef,
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
  isAtomicFormattingNode,
  isInlineFormattingNode,
} from "../formatting/index.js";
import {
  bidiClass,
  BidiItemsBuilder,
  BidiOrderIndices,
  bidiVisualOrderForLine,
  bidiLineTrailingResetStart,
  buildLineBreakMap,
  mirroredBidiText,
  resolveBidiParagraphs,
  type BidiClass,
  type BidiItem,
  type BidiParagraphCollection,
  type BreakOpportunityKind,
  type LineBreakTailoring,
} from "../../unicode/index.js";
import { processCssText } from "../text/index.js";
import type { InlineItem, InlineItemStream, ProcessedCssText, LogicalTextUnit, InlineItemStreamSet } from "../text/index.js";
import type {
  ComputedStyle,
  CssGap,
  CssLength,
  CssLengthPercentageExpression,
} from "../style/index.js";
import {
  InvalidCssNumericInput,
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
  CssTextMeasurer,
  CssControlMetrics,
  LayoutBoxFragment,
  LayoutControlTextLine,
  LayoutClipChain,
  LayoutBudgets,
  LayoutFragment,
  LayoutFragmentId,
  LayoutFragmentTree,
  InlineContinuationGeometry,
  LayoutOutcome,
  LayoutPaintStyle,
  LayoutScrollAttachment,
  LayoutScrollOwner,
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
import { selectLogicalLines, type LogicalLineSelectionItem } from "./line-selection.js";
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

interface InlineVerticalMetrics {
  readonly lineHeight: CssPixelLength;
  readonly ascent: CssPixelLength;
  readonly descent: CssPixelLength;
  readonly baselineShift: CssPixelLength;
}

interface InlineLineEntry extends InlineVerticalMetrics {
  readonly fragment: LayoutFragmentId;
  readonly metrics: UsedFontMetrics;
  readonly verticalAlign: ComputedStyle["text"]["verticalAlign"];
  readonly bidiParagraph: number;
  readonly bidiItemStart: number;
  readonly bidiItemEnd: number;
}

// Empty immutable collections carry no document identity and are safe to share.
const EMPTY_FRAGMENT_CHILDREN: readonly LayoutFragmentId[] = Object.freeze([]);
const EMPTY_FRAGMENT_LINES: readonly LineBox[] = Object.freeze([]);

interface InlineBidiPosition {
  readonly paragraph: number;
  readonly item: number;
}

/** Private packed storage, never exposed for mutation by artifact consumers. */
class InlineBidiPositions {
  readonly #paragraphs: BidiParagraphCollection<number>["paragraphs"];
  public constructor(paragraphs: BidiParagraphCollection<number>["paragraphs"]) {
    checkPackedMetadata(80, this); this.#paragraphs = paragraphs; Object.freeze(this); registerRetainedOwner(this, [paragraphs], () => 16);
  }
  public at(index: number): InlineBidiPosition | undefined {
    if (index < 0) return undefined;
    let low = 0, high = this.#paragraphs.length;
    while (low < high) { const middle = (low + high) >>> 1;
      if ((this.#paragraphs[middle]?.itemEnd ?? 0) <= index) low = middle + 1; else high = middle; }
    const slice = this.#paragraphs[low];
    return slice === undefined || index < slice.itemStart ? undefined : { paragraph: low, item: index - slice.itemStart };
  }
}

interface InlineTextNodeAnalysis {
  readonly start: number;
  readonly end: number;
}

/** Layout offsets reference the immutable source item rather than copying its text identity. */
interface InlineLogicalUnit {
  readonly logicalIndex: number;
  readonly advance: CssPixelLength;
  readonly streamIndex: number;
  readonly item: InlineItem & { readonly formattingNode: FormattingNodeId };
  readonly bidiItemStart: number;
  readonly bidiItemEnd: number;
  readonly lineStartCodeUnit: number;
  readonly lineEndCodeUnit: number;
}

interface AtomicTextRange { readonly unit: LogicalTextUnit; readonly start: number; readonly end: number; }
class AtomicTextRanges {
  readonly #rows = new PackedRows(2);
  readonly #text: ProcessedCssText;
  public constructor(text: ProcessedCssText) { this.#text = text; }
  public get length(): number { return this.#rows.length; }
  public push(start: number, end: number): void { this.#rows.push(start, end); }
  public within(start: number, end: number): AtomicTextRange[] {
    let low = 0, high = this.length;
    while (low < high) { const middle = (low + high) >>> 1;
      if (this.#rows.get(middle, 0) < start) low = middle + 1; else high = middle; }
    const ranges: AtomicTextRange[] = [];
    for (let index = low; index < this.length && this.#rows.get(index, 1) <= end; index += 1) {
      const unit = this.#text.units.at(index);
      if (unit?.kind === "text" || unit?.kind === "tab") ranges.push({ unit, start: this.#rows.get(index, 0), end: this.#rows.get(index, 1) });
    }
    return ranges;
  }
}

class InlineLogicalUnits extends ValueSequence<InlineLogicalUnit> {
  readonly #rows: PackedRows;
  readonly #advances: PackedRows;
  readonly stream: InlineItemStream;
  public constructor(stream: InlineItemStream, rows: PackedRows, advances: PackedRows) {
    super(); checkPackedMetadata(148, this); this.stream = stream; this.#rows = rows; this.#advances = advances;
    registerRetainedOwner(this, [rows, advances], () => 32); Object.freeze(this);
  }
  public get length(): number { return this.#rows.length; }
  public at(index: number): InlineLogicalUnit | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const item = this.stream.items.at(this.#rows.get(index, 0));
    if (item?.formattingNode === null || item === undefined) return undefined;
    return { logicalIndex: index, advance: this.#advances.get(index, 0) as CssPixelLength, streamIndex: this.#rows.get(index, 0), item: item as InlineLogicalUnit["item"],
      bidiItemStart: this.#rows.get(index, 1), bidiItemEnd: this.#rows.get(index, 2),
      lineStartCodeUnit: this.#rows.get(index, 3), lineEndCodeUnit: this.#rows.get(index, 4) };
  }
  public itemKind(identity: number | undefined): InlineItem["kind"] | undefined {
    return identity === undefined || identity < 0 ? undefined : this.stream.items.at(identity)?.kind;
  }
  public forBidiItem(item: number): InlineLogicalUnit | undefined {
    let low = 0, high = this.length;
    while (low < high) { const middle = (low + high) >>> 1;
      if (this.#rows.get(middle, 2) <= item) low = middle + 1; else high = middle; }
    const unit = this.at(low);
    return unit !== undefined && unit.bidiItemStart <= item ? unit : undefined;
  }
}

interface InlineTextAnalysis {
  readonly bidi: BidiParagraphCollection<number>;
  readonly textNodes: ReadonlyMap<FormattingNodeId, InlineTextNodeAnalysis>;
  readonly positions: InlineBidiPositions;
  readonly logicalUnits: InlineLogicalUnits;
  readonly breaksBefore: InlineBreaks;
  readonly resourceCounts: {
    readonly bidiItems: number;
    readonly bidiRuns: number;
    readonly graphemeClusters: number;
    readonly breakOpportunities: number;
  };
}

const BREAK_KINDS: readonly BreakOpportunityKind[] = ["prohibited", "allowed", "mandatory", "emergency"];
class InlineBreaks {
  readonly #values: Uint8Array;
  public constructor(values: readonly BreakOpportunityKind[]) {
    checkPackedCapacity(values.length + 208, this); this.#values = Uint8Array.from(values, (value) => BREAK_KINDS.indexOf(value));
    registerRetainedOwner(this, [this.#values], () => 16); Object.freeze(this);
  }
  public at(index: number): BreakOpportunityKind | undefined {
    const value = this.#values[index]; return value === undefined ? undefined : BREAK_KINDS[value];
  }
}
class IntrinsicLineItems extends ValueSequence<LogicalLineSelectionItem> {
  readonly #rows: PackedRows;
  readonly #vertical: readonly InlineVerticalMetrics[];
  public readonly length: number;
  public constructor(rows: PackedRows, vertical: readonly InlineVerticalMetrics[]) {
    super(); checkPackedMetadata(148, this);
    this.#rows = rows.seal(); this.#vertical = Object.freeze(vertical); this.length = rows.length;
    registerRetainedOwner(this, [rows, this.#vertical], () => 24); Object.freeze(this);
  }
  public at(index: number): LogicalLineSelectionItem | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const flags = this.#rows.get(index, 3), tab = this.#rows.get(index, 1);
    return { logicalIndex: index, advance: this.#rows.get(index, 0) as CssPixelLength,
      tabInterval: tab < 0 ? null : tab as CssPixelLength, breakBefore: BREAK_KINDS[flags & 3] ?? "prohibited",
      forcedBreak: (flags & 4) !== 0, collapsibleSpace: (flags & 8) !== 0, wrappingAllowed: (flags & 16) !== 0 };
  }
  public vertical(index: number): InlineVerticalMetrics {
    const value = this.#vertical[this.#rows.get(index, 2)];
    if (value === undefined) throw new RangeError("Missing intrinsic inline vertical metrics.");
    return value;
  }
  public hasContent(index: number): boolean { return (this.#rows.get(index, 3) & 32) !== 0; }
}
interface IntrinsicRunAnalysis {
  readonly minContent: CssPixelLength;
  readonly maxContent: CssPixelLength;
  readonly items: IntrinsicLineItems;
}
const INTRINSIC_RUN_CACHE = new WeakMap<InlineItemStreamSet, RetainedCacheMap<string, IntrinsicRunAnalysis>>();
const TEXT_METRIC_IDENTITIES = new WeakMap<object, number>();
let nextTextMetricIdentity = 0;
function textMetricIdentity(owner: object, key: string): number {
  const value = (owner as Record<string, object>)[key];
  if (value === undefined) throw new RangeError("Missing text-metric dependency.");
  let identity = TEXT_METRIC_IDENTITIES.get(value);
  if (identity === undefined) { identity = ++nextTextMetricIdentity; TEXT_METRIC_IDENTITIES.set(value, identity); }
  return identity;
}
/** Exact callable identity plus resolved metric values participates in every text-dependent cache key. */
export function textMeasurementDependencyKey(measurer: CssTextMeasurer, metrics: UsedFontMetrics): string {
  return [textMetricIdentity(measurer, "measure"), textMetricIdentity(measurer, "fontMetrics"), textMetricIdentity(measurer, "defaultFontMetrics"),
    metrics.fontSize, metrics.chAdvance, metrics.xHeight, metrics.ascent, metrics.descent, metrics.lineGap, metrics.baseline].join(":");
}
const INLINE_TEXT_ANALYSIS_CACHE = new WeakMap<
  InlineItemStream,
  RetainedCacheMap<string, InlineTextAnalysis>
>();
const PAINT_STYLE_CACHE = new WeakMap<
  FormattingTree,
  RetainedCacheMap<FormattingNodeId, LayoutPaintStyle>
>();

function formattingCache<K, V>(
  caches: WeakMap<FormattingTree, RetainedCacheMap<K, V>>,
  formatting: FormattingTree,
): Map<K, V> {
  const cached = caches.get(formatting);
  if (cached !== undefined) return cached;
  const created = new RetainedCacheMap<K, V>();
  caches.set(formatting, created);
  registerRetainedCache(formatting, created);
  return created;
}

interface InlineFormattingCursor {
  readonly containingBlock: LayoutContainingBlock;
  readonly forcedContentWidth?: CssPixelLength | null;
  readonly forcedContentHeight?: CssPixelLength | null;
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
  readonly lineLevelOverrides: Map<number, number>;
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

interface FlexNaturalLineMeasurement {
  readonly inputs: readonly (number | string | boolean | null)[];
  readonly crossSizes: readonly CssNonNegativeLength[];
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
      throw new InvalidCssNumericInput(
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
  const size = value.kind === "zero" ? ZERO :
    value.kind === "length" && value.unit === "px"
      ? cssPx(value.value)
      : initial.fontSize;
  return checkedFontMetrics(input.context.textMeasurer.fontMetrics(size));
}

/** The authored table wrapper owns outer-box behavior; anonymous fixup boxes do not. */
function ownsOuterBoxStyle(node: FormattingNode): boolean {
  return node.kind === "table-wrapper"
    ? node.source !== null
    : node.appliesBoxStyle && node.kind !== "table";
}

/** Transforms apply to box-generating elements except non-replaced inline boxes and columns. */
function hasTransform(tree: FormattingTree, node: FormattingNode, style: ComputedStyle | null): boolean {
  return ownsOuterBoxStyle(node) && style?.box.transform != null
    && node.kind !== "table-column" && node.kind !== "table-column-group"
    && (node.outer !== "inline" || isAtomicInlineBox(tree, node));
}

function hasOverflowBox(tree: FormattingTree, node: FormattingNode): boolean {
  return ownsOuterBoxStyle(node) && (node.outer !== "inline" || isAtomicInlineBox(tree, node));
}

function hasPaintContainment(tree: FormattingTree, node: FormattingNode, style: ComputedStyle | null): boolean {
  return ownsOuterBoxStyle(node) && style?.box.contain === "paint"
    && node.kind !== "table-column" && node.kind !== "table-column-group"
    && (node.outer !== "inline" || isAtomicInlineBox(tree, node));
}

function viewportOverflowSource(formatting: FormattingTree): DocumentNodeRef | null {
  const root = formatting.document.documentElement;
  if (root === null) return null;
  const rootStyle = formatting.styles.style(root);
  if (rootStyle.display.box === "none") return null;
  const body = formatting.document.body;
  const bodyStyle = body === null ? null : formatting.styles.style(body);
  return rootStyle.box.overflowX === "visible" && rootStyle.box.overflowY === "visible"
    && rootStyle.box.contain === "none" && bodyStyle?.box.contain === "none"
    && bodyStyle.display.box !== "none" ? body : root;
}

class LayoutBuilder {
  readonly #viewportOverflowSource: DocumentNodeRef | null;
  readonly #input: BuildLayoutFragmentTreeInput;
  readonly #formatting: FormattingTree;
  readonly #budgets: LayoutBudgets;
  readonly #rootFontMetrics: UsedFontMetrics;
  readonly #fontMetricsCache = new Map<CssPixelLength, UsedFontMetrics>();
  readonly #tableGridStyles = new Map<ComputedStyle, ComputedStyle>();
  readonly #textAdvanceCache = new Map<string, CssNonNegativeLength>();
  readonly #fragments = new Map<LayoutFragmentId, LayoutFragment>();
  readonly #clipChains = new Map<LayoutFragmentId, LayoutClipChain>();
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
  readonly #paintStyles = createPaintStyleSharing();

  readonly #marginProfileCache = new Map<string, CollapsibleMarginProfile>();
  readonly #intrinsicContributionCache: IntrinsicContributionCache;
  readonly #tableSlotGridCache = new Map<FormattingNodeId, TableSlotGrid>();
  readonly #imageDimensionDependencies = new Set<string>();
  readonly #containingBlocks = new Map<FormattingNodeId, LayoutContainingBlock>();
  readonly #ownedContainingBlocks = new Map<FormattingNodeId, Set<LayoutContainingBlock>>();
  readonly #indefiniteBlockConsumers = new WeakSet<LayoutContainingBlock>();
  readonly #blockDefinitenessTransfers = new WeakMap<LayoutContainingBlock, Set<LayoutContainingBlock>>();
  readonly #blockDefinitenessParents = new WeakMap<LayoutContainingBlock, LayoutContainingBlock>();
  readonly #flexNaturalLines = new Map<FormattingNodeId, FlexNaturalLineMeasurement[]>();
  #flexNaturalLineUnits = 0;
  readonly #positionedContainingBlocks = new Map<FormattingNodeId, CssRect>();
  readonly #deferredPositioned = new Map<LayoutFragmentId, { readonly node: FormattingNode; readonly depth: number }>();
  readonly #principalFragments = new Map<FormattingNodeId, LayoutFragmentId>();
  readonly #outsideMarkers = new Map<LayoutFragmentId, FormattingNodeId>();
  readonly #stackingMetadata = new Map<
    LayoutFragmentId,
    LayoutStackingMetadata
  >();
  readonly #scrollAttachments = new Map<
    LayoutFragmentId,
    LayoutScrollAttachment
  >();
  readonly #floatManagers: FloatExclusionManager[] = [];
  readonly #tableWork = new Map<TableBudgetName, number>();
  readonly #tableBorderOverrides = new Map<FormattingNodeId, TableBorderOverride>();
  readonly #tableCollapsedBorderSegments = new Map<
    FormattingNodeId,
    readonly LayoutTableCollapsedBorderSegment[]
  >();
  readonly #textAnalysisWork = { intrinsicCalls: 0, intrinsicReuses: 0, intrinsicAnalyzedUnits: 0, inlineBuilds: 0, inlineReuses: 0 };
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
    this.#viewportOverflowSource = viewportOverflowSource(input.formatting);
    this.#budgets = budgets;
    this.#paintStyleCache = formattingCache(
      PAINT_STYLE_CACHE,
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
    if (value.kind !== "text") {
      const node = this.#formatting.node(value.formattingNode);
      const position = this.#boxComputed(node)?.box.position;
      if (this.#hasTransform(node) || position === "relative" || position === "sticky") this.#hasInFlowPositioning = true;
    }
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
    return formattingComputedStyle(node, this.#formatting.styles);
  }

  #hasTransform(node: FormattingNode): boolean {
    return hasTransform(this.#formatting, node, this.#computed(node));
  }

  #paintContainment(node: FormattingNode): boolean {
    return hasPaintContainment(this.#formatting, node, this.#boxComputed(node));
  }

  #independentFormattingContext(node: FormattingNode): boolean {
    const box = this.#boxComputed(node)?.box;
    return this.#paintContainment(node) || (hasOverflowBox(this.#formatting, node) && box !== undefined && (isScrollableOverflow(box.overflowX) || isScrollableOverflow(box.overflowY)));
  }

  #establishesPositionedContainingBlock(node: FormattingNode): boolean {
    const style = this.#boxComputed(node);
    return (style !== null && style.box.position !== "static") || this.#hasTransform(node) || this.#paintContainment(node);
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
      cache = new RetainedCacheMap<string, InlineTextAnalysis>();
      INLINE_TEXT_ANALYSIS_CACHE.set(stream, cache);
      registerRetainedCache(stream, cache);
      registerRetainedCache(this.#input.inlineItemStreams, cache);
    }
    const cacheKey = [
      direction,
      this.#textMetricKey(),
      this.#budgets.maxCodePointsPerBidiParagraph,
      this.#budgets.maxBidiItems,
      this.#budgets.maxBidiEmbeddingDepth,
      this.#budgets.maxBidiRuns,
      this.#budgets.maxGraphemeClusters,
      this.#budgets.maxBreakOpportunities,
    ].join("\u0000");
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      this.#textAnalysisWork.inlineReuses += 1;
      this.#reserveInlineTextAnalysis(cached);
      return cached;
    }
    this.#textAnalysisWork.inlineBuilds += 1;
    const itemBuilder = new BidiItemsBuilder<number>(stream.items.length);
    const textNodeRecords = new Map<FormattingNodeId, { start: number; end: number }>();
    const logicalRows = new PackedRows(5, false, Math.max(1, Math.min(128, stream.items.length)));
    const advances = new PackedRows(1, true, Math.max(1, Math.min(128, stream.items.length)));
    const logicalUnits = new InlineLogicalUnits(stream, logicalRows, advances);
    let streamIndex = 0;
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
    const plaintextStarts: number[] = [];
    const append = (
      bidiType: BidiClass,
      text: string,
      codePoint: number | null,
      identity: InlineItem | null,
    ): number => {
      if (itemBuilder.length >= this.#budgets.maxBidiItems - this.#bidiItems) {
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
      const logicalIndex = itemBuilder.length;
      itemBuilder.push(
        Object.freeze({
          kind:
            codePoint !== null && identity?.kind !== "atomic-inline"
              ? "code-point"
              : identity?.kind === "atomic-inline"
                ? "atomic-inline"
                : "structural-control",
          text,
          codePoint,
          bidiClass: bidiType,
          sourceStartCodeUnit: identity?.contentStartCodeUnit ?? 0,
          sourceEndCodeUnit: identity?.contentEndCodeUnit ?? 0,
          identity: identity === null ? -1 : streamIndex,
        }),
      );
      if (codePoint !== null) paragraphCodePoints += 1;
      if (bidiType === "B") paragraphCodePoints = 0;
      return logicalIndex;
    };
    const appendUnit = (
      node: FormattingNode,
      kind: "text" | "tab" | "soft-hyphen" | "atomic-inline" | "forced-break" | "break-opportunity",
      text: string,
      item: InlineItem,
    ): void => {
      const bidiItemStart = itemBuilder.length;
      if (kind === "forced-break") {
        append("B", "", null, item);
      } else if (kind === "break-opportunity") {
        append("BN", "", null, item);
      } else if (kind === "atomic-inline") {
        append("ON", text, 0xfffc, item);
      } else {
        for (const character of text) {
          const codePoint = character.codePointAt(0);
          if (codePoint === undefined) continue;
          append(bidiClass(codePoint), character, codePoint, item);
        }
      }
      const lineValue =
        kind === "forced-break"
          ? "\n"
          : kind === "break-opportunity"
            ? "\u200b"
            : text;
      if (item.formattingNode === null) throw new RangeError("Logical layout units require a formatting node.");
      advances.push(kind === "text" ? this.#measure(text, this.#fontSize(this.#computed(node))) : ZERO);
      const logicalIndex = logicalRows.push(streamIndex, bidiItemStart, itemBuilder.length, logicalText.length, logicalText.length + lineValue.length);
      const record = textNodeRecords.get(node.id) ?? { start: logicalIndex, end: logicalIndex + 1 };
      record.end = logicalIndex + 1; textNodeRecords.set(node.id, record);
      if (this.#computed(node)?.text.unicodeBidi === "plaintext") plaintextStarts.push(bidiItemStart);
      logicalText += lineValue;
    };
    const control = (type: BidiClass): void => {
      append(type, "", null, null);
    };
    for (const [itemIndex, item] of stream.items.entries()) {
      streamIndex = itemIndex;
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
        appendUnit(node, "atomic-inline", "\ufffc", item);
        continue;
      }
      if (item.kind === "forced-line-break") {
        const record = textNodeRecords.get(node.id) ?? {
          start: logicalUnits.length, end: logicalUnits.length,
        };
        textNodeRecords.set(node.id, record);
        appendUnit(
            node,
            "forced-break",
            "",
            item,
          );
        record.end = logicalUnits.length;
        continue;
      }
      if (item.kind === "break-opportunity") {
        appendUnit(node, "break-opportunity", "", item);
        continue;
      }
      const record = textNodeRecords.get(node.id) ?? {
        start: logicalUnits.length, end: logicalUnits.length,
      };
      textNodeRecords.set(node.id, record);
      appendUnit(
          node,
          item.kind === "soft-hyphen"
            ? "soft-hyphen"
            : item.kind === "tab"
              ? "tab"
              : "text",
          item.text,
          item,
        );
      record.end = logicalUnits.length;
    }
    logicalRows.seal(); advances.seal();
    const items = itemBuilder.finish();
    const graphemeClusterBoundaries = [
      0,
      ...Array.from({ length: logicalRows.length }, (_, index) => logicalRows.get(index, 4)),
    ];
    let tailoringUnit = 0;
    const tailoringByNode = new Map<FormattingNodeId | null, LineBreakTailoring>();
    const lineBreakMap = buildLineBreakMap(
      logicalText,
      ({ codeUnitOffset }) => {
        while (tailoringUnit + 1 < logicalRows.length && logicalRows.get(tailoringUnit + 1, 3) <= codeUnitOffset) tailoringUnit += 1;
        const index = tailoringUnit < logicalRows.length && logicalRows.get(tailoringUnit, 4) <= codeUnitOffset
          ? Math.min(tailoringUnit + 1, logicalRows.length - 1) : tailoringUnit;
        const id = index < logicalRows.length ? stream.items.formattingNodeAt(logicalRows.get(index, 0)) : null;
        const retained = tailoringByNode.get(id);
        if (retained !== undefined) return retained;
        const node = id === null ? null : this.#formatting.node(id);
        const style = node === null ? null : this.#computed(node);
        const breakWord = style?.text.wordBreak === "break-word";
        const tailoring: LineBreakTailoring = {
          lineBreak: style?.text.lineBreak ?? "auto", wordBreak: breakWord ? "normal" : style?.text.wordBreak ?? "normal",
          overflowWrap: breakWord ? "anywhere" : style?.text.overflowWrap ?? "normal", hyphens: style?.text.hyphens ?? "manual",
          language: node === null ? null : this.#language(node), preserveGraphemeClusters: true,
        };
        tailoringByNode.set(id, tailoring); return tailoring;
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
    const paragraphDirection = (itemStart: number, itemEnd: number): "ltr" | "rtl" | "auto" =>
      plaintextStarts.some((index) => index >= itemStart && index < itemEnd) ? "auto" : direction;
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
    let bidiRuns = 0;
    for (const slice of bidi.paragraphs) {
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

    }
    const textNodes = new Map<FormattingNodeId, InlineTextNodeAnalysis>();
    for (const [id, record] of textNodeRecords) textNodes.set(id, Object.freeze(record));
    const breaksBefore: BreakOpportunityKind[] = [];
    let opportunityIndex = 0;
    for (let index = 0; index < logicalRows.length; index += 1) {
      while (
        (lineBreakMap.opportunities[opportunityIndex]?.codeUnitOffset ??
          Number.MAX_SAFE_INTEGER) < logicalRows.get(index, 3)
      )
        opportunityIndex += 1;
      const opportunity = lineBreakMap.opportunities[opportunityIndex];
      breaksBefore.push(
        opportunity?.codeUnitOffset === logicalRows.get(index, 3)
          ? opportunity.kind
          : "prohibited",
      );
    }
    const analysis = Object.freeze({
      bidi,
      textNodes,
      positions: new InlineBidiPositions(bidi.paragraphs),
      logicalUnits,
      breaksBefore: new InlineBreaks(breaksBefore),
      resourceCounts: Object.freeze({
        bidiItems: items.length,
        bidiRuns,
        graphemeClusters,
        breakOpportunities: lineBreakMap.opportunities.length,
      }),
    });
    this.#reserveInlineTextAnalysis(analysis);
    if (cache.size >= 4) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
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
    if (!node.appliesBoxStyle && !ownsOuterBoxStyle(node)) return null;
    const style = this.#computed(node);
    if (node.kind !== "table" || style === null) return style;
    const cached = this.#tableGridStyles.get(style);
    if (cached !== undefined) return cached;
    // CSS Tables assigns these properties to the wrapper, around grid and
    // captions. Keep the grid's sizing, padding, border, and paint inputs intact.
    const zero = Object.freeze({ kind: "zero" as const });
    const auto = Object.freeze({ kind: "auto" as const });
    const grid = Object.freeze({
      ...style,
      box: Object.freeze({
        ...style.box,
        margin: Object.freeze({ top: zero, right: zero, bottom: zero, left: zero }),
        position: "static" as const,
        inset: Object.freeze({ top: auto, right: auto, bottom: auto, left: auto }),
        zIndex: null,
        float: "none" as const,
        clear: "none" as const,
        transform: null,
        overflowX: "visible" as const,
        overflowY: "visible" as const,
        legacyClip: Object.freeze({ kind: "auto" as const }),
        clipPath: Object.freeze({ kind: "none" as const }),
      }),
    });
    this.#tableGridStyles.set(style, grid);
    return grid;
  }

  /** Anonymous item wrappers borrow only the principal child's box properties. */
  #itemComputed(node: FormattingNode): ComputedStyle | null {
    if ((node.kind === "flex-item" || node.kind === "grid-item") && !node.appliesBoxStyle) {
      const child = node.children.length === 1 ? node.children[0] : undefined;
      return child === undefined ? null : this.#boxComputed(this.#formatting.node(child));
    }
    return this.#boxComputed(node);
  }

  #itemContent(node: FormattingNode): FormattingNode {
    if ((node.kind === "flex-item" || node.kind === "grid-item") && !node.appliesBoxStyle
      && node.children.length === 1 && node.children[0] !== undefined)
      return this.#itemContent(this.#formatting.node(node.children[0]));
    if (node.kind === "table-wrapper") {
      const table = node.children.find((id) => this.#formatting.node(id).kind === "table");
      if (table !== undefined) return this.#formatting.node(table);
    }
    return node;
  }

  /** Record the supplied owner, rather than searching across independent descendants. */
  #recordBlockPercentageConsumer(node: FormattingNode, block: LayoutContainingBlock): void {
    if (block.percentageHeight !== null) return;
    const style = this.#boxComputed(node);
    if (style === null) return;
    if ([style.box.height, style.box.minHeight, style.box.maxHeight].some(percentageDependent)
      || style.box.position === "relative"
        && [style.box.inset.top, style.box.inset.bottom].some(percentageDependent))
      this.#indefiniteBlockConsumers.add(block);
  }

  #needsDefiniteItemBlock(node: FormattingNode): boolean {
    const needs = (block: LayoutContainingBlock): boolean => block.percentageHeight === null
      && (this.#indefiniteBlockConsumers.has(block)
        || [...this.#blockDefinitenessTransfers.get(block) ?? []].some(needs));
    return [...this.#ownedContainingBlocks.get(this.#itemContent(node).id) ?? []]
      .some(needs);
  }

  #finalizeItemBlock(node: FormattingNode, height: CssPixelLength): void {
    const finalize = (block: LayoutContainingBlock, allocation: CssPixelLength): void => {
      if (block.percentageHeight !== null) return;
      block.percentageHeight = allocation;
      for (const dependent of this.#blockDefinitenessTransfers.get(block) ?? [])
        finalize(dependent, dependent.rect.height);
    };
    for (const block of this.#ownedContainingBlocks.get(this.#itemContent(node).id) ?? [])
      finalize(block, this.#itemContent(node).kind === "table" ? block.rect.height : height);
  }

  #transferBlockDefiniteness(parent: LayoutContainingBlock, child: LayoutContainingBlock): void {
    if (parent === child || parent.percentageHeight !== null || child.percentageHeight !== null) return;
    const dependents = this.#blockDefinitenessTransfers.get(parent) ?? new Set<LayoutContainingBlock>();
    dependents.add(child);
    this.#blockDefinitenessTransfers.set(parent, dependents);
    this.#blockDefinitenessParents.set(child, parent);
  }

  #fontSize(style: ComputedStyle | null): CssPixelLength {
    const value = style?.text.fontSize;
    return value?.kind === "zero" ? ZERO : value?.kind === "length" && value.unit === "px"
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
      throw new InvalidCssNumericInput(
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
    owner?: LayoutContainingBlock,
  ): CssPixelLength | null {
    if (owner !== undefined && percentageBasis === null && percentageDependent(value))
      this.#indefiniteBlockConsumers.add(owner);
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
      throw new InvalidCssNumericInput("Non-finite computed CSS length.");
    switch (value.unit) {
      case "px": return cssPx(value.value);
      case "%": return percentageBasis === null
        ? null : cssMultiply(percentageBasis, value.value / 100);
      case "vw": return cssMultiply(this.#input.context.viewport.width, value.value / 100);
      case "vh": return cssMultiply(this.#input.context.viewport.height, value.value / 100);
      case "rem": return cssMultiply(this.#rootFontMetrics.fontSize, value.value);
      case "em": return cssMultiply(this.#fontSize(style), value.value);
      case "ex": return cssMultiply(this.#metrics(style).xHeight, value.value);
      case "ch": return cssMultiply(this.#metrics(style).chAdvance, value.value);
    }
  }

  #usedGap(
    value: CssGap,
    percentageBasis: CssPixelLength | null,
    style: ComputedStyle,
    owner?: LayoutContainingBlock,
  ): CssPixelLength | null {
    return value.kind === "normal"
      ? ZERO
      : this.#usedLength(value, percentageBasis, style, owner);
  }

  #usedMath(
    expression: CssLengthPercentageExpression,
    percentageBasis: CssPixelLength,
    style: ComputedStyle | null,
  ): CssPixelLength {
    return evaluateUsedCssMath(expression, (value, unit) => this.#usedLength(
      { kind: "length", value, unit }, percentageBasis, style) ?? ZERO);
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
    const node = formattingNode === undefined ? null : this.#formatting.node(formattingNode);
    // The wrapper contributes the grid's chrome; collapsed perimeter halves and
    // padding suppression are resolved on the table grid, not authored twice.
    const borderOwner = node?.kind === "table-wrapper"
      ? node.children.find((id) => this.#formatting.node(id).kind === "table") ?? formattingNode
      : formattingNode;
    const override = borderOwner === undefined ? undefined : this.#tableBorderOverrides.get(borderOwner);
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
      && override?.suppressPadding === true
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
      : (override?.widths ?? computedBorder);
    return { margin, padding, border };
  }

  #containingBlock(
    owner: FormattingNodeId | null,
    rect: CssRect,
    percentageWidth: CssPixelLength | null,
    percentageHeight: CssPixelLength | null,
  ): LayoutContainingBlock {
    const block = { owner, rect, percentageWidth, percentageHeight };
    if (owner !== null) {
      const owned = this.#ownedContainingBlocks.get(owner) ?? new Set<LayoutContainingBlock>();
      owned.add(block);
      this.#ownedContainingBlocks.set(owner, owned);
    }
    return block;
  }

  #dimensions(
    node: FormattingNode,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null = null,
    distributeForcedAutoMargins = false,
    styleOverride?: ComputedStyle | null,
  ): UsedDimensions {
    const style = styleOverride === undefined ? this.#boxComputed(node) : styleOverride;
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
    if (node.outer !== "block" || isAtomicFormattingNode(node)) return false;
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
      node.kind === "image"
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
      this.#independentFormattingContext(node) ||
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
          if (isInlineFormattingNode(child) || this.#outOfFlow(child)
            || child.kind === "marker" && child.markerPlacement === "outside")
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
      background: computedPaintBackground(style, node.appliesBoxStyle, hideEmptyCell),
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
    const shared = this.#paintStyles.share(paintStyle);
    this.#paintStyleCache.set(node.id, shared);
    return shared;
  }

  #tableCellHasContent(node: FormattingNode): boolean {
    const pending = [...node.children];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const child = this.#formatting.node(id);
      if (this.#outOfFlow(child)) continue;
      if (child.kind === "form-control" || child.kind === "replaced-element" || child.kind === "image" || child.kind === "forced-line-break") return true;
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


  #overflowClip(
    node: FormattingNode,
    paddingRect: CssRect,
    inherited: CssRect,
  ): CssRect {
    const style = this.#boxComputed(node);
    if (style === null || (node.pseudo === null && node.source === this.#viewportOverflowSource) || !hasOverflowBox(this.#formatting, node)) return inherited;
    let result = inherited;
    if (
      clipsOverflow(style.box.overflowX) ||
      clipsOverflow(style.box.overflowY)
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
    return result;
  }

  #explicitClip(node: FormattingNode, borderRect: CssRect, inherited: CssRect): CssRect {
    const style = this.#boxComputed(node);
    if (style === null) return inherited;
    let result = inherited;
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

  #clip(node: FormattingNode, paddingRect: CssRect, borderRect: CssRect, inherited: CssRect): CssRect {
    const clipped = this.#explicitClip(node, borderRect, this.#overflowClip(node, paddingRect, inherited));
    return this.#paintContainment(node) ? cssIntersection(clipped, paddingRect) : clipped;
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
    alignmentBox?: { readonly height: CssPixelLength; readonly ascent: CssPixelLength },
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
        cssDivide(alignmentBox?.height ?? this.#lineHeight(style, metrics), 2),
        negate(alignmentBox?.ascent ?? this.#inlineExtents(metrics, this.#lineHeight(style, metrics)).ascent),
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
    const leading = sum(lineHeight, negate(metrics.ascent), negate(metrics.descent));
    const before = cssDivide(leading, 2);
    return {
      ascent: cssAdd(metrics.ascent, before),
      descent: cssAdd(metrics.descent, sum(leading, negate(before))),
    };
  }

  #lineExtents(
    strutMetrics: UsedFontMetrics,
    strutLineHeight: CssPixelLength,
    entries: Iterable<InlineVerticalMetrics>,
  ): { readonly ascent: CssPixelLength; readonly descent: CssPixelLength; readonly height: CssPixelLength } {
    const strut = this.#inlineExtents(strutMetrics, strutLineHeight);
    let ascent = strut.ascent, descent = strut.descent, specified = strutLineHeight;
    for (const entry of entries) {
      ascent = cssMax(ascent, sum(entry.ascent, entry.baselineShift));
      descent = cssMax(descent, sum(entry.descent, negate(entry.baselineShift)));
      specified = cssMax(specified, entry.lineHeight);
    }
    return { ascent, descent, height: cssMax(sum(ascent, descent), specified) };
  }

  #textInkRect(rect: CssRect, baseline: CssPixelLength, metrics: UsedFontMetrics): CssRect {
    return cssRect(rect.x, point(rect.y, sum(baseline, negate(metrics.ascent))), rect.width,
      sum(metrics.ascent, metrics.descent));
  }

  #nativeControlPlacement(
    node: FormattingFormControlNode,
    contentHeight: CssPixelLength,
    metrics: CssControlMetrics,
  ): { readonly blockOffset: CssPixelLength; readonly height: CssPixelLength; readonly baseline: CssPixelLength | null } {
    const multiline = node.control.kind === "textarea" || node.control.kind === "select" && node.control.multiple;
    return multiline
      ? { blockOffset: ZERO, height: contentHeight, baseline: null }
      : { blockOffset: cssDivide(sum(contentHeight, negate(metrics.height)), 2),
          height: metrics.height, baseline: metrics.baseline };
  }

  #atomicInlineExtents(
    node: FormattingFormControlNode | FormattingReplacedNode,
    contentHeight: CssPixelLength,
    edges: { readonly margin: CssSignedEdges; readonly padding: CssEdges; readonly border: CssEdges },
    nativeMetrics: CssControlMetrics | null,
  ): InlineVerticalMetrics {
    const style = this.#computed(node);
    const metrics = this.#metrics(style);
    const { margin, padding, border } = edges;
    const lineHeight = sum(margin.top, border.top, padding.top, contentHeight,
      padding.bottom, border.bottom, margin.bottom);
    const native = node.kind === "form-control" && nativeMetrics !== null
      ? this.#nativeControlPlacement(node, contentHeight, nativeMetrics) : null;
    const ascent = native?.baseline === null || native === null ? lineHeight
      : sum(margin.top, border.top, padding.top, native.blockOffset, native.baseline);
    const verticalAlign = style?.text.verticalAlign ?? { kind: "keyword" as const, value: "baseline" as const };
    return { lineHeight, ascent, descent: sum(lineHeight, negate(ascent)),
      baselineShift: this.#verticalShift(node, verticalAlign, metrics, { height: lineHeight, ascent }) };
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
    const fragment = this.#fragments.get(root);
    if (fragment === undefined) return;
    this.#translate(
      { fragment: root, borderRect: fragment.borderRect, marginRect: fragment.marginRect },
      inlineOffset,
      blockOffset,
      containingClip,
    );
    const moved = this.#fragments.get(root);
    if (moved === undefined) return;
    const textRect = cssRect(moved.contentRect.x, rootY, moved.contentRect.width, rootTextHeight);
    const inkRect = moved.kind === "text" ? this.#textInkRect(textRect, rootBaseline, moved.usedFontMetrics) : textRect;
    this.#fragments.set(root, {
      ...moved,
      ...(moved.kind === "text" ? {
        baseline: rootBaseline,
        contentRect: textRect,
        paddingRect: textRect,
        borderRect: textRect,
        marginRect: textRect,
        inkRect,
        overflowRect: unionOverflowRect(textRect, inkRect),
      } : {}),
    });
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
      paragraph.items.at(logicalItemStart - 1)?.kind === "structural-control"
      && cursor.textAnalysis.logicalUnits.itemKind(paragraph.items.at(logicalItemStart - 1)?.identity) !== "forced-line-break"
    ) {
      logicalItemStart -= 1;
    }
    while (
      paragraph !== undefined &&
      logicalItemEnd < paragraph.items.length &&
      paragraph.items.at(logicalItemEnd)?.kind === "structural-control"
      && cursor.textAnalysis.logicalUnits.itemKind(paragraph.items.at(logicalItemEnd)?.identity) !== "forced-line-break"
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
            itemIndices: new BidiOrderIndices([]),
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
    const { ascent, descent, height } = this.#lineExtents(cursor.strutMetrics, cursor.strutLineHeight, entries);
    let contentRight = cursor.lineStartX;
    for (const entry of entries) {
      const fragment = this.#fragments.get(entry.fragment);
      if (fragment !== undefined) {
        contentRight = cssCoordinateFromFixed(Math.max(contentRight,
          cssCoordinateAdd(fragment.borderRect.x, fragment.borderRect.width)));
      }
    }
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
        entry.ascent,
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
    const fragmentIds = logicalEntries.map((entry) => entry.fragment);
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
      visualOrder: Object.freeze(usedIds),
      logicalItemStart,
      logicalItemEnd,
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
    let logicalText = "";
    for (let index = unit.logicalIndex; index < logicalUnitEnd; index += 1) {
      logicalText += cursor.textAnalysis.logicalUnits.at(index)?.item.text ?? "";
    }
    const finalUnit = cursor.textAnalysis.logicalUnits.at(logicalUnitEnd - 1) ?? unit;
    const text = unit.item.kind === "soft-hyphen" ? "-" : logicalText;
    if (text.length === 0) return null;
    this.#ensureLineCapacity(cursor);
    this.#ensureLineFragmentCapacity(cursor);
    const usedLineHeight = this.#lineHeight(style, metrics);
    const visible = style.visibility === "visible";
    const globalStart = unit.bidiItemStart;
    const globalEnd = finalUnit.bidiItemEnd;
    const position =
      globalStart < 0 ? undefined : cursor.textAnalysis.positions.at(globalStart);
    const paragraphSlice =
      position === undefined
        ? undefined
        : cursor.textAnalysis.bidi.paragraphs[position.paragraph];
    const bidiItemStart = position?.item ?? 0;
    const bidiItemEnd =
      globalEnd >= globalStart && position !== undefined
        ? bidiItemStart + globalEnd - globalStart
        : bidiItemStart;
    const embeddingLevel = cursor.lineLevelOverrides.get(unit.logicalIndex)
      ?? paragraphSlice?.paragraph.embeddingLevels.at(bidiItemStart) ?? 0;
    let advance: CssPixelLength = ZERO;
    for (let index = unit.logicalIndex; index < logicalUnitEnd; index += 1) {
      const candidate = cursor.textAnalysis.logicalUnits.at(index);
      if (candidate === undefined || candidate.bidiItemStart >= globalEnd)
        break;
      if (
        (candidate.item.kind === "text" ||
          candidate.item.kind === "tab" ||
          candidate.item.kind === "soft-hyphen") &&
        candidate.bidiItemStart >= globalStart &&
        candidate.bidiItemEnd <= globalEnd
      ) {
        const candidateText =
          candidate.item.kind === "soft-hyphen"
            ? "-"
            : candidate.item.kind === "tab"
              ? " "
              : candidate.item.text;
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
    const clusterRows = new PackedRows(4, true, Math.max(1, Math.min(128, logicalUnitEnd - unit.logicalIndex)));
    let visualText = "";
    const reverse = (embeddingLevel & 1) !== 0;
    const unitCount = logicalUnitEnd - unit.logicalIndex;
    for (let offset = 0; offset < unitCount; offset += 1) {
      const logicalIndex = reverse
        ? logicalUnitEnd - 1 - offset
        : unit.logicalIndex + offset;
      const candidate = cursor.textAnalysis.logicalUnits.at(logicalIndex);
      if (
        candidate === undefined ||
        candidate.bidiItemStart < globalStart ||
        candidate.bidiItemEnd > globalEnd ||
        (candidate.item.kind !== "text" &&
          candidate.item.kind !== "tab" &&
          candidate.item.kind !== "soft-hyphen")
      )
        continue;
      let clusterText =
        candidate.item.kind === "soft-hyphen"
          ? "-"
          : candidate.item.kind === "tab"
            ? " "
            : candidate.item.text;
      if (
        paragraphSlice !== undefined &&
        candidate.item.kind !== "soft-hyphen" &&
        candidate.item.kind !== "tab"
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
      clusterRows.push(candidate.streamIndex, visualStartCodeUnit, visualText.length,
        cursor.usedUnitAdvances.get(candidate.logicalIndex) ?? this.#measure(clusterText, metrics.fontSize));
    }
    if (visualText.length === 0) visualText = text;
    const visualClusters = new LayoutTextClusters(visualText, clusterRows, cursor.textAnalysis.logicalUnits.stream.items);
    const sourceRange =
      visualClusters.length === 1
        ? (visualClusters.at(0)?.sourceRange ?? null)
        : node.kind !== "text-sequence" ||
            node.source === null ||
            node.sourceRange === null
          ? node.sourceRange
          : this.#formatting.document.textSourceRange(
              node.source,
              unit.item.contentStartCodeUnit,
              finalUnit.item.contentEndCodeUnit,
            );
    const extents = this.#inlineExtents(metrics, usedLineHeight);
    const inkRect = this.#textInkRect(box, extents.ascent, metrics);
    const fragment = this.#store<LayoutTextFragment>({
      id: this.#newId(
        node.id,
        `text:${String(unit.item.contentStartCodeUnit)}:${String(unit.logicalIndex)}`,
      ),
      kind: "text",
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange,
      contentStartCodeUnit: unit.item.contentStartCodeUnit,
      contentEndCodeUnit: finalUnit.item.contentEndCodeUnit,
      text: visible && metrics.fontSize > 0 ? text : "",
      visualText: visible && metrics.fontSize > 0 ? visualText : "",
      visualClusters: visible && metrics.fontSize > 0
        ? visualClusters
        : EMPTY_TEXT_CLUSTERS,
      bidiParagraph: position?.paragraph ?? 0,
      embeddingLevel,
      contentRect: box,
      paddingRect: box,
      borderRect: box,
      marginRect: box,
      inkRect,
      overflowRect: unionOverflowRect(box, inkRect),
      clipRect: clip,
      children: EMPTY_FRAGMENT_CHILDREN,
      lineBoxes: EMPTY_FRAGMENT_LINES,
      usedFontMetrics: metrics,
      baseline: extents.ascent,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic:
        visible && node.semantic?.accessibilityHidden !== true
          ? node.semantic
          : null,
      style: this.#paintStyle(node),


    });
    const verticalAlign =
      this.#formatting.parent(node.id)?.id === cursor.containingFormattingNode
        ? ({ kind: "keyword", value: "baseline" } as const)
        : style.text.verticalAlign;
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
    return cursor.textAnalysis.breaksBefore.at(unit.logicalIndex) ?? "prohibited";
  }

  #logicalUnitAdvance(
    cursor: InlineFormattingCursor,
    unit: InlineLogicalUnit,
  ): CssPixelLength {
    const node = this.#formatting.node(unit.item.formattingNode);
    if (unit.item.kind === "text")
      return unit.advance;
    if (unit.item.kind === "soft-hyphen") return ZERO;
    if (unit.item.kind === "tab") return ZERO;
    if (unit.item.kind === "atomic-inline") {
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
    return cursor.textAnalysis.logicalUnits.forBidiItem(item);
  }

  #selectInlineLineBreaks(cursor: InlineFormattingCursor): void {
    const forcedBoundaries: number[] = [];
    const selection = selectLogicalLines(
      cursor.textAnalysis.logicalUnits.map((unit) => {
        if (unit.item.kind === "forced-line-break") forcedBoundaries.push(unit.logicalIndex + 1);
        const node = this.#formatting.node(unit.item.formattingNode);
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
            unit.item.kind === "tab"
              ? cssMultiply(
                  this.#metrics(this.#computed(node)).chAdvance,
                  this.#computed(node)?.text.tabSize ?? 8,
                )
              : null,
          breakBefore: this.#breakBeforeUnit(cursor, unit),
          forcedBreak: unit.item.kind === "forced-line-break",
          collapsibleSpace: ("collapsibleSpace" in unit.item && unit.item.collapsibleSpace),
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
    // Apply the same UAX #9 L1 line-end reset before coalescing fragments. Only
    // changed trailing units need overrides; the paragraph vector stays canonical.
    const boundaries = [...new Set([...selection.breaksBefore, ...forcedBoundaries, selection.retainedItems])].filter((boundary) => boundary <= selection.retainedItems).sort((left, right) => left - right);
    let lineStart = 0;
    for (const lineEnd of boundaries) {
      if (lineEnd <= lineStart) continue;
      const first = cursor.textAnalysis.logicalUnits.at(lineStart), last = cursor.textAnalysis.logicalUnits.at(lineEnd - 1);
      if (first !== undefined && last !== undefined) {
        const firstPosition = cursor.textAnalysis.positions.at(first.bidiItemStart);
        const lastPosition = cursor.textAnalysis.positions.at(last.bidiItemEnd - 1);
        if (firstPosition !== undefined && lastPosition !== undefined) {
          for (let paragraphIndex = firstPosition.paragraph; paragraphIndex <= lastPosition.paragraph; paragraphIndex += 1) {
            const slice = cursor.textAnalysis.bidi.paragraphs[paragraphIndex];
            if (slice === undefined) continue;
            const start = Math.max(first.bidiItemStart, slice.itemStart) - slice.itemStart;
            const end = Math.min(last.bidiItemEnd, slice.itemEnd) - slice.itemStart;
            const reset = bidiLineTrailingResetStart(slice.paragraph, start, end);
            for (let item = reset; item < end; item += 1) {
              const level = slice.paragraph.embeddingLevels.at(item);
              if (level === null || level === slice.paragraph.baseLevel) continue;
              const unit = cursor.textAnalysis.logicalUnits.forBidiItem(slice.itemStart + item);
              if (unit !== undefined) cursor.lineLevelOverrides.set(unit.logicalIndex, slice.paragraph.baseLevel);
            }
          }
        }
      }
      lineStart = lineEnd;
    }
  }

  #atomicVisualClusters(
    node: FormattingNode,
    processed: ProcessedCssText,
    baseDirection: "ltr" | "rtl" | "auto",
    directionalSegments: readonly ControlDisplayTextSegment[],
    metrics: UsedFontMetrics,
    lines?: LayoutControlTextLine[],
  ): LayoutTextClusters {
    const itemBuilder = new BidiItemsBuilder<number>(processed.units.length);
    const ranges = new AtomicTextRanges(processed);
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
      if (itemBuilder.length >= this.#budgets.maxBidiItems - this.#bidiItems) {
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
      itemBuilder.push(Object.freeze(item));
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
      const start = itemBuilder.length;
      if (unit.kind === "forced-break") {
        append({
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
      ranges.push(start, itemBuilder.length);
    }
    if (activeSegment >= 0)
      structuralControl("PDI", processed.transformed.value.length);
    const items = itemBuilder.finish();
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
      const lineStart = clusters.length;
      if (lines !== undefined) { visualAdvance = ZERO; visualCodeUnitOffset = 0; }
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
      const paragraphRanges = ranges.within(slice.itemStart, slice.itemEnd);
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
      if (lines !== undefined) {
        const lineClusters = Object.freeze(clusters.splice(lineStart));
        const height = this.#lineHeight(this.#computed(node), metrics);
        lines.push(Object.freeze({ text: lineClusters.map((cluster) => cluster.text).join(""), clusters: LayoutTextClusters.from(lineClusters),
          blockOffset: cssMultiply(height, lines.length), height, baseline: this.#inlineExtents(metrics, height).ascent }));
      }
    }
    this.#bidiItems += items.length;
    this.#bidiRuns += bidiRuns;
    this.#graphemeClusters += graphemeClusters;
    this.#visualRuns += visualRuns;
    return LayoutTextClusters.from(clusters);
  }

  #placeText(
    node: FormattingTextNode,
    cursor: InlineFormattingCursor,
    clip: CssRect,
  ): LayoutResult {
    const children: LayoutFragmentId[] = [];
    const analyzed = cursor.textAnalysis.textNodes.get(node.id);
    const units = cursor.textAnalysis.logicalUnits;
    const unitEnd = analyzed?.end ?? 0;
    for (let index = analyzed?.start ?? 0; index < unitEnd;) {
      this.#input.signal?.throwIfAborted();
      const unit = units.at(index);
      if (unit === undefined) break;
      if (unit.logicalIndex >= cursor.logicalUnitLimit) {
        cursor.lineSelectionStopped = true;
        break;
      }
      if (unit.item.kind === "forced-line-break") {
        this.#finalizeLine(cursor, true, "forced");
        index += 1;
        continue;
      }
      if (unit.item.kind === "soft-hyphen") {
        const following =
          cursor.textAnalysis.logicalUnits.at(unit.logicalIndex + 1);
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
      const firstPosition = cursor.textAnalysis.positions.at(unit.bidiItemStart);
      const firstParagraph =
        firstPosition === undefined
          ? undefined
          : cursor.textAnalysis.bidi.paragraphs[firstPosition.paragraph]
              ?.paragraph;
      const firstLevel = cursor.lineLevelOverrides.get(unit.logicalIndex) ?? (
        firstPosition === undefined
          ? null
          : (firstParagraph?.embeddingLevels.at(firstPosition.item) ?? null));
      let end = index + 1;
      while (unit.item.kind === "text" && end < unitEnd) {
        const candidate = units.at(end);
        if (
          candidate === undefined ||
          candidate.item.kind !== "text" ||
          cursor.suppressedUnits.has(candidate.logicalIndex) ||
          cursor.selectedLineBreaks.has(candidate.logicalIndex)
        )
          break;
        const position = cursor.textAnalysis.positions.at(candidate.bidiItemStart);
        const paragraph =
          position === undefined
            ? undefined
            : cursor.textAnalysis.bidi.paragraphs[position.paragraph]
                ?.paragraph;
        const level = cursor.lineLevelOverrides.get(candidate.logicalIndex) ?? (
          position === undefined
            ? null
            : (paragraph?.embeddingLevels.at(position.item) ?? null));
        if (
          position?.paragraph !== firstPosition?.paragraph ||
          level !== firstLevel
        )
          break;
        end += 1;
      }
      const last = units.at(end - 1) ?? unit;
      const placed = this.#textFragment(
        node,
        cursor,
        unit,
        clip,
        last.logicalIndex + 1,
      );
      if (placed !== null) children.push(placed.id);
      cursor.collapsedSpace = ("collapsibleSpace" in last.item && last.item.collapsibleSpace);
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

  #controlIntrinsicInline(node: FormattingNode, metrics: UsedFontMetrics): CssPixelLength | null {
    if (node.kind !== "form-control") return null;
    return node.control.kind === "text" ? cssMultiply(metrics.chAdvance, node.control.size)
      : node.control.kind === "textarea" ? cssMultiply(metrics.chAdvance, node.control.cols)
      : this.#input.context.controlMeasurer.measure(node.control, this.#formatting.document, this.#formatting.state).width;
  }

  /** Replaced elements share one size/aspect-ratio calculation in used and intrinsic layout. */
  #replacedContentSize(
    node: FormattingReplacedNode,
    widthBasis: CssPixelLength | null,
    heightBasis: CssPixelLength | null,
    fallbackWidth: CssPixelLength,
    fallbackHeight: CssPixelLength,
    forcedWidth: CssPixelLength | null = null,
    forcedHeight: CssPixelLength | null = null,
    ignoreInlineConstraints = false,
    recordDependency = true,
  ): { readonly width: CssNonNegativeLength; readonly height: CssNonNegativeLength } {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const edges = this.#edges(style, widthBasis ?? ZERO, node.id);
    const inlineChrome = sum(edges.padding.left, edges.padding.right, edges.border.left, edges.border.right);
    const blockChrome = sum(edges.padding.top, edges.padding.bottom, edges.border.top, edges.border.bottom);
    const toContent = (value: CssPixelLength, chrome: CssPixelLength): CssNonNegativeLength =>
      nonNegative(style?.box.boxSizing === "border-box" ? sum(value, negate(chrome)) : value);
    const cssWidth = style === null || ignoreInlineConstraints ? null : this.#usedLength(style.box.width, widthBasis, style);
    const cssHeight = style === null ? null : this.#usedLength(style.box.height, heightBasis, style);
    const authoredWidth = forcedWidth ?? (cssWidth === null
      ? node.intrinsicWidth === null ? null : cssPx(node.intrinsicWidth)
      : toContent(cssWidth, inlineChrome));
    const authoredHeight = forcedHeight ?? (cssHeight === null
      ? node.intrinsicHeight === null ? null : cssPx(node.intrinsicHeight)
      : toContent(cssHeight, blockChrome));
    // Retained formatting can outlive this allocation. An auto authored axis is
    // conservatively dependent even if flex/grid temporarily forces both axes.
    if (recordDependency && node.imageResourceId !== null && (cssWidth === null || cssHeight === null))
      this.#imageDimensionDependencies.add(node.imageResourceId);
    const naturalWidth = node.naturalWidth === null ? null : cssPx(node.naturalWidth);
    const naturalHeight = node.naturalHeight === null ? null : cssPx(node.naturalHeight);
    const ratio = naturalWidth !== null && naturalWidth > 0 && naturalHeight !== null && naturalHeight > 0
      ? naturalWidth / naturalHeight : null;
    let width = authoredWidth ?? (ratio !== null && authoredHeight !== null
      ? cssMultiply(authoredHeight, ratio) : naturalWidth ?? fallbackWidth);
    let height = authoredHeight ?? (ratio !== null
      ? cssDivide(width, ratio) : naturalHeight ?? fallbackHeight);
    const minimumWidth = style === null || ignoreInlineConstraints ? ZERO
      : toContent(this.#usedLength(style.box.minWidth, widthBasis, style) ?? ZERO, inlineChrome);
    const maximumWidthValue = style === null || ignoreInlineConstraints ? null
      : this.#usedLength(style.box.maxWidth, widthBasis, style);
    const maximumWidth = maximumWidthValue === null ? null : toContent(maximumWidthValue, inlineChrome);
    const minimumHeight = style === null ? ZERO
      : toContent(this.#usedLength(style.box.minHeight, heightBasis, style) ?? ZERO, blockChrome);
    const maximumHeightValue = style === null ? null : this.#usedLength(style.box.maxHeight, heightBasis, style);
    const maximumHeight = maximumHeightValue === null ? null : toContent(maximumHeightValue, blockChrome);
    if (forcedWidth === null) width = constrainedSize(width, null, minimumWidth, maximumWidth);
    if (authoredHeight === null && ratio !== null) height = cssDivide(width, ratio);
    if (forcedHeight === null) height = constrainedSize(height, null, minimumHeight, maximumHeight);
    if (authoredWidth === null && authoredHeight === null && ratio !== null) {
      width = constrainedSize(cssMultiply(height, ratio), null, minimumWidth, maximumWidth);
    }
    return { width: nonNegative(width), height: nonNegative(height) };
  }

  #atomic(
    node: FormattingFormControlNode | FormattingReplacedNode,
    cursor: InlineFormattingCursor,
    clip: CssRect,
  ): LayoutResult {
    const participatesInLine = cursor.containingFormattingNode !== node.id;
    if (participatesInLine) {
      this.#ensureLineCapacity(cursor);
      this.#ensureLineFragmentCapacity(cursor);
    }
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
    const controlLines: LayoutControlTextLine[] | undefined = node.kind === "form-control" && node.control.kind === "textarea" ? [] : undefined;
    const atomicText = controlLines === undefined ? processedText : processCssText(logicalText, "none", "pre", false,
      { maxGraphemeClusters: Math.max(0, this.#budgets.maxGraphemeClusters - this.#graphemeClusters) }, this.#input.signal);
    if (atomicText.outcome.status !== "complete") {
      this.#truncated ??= "maxGraphemeClusters";
      throw new LayoutBudgetExhausted();
    }
    const visualClusters = this.#atomicVisualClusters(
      node,
      atomicText,
      baseDirection,
      directionalSegments,
      metrics,
      controlLines,
    );
    const text = visualClusters.map((cluster) => cluster.text).join("");
    const lineHeight = this.#lineHeight(style, metrics);
    const containingWidth = cursor.containingBlock.percentageWidth ?? ZERO;
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
    const intrinsicWidth = this.#controlIntrinsicInline(node, metrics) ?? (
      node.kind !== "form-control" && node.intrinsicWidth !== null
        ? cssPx(node.intrinsicWidth)
        : visualClusters.reduce<CssPixelLength>(
            (advance, cluster) => cssAdd(advance, cluster.advance),
            ZERO,
          ));
    const specifiedWidth =
      style === null
        ? null
        : this.#usedLength(style.box.width, containingWidth, style);
    const toContentWidth = (value: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(value, negate(horizontalChrome)))
        : value;
    let contentWidth: CssPixelLength = nonNegative(
      cursor.forcedContentWidth ?? (specifiedWidth === null ? intrinsicWidth : toContentWidth(specifiedWidth)),
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
    const nativeControlMetrics = node.kind === "form-control"
      ? this.#input.context.controlMeasurer.measure(node.control, this.#formatting.document, this.#formatting.state) : null;
    const intrinsicHeight =
      node.kind !== "form-control" && node.intrinsicHeight !== null
        ? cssPx(node.intrinsicHeight)
        : node.kind === "form-control" && node.control.kind === "textarea"
          ? cssMultiply(nativeControlMetrics?.height ?? lineHeight, node.control.rows) : nativeControlMetrics?.height ?? lineHeight;
    const resolveHeight = (value: CssLength): CssPixelLength | null =>
      this.#usedLength(value, cursor.containingBlock.percentageHeight, style);
    const toContentHeight = (value: CssPixelLength): CssPixelLength =>
      style?.box.boxSizing === "border-box"
        ? nonNegative(sum(value, negate(verticalChrome)))
        : nonNegative(value);
    const specifiedHeight =
      style === null ? null : resolveHeight(style.box.height);
    const minimumHeight =
      style === null ? ZERO : (resolveHeight(style.box.minHeight) ?? ZERO);
    const maximumHeight =
      style === null ? null : resolveHeight(style.box.maxHeight);
    let contentHeight = constrainedSize(
      intrinsicHeight,
      cursor.forcedContentHeight ?? (specifiedHeight === null ? null : toContentHeight(specifiedHeight)),
      toContentHeight(minimumHeight),
      maximumHeight === null ? null : toContentHeight(maximumHeight),
    );
    if (node.kind !== "form-control") {
      const size = this.#replacedContentSize(node, cursor.containingBlock.percentageWidth,
        cursor.containingBlock.percentageHeight, intrinsicWidth, intrinsicHeight,
        cursor.forcedContentWidth ?? null, cursor.forcedContentHeight ?? null);
      contentWidth = size.width;
      contentHeight = size.height;
    }
    const advance = sum(
      margin.left,
      border.left,
      padding.left,
      contentWidth,
      padding.right,
      border.right,
      margin.right,
    );
    const globalItem = cursor.textAnalysis.logicalUnits.at(cursor.textAnalysis.textNodes.get(node.id)?.start ?? Number.MAX_SAFE_INTEGER)?.bidiItemStart ?? -1;
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
    const nativePlacement = node.kind === "form-control" && nativeControlMetrics !== null
      ? this.#nativeControlPlacement(node, contentHeight, nativeControlMetrics) : null;
    const nativeControlPaintRect = nativePlacement === null ? null : cssRect(contentRect.x,
      point(contentRect.y, nativePlacement.blockOffset), contentRect.width, nativePlacement.height);
    const visible = style?.visibility === "visible";
    const atomicExtents = this.#atomicInlineExtents(node, contentHeight, { margin, padding, border }, nativeControlMetrics);
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
      overflowRect: nativeControlPaintRect === null ? borderRect : unionOverflowRect(borderRect, nativeControlPaintRect),
      clipRect: this.#clip(node, paddingRect, borderRect, clip),
      children: EMPTY_FRAGMENT_CHILDREN,
      lineBoxes: EMPTY_FRAGMENT_LINES,
      usedFontMetrics: metrics,
      baseline: cssAdd(atomicExtents.ascent, negate(margin.top)),
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic:
        visible && node.semantic?.accessibilityHidden !== true
          ? node.semantic
          : null,
      style: this.#paintStyle(node),


    } as const;
    const fragment: LayoutBoxFragment =
      node.kind === "form-control" && control !== null && nativeControlMetrics !== null && nativeControlPaintRect !== null && nativePlacement !== null
        ? {
            ...common,
            kind: "control",
            nativeControlMetrics,
            nativeControlPaintRect,
            nativeControlBaseline: nativePlacement.baseline,
            controlLabel: control.label,
            controlValue: control.value,
            ...(controlLines === undefined ? { controlText: visible && metrics.fontSize > 0 ? text : "" }
              : { controlLines: Object.freeze(visible && metrics.fontSize > 0 ? controlLines : []) }),
            visualClusters: visible && metrics.fontSize > 0
              ? visualClusters
              : EMPTY_TEXT_CLUSTERS,
          }
        : {
            ...common,
            kind: "replaced",
            replacedText: visible && metrics.fontSize > 0 ? text : "",
            visualClusters: visible && metrics.fontSize > 0
              ? visualClusters
              : EMPTY_TEXT_CLUSTERS,
          };
    this.#store(fragment, true);
    // Atomic alignment and line sizing use the margin box, not a font strut
    // centered within the border box. A native baseline includes its CSS edges;
    // replaced/scrolling widgets without one synthesize the bottom margin edge.
    const bidiPosition =
      globalItem < 0 ? undefined : cursor.textAnalysis.positions.at(globalItem);
    const verticalAlign = style?.text.verticalAlign ?? {
      kind: "keyword",
      value: "baseline",
    };
    if (participatesInLine) cursor.entries.push({
      fragment: fragment.id,
      metrics,
      ...atomicExtents,
      verticalAlign,
      bidiParagraph: bidiPosition?.paragraph ?? 0,
      bidiItemStart: bidiPosition?.item ?? 0,
      bidiItemEnd: (bidiPosition?.item ?? 0) + 1,
    });
    cursor.x = point(cursor.x, advance);
    cursor.collapsedSpace = false;
    return { fragment: fragment.id, borderRect, marginRect };
  }

  #fitContentInlineSize(node: FormattingNode, containingWidth: CssPixelLength): CssPixelLength {
    const style = this.#itemComputed(node);
    const { margin, padding, border } = this.#edges(style, containingWidth, node.id);
    const available = nonNegative(sum(containingWidth, negate(margin.left), negate(margin.right),
      negate(padding.left), negate(padding.right), negate(border.left), negate(border.right)));
    // Contributions already resolve preferred/min/max widths and box sizing
    // against the containing width. Preserve min-content overflow when needed.
    const intrinsic = this.#intrinsicContributions(node.id, containingWidth).contentBox;
    return cssMin(intrinsic.maxContentInlineSize, cssMax(intrinsic.minContentInlineSize, available));
  }

  #atomicInlineAdvance(
    node: FormattingNode,
    containingWidth: CssPixelLength,
  ): CssPixelLength {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const { margin, padding, border } = this.#edges(style, containingWidth, node.id);
    const content = this.#fitContentInlineSize(node, containingWidth);
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
    const percentageWidth = cursor.containingBlock.percentageWidth ?? containingWidth;
    const expectedAdvance = this.#atomicInlineAdvance(node, percentageWidth);
    const edges = this.#edges(this.#boxComputed(node), percentageWidth);
    const forcedWidth = nonNegative(sum(expectedAdvance, negate(edges.margin.left), negate(edges.margin.right),
      negate(edges.padding.left), negate(edges.padding.right), negate(edges.border.left), negate(edges.border.right)));
    const globalItem = cursor.textAnalysis.logicalUnits.at(cursor.textAnalysis.textNodes.get(node.id)?.start ?? Number.MAX_SAFE_INTEGER)?.bidiItemStart ?? -1;
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
      containingWidth,
      clip,
      depth + 1,
      cursor.containingBlock,
      forcedWidth,
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
      baseline: cssCoordinateDifference(point(fragment.marginRect.y, atomicMetrics.baseline), fragment.borderRect.y),
      usedFontMetrics: atomicMetrics,
    });
    const bidiPosition =
      globalItem < 0 ? undefined : cursor.textAnalysis.positions.at(globalItem);
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
      baselineShift: this.#verticalShift(node, verticalAlign, atomicMetrics,
        { height: fragment.marginRect.height, ascent: atomicMetrics.ascent }),
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
        children: children.length === 0 ? EMPTY_FRAGMENT_CHILDREN : Object.freeze([...children]),
        lineBoxes: lineBoxes.length === 0 ? EMPTY_FRAGMENT_LINES : Object.freeze([...lineBoxes]),
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
    if (node.kind === "list-item") {
      const marker = node.children.map((id) => this.#formatting.node(id))
        .find((child) => child.kind === "marker" && child.markerPlacement === "outside");
      if (marker !== undefined) this.#outsideMarkers.set(fragment.id, marker.id);
    }
    const position = this.#boxComputed(node)?.box.position;
    if (this.#establishesPositionedContainingBlock(node)) {
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
      node.kind !== "image"
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
    this.#containingBlocks.set(id, cursor.containingBlock);
    this.#recordBlockPercentageConsumer(node, cursor.containingBlock);
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
      node.kind === "image"
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
        cursor.containingBlock,
      );
      cursor.y = cssCoordinateAdd(
        result.marginRect.y,
        result.marginRect.height,
      );
      cursor.x = cursor.continuationX;
      return result;
    }
    const style = this.#boxComputed(node);
    const containingWidth = cursor.containingBlock.percentageWidth ?? ZERO;
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
      const childNode = this.#formatting.node(child);
      if (childNode.kind === "marker" && childNode.markerPlacement === "outside") continue;
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
    const firstUnit = cursor.textAnalysis.textNodes.get(id)?.start;
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

  #textMetricKey(): string {
    return textMeasurementDependencyKey(this.#input.context.textMeasurer, this.#rootFontMetrics);
  }

  #intrinsicInlineRun(
    roots: readonly FormattingNodeId[],
    leaf = false,
    availableInlineSize: CssPixelLength | null = null,
    strutStyle: ComputedStyle | null = null,
  ): { readonly minContent: CssPixelLength; readonly maxContent: CssPixelLength; readonly blockSize: CssPixelLength; readonly firstBaseline: CssPixelLength | null; readonly lastBaseline: CssPixelLength | null } {
    this.#textAnalysisWork.intrinsicCalls += 1;
    let cache = INTRINSIC_RUN_CACHE.get(this.#input.inlineItemStreams);
    if (cache === undefined) {
      cache = new RetainedCacheMap<string, IntrinsicRunAnalysis>();
      INTRINSIC_RUN_CACHE.set(this.#input.inlineItemStreams, cache);
      registerRetainedCache(this.#input.inlineItemStreams, cache);
    }
    const key = `${this.#textMetricKey()}:${String(leaf)}:${String(this.#budgets.maxBreakOpportunities)}:${String(this.#budgets.maxDepth)}:${roots.join("\u0000")}`;
    const retained = cache.get(key);
    if (retained !== undefined) { this.#textAnalysisWork.intrinsicReuses += 1; return { minContent: retained.minContent, maxContent: retained.maxContent,
      ...this.#intrinsicRunBlockMetrics(retained.items, availableInlineSize, strutStyle) }; }
    const reuse = { allowed: true };
    type Event = {
      readonly kind: "text" | "tab" | "soft-hyphen" | "forced-break" | "break-opportunity" | "atomic" | "opening-edge" | "closing-edge";
      readonly text: string;
      readonly style: ComputedStyle | null;
      readonly minimum: CssPixelLength;
      readonly maximum: CssPixelLength;
      readonly collapsibleSpace: boolean;
      readonly offset: number;
      readonly vertical: InlineVerticalMetrics;
    };
    const events: Event[] = [];
    const firstRoot = roots[0];
    const containing = firstRoot === undefined ? null : leaf ? firstRoot : this.#formatting.parent(firstRoot)?.id ?? null;
    let text = "";
    const append = (kind: Event["kind"], value: string, node: FormattingNode,
      minimum: CssPixelLength = ZERO, maximum: CssPixelLength = minimum, collapsibleSpace = false,
      vertical?: InlineVerticalMetrics): void => {
      const style = this.#computed(node);
      const metrics = this.#metrics(style);
      const lineHeight = this.#lineHeight(style, metrics);
      const verticalAlign = this.#formatting.parent(node.id)?.id === containing
        ? { kind: "keyword" as const, value: "baseline" as const }
        : style?.text.verticalAlign ?? { kind: "keyword" as const, value: "baseline" as const };
      const extents = this.#inlineExtents(metrics, lineHeight);
      const widthIndependent = (value: unknown): boolean => {
        if (value === null || typeof value !== "object") return true;
        const token = value as { kind?: string; unit?: string; value?: unknown };
        return token.kind !== "calculation" && (token.kind !== "length"
          || (token.unit === undefined ? widthIndependent(token.value) : !["vw", "vh", "%"].includes(token.unit)));
      };
      if (style !== null && ![style.text.lineHeight, style.text.verticalAlign, style.box.margin.left, style.box.margin.right,
        style.box.padding.left, style.box.padding.right].every(widthIndependent)) reuse.allowed = false;
      events.push({ kind, text: value, style, minimum, maximum, collapsibleSpace, offset: text.length,
        vertical: vertical ?? { lineHeight, ...extents, baselineShift: this.#verticalShift(node, verticalAlign, metrics) } });
      text += value;
    };
    const visit = (id: FormattingNodeId, depth: number): void => {
      this.#input.signal?.throwIfAborted();
      if (depth > this.#budgets.maxDepth) return;
      const node = this.#formatting.node(id);
      const style = this.#computed(node);
      if (node.kind === "marker" && node.markerPlacement === "outside" && !leaf) return;
      if (node.kind === "forced-line-break") { append("forced-break", "\n", node); return; }
      if (node.kind === "line-break-opportunity") { append("break-opportunity", "\u200b", node); return; }
      if (!leaf && (isAtomicInlineBox(this.#formatting, node)
        || node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image")) {
        reuse.allowed = false;
        const contribution = this.#intrinsicContributions(id, availableInlineSize);
        const sizes = contribution.borderBox;
        const edges = this.#edges(this.#boxComputed(node), availableInlineSize ?? ZERO, node.id);
        const margin = sum(edges.margin.left, edges.margin.right);
        let vertical: InlineVerticalMetrics;
        if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image") {
          const native = node.kind === "form-control"
            ? this.#input.context.controlMeasurer.measure(node.control, this.#formatting.document, this.#formatting.state) : null;
          vertical = this.#atomicInlineExtents(node, contribution.contentBox.maximumBlockContribution, edges, native);
        } else {
          const lineHeight = sum(sizes.maximumBlockContribution, edges.margin.top, edges.margin.bottom);
          const baseline = node.kind === "table-wrapper" ? contribution.firstBaseline
            : this.#intrinsicLastBaseline(id, availableInlineSize ?? sizes.maxContentInlineSize);
          const ascent = baseline === null ? lineHeight : cssMin(lineHeight, nonNegative(sum(edges.margin.top, baseline)));
          const align = style?.text.verticalAlign ?? { kind: "keyword" as const, value: "baseline" as const };
          vertical = { lineHeight, ascent, descent: sum(lineHeight, negate(ascent)),
            baselineShift: this.#verticalShift(node, align, this.#metrics(style), { height: lineHeight, ascent }) };
        }
        append("atomic", "\ufffc", node,
          sum(sizes.minContentInlineSize, margin), sum(sizes.maxContentInlineSize, margin), false, vertical);
        return;
      }
      if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker"
        || node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image") {
        const intrinsic = node.kind === "form-control"
          ? this.#controlIntrinsicInline(node, this.#metrics(style))
          : node.kind === "replaced-element" || node.kind === "image"
            ? node.intrinsicWidth === null ? null : cssPx(node.intrinsicWidth)
            : null;
        if (intrinsic !== null) { reuse.allowed = false; append("atomic", "\ufffc", node, intrinsic); return; }
        const processed = this.#input.inlineItemStreams.textForFormattingNode(id);
        if (processed === null || processed.outcome.status !== "complete")
          throw new RangeError("Intrinsic sizing requires complete canonical logical text.");
        for (const unit of processed.units) {
          append(unit.kind, unit.kind === "forced-break" ? "\n" : unit.text, node, ZERO, ZERO, unit.collapsibleSpace);
        }
        return;
      }
      // This recursion is restricted to inline formatting; block/table/grid boxes are
      // composed by their own contribution owner below.
      const boxStyle = this.#boxComputed(node);
      if (boxStyle !== null && [boxStyle.box.margin.left, boxStyle.box.margin.right,
        boxStyle.box.padding.left, boxStyle.box.padding.right].some(percentageDependent)) reuse.allowed = false;
      const edges = this.#edges(boxStyle, ZERO, node.id);
      append("opening-edge", "", node, sum(edges.margin.left, edges.border.left, edges.padding.left));
      for (const child of node.children) {
        const childNode = this.#formatting.node(child);
        if (!this.#outOfFlow(childNode) && isInlineFormattingNode(childNode)) visit(child, depth + 1);
      }
      append("closing-edge", "", node, sum(edges.padding.right, edges.border.right, edges.margin.right));
    };
    for (const root of roots) visit(root, 0);
    this.#textAnalysisWork.intrinsicAnalyzedUnits += events.length;
    let eventIndex = 0;
    const breaks = buildLineBreakMap(text, ({ codeUnitOffset }) => {
      while (eventIndex + 1 < events.length && (events[eventIndex + 1]?.offset ?? Infinity) <= codeUnitOffset)
        eventIndex += 1;
      const style = events[eventIndex]?.style;
      const breakWord = style?.text.wordBreak === "break-word";
      return {
        lineBreak: style?.text.lineBreak ?? "auto",
        wordBreak: breakWord ? "normal" : (style?.text.wordBreak ?? "normal"),
        overflowWrap: breakWord ? "anywhere" : (style?.text.overflowWrap ?? "normal"),
        hyphens: style?.text.hyphens ?? "manual", language: null, preserveGraphemeClusters: true,
      };
    }, { maxBreakOpportunities: this.#budgets.maxBreakOpportunities }, this.#input.signal);
    if (breaks.outcome.status !== "complete") {
      this.#truncated ??= "maxBreakOpportunities";
      throw new LayoutBudgetExhausted();
    }
    let minimum = ZERO as CssPixelLength;
    let maximum = ZERO as CssPixelLength;
    let segment = ZERO as CssPixelLength;
    let line = ZERO as CssPixelLength;
    let segmentTrailing = ZERO as CssPixelLength;
    let lineTrailing = ZERO as CssPixelLength;
    let segmentHasContent = false;
    let lineHasContent = false;
    let previousSoftHyphen: ComputedStyle | null | undefined;
    let lastBreakOffset = -1;
    const finishSegment = (hyphen = false): void => {
      minimum = cssMax(minimum, nonNegative(sum(segment, negate(segmentTrailing),
        hyphen && previousSoftHyphen !== undefined ? this.#measure("-", this.#metrics(previousSoftHyphen).fontSize) : ZERO)));
      segment = segmentTrailing = ZERO;
      segmentHasContent = false;
    };
    const finishLine = (): void => {
      maximum = cssMax(maximum, nonNegative(sum(line, negate(lineTrailing))));
      line = lineTrailing = ZERO;
      lineHasContent = false;
    };
    for (const event of events) {
      this.#input.signal?.throwIfAborted();
      const opportunity = event.offset === 0 ? null : breaks.atCodeUnit(event.offset);
      if (event.kind !== "closing-edge" && event.offset !== lastBreakOffset
        && opportunity?.participatesInMinContent === true
        && event.style?.text.whiteSpace !== "nowrap" && event.style?.text.whiteSpace !== "pre") {
        finishSegment(true);
        lastBreakOffset = event.offset;
      }
      if (event.kind === "forced-break") { finishSegment(); finishLine(); previousSoftHyphen = undefined; continue; }
      if (event.kind === "break-opportunity") { previousSoftHyphen = undefined; continue; }
      if (event.kind === "soft-hyphen") { previousSoftHyphen = event.style; continue; }
      const metrics = this.#metrics(event.style);
      const tabInterval = cssMultiply(metrics.chAdvance, event.style?.text.tabSize ?? 8);
      const tab = (advance: CssPixelLength): CssPixelLength => tabInterval === 0 ? ZERO
        : cssLengthFromFixed(tabInterval - (advance % tabInterval + tabInterval) % tabInterval);
      const measured = event.kind === "text" ? this.#measure(event.text, metrics.fontSize) : event.minimum;
      const minimumAdvance = event.kind === "tab" ? tab(segment) : measured;
      const maximumAdvance = event.kind === "tab" ? tab(line)
        : event.kind === "text" ? measured : event.maximum;
      if (!event.collapsibleSpace || segmentHasContent) {
        segment = cssAdd(segment, minimumAdvance);
        if (event.collapsibleSpace) segmentTrailing = cssAdd(segmentTrailing, minimumAdvance);
      }
      if (!event.collapsibleSpace || lineHasContent) {
        line = cssAdd(line, maximumAdvance);
        if (event.collapsibleSpace) lineTrailing = cssAdd(lineTrailing, maximumAdvance);
      }
      if (event.kind !== "opening-edge" && event.kind !== "closing-edge") {
        if (!event.collapsibleSpace) {
          segmentTrailing = lineTrailing = ZERO;
          segmentHasContent = lineHasContent = true;
        }
        previousSoftHyphen = undefined;
      }
    }
    finishSegment(); finishLine();
    const selectedEvents = events.filter((event) =>
      event.kind !== "opening-edge" && event.kind !== "closing-edge" || event.maximum !== 0);
    const rows = new PackedRows(4, true, Math.max(1, Math.min(128, selectedEvents.length)));
    let previousBoundary = -1;
    const vertical: InlineVerticalMetrics[] = [];
    const verticalIndex = new Map<string, number>();
    for (const event of selectedEvents) {
      const boundary = event.kind === "closing-edge" || event.offset === previousBoundary
        ? "prohibited" : breaks.atCodeUnit(event.offset)?.kind ?? "prohibited";
      if (event.kind !== "closing-edge") previousBoundary = event.offset;
      const metrics = this.#metrics(event.style);
      const advance = event.kind === "text" ? this.#measure(event.text, metrics.fontSize)
        : event.kind === "atomic" && availableInlineSize !== null ? cssMin(event.maximum, cssMax(event.minimum, availableInlineSize))
          : event.maximum;
      const metric = event.vertical;
      const key = [metric.lineHeight, metric.ascent, metric.descent, metric.baselineShift].join(":");
      let metricIndex = verticalIndex.get(key);
      if (metricIndex === undefined) {
        checkPackedMetadata(80);
        metricIndex = vertical.length; vertical.push(Object.freeze(metric)); verticalIndex.set(key, metricIndex);
      }
      rows.push(advance, event.kind === "tab" ? cssMultiply(metrics.chAdvance, event.style?.text.tabSize ?? 8) : -1,
        metricIndex, BREAK_KINDS.indexOf(boundary) | (event.kind === "forced-break" ? 4 : 0)
          | (event.collapsibleSpace ? 8 : 0) | (event.style?.text.whiteSpace !== "nowrap" && event.style?.text.whiteSpace !== "pre" ? 16 : 0)
          | (event.kind !== "break-opportunity" && event.kind !== "soft-hyphen" ? 32 : 0));
    }
    const analysis = Object.freeze({ minContent: minimum, maxContent: cssMax(minimum, maximum), items: new IntrinsicLineItems(rows, vertical) });
    if (reuse.allowed && cache.size < 4096) cache.set(key, analysis);
    return { minContent: analysis.minContent, maxContent: analysis.maxContent,
      ...this.#intrinsicRunBlockMetrics(analysis.items, availableInlineSize, strutStyle) };
  }

  #intrinsicRunBlockMetrics(items: IntrinsicLineItems, availableInlineSize: CssPixelLength | null, strutStyle: ComputedStyle | null): {
    readonly blockSize: CssPixelLength; readonly firstBaseline: CssPixelLength | null; readonly lastBaseline: CssPixelLength | null;
  } {
    if (availableInlineSize === null) return { blockSize: ZERO, firstBaseline: null, lastBaseline: null };
    const selection = selectLogicalLines(items, nonNegative(availableInlineSize), nonNegative(availableInlineSize),
      { maxSelectedLines: this.#budgets.maxLineBoxes }, this.#input.signal);
    if (selection.outcome.status === "rejected") throw new RangeError("Intrinsic line selection was rejected.");
    if (selection.outcome.status === "truncated") { this.#truncated ??= "maxLineBoxes"; throw new LayoutBudgetExhausted(); }
    const strutMetrics = this.#metrics(strutStyle);
    const strut = this.#lineHeight(strutStyle, strutMetrics);
    let blockSize = ZERO as CssPixelLength;
    let firstBaseline: CssPixelLength | null = null, lastBaseline: CssPixelLength | null = null;
    let start = 0, end = 0, hasContent = false;
    const finish = (): void => {
      const entries = function* (): Generator<InlineVerticalMetrics> {
        for (let index = start; index < end; index += 1)
          if (!selection.suppressed.has(index)) yield items.vertical(index);
      };
      const line = this.#lineExtents(strutMetrics, strut, entries());
      lastBaseline = sum(blockSize, line.ascent);
      firstBaseline ??= lastBaseline;
      blockSize = cssAdd(blockSize, line.height);
      start = end; hasContent = false;
    };
    for (const item of items) {
      const index = item.logicalIndex;
      if (selection.breaksBefore.has(index)) finish();
      end = index + 1;
      if (item.forcedBreak) finish();
      else if (!selection.suppressed.has(index)) hasContent ||= items.hasContent(index);
    }
    if (hasContent) finish();
    return { blockSize, firstBaseline, lastBaseline };
  }

  #intrinsicInlineSizes(
    id: FormattingNodeId,
  ): { readonly minContent: CssPixelLength; readonly maxContent: CssPixelLength } {
    this.#input.signal?.throwIfAborted();
    const node = this.#formatting.node(id);
    if (node.kind === "replaced-element" || node.kind === "image") {
      const style = this.#computed(node);
      const size = this.#replacedContentSize(node, null, null,
        this.#measure(node.fallbackText, this.#fontSize(style)), this.#lineHeight(style, this.#metrics(style)), null, null, true, false);
      return { minContent: size.width, maxContent: size.width };
    }
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker"
      || node.kind === "form-control"
      || node.kind === "forced-line-break" || node.kind === "line-break-opportunity")
      return this.#intrinsicInlineRun([id], true);
    const maximum = cssLengthFromFixed(Number.MAX_SAFE_INTEGER);
    if (node.kind === "grid-container") return {
      minContent: intrinsicGridInlineSize(this.#gridIntrinsicSizingHost(), node, "min-content", maximum),
      maxContent: intrinsicGridInlineSize(this.#gridIntrinsicSizingHost(), node, "max-content", maximum),
    };
    if (node.kind === "table" || node.kind === "table-wrapper")
      return this.#tableBudget(() => intrinsicTableInlineSizes(this.#tableIntrinsicSizingHost(), node));
    const style = this.#boxComputed(node);
    const rowFlex = node.kind === "flex-container"
      && (style?.box.flexDirection === "row" || style?.box.flexDirection === "row-reverse");
    let minimum = ZERO as CssPixelLength;
    let maximumInline = ZERO as CssPixelLength;
    let inlineRun: FormattingNodeId[] = [];
    let inFlowChildren = 0;
    const flush = (): void => {
      if (inlineRun.length === 0) return;
      const sizes = this.#intrinsicInlineRun(inlineRun);
      minimum = cssMax(minimum, sizes.minContent);
      maximumInline = cssMax(maximumInline, sizes.maxContent);
      inlineRun = [];
    };
    for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (this.#outOfFlow(child) || child.kind === "marker" && child.markerPlacement === "outside") continue;
      inFlowChildren += 1;
      if (!rowFlex && isInlineFormattingNode(child)) { inlineRun.push(childId); continue; }
      flush();
      const contribution = this.#intrinsicContributions(childId, null).borderBox;
      const edges = this.#edges(this.#itemComputed(child), ZERO, child.id);
      const margin = sum(edges.margin.left, edges.margin.right);
      const childMinimum = sum(contribution.minContentInlineSize, margin);
      const childMaximum = sum(contribution.maxContentInlineSize, margin);
      minimum = rowFlex ? cssAdd(minimum, childMinimum) : cssMax(minimum, childMinimum);
      maximumInline = rowFlex ? cssAdd(maximumInline, childMaximum) : cssMax(maximumInline, childMaximum);
    }
    flush();
    if (rowFlex && inFlowChildren > 1) {
      const gap = cssMultiply(this.#usedGap(style.box.columnGap, null, style) ?? ZERO, inFlowChildren - 1);
      minimum = cssAdd(minimum, gap);
      maximumInline = cssAdd(maximumInline, gap);
    }
    return { minContent: minimum, maxContent: maximumInline };
  }

  #intrinsicContributions(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength | null,
    inlineSizing: "contribution" | "content" = "contribution",
  ): IntrinsicSizeContributions {
    const node = this.#formatting.node(id);
    if ((node.kind === "flex-item" || node.kind === "grid-item") && !node.appliesBoxStyle
      && node.children.length === 1 && node.children[0] !== undefined)
      return this.#intrinsicContributions(node.children[0], availableInlineSize, inlineSizing);
    const outcome = this.#intrinsicContributionCache.resolve(
      { formattingNode: id, availableInlineSize, inlineSizing },
      () => {
        const maximum = cssLengthFromFixed(Number.MAX_SAFE_INTEGER);
        const inlineSize = availableInlineSize ?? maximum;
        const node = this.#formatting.node(id);
        const sizes = this.#intrinsicInlineSizes(id);
        let minimumInline = sizes.minContent;
        let maximumInline = sizes.maxContent;
        const block = this.#intrinsicBlockSize(id, inlineSize);
        const style = this.#boxComputed(node);
        if (node.kind === "image" && node.imageResourceId !== null
          && (inlineSizing === "content" || style === null
            || this.#usedLength(style.box.width, availableInlineSize, style) === null))
          this.#imageDimensionDependencies.add(node.imageResourceId);
        const edges = this.#edges(style, availableInlineSize ?? ZERO, node.id);
        const inlineBorderPadding = sum(
          edges.border.left,
          edges.padding.left,
          edges.padding.right,
          edges.border.right,
        );
        if (style !== null && inlineSizing === "contribution") {
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
      inlineSizing,
    });
  }

  #gridItemMinimumInlineContribution(
    id: FormattingNodeId,
    contributions: IntrinsicSizeContributions,
    automaticMinimum: boolean,
  ): CssNonNegativeLength {
    const node = this.#formatting.node(id);
    const style = this.#itemComputed(node);
    if (style === null) return contributions.borderBox.minContentInlineSize;
    const chrome = nonNegative(sum(
      contributions.borderBox.minContentInlineSize,
      negate(contributions.contentBox.minContentInlineSize),
    ));
    // A definite preferred size supplies the minimum contribution. Otherwise
    // substitute the used minimum size, rather than the min-content width.
    if (this.#usedLength(style.box.width, null, style) !== null)
      return contributions.borderBox.minContentInlineSize;
    if (style.box.minWidth.kind === "auto")
      return !automaticMinimum || isScrollableOverflow(style.box.overflowX)
        ? chrome
        : contributions.borderBox.minContentInlineSize;
    const minimum = this.#usedLength(style.box.minWidth, null, style);
    if (minimum === null) return contributions.borderBox.minContentInlineSize;
    return nonNegative(style.box.boxSizing === "border-box"
      ? cssMax(chrome, minimum)
      : sum(chrome, minimum));
  }

  #intrinsicBlockSize(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth = 0,
    forcedContentWidth: CssPixelLength | null = null,
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
        forcedContentWidth,
      );
    }
    if (node.kind === "table" || node.kind === "table-wrapper") {
      return this.#tableBudget(() => intrinsicTableBlockSize(
        {
          ...this.#tableIntrinsicSizingHost(),
          dimensions: (candidate, width, height, forcedWidth) =>
            this.#dimensions(candidate, width, height, forcedWidth, false,
              candidate.kind === "table" ? this.#computed(candidate) : undefined),
          intrinsicOuterBlockSize: (candidate, inlineSize, candidateDepth) =>
            this.#intrinsicOuterBlockSize(candidate, inlineSize, candidateDepth),
        },
        node,
        availableInlineSize,
        depth,
        forcedContentWidth,
      ));
    }
    const style = this.#computed(node);
    const dimensions = this.#dimensions(node, availableInlineSize, null, forcedContentWidth);
    const contentInlineSize = dimensions.contentWidth;
    if (dimensions.specifiedHeight !== null)
      return constrainedSize(dimensions.specifiedHeight, dimensions.specifiedHeight,
        dimensions.minHeight, dimensions.maxHeight);
    let automatic: CssPixelLength;
    if (node.kind === "replaced-element" || node.kind === "image") {
      automatic = this.#replacedContentSize(node, availableInlineSize, null,
        this.#measure(node.fallbackText, this.#fontSize(style)), this.#lineHeight(style, this.#metrics(style)), forcedContentWidth).height;
    } else if (node.kind === "form-control") {
      automatic = cssMultiply(this.#input.context.controlMeasurer.measure(node.control, this.#formatting.document, this.#formatting.state).height, node.control.kind === "textarea" ? node.control.rows : 1);
    } else if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker" ||
      node.kind === "forced-line-break" ||
      node.kind === "line-break-opportunity"
    ) {
      automatic = this.#intrinsicInlineRun([id], true, contentInlineSize, style).blockSize;
    } else if (node.kind === "flex-container") {
      automatic = this.#intrinsicFlexBlockSize(
        node,
        contentInlineSize,
        depth + 1,
      );
    } else if (node.kind === "grid-container") {
      automatic = intrinsicGridBlockSize(
        this.#gridIntrinsicSizingHost(),
        node,
        contentInlineSize,
        depth + 1,
      );
    } else if (node.kind === "table-row") {
      automatic = ZERO;
      for (const child of node.children) {
        automatic = cssMax(
          automatic,
          this.#intrinsicOuterBlockSize(child, contentInlineSize, depth + 1),
        );
      }
    } else {
      automatic = ZERO;
      let inlineRun: FormattingNodeId[] = [];
      const flush = (): void => {
        if (inlineRun.length === 0) return;
        automatic = cssAdd(automatic, this.#intrinsicInlineRun(inlineRun, false, contentInlineSize, style).blockSize);
        inlineRun = [];
      };
      for (const childId of node.children) {
        const child = this.#formatting.node(childId);
        if (this.#outOfFlow(child) || child.kind === "marker" && child.markerPlacement === "outside") continue;
        if (isInlineFormattingNode(child)) { inlineRun.push(childId); continue; }
        flush();
        automatic = cssAdd(automatic, this.#intrinsicOuterBlockSize(childId, contentInlineSize, depth + 1));
      }
      flush();
    }
    return constrainedSize(nonNegative(automatic), null, dimensions.minHeight, dimensions.maxHeight);
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
    const edges = this.#edges(this.#boxComputed(node), availableInlineSize, node.id);
    const contentStart = sum(edges.border.top, edges.padding.top);
    if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image") {
      const native = node.kind === "form-control"
        ? this.#input.context.controlMeasurer.measure(node.control, this.#formatting.document, this.#formatting.state) : null;
      const vertical = this.#atomicInlineExtents(node, this.#intrinsicBlockSize(id, availableInlineSize, depth + 1), edges,
        native);
      return nonNegative(sum(vertical.ascent, negate(edges.margin.top)));
    }
    if (
      node.kind === "text-sequence" ||
      node.kind === "generated-text" ||
      node.kind === "marker" ||
      node.kind === "forced-line-break" ||
      node.kind === "line-break-opportunity"
    ) {
      const metrics = this.#metrics(style);
      return nonNegative(sum(
        contentStart,
        this.#inlineExtents(metrics, this.#lineHeight(style, metrics)).ascent,
      ));
    }
    const children = node.children
      .map((child) => this.#formatting.node(child))
      .filter((child) => !this.#outOfFlow(child) && !(child.kind === "marker" && child.markerPlacement === "outside"));
    if (children.length === 0) return null;
    if (children.every((child) => isInlineFormattingNode(child))) {
      const baseline = this.#intrinsicInlineRun(children.map((child) => child.id), false,
        this.#dimensions(node, availableInlineSize, null).contentWidth, style).firstBaseline;
      return baseline === null ? null : nonNegative(sum(contentStart, baseline));
    }
    let offset: CssPixelLength = contentStart;
    for (const child of children) {
      const childStyle = this.#boxComputed(child);
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

  #intrinsicLastBaseline(id: FormattingNodeId, availableInlineSize: CssPixelLength, depth = 0): CssPixelLength | null {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) return null;
    const node = this.#formatting.node(id);
    if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image")
      return null; // Standalone atomic blocks do not establish an inner text line.
    const style = this.#computed(node);
    const dimensions = this.#dimensions(node, availableInlineSize, null);
    let offset = sum(dimensions.border.top, dimensions.padding.top);
    let baseline: CssPixelLength | null = null;
    let run: FormattingNodeId[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const metrics = this.#intrinsicInlineRun(run, false, dimensions.contentWidth, style);
      if (metrics.lastBaseline !== null) baseline = sum(offset, metrics.lastBaseline);
      offset = cssAdd(offset, metrics.blockSize); run = [];
    };
    for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (this.#outOfFlow(child) || child.kind === "marker" && child.markerPlacement === "outside") continue;
      if (isInlineFormattingNode(child)) { run.push(childId); continue; }
      flush();
      const edges = this.#edges(this.#boxComputed(child), dimensions.contentWidth, child.id);
      const last = this.#intrinsicLastBaseline(childId, dimensions.contentWidth, depth + 1);
      if (last !== null) baseline = sum(offset, edges.margin.top, last);
      offset = cssAdd(offset, this.#intrinsicOuterBlockSize(childId, dimensions.contentWidth, depth + 1));
    }
    flush();
    return baseline;
  }

  #intrinsicOuterBlockSize(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth: number,
    forcedContentWidth: CssPixelLength | null = null,
  ): CssNonNegativeLength {
    const node = this.#formatting.node(id);
    if ((node.kind === "flex-item" || node.kind === "grid-item") && !node.appliesBoxStyle
      && node.children.length === 1 && node.children[0] !== undefined)
      return this.#intrinsicOuterBlockSize(node.children[0], availableInlineSize, depth, forcedContentWidth);
    const block = this.#intrinsicBlockSize(id, availableInlineSize, depth, forcedContentWidth);
    const edges = this.#edges(this.#boxComputed(node), availableInlineSize, node.id);
    return nonNegative(
      sum(
        block,
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
          this.#intrinsicOuterBlockSize(item, availableInlineSize, depth,
            this.#columnFlexCrossSize(this.#formatting.node(item), style, axes, availableInlineSize)),
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
        );
      } else {
        lineMain = required;
        lineCross = cssMax(
          lineCross,
          this.#intrinsicOuterBlockSize(item, availableInlineSize, depth),
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null,
    forcedContentHeight: CssPixelLength | null,
    forcedContentHeightIsDefinite: boolean,
  ): LayoutResult {
    return layoutTableContainer(
      {
        containingBlock: (owner, rect, widthBasis, heightBasis) => {
          const block = this.#containingBlock(owner, rect, widthBasis, heightBasis);
          if (owner !== wrapper.id && forcedContentHeight !== null && !forcedContentHeightIsDefinite)
            this.#transferBlockDefiniteness(containingBlock, block);
          return block;
        },
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
          const edges = this.#edges(this.#boxComputed(node), basis);
          return nonNegative(sum(
            edges.padding.left,
            edges.padding.right,
            edges.border.left,
            edges.border.right,
          ));
        },
        tableSlotGrid: (node) => this.#tableSlotGrid(node),
        dimensions: (node, containingWidth, containingHeight, forcedWidth) =>
          this.#dimensions(node, containingWidth, containingHeight, forcedWidth,
            node.kind === "table" && wrapper.outer === "block"
              && (this.#computed(wrapper)?.box.float ?? "none") === "none"
              && !this.#outOfFlow(wrapper),
            node.kind === "table" ? this.#computed(node) : undefined),
        intrinsicContributions: (id, availableInlineSize) =>
          this.#intrinsicContributions(id, availableInlineSize),
        layoutChild: (
          id,
          childX,
          childY,
          childWidth,
          childClip,
          childDepth,
          childContainingBlock,
          forcedWidth,
          forcedHeight,
          forcedHeightIsDefinite,
        ) => this.#tryLayoutNode(
          id,
          childX,
          childY,
          childWidth,
          childClip,
          childDepth,
          childContainingBlock,
          forcedWidth,
          forcedHeight,
          forcedHeightIsDefinite,
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
        container: (node, contentRect, paddingRect, borderRect, marginRect, clipRect, children, lines, owner) => {
          this.#containingBlocks.set(node.id, owner);
          return this.#container(node, contentRect, paddingRect, borderRect, marginRect, clipRect, children, lines);
        },
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
      { wrapper, x, y, width, clip, depth, containingBlock, forcedContentWidth, forcedContentHeight, forcedContentHeightIsDefinite },
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
        const edges = this.#edges(this.#boxComputed(node), basis);
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
      computed: (node) => this.#itemComputed(node),
      boxComputed: (node) => this.#boxComputed(node),
      isOutOfFlow: (node) => this.#outOfFlow(node),
      usedGap: (value, basis, style) => this.#usedGap(value, basis, style),
      usedLength: (value, basis, style) => this.#usedLength(value, basis, style),
      edges: (style, containingWidth) => this.#edges(style, containingWidth),
      intrinsicContributions: (id, availableInlineSize) =>
        this.#intrinsicContributions(id, availableInlineSize),
      gridItemMinimumInlineContribution: (id, contributions, automaticMinimum) =>
        this.#gridItemMinimumInlineContribution(id, contributions, automaticMinimum),
      intrinsicOuterBlockSize: (id, availableInlineSize, depth) =>
        this.#intrinsicOuterBlockSize(id, availableInlineSize, depth),
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
    const translatedOffsets = new Map<FormattingNodeId, {
      readonly inline: CssPixelLength;
      readonly block: CssPixelLength;
    }>();
    const pending = [{ id: result.fragment, inline: inlineOffset, block: blockOffset }];
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) continue;
      const { id } = entry;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      let inline = entry.inline;
      let block = entry.block;
      if (id !== result.fragment && fragment.kind !== "text" && !this.#deferredPositioned.has(id)) {
        const node = this.#formatting.node(fragment.formattingNode);
        const style = this.#boxComputed(node);
        const position = style?.box.position;
        if (position === "absolute" || position === "fixed") {
          const owner = this.#positionedContainingNode(node, position === "fixed");
          const ownerOffset = owner === null ? undefined : translatedOffsets.get(owner.id);
          // Auto insets retain the hypothetical normal-flow position on each axis.
          // Explicit insets follow only their containing block, which may be outside
          // this subtree (or move differently from an intervening positioned box).
          const automatic = (side: keyof ComputedStyle["box"]["inset"]): boolean => {
            const value = style?.box.inset[side];
            return value === undefined || value.kind === "auto" || value.kind === "none";
          };
          if (!automatic("left") || !automatic("right")) inline = ownerOffset?.inline ?? ZERO;
          if (!automatic("top") || !automatic("bottom")) block = ownerOffset?.block ?? ZERO;
        }
      }
      if (fragment.kind !== "text") translatedOffsets.set(fragment.formattingNode, { inline, block });
      for (const child of fragment.children) pending.push({ id: child, inline, block });
      const move = (rect: CssRect): CssRect =>
        cssRect(point(rect.x, inline), point(rect.y, block), rect.width, rect.height);
      if (this.#principalFragments.get(fragment.formattingNode) === id) {
        for (const owned of this.#ownedContainingBlocks.get(fragment.formattingNode) ?? []) owned.rect = move(owned.rect);
      }
      const lineBoxes = fragment.lineBoxes.map((line) => {
        const moved = Object.freeze({
          ...line,
          rect: move(line.rect),
          baseline: cssAdd(line.baseline, block),
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
        ...(fragment.kind === "text" ? { inkRect: move(fragment.inkRect) } : {}),
        ...(fragment.kind === "control" && fragment.nativeControlPaintRect !== undefined
          ? { nativeControlPaintRect: move(fragment.nativeControlPaintRect) } : {}),
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
    basis: CssPixelLength | null,
  ): CssPixelLength | null {
    const value = style?.box.inset[side];
    return value === undefined || value.kind === "auto" || value.kind === "none"
      ? null
      : this.#usedLength(value, basis, style);
  }

  #positionedContainingNode(node: FormattingNode, fixed: boolean): FormattingNode | null {
    let parent = this.#formatting.parent(node.id);
    while (parent !== null) {
      if (fixed ? this.#hasTransform(parent) || this.#paintContainment(parent) : this.#establishesPositionedContainingBlock(parent)) return parent;
      parent = this.#formatting.parent(parent.id);
    }
    return null;
  }

  #positionedContainingBlock(node: FormattingNode, fixed: boolean): CssRect {
    const owner = this.#positionedContainingNode(node, fixed);
    if (owner !== null) {
      const rect = this.#positionedContainingBlocks.get(owner.id);
      if (rect === undefined) throw new RangeError("Positioned containing block has not been finalized.");
      return rect;
    }
    return fixed ? this.#input.context.scrollport : this.#input.context.initialContainingBlock;
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
    const fixed = style?.box.position === "fixed";
    const owner = this.#positionedContainingNode(node, fixed);
    const viewportFixed = fixed && owner === null;
    if (owner !== null && !this.#positionedContainingBlocks.has(owner.id)) {
      // The nearest owner may still be laying out its auto-sized descendants.
      // Reserve its static position, then use this same layout path once the owner is final.
      this.#reserve();
      try {
        const empty = cssRect(staticX, staticY, ZERO, ZERO);
        const placeholder = this.#container(node, empty, empty, empty, empty, inheritedClip, [], []);
        this.#deferredPositioned.set(placeholder.fragment, { node, depth });
        return placeholder;
      } finally {
        this.#reserved -= 1;
      }
    }
    const containingBlock =
      (fixed ? undefined : containingBlockOverride) ??
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
            const preferredMinimum = this.#intrinsicContributions(node.id, containingBlock.width).contentBox.minContentInlineSize;
            const preferred = this.#intrinsicContributions(node.id, containingBlock.width).contentBox.maxContentInlineSize;
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
    let forcedHeight =
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
    if (forcedHeight !== null) forcedHeight = constrainedSize(forcedHeight, null,
      dimensions.minHeight, dimensions.maxHeight);
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
      viewportFixed
        ? this.#input.context.scrollport
        : inheritedClip,
      depth,
      this.#containingBlock(owner?.id ?? null, containingBlock, containingBlock.width, containingBlock.height),
      forcedWidth,
      forcedHeight,
      true,
    );
    if (result === null) return null;
    // Finalize offsets against the actual border box: intrinsic table/caption
    // sizing can enlarge it beyond preliminary width or height predictions.
    const targetBorderX = useLeftInset
      ? point(containingBlock.x, sum(left, edges.margin.left))
      : right !== null
        ? point(
            cssCoordinateAdd(containingBlock.x, containingBlock.width),
            sum(negate(right), negate(edges.margin.right), negate(result.borderRect.width)),
          )
        : borderX;
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
    const positioned = this.#translate(
      result,
      cssCoordinateDifference(targetBorderX, result.borderRect.x),
      cssCoordinateDifference(targetBorderY, result.borderRect.y),
      viewportFixed
        ? this.#input.context.scrollport
        : inheritedClip,
    );
    if (viewportFixed) {
      const fragment = this.#fragments.get(positioned.fragment);
      if (fragment !== undefined) {
        this.#scrollAttachments.set(positioned.fragment, Object.freeze({
          kind: "fixed",
          root: positioned.fragment,
          normalBorderRect: fragment.borderRect,
        }));
      }
    }
    return positioned;
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
    const containingBlock = this.#containingBlocks.get(node.id);
    if (containingBlock === undefined) throw new RangeError("Missing owned in-flow containing block.");
    if (style.box.position === "sticky") {
      this.#scrollAttachments.set(result.fragment, Object.freeze({
        kind: "sticky",
        root: result.fragment,
        normalBorderRect: result.borderRect,
        containingBlock: containingBlock.rect,
        containingFragment: containingBlock.owner === null ? null : this.#principalFragments.get(containingBlock.owner) ?? null,
        top: null, right: null, bottom: null, left: null,
      }));
      return result;
    }
    const insetBasis = containingBlock;
    const left = this.#usedInset(style, "left", insetBasis.percentageWidth);
    const right = this.#usedInset(style, "right", insetBasis.percentageWidth);
    const top = this.#usedInset(style, "top", insetBasis.percentageHeight);
    const bottom = this.#usedInset(style, "bottom", insetBasis.percentageHeight);
    const inlineOffset =
      left !== null && right !== null
        ? style.text.direction === "rtl"
          ? negate(right)
          : left
        : (left ?? (right === null ? ZERO : negate(right)));
    const blockOffset = top ?? (bottom === null ? ZERO : negate(bottom));
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
    forcedContentHeightIsDefinite = false,
  ): LayoutResult {
    const ownsFloatManager =
      this.#floatManagers.length === 0 ||
      !this.#normalBlockFlow(node) ||
      this.#independentFormattingContext(node);
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
        containingBlock,
        forcedContentWidth,
        forcedContentHeight,
        manager,
        ownsFloatManager,
        forcedContentHeightIsDefinite,
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null,
    floatManager: FloatExclusionManager,
    ownsFloatManager: boolean,
    forcedContentHeightIsDefinite: boolean,
  ): LayoutResult {
    const containerId = this.#newId(node.id);
    const dimensions = this.#dimensions(
      node,
      containingBlock.percentageWidth ?? containingWidth,
      containingBlock.percentageHeight,
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
    // A formatting-context allocation is already constrained by its owner.
    // Its used pixels and its ability to resolve percentages are separate inputs.
    const definiteContentHeight = forcedContentHeight !== null
      ? forcedContentHeightIsDefinite ? forcedContentHeight : null
      : dimensions.specifiedHeight === null ? null
        : constrainedSize(dimensions.specifiedHeight, dimensions.specifiedHeight,
          dimensions.minHeight, dimensions.maxHeight);
    const itemWrapper = node.kind === "flex-item" || node.kind === "grid-item";
    const childContainingBlock = itemWrapper ? containingBlock : this.#containingBlock(
      node.id, cssRect(contentX, contentY, dimensions.contentWidth, definiteContentHeight ?? ZERO),
      dimensions.contentWidth, definiteContentHeight,
    );
    if (forcedContentHeight !== null && !forcedContentHeightIsDefinite)
      this.#transferBlockDefiniteness(containingBlock, childContainingBlock);
    // The final block size is not known until in-flow layout finishes. Descendant
    // clips are recomputed from the final rectangles before the tree is exposed.
    const childClip = inheritedClip;
    const children: LayoutFragmentId[] = [];
    let outsideMarker: FormattingNodeId | null = null;
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
        containingBlock: childContainingBlock,
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
        lineLevelOverrides: new Map<number, number>(),
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
      if (child.kind === "marker" && child.markerPlacement === "outside") {
        outsideMarker = childId;
        continue;
      }
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
        const floatContentWidth = this.#fitContentInlineSize(child, dimensions.contentWidth);
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
        let result = this.#tryLayoutNode(
          childId,
          initialX,
          point(floatY, childDimensions.margin.top),
          dimensions.contentWidth,
          childClip,
          depth + 1,
          childContainingBlock,
          floatContentWidth,
        );
        if (result === null) break;
        if (childStyle.box.float === "right") {
          result = this.#translate(result,
            cssCoordinateDifference(range.end, point(result.marginRect.x, result.marginRect.width)),
            ZERO, childClip);
        }
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
        !this.#independentFormattingContext(node);
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
        this.#independentFormattingContext(child);
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
        childContainingBlock,
        childForcedWidth,
        sizedItem ? forcedContentHeight : null,
        sizedItem && forcedContentHeightIsDefinite,
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
    const inlineComplete = flushInline();
    if (outsideMarker !== null && children.length === 0 && inlineComplete) {
      const style = this.#computed(node);
      currentBottom = point(contentY, this.#lineHeight(style, this.#metrics(style)));
    }
    const collapseLast =
      dimensions.border.bottom === 0 &&
      dimensions.padding.bottom === 0 &&
      dimensions.specifiedHeight === null &&
      dimensions.minHeight === 0 &&
      this.#normalBlockFlow(node) &&
      !this.#independentFormattingContext(node);
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
    if (!itemWrapper) childContainingBlock.rect = contentRect;
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
    if (this.#establishesPositionedContainingBlock(node))
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
    forcedContentHeightIsDefinite = false,
  ): LayoutResult {
    return layoutGridContainer(
      {
        containingBlock: (owner, rect, widthBasis, heightBasis) => this.#containingBlock(owner, rect, widthBasis, heightBasis),
        transferBlockDefiniteness: (parent, child) => { this.#transferBlockDefiniteness(parent, child); },
        dependOnBlockSize: (owner) => this.#indefiniteBlockConsumers.add(owner),
        budgets: this.#budgets,
        signal: this.#input.signal,
        formattingNode: (id) => this.#formatting.node(id),
        computed: (candidate) => this.#itemComputed(candidate),
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
        usedGap: (value, basis, computed, owner) =>
          this.#usedGap(value, basis, computed, owner),
        usedLength: (value, basis, computed, owner) =>
          this.#usedLength(value, basis, computed, owner),
        isOutOfFlow: (candidate) => this.#outOfFlow(candidate),
        intrinsicContributions: (id, availableInlineSize) =>
          this.#intrinsicContributions(id, availableInlineSize),
        gridItemMinimumInlineContribution: (id, contributions, automaticMinimum) =>
          this.#gridItemMinimumInlineContribution(id, contributions, automaticMinimum),
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
          childContainingBlock,
          forcedWidth,
          forcedHeight,
          forcedHeightIsDefinite,
        ) =>
          this.#tryLayoutNode(
            id,
            childX,
            childY,
            childWidth,
            childClip,
            childDepth,
            childContainingBlock,
            forcedWidth,
            forcedHeight,
            forcedHeightIsDefinite,
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
        containingBlock,
        forcedContentWidth,
        forcedContentHeight,
        forcedContentHeightIsDefinite,
      },
    );
  }

  #flexCrossStretches(childStyle: ComputedStyle | null, containerStyle: ComputedStyle, axes: FlexAxes): boolean {
    const alignment = usedItemAlignment(childStyle?.box.alignSelf.position === "auto" || childStyle?.box.alignSelf === undefined
      ? containerStyle.box.alignItems : childStyle.box.alignSelf);
    const property = axes.row ? childStyle?.box.height : childStyle?.box.width;
    return alignment === "stretch" && (property === undefined || property.kind === "auto" || property.kind === "none")
      && childStyle?.box.margin[axes.crossStart].kind !== "auto"
      && childStyle?.box.margin[axes.crossEnd].kind !== "auto";
  }

  #columnFlexCrossSize(child: FormattingNode, containerStyle: ComputedStyle, axes: FlexAxes,
    containingWidth: CssPixelLength): CssPixelLength {
    const style = this.#itemComputed(child);
    // Only a single-line stretch has its final cross size before line collection.
    // Wrapped columns first use fit-content and then stretch within their own line.
    if (containerStyle.box.flexWrap === "nowrap" && this.#flexCrossStretches(style, containerStyle, axes))
      return this.#dimensions(child, containingWidth, null, null, false, style).contentWidth;
    return this.#fitContentInlineSize(child, containingWidth);
  }

  #flexItemInput(
    childId: FormattingNodeId,
    sourceIndex: number,
    axes: FlexAxes,
    containingWidth: CssPixelLength,
    definiteMainSize: CssPixelLength | null,
    columnCrossSize: CssPixelLength | null = null,
  ): FlexItemInput<FormattingNodeId> {
    const child = this.#formatting.node(childId);
    const style = this.#itemComputed(child);
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
      ? this.#intrinsicContributions(childId, null, "content").contentBox.maxContentInlineSize
      : this.#intrinsicBlockSize(childId, containingWidth, 0, columnCrossSize);
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
    const base = basisValue?.kind === "content" ? nonNegative(intrinsic)
      : basisFromProperty !== null ? toContent(basisFromProperty)
        : preferredValue !== null ? toContent(preferredValue) : nonNegative(intrinsic);
    const minimumProperty = rowAxis
      ? style?.box.minWidth
      : style?.box.minHeight;
    const automaticMinimum = isScrollableOverflow((rowAxis ? style?.box.overflowX : style?.box.overflowY) ?? "visible") ? ZERO : rowAxis
      ? cssMin(
          this.#intrinsicContributions(childId, null, "content").contentBox.minContentInlineSize,
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
    const style = this.#itemComputed(child);
    const startProperty = style?.box.margin[axes.crossStart];
    const endProperty = style?.box.margin[axes.crossEnd];
    const free = sum(lineCrossSize, negate(outerCrossSize));
    const autoStart = startProperty?.kind === "auto";
    const autoEnd = endProperty?.kind === "auto";
    if (autoStart || autoEnd) {
      const logical = free > 0 && autoStart ? autoEnd ? cssDivide(free, 2) : free : ZERO;
      return axes.crossReverse ? sum(free, negate(logical)) : logical;
    }
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

  #discardLayoutSubtrees(roots: readonly LayoutFragmentId[]): void {
    const discarded = new Set<LayoutFragmentId>();
    const affectedFormattingNodes = new Set<FormattingNodeId>();
    const affectedDocumentNodes = new Set<DocumentNodeRef>();
    const pending = [...roots];
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
      this.#scrollAttachments.delete(id);
      if (this.#principalFragments.get(fragment.formattingNode) === id) {
        this.#principalFragments.delete(fragment.formattingNode);
        this.#positionedContainingBlocks.delete(fragment.formattingNode);
        this.#containingBlocks.delete(fragment.formattingNode);
        for (const block of this.#ownedContainingBlocks.get(fragment.formattingNode) ?? []) {
          const parent = this.#blockDefinitenessParents.get(block);
          if (parent !== undefined) this.#blockDefinitenessTransfers.get(parent)?.delete(block);
          this.#blockDefinitenessParents.delete(block);
          this.#blockDefinitenessTransfers.delete(block);
          this.#indefiniteBlockConsumers.delete(block);
        }
        this.#ownedContainingBlocks.delete(fragment.formattingNode);
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
    forcedContentHeightIsDefinite = false,
  ): LayoutResult {
    const style = this.#boxComputed(node) ?? this.#computed(node);
    if (style === null)
      throw new Error("A flex formatting context requires a computed style.");
    const dimensions = this.#dimensions(node, width, containingBlock.percentageHeight, forcedContentWidth);
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
    const specifiedBlockSize = forcedContentHeight ?? dimensions.specifiedHeight;
    const definiteBlockSize = forcedContentHeight !== null
      ? forcedContentHeightIsDefinite ? forcedContentHeight : null
      : dimensions.specifiedHeight === null ? null
        : constrainedSize(dimensions.specifiedHeight, dimensions.specifiedHeight, dimensions.minHeight, dimensions.maxHeight);
    const childContainingBlock = this.#containingBlock(node.id,
      cssRect(contentX, contentY, dimensions.contentWidth, definiteBlockSize ?? ZERO),
      dimensions.contentWidth, definiteBlockSize);
    if (forcedContentHeight !== null && !forcedContentHeightIsDefinite)
      this.#transferBlockDefiniteness(containingBlock, childContainingBlock);
    const definiteItemMainSize = (child: FormattingNode): boolean => {
      if (rowAxis || definiteBlockSize !== null) return true;
      const childStyle = this.#itemComputed(child);
      const basis = childStyle?.box.flexBasis;
      const preferred = basis?.kind === "auto" ? childStyle?.box.height : basis;
      return preferred !== undefined && preferred.kind !== "content"
        && this.#usedLength(preferred, null, childStyle) !== null;
    };
    const stretchedCrossSize = (child: FormattingNode, crossSize: CssPixelLength): CssNonNegativeLength => {
      const childStyle =
        this.#itemComputed(child);
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
      const crossBasis = rowAxis ? definiteBlockSize : dimensions.contentWidth;
      const crossBorderPadding = rowAxis
        ? sum(childEdges.border.top, childEdges.padding.top, childEdges.padding.bottom, childEdges.border.bottom)
        : sum(childEdges.border.left, childEdges.padding.left, childEdges.padding.right, childEdges.border.right);
      const crossConstraint = (value: CssLength): CssPixelLength | null => {
        const used = this.#usedLength(value, crossBasis, childStyle);
        return used === null ? null : childStyle?.box.boxSizing === "border-box"
          ? nonNegative(sum(used, negate(crossBorderPadding))) : used;
      };
      const minimumCross = childStyle === null ? ZERO
        : crossConstraint(rowAxis ? childStyle.box.minHeight : childStyle.box.minWidth) ?? ZERO;
      const maximumCross = childStyle === null ? null
        : crossConstraint(rowAxis ? childStyle.box.maxHeight : childStyle.box.maxWidth);
      return constrainedSize(nonNegative(sum(crossSize, negate(crossChrome))),
        null, minimumCross, maximumCross);
    };
    const flexItems = node.children.filter(
      (child) => !this.#outOfFlow(this.#formatting.node(child)),
    );
    const outOfFlow = node.children.filter((child) =>
      this.#outOfFlow(this.#formatting.node(child)),
    );
    if (!rowAxis && definiteBlockSize === null && flexItems.some((id) => {
      const basis = this.#itemComputed(this.#formatting.node(id))?.box.flexBasis;
      return basis !== undefined && basis.kind !== "content" && percentageDependent(basis);
    })) this.#indefiniteBlockConsumers.add(childContainingBlock);
    const preliminary = flexItems.map((child, sourceIndex) =>
      this.#flexItemInput(
        child,
        sourceIndex,
        axes,
        dimensions.contentWidth,
        rowAxis ? dimensions.contentWidth : definiteBlockSize,
        rowAxis ? null : this.#columnFlexCrossSize(this.#formatting.node(child), style, axes, dimensions.contentWidth),
      ),
    );
    let mainSize: CssNonNegativeLength;
    if (rowAxis) mainSize = nonNegative(dimensions.contentWidth);
    else if (specifiedBlockSize !== null)
      mainSize = nonNegative(forcedContentHeight ?? definiteBlockSize ?? specifiedBlockSize);
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
    // One allocation calculation serves fresh measurement and exact planning reuse.
    const allocateCross = (naturalSizes: readonly CssNonNegativeLength[]) => {
      const sizes = [...naturalSizes];
      const crossCursor = naturalSizes.reduce<CssPixelLength>((total, size) => sum(total, size),
        cssMultiply(crossGap, Math.max(0, naturalSizes.length - 1)));
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
      if (style.box.flexWrap === "nowrap" && sizes[0] !== undefined) {
        // A single-line flex container's line cross size is its inner cross size,
        // even when an item's natural max-content width overflows that size.
        sizes[0] = nonNegative(availableCrossSize);
        usedCrossSize = availableCrossSize;
      }
      if (
        sizes.length > 0 &&
        availableCrossSize > usedCrossSize &&
        (sizes.length === 1 ||
          style.box.alignContent.value === "stretch" ||
          style.box.alignContent.value === "normal")
      ) {
        let free = sum(availableCrossSize, negate(usedCrossSize));
        let remainingLines = sizes.length;
        for (const [index, size] of sizes.entries()) {
          const addition = cssDivide(free, remainingLines);
          sizes[index] = nonNegative(sum(size, addition));
          free = sum(free, negate(addition));
          remainingLines -= 1;
        }
        usedCrossSize = availableCrossSize;
      }
      return { contentHeight, availableCrossSize, usedCrossSize, sizes };
    };
    // Formatting and measurement contexts are immutable within this builder. The
    // tuple contains every varying sizing input, including each resolved main
    // allocation and line boundary. No fragments or layout callbacks are cached.
    const measurementInputs = rowAxis && style.box.flexWrap !== "nowrap" ? [
      width, containingBlock.percentageWidth, containingBlock.percentageHeight,
      forcedContentWidth, forcedContentHeight, forcedContentHeightIsDefinite,
      dimensions.contentWidth, definiteBlockSize, mainSize,
      ...lines.flatMap((line) => [line.items.length,
        ...line.items.flatMap((item) => [item.identity, item.targetMainSize, item.mainOffset])]),
    ] : null;
    const cachedMeasurement = measurementInputs === null || this.#truncated !== null ? undefined
      : this.#flexNaturalLines.get(node.id)?.find((entry) => entry.inputs.length === measurementInputs.length
        && entry.inputs.every((value, index) => value === measurementInputs[index]));
    const plannedCross = cachedMeasurement === undefined ? null : allocateCross(cachedMeasurement.crossSizes);
    // One shared budget counts retained sizing records: a contribution, a plan
    // header, a line's cross metric, or an item's main-allocation tuple. Reserve
    // before creating child fragments; dropping the memo would restore repeated
    // unbounded measurement, and a late rejection would orphan those fragments.
    let planningReservation = 0;
    if (measurementInputs !== null && cachedMeasurement === undefined) {
      const entries = 1 + lines.length + lines.reduce((count, line) => count + line.items.length, 0);
      if (this.#truncated !== null || !this.#intrinsicContributionCache.reservePlanningEntries(entries)) {
        this.#truncated ??= "maxIntrinsicContributionCacheEntries";
        throw new LayoutBudgetExhausted();
      }
      planningReservation = entries;
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
        readonly childIndex: number;
      }[];
      readonly naturalCrossStart: CssPixelLength;
      crossSize: CssNonNegativeLength;
    }[] = [];
    let crossCursor: CssPixelLength = ZERO;
    for (const [lineIndex, line] of lines.entries()) {
      const laidOut: {
        readonly item: ResolvedFlexItem<FormattingNodeId>;
        result: LayoutResult;
        outerCross: CssPixelLength;
        baseline: CssPixelLength;
        readonly stretches: boolean;
        readonly containingX: CssCoordinate;
        readonly borderY: CssCoordinate;
        readonly childIndex: number;
      }[] = [];
      let lineCross: CssPixelLength = ZERO;
      for (const item of line.items) {
        const child = this.#formatting.node(item.identity);
        const childStyle = this.#itemComputed(child);
        const childEdges = this.#edges(childStyle, dimensions.contentWidth);
        const stretches = this.#flexCrossStretches(childStyle, style, axes);
        const crossWidth = rowAxis
          ? item.targetMainSize
          : this.#columnFlexCrossSize(child, style, axes, dimensions.contentWidth);
        const containingX = rowAxis
          ? point(
              contentX,
              sum(item.mainOffset, negate(childEdges.margin.left)),
            )
          : point(contentX, crossCursor);
        const borderY = rowAxis
          ? point(contentY, sum(crossCursor, childEdges.margin.top))
          : point(contentY, item.mainOffset);
        // A completed natural plan preserves wrapped overflow. Known nowrap
        // allocations need no natural cross measurement in the first place.
        const knownCross = plannedCross?.sizes[lineIndex]
          ?? (style.box.flexWrap === "nowrap" ? definiteBlockSize : null);
        const initialCrossHeight = rowAxis && stretches && knownCross !== null
          ? stretchedCrossSize(child, knownCross) : null;
        const result = this.#tryLayoutNode(
          item.identity,
          containingX,
          borderY,
          dimensions.contentWidth,
          clip,
          depth + 1,
          childContainingBlock,
          rowAxis ? item.targetMainSize : crossWidth,
          rowAxis ? initialCrossHeight : item.targetMainSize,
          rowAxis ? initialCrossHeight !== null : definiteItemMainSize(child),
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
          childIndex,
        });
        lineCross = cssMax(lineCross, outerCross);
      }
      lineCross = cachedMeasurement?.crossSizes[lineIndex] ?? lineCross;
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
    if (planningReservation > 0) {
      if (measurementInputs !== null && this.#truncated === null && laidOutLines.length === lines.length
        && laidOutLines.every((line, index) => line.results.length === lines[index]?.items.length)) {
        const entries = this.#flexNaturalLines.get(node.id) ?? [];
        entries.push({ inputs: measurementInputs, crossSizes: laidOutLines.map((line) => line.crossSize) });
        this.#flexNaturalLines.set(node.id, entries);
        this.#flexNaturalLineUnits += planningReservation;
      } else this.#intrinsicContributionCache.releasePlanningEntries(planningReservation);
    }
    const allocation = allocateCross(laidOutLines.map((line) => line.crossSize));
    const { contentHeight, availableCrossSize, usedCrossSize } = allocation;
    for (const [index, line] of laidOutLines.entries()) line.crossSize = allocation.sizes[index] ?? line.crossSize;
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
      // Stretch invalidates sibling subtrees together. Rebuild the global line
      // index once for the batch, rather than once per item (quadratic in lines).
      const stretchSizes = new Map<LayoutFragmentId, CssNonNegativeLength>();
      for (const line of laidOutLines) {
        for (const entry of line.results) {
          if (!entry.stretches) continue;
          const child = this.#formatting.node(entry.item.identity);
          const forcedCrossSize = stretchedCrossSize(child, line.crossSize);
          const previous = entry.result.fragment;
          const previousFragment = this.#fragments.get(previous);
          const previousCrossSize = rowAxis
            ? previousFragment?.contentRect.height
            : previousFragment?.contentRect.width;
          // Stretch makes the used cross size definite for descendant percentages,
          // even when the first pass happened to use the same pixel size.
          if (previousCrossSize === forcedCrossSize
            && (!rowAxis || !this.#needsDefiniteItemBlock(child))) {
            if (rowAxis) this.#finalizeItemBlock(child, forcedCrossSize);
            continue;
          }
          stretchSizes.set(previous, forcedCrossSize);
        }
      }
      if (stretchSizes.size > 0) this.#discardLayoutSubtrees([...stretchSizes.keys()]);
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
          const forcedCrossSize = stretchSizes.get(entry.result.fragment);
          if (forcedCrossSize !== undefined) {
            const child = this.#formatting.node(entry.item.identity);
            const relaid = this.#tryLayoutNode(
              entry.item.identity,
              entry.containingX,
              entry.borderY,
              dimensions.contentWidth,
              clip,
              depth + 1,
              childContainingBlock,
              rowAxis ? entry.item.targetMainSize : forcedCrossSize,
              rowAxis ? forcedCrossSize : entry.item.targetMainSize,
              rowAxis || definiteItemMainSize(child),
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
    childContainingBlock.rect = contentRect;
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
    if (this.#establishesPositionedContainingBlock(node)) {
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
          ? this.#intrinsicContributions(child, dimensions.contentWidth).contentBox.maxContentInlineSize
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
    forcedContentHeightIsDefinite = false,
  ): LayoutResult {
    this.#reserve();
    try {
      this.#input.signal?.throwIfAborted();
      const node = this.#formatting.node(id);
      this.#containingBlocks.set(id, containingBlock);
      this.#recordBlockPercentageConsumer(node, containingBlock);
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
        node.kind === "image"
      ) {
        const standaloneAtomic = isAtomicFormattingNode(node);
        const atomicY = standaloneAtomic
          ? point(y, negate(this.#edges(this.#boxComputed(node), width, node.id).margin.top)) : y;
        const cursor: InlineFormattingCursor = {
          containingBlock,
          forcedContentWidth,
          forcedContentHeight,
          containingFragment: this.#newId(node.id, "atomic-context"),
          containingFormattingNode: node.id,
          continuationX: x,
          continuationMaxX: point(x, width),
          maxX: point(x, width),
          x,
          y: atomicY,
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
        lineLevelOverrides: new Map<number, number>(),
          entries: [],
          lineBoxes: [],
        };
        if (!standaloneAtomic) this.#selectInlineLineBreaks(cursor);
        const result = this.#inlineReserved(id, cursor, clip, depth + 1);
        try {
          if (!standaloneAtomic) this.#finalizeLine(cursor, false, "end-of-paragraph");
        } catch (error) {
          if (!(error instanceof LayoutBudgetExhausted)) throw error;
        }
        this.#releaseLineReservation(cursor);
        // Line alignment can move an atomic box. Positioned layout must finalize
        // against the stored box, not the pre-alignment result returned above.
        const finalized = this.#fragments.get(result.fragment);
        if (finalized?.kind === "box") {
          const baseline = this.#firstDescendantBaseline(finalized.children);
          if (baseline !== null) this.#fragments.set(finalized.id, { ...finalized,
            baseline: nonNegative(cssCoordinateDifference(baseline, finalized.borderRect.y)) });
        }
        return finalized === undefined ? result
          : {fragment:result.fragment,borderRect:finalized.borderRect,marginRect:finalized.marginRect};
      }
      if (node.kind === "table-wrapper") {
        return this.#tableFormattingContext(
          node as TableWrapperFormattingNode,
          x,
          y,
          width,
          clip,
          depth,
          containingBlock,
          forcedContentWidth,
          forcedContentHeight,
          forcedContentHeightIsDefinite,
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
          containingBlock,
          forcedContentWidth,
          forcedContentHeight,
          forcedContentHeightIsDefinite,
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
          containingBlock,
          forcedContentWidth,
          forcedContentHeight,
          forcedContentHeightIsDefinite,
        );
      }
      return this.#flow(
        node,
        x,
        y,
        width,
        clip,
        depth,
        containingBlock,
        forcedContentWidth,
        forcedContentHeight,
        forcedContentHeightIsDefinite,
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
    containingBlock: LayoutContainingBlock,
    forcedContentWidth: CssPixelLength | null = null,
    forcedContentHeight: CssPixelLength | null = null,
    forcedContentHeightIsDefinite = false,
  ): LayoutResult | null {
    try {
      const result = this.#layoutNode(
        id,
        x,
        y,
        width,
        clip,
        depth,
        containingBlock,
        forcedContentWidth,
        forcedContentHeight,
        forcedContentHeightIsDefinite,
      );
      return result;
    } catch (error) {
      if (error instanceof LayoutBudgetExhausted) return null;
      throw error;
    }
  }

  #resolveDeferredPositioned(): void {
    for (const [placeholderId, deferred] of this.#deferredPositioned) {
      this.#input.signal?.throwIfAborted();
      const placeholder = this.#fragments.get(placeholderId);
      const parentId = this.#parentIndex.get(placeholderId);
      const parent = parentId === undefined ? undefined : this.#fragments.get(parentId);
      if (placeholder === undefined || parent === undefined) continue;
      this.#discardLayoutSubtrees([placeholderId]);
      const result = this.#layoutOutOfFlow(deferred.node, placeholder.borderRect.x, placeholder.borderRect.y,
        placeholder.clipRect, deferred.depth);
      const children = parent.children.flatMap((id) => id === placeholderId
        ? result === null ? [] : [result.fragment] : [id]);
      this.#fragments.set(parent.id, { ...parent, children: Object.freeze(children) });
      if (result !== null) this.#parentIndex.set(result.fragment, parent.id);
    }
  }

  #refreshOverflow(root: LayoutFragmentId): void {
    const order: LayoutFragmentId[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      order.push(id);
      pending.push(...fragment.children);
    }
    for (const id of order.reverse()) {
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      let overflowRect = fragment.overflowRect;
      for (const child of fragment.children) {
        if (this.#scrollAttachments.get(child)?.kind === "fixed") continue;
        const overflow = this.#fragments.get(child)?.overflowRect;
        if (overflow !== undefined) overflowRect = unionOverflowRect(overflowRect, overflow);
      }
      this.#fragments.set(id, { ...fragment, overflowRect });
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
      let current = this.#fragments.get(positioned.fragment);
      if (current !== undefined && current.kind !== "text" && this.#hasTransform(node)) {
        const style = this.#computed(node);
        let inlineOffset: CssPixelLength = ZERO;
        let blockOffset: CssPixelLength = ZERO;
        for (const translation of style?.box.transform ?? []) {
          inlineOffset = cssAdd(inlineOffset, this.#usedLength(translation.x, current.borderRect.width, style) ?? ZERO);
          blockOffset = cssAdd(blockOffset, this.#usedLength(translation.y, current.borderRect.height, style) ?? ZERO);
        }
        this.#translate({ fragment: current.id, borderRect: current.borderRect, marginRect: current.marginRect },
          inlineOffset, blockOffset, this.#documentCanvasClip());
        current = this.#fragments.get(positioned.fragment);
      }
      if (current === undefined) continue;
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
  }

  #positionOutsideMarkers(): void {
    for (const [parentId, markerId] of this.#outsideMarkers) {
      this.#input.signal?.throwIfAborted();
      const parent = this.#fragments.get(parentId);
      if (parent === undefined) continue;
      const node = this.#formatting.node(parent.formattingNode);
      const style = this.#computed(node);
      const content = parent.kind !== "text" ? parent.inlineContinuations?.[0]?.contentRect ?? parent.contentRect : parent.contentRect;
      const metrics = this.#metrics(style);
      const baseline = this.#firstDescendantBaseline(parent.children)
        ?? point(content.y, this.#inlineExtents(metrics, this.#lineHeight(style, metrics)).ascent);
      let markerWidth: CssPixelLength;
      try { markerWidth = this.#intrinsicContributions(markerId, null).contentBox.maxContentInlineSize; }
      catch (error) { if (error instanceof LayoutBudgetExhausted) break; throw error; }
      const x = style?.text.direction === "rtl" ? point(content.x, content.width) : point(content.x, negate(markerWidth));
      const marker = this.#tryLayoutNode(markerId, x, content.y, markerWidth, parent.clipRect, 0,
        this.#containingBlock(node.id, content, content.width, null));
      if (marker === null) break;
      const fragment = this.#fragments.get(marker.fragment);
      const markerBaseline = fragment === undefined ? marker.borderRect.y
        : this.#firstDescendantBaseline(fragment.children)
          ?? point(fragment.borderRect.y, fragment.baseline ?? ZERO);
      this.#translate(marker, ZERO, cssCoordinateDifference(baseline, markerBaseline), parent.clipRect);
      this.#fragments.set(parentId, { ...parent, children: Object.freeze([marker.fragment, ...parent.children]) });
      this.#parentIndex.set(marker.fragment, parentId);
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
      const integerLevel = positioned || flexOrGridItem ? itemStyle?.box.zIndex ?? null : null;
      const establishes =
        entry.root ||
        (node !== null && (this.#hasTransform(node) || this.#paintContainment(node))) ||
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

  #refreshInlineContinuationGeometry(): void {
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
  }

  #buildClipChains(root: LayoutFragmentId): void {
    const sameRect = (left: CssRect, right: CssRect): boolean =>
      left.x === right.x && left.y === right.y &&
      left.width === right.width && left.height === right.height;
    const canvas: LayoutClipChain = Object.freeze({ kind: "canvas", owner: null, rect: this.#documentCanvasClip(), parent: null });
    const pending = [{ id: root, inherited: canvas, clipRect: canvas.rect }];
    while (pending.length > 0) {
      this.#input.signal?.throwIfAborted();
      const entry = pending.pop();
      if (entry === undefined) continue;
      const fragment = this.#fragments.get(entry.id);
      if (fragment === undefined) continue;
      let chain = entry.inherited;
      let clipRect = entry.clipRect;
      const node = this.#formatting.node(fragment.formattingNode);
      const position = fragment.kind !== "text" ? this.#boxComputed(node)?.box.position : undefined;
      if (position === "absolute" || position === "fixed") {
        // Overflow follows the containing block; explicit clips still follow ancestry.
        const ownerNode = this.#positionedContainingNode(node, position === "fixed");
        const viewportFixed = position === "fixed" && ownerNode === null;
        const containingAncestors = new Set<FormattingNodeId>();
        if (!viewportFixed) {
          let parent = ownerNode;
          while (parent !== null) {
            containingAncestors.add(parent.id);
            parent = this.#formatting.parent(parent.id);
          }
        }
        const retained: LayoutClipChain[] = [];
        for (let current: LayoutClipChain | null = chain; current !== null; current = current.parent) {
          const owner = current.owner === null ? undefined : this.#fragments.get(current.owner);
          if (current.kind === "clip" || (!viewportFixed &&
            (current.kind !== "overflow" || (owner !== undefined && containingAncestors.has(owner.formattingNode))))) retained.push(current);
        }
        let filtered: LayoutClipChain | null = viewportFixed
          ? Object.freeze({ kind: "viewport", owner: fragment.id, rect: this.#input.context.scrollport, parent: null }) : null;
        clipRect = viewportFixed ? this.#input.context.scrollport : canvas.rect;
        for (let index = retained.length - 1; index >= 0; index -= 1) {
          const current = retained[index];
          if (current === undefined) continue;
          clipRect = cssIntersection(clipRect, current.rect);
          filtered = current.parent === filtered ? current : Object.freeze({ ...current, parent: filtered });
        }
        chain = filtered ?? canvas;
      }
      if (fragment.kind !== "text" && this.#boxComputed(node) !== null) {
        for (const [kind, own] of [
          ["overflow", this.#overflowClip(node, fragment.paddingRect, canvas.rect)],
          ["contain", this.#paintContainment(node) ? fragment.paddingRect : canvas.rect],
          ["clip", this.#explicitClip(node, fragment.borderRect, canvas.rect)],
        ] as const) {
          if (!sameRect(own, canvas.rect)) {
            chain = Object.freeze({ kind, owner: fragment.id, rect: own, parent: chain });
            clipRect = cssIntersection(clipRect, own);
          }
        }
      }
      this.#clipChains.set(fragment.id, chain);
      if (!sameRect(fragment.clipRect, clipRect)) this.#fragments.set(entry.id, { ...fragment, clipRect });
      for (const child of fragment.children) {
        const childFragment = this.#fragments.get(child);
        const childNode = childFragment === undefined ? null : this.#formatting.node(childFragment.formattingNode);
        const outside = node.kind === "list-item" && childNode?.kind === "marker" && childNode.markerPlacement === "outside";
        pending.push({ id: child, inherited: outside ? entry.inherited : chain,
          clipRect: outside ? entry.clipRect : clipRect });
      }
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
        this.#containingBlock(null, context.initialContainingBlock, context.initialContainingBlock.width, context.initialContainingBlock.height),
      );
    } catch (error) {
      if (!(error instanceof LayoutBudgetExhausted)) throw error;
    }
    if (root === null)
      return ImmutableLayoutFragmentTree.rejected(
        this.#input,
        "invalid-context",
      );
    try {
      this.#resolveDeferredPositioned();
    } catch (error) {
      if (!(error instanceof LayoutBudgetExhausted)) throw error;
    }
    this.#refreshInlineContinuationGeometry();
    this.#positionOutsideMarkers();
    if (this.#hasInFlowPositioning) {
      this.#applyFinalInFlowPositions(root.fragment);
      // Continuations describe the inline's own flow box. Translating an inline
      // moves its existing continuations; rebuilding them from visually moved
      // descendants would incorrectly move an unpositioned ancestor's decoration.
    }
    if (this.#hasInFlowPositioning || this.#deferredPositioned.size > 0 || this.#outsideMarkers.size > 0)
      this.#refreshOverflow(root.fragment);
    this.#buildClipChains(root.fragment);
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
    this.#flexNaturalLines.clear();
    this.#intrinsicContributionCache.releasePlanningEntries(this.#flexNaturalLineUnits);
    this.#flexNaturalLineUnits = 0;
    return new ImmutableLayoutFragmentTree(
      this.#input,
      root.fragment,
      this.#fragments,
      this.#formattingIndex,
      this.#documentIndex,
      this.#parentIndex,
      this.#lineBoxes,
      this.#stackingMetadata,
      this.#scrollAttachments,
      this.#clipChains,
      outcome,
      this.#rootFontMetrics,
      Object.freeze({ ...this.#textAnalysisWork }),
      (fragment, scrollport) => {
        const style = this.#boxComputed(this.#formatting.node(fragment.formattingNode));
        return { top: this.#usedInset(style, "top", scrollport.height),
          right: this.#usedInset(style, "right", scrollport.width),
          bottom: this.#usedInset(style, "bottom", scrollport.height),
          left: this.#usedInset(style, "left", scrollport.width) };
      },
      this.#imageDimensionDependencies,
    );
  }
}

class ImmutableLayoutFragmentTree implements LayoutFragmentTree {
  readonly #imageDimensionDependencies: ReadonlySet<string>;
  readonly #clipChains: ReadonlyMap<LayoutFragmentId, LayoutClipChain>;
  readonly formatting: FormattingTree;
  readonly context: BuildLayoutFragmentTreeInput["context"];
  readonly rootFontMetrics: UsedFontMetrics;
  readonly root: LayoutFragmentId;
  readonly lineBoxes: readonly LineBox[];
  readonly outcome: LayoutOutcome;
  readonly textAnalysisWork: LayoutFragmentTree["textAnalysisWork"];
  readonly viewportDirection: "ltr" | "rtl";
  readonly viewportOverflow: { readonly x: CssOverflow; readonly y: CssOverflow };
  readonly scrollExtent: CssRect;
  readonly scrollOwners: readonly LayoutScrollOwner[];
  readonly #scrollOwners = new Map<LayoutFragmentId, LayoutScrollOwner>();
  readonly #scrollAncestors = new Map<LayoutFragmentId, LayoutFragmentId | null>();
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
  readonly #scrollAttachments: ReadonlyMap<
    LayoutFragmentId,
    LayoutScrollAttachment
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
    scrollAttachments: ReadonlyMap<LayoutFragmentId, LayoutScrollAttachment>,
    clipChains: ReadonlyMap<LayoutFragmentId, LayoutClipChain>,
    outcome: LayoutOutcome,
    rootMetrics: UsedFontMetrics,
    textAnalysisWork: LayoutFragmentTree["textAnalysisWork"] = Object.freeze({ intrinsicCalls: 0, intrinsicReuses: 0, intrinsicAnalyzedUnits: 0, inlineBuilds: 0, inlineReuses: 0 }),
    stickyInsets?: (fragment: LayoutFragment, scrollport: CssRect) => Pick<Extract<LayoutScrollAttachment, { kind: "sticky" }>, "top" | "right" | "bottom" | "left">,
    imageDimensionDependencies: ReadonlySet<string> = new Set(),
  ) {
    this.#imageDimensionDependencies = imageDimensionDependencies;
    this.textAnalysisWork = textAnalysisWork;
    this.#clipChains = clipChains;
    this.formatting = input.formatting;
    const html = input.formatting.document.documentElement;
    const body = input.formatting.document.body;
    const htmlStyle = html === null ? null : input.formatting.styles.style(html);
    const bodyStyle = body === null ? null : input.formatting.styles.style(body);
    this.viewportDirection = htmlStyle?.box.contain === "none" && bodyStyle?.box.contain === "none"
      ? bodyStyle.text.direction : htmlStyle?.text.direction ?? "ltr";
    const overflowSource = viewportOverflowSource(input.formatting);
    const overflow = overflowSource === null ? null : input.formatting.styles.style(overflowSource).box;
    const viewportPolicy = (value:CssOverflow):CssOverflow => value === "visible" ? "auto" : value === "clip" ? "hidden" : value;
    this.viewportOverflow = Object.freeze({ x: viewportPolicy(overflow?.overflowX ?? "visible"), y: viewportPolicy(overflow?.overflowY ?? "visible") });
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
    this.#scrollAttachments = complete
      ? scrollAttachments
      : new Map([...scrollAttachments].filter(([id]) => reachable.has(id)));
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
    const scrolling = this.#buildScrollOwners(input.signal);
    this.scrollOwners = scrolling.owners;
    this.scrollExtent = scrolling.extent;
    if (stickyInsets !== undefined) {
      const attachments = new Map(this.#scrollAttachments);
      for (const [id, attachment] of attachments) {
        if (attachment.kind !== "sticky") continue;
        const scrollport = this.scrollAncestor(id)?.scrollport ?? this.context.scrollport;
        attachments.set(id, Object.freeze({ ...attachment, ...stickyInsets(this.fragment(id), scrollport) }));
      }
      this.#scrollAttachments = attachments;
    }
    Object.freeze(this);
    registerRetainedOwner(this, () => [this.#imageDimensionDependencies, this.#clipChains, this.#fragments, this.#parents, this.#formattingIndex, this.#documentIndex, this.#stackingMetadata, this.#scrollAttachments, this.#scrollOwners, this.#scrollAncestors, this.scrollOwners, this.scrollExtent]);
  }

  #buildScrollOwners(signal?: AbortSignal): {readonly owners: readonly LayoutScrollOwner[]; readonly extent: CssRect} {
    const styles = new Map<LayoutFragmentId, ComputedStyle>();
    const candidates = new Set<LayoutFragmentId>();
    const viewportSource = viewportOverflowSource(this.formatting);
    const ordered: LayoutFragmentId[] = [];
    const pending = [this.root];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.fragment(id);
      ordered.push(id);
      const node = this.formatting.node(fragment.formattingNode);
      if (fragment.kind !== "text" && node.styleNode !== null && hasOverflowBox(this.formatting, node)) {
        const style = node.pseudo === null ? this.formatting.styles.style(node.styleNode)
          : this.formatting.styles.pseudo(node.styleNode, node.pseudo) ?? this.formatting.styles.style(node.styleNode);
        const propagated = node.pseudo === null && fragment.documentNode === viewportSource;
        styles.set(id,propagated ? {...style,box:{...style.box,overflowX:"visible",overflowY:"visible"}} : style);
        if (!propagated && fragment.documentNode !== null && (isScrollableOverflow(style.box.overflowX) || isScrollableOverflow(style.box.overflowY))) candidates.add(id);
      }
      for (let index = fragment.children.length - 1; index >= 0; index -= 1) {
        const child = fragment.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    if (candidates.size === 0 && ![...styles.values()].some(style=>style.box.contain === "paint" || clipsOverflow(style.box.overflowX) || clipsOverflow(style.box.overflowY))) {
      return {owners:Object.freeze([]),extent:this.fragment(this.root).overflowRect};
    }
    const redirected = new Map<LayoutFragmentId, LayoutFragmentId[]>();
    const outOfFlow = new Set<LayoutFragmentId>();
    for (const id of ordered) {
      const style = styles.get(id);
      if (style?.box.position !== "absolute" && style?.box.position !== "fixed") continue;
      const parent = this.scrollAttachmentParent(id);
      if (parent?.id === this.parent(id)?.id) continue;
      outOfFlow.add(id);
      if (parent !== null) {
        const children = redirected.get(parent.id) ?? [];
        children.push(id);
        redirected.set(parent.id,children);
      }
    }
    // A child's trapped paint overflow must not enlarge an ancestor's scroll range.
    const propagated = new Map<LayoutFragmentId, CssRect>();
    const extents = new Map<LayoutFragmentId, CssRect>();
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      signal?.throwIfAborted();
      const id = ordered[index];
      if (id === undefined) continue;
      const fragment = this.fragment(id);
      let extent = fragment.kind === "text" ? fragment.borderRect : fragment.paddingRect;
      let inFlowExtent = fragment.contentRect;
      for (const child of [...fragment.children.filter(child=>!outOfFlow.has(child)), ...(redirected.get(id)??[])]) {
        if (this.scrollAttachment(child)?.kind === "fixed") continue;
        const childNode = this.formatting.node(this.fragment(child).formattingNode);
        if (candidates.has(id) && childNode.kind === "marker" && childNode.markerPlacement === "outside") continue;
        const rect = propagated.get(child);
        if (rect !== undefined) {
          extent = cssUnion([extent, rect], extent);
          const position = styles.get(child)?.box.position;
          if (position !== "absolute" && position !== "fixed") inFlowExtent = cssUnion([inFlowExtent,rect],inFlowExtent);
        }
      }
      if (candidates.has(id)) {
        const rtl = styles.get(id)?.text.direction === "rtl";
        const inlinePadding = rtl ? fragment.contentRect.x-fragment.paddingRect.x
          : fragment.paddingRect.x+fragment.paddingRect.width-fragment.contentRect.x-fragment.contentRect.width;
        const bottomPadding = fragment.paddingRect.y+fragment.paddingRect.height-fragment.contentRect.y-fragment.contentRect.height;
        const padded = cssRect(cssCoordinateFromFixed(inFlowExtent.x-(rtl?inlinePadding:0)),inFlowExtent.y,
          cssLengthFromFixed(inFlowExtent.width+inlinePadding),cssLengthFromFixed(inFlowExtent.height+bottomPadding));
        extent = cssUnion([extent,padded],extent);
      }
      extents.set(id, extent);
      const style = styles.get(id);
      if (style !== undefined) {
        const port = fragment.paddingRect;
        const contain = hasPaintContainment(this.formatting, this.formatting.node(fragment.formattingNode), style);
        const clipX = contain || clipsOverflow(style.box.overflowX);
        const clipY = contain || clipsOverflow(style.box.overflowY);
        extent = cssRect(clipX ? port.x : extent.x, clipY ? port.y : extent.y,
          clipX ? port.width : extent.width, clipY ? port.height : extent.height);
      }
      for (const child of fragment.children) {
        const childNode = this.formatting.node(this.fragment(child).formattingNode);
        if (childNode.kind === "marker" && childNode.markerPlacement === "outside") {
          const markerExtent = propagated.get(child);
          if (markerExtent !== undefined) extent = cssUnion([extent, markerExtent], extent);
        }
      }
      propagated.set(id, cssUnion([fragment.borderRect, extent], fragment.borderRect));
    }
    for (const id of ordered) {
      const parent = this.scrollAttachmentParent(id);
      const ancestor = parent === null ? null : candidates.has(parent.id) ? parent.id : this.#scrollAncestors.get(parent.id) ?? null;
      if (ancestor !== null) this.#scrollAncestors.set(id, ancestor);
      if (!candidates.has(id)) continue;
      const fragment = this.fragment(id);
      const style = styles.get(id);
      const extent = extents.get(id);
      if (style === undefined || extent === undefined || fragment.documentNode === null) continue;
      const port = fragment.paddingRect;
      const rtl = style.text.direction === "rtl";
      this.#scrollOwners.set(id, Object.freeze({ fragment: id, documentNode: fragment.documentNode,
        parent: ancestor, scrollport: port, contentExtent: extent,
        minInline: isScrollableOverflow(style.box.overflowX) && rtl ? Math.min(0, extent.x - port.x) : 0,
        maxInline: isScrollableOverflow(style.box.overflowX) && !rtl ? Math.max(0, extent.x + extent.width - port.x - port.width) : 0,
        minBlock: 0,
        maxBlock: isScrollableOverflow(style.box.overflowY) ? Math.max(0, extent.y + extent.height - port.y - port.height) : 0,
        overflowX: style.box.overflowX, overflowY: style.box.overflowY, direction: style.text.direction,
      }));
    }
    return {owners:Object.freeze([...this.#scrollOwners.values()]),extent:propagated.get(this.root)??this.fragment(this.root).overflowRect};
  }

  public imageDimensionsAffectLayout(resourceId: string): boolean {
    // A truncated/rejected pass cannot prove unvisited intrinsic consumers inert.
    return this.outcome.status !== "complete" || this.#imageDimensionDependencies.has(resourceId);
  }

  public scrollContainer(id: LayoutFragmentId): LayoutScrollOwner | null { return this.#scrollOwners.get(id) ?? null; }
  public scrollAncestor(id: LayoutFragmentId): LayoutScrollOwner | null {
    const owner = this.#scrollAncestors.get(id);
    return owner === undefined || owner === null ? null : this.#scrollOwners.get(owner) ?? null;
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
      children: EMPTY_FRAGMENT_CHILDREN,
      lineBoxes: EMPTY_FRAGMENT_LINES,
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
      new Map(),
      new Map(),
      { status: "rejected", reason },
      REJECTED_FONT_METRICS,
    );
  }

  public clipChain(id: LayoutFragmentId): LayoutClipChain | null { return this.#clipChains.get(id) ?? null; }

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

  public scrollAttachmentParent(id: LayoutFragmentId): LayoutFragment | null {
    const fragment = this.fragment(id);
    const node = this.formatting.node(fragment.formattingNode);
    const computed = (candidate: FormattingNode): ComputedStyle | null => candidate.styleNode === null ? null
      : candidate.pseudo === null ? this.formatting.styles.style(candidate.styleNode)
        : this.formatting.styles.pseudo(candidate.styleNode, candidate.pseudo) ?? this.formatting.styles.style(candidate.styleNode);
    const position = computed(node)?.box.position;
    const parent = this.parent(id);
    if (node.kind === "marker" && node.markerPlacement === "outside" && parent !== null
      && this.formatting.node(parent.formattingNode).kind === "list-item")
      return this.scrollAttachmentParent(parent.id);
    if (fragment.kind === "text" || !ownsOuterBoxStyle(node) || (position !== "fixed" && position !== "absolute")) return this.parent(id);
    let owner = this.formatting.parent(node.id);
    while (owner !== null) {
      const ownerStyle = computed(owner);
      if ((position === "absolute" && ownsOuterBoxStyle(owner) && ownerStyle !== null && ownerStyle.box.position !== "static")
        || hasTransform(this.formatting, owner, ownerStyle) || hasPaintContainment(this.formatting, owner, ownerStyle)) {
        return this.forFormattingNode(owner.id).find((candidate) => candidate.kind !== "text") ?? null;
      }
      owner = this.formatting.parent(owner.id);
    }
    return null;
  }

  public scrollAttachment(id: LayoutFragmentId): LayoutScrollAttachment | null {
    return this.#scrollAttachments.get(id) ?? null;
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
    if (error instanceof InvalidCssNumericInput) {
      return ImmutableLayoutFragmentTree.rejected(
        input,
        "invalid-fixed-point-input",
      );
    }
    throw error;
  }
}
