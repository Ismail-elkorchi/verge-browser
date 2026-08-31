import type {
  DocumentNodeRef,
  HtmlTableCellMetadata,
  HtmlTableColumnGroupMetadata,
  HtmlTableColumnMetadata,
} from "../../../document/index.js";
import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { ComputedStyle, CssBorderStyle, CssColor, CssLength } from "../../style/index.js";
import type { CssCoordinate, CssNonNegativeLength, CssPixelLength, CssRect } from "../fixed.js";
import type { IntrinsicSizeContributions } from "../intrinsic/index.js";
import type {
  LayoutBudgets,
  LayoutFragment,
  LayoutFragmentId,
  LayoutPaintStyle,
  LayoutTableCollapsedBorderSegment,
  LineBox,
} from "../types.js";

export type TableBudgetName =
  | "maxTableRoots"
  | "maxTableRowGroups"
  | "maxTableRows"
  | "maxTableColumnGroups"
  | "maxTableColumns"
  | "maxTableCells"
  | "maxTableSlotIntervals"
  | "maxTableColspanWork"
  | "maxTableRowspanWork"
  | "maxTableAnonymousMissingCells"
  | "maxTableIntrinsicMeasureWork"
  | "maxTableColumnDistributionWork"
  | "maxTableRowDistributionWork"
  | "maxTableCollapsedBorderCandidates"
  | "maxTableCollapsedBorderSegments"
  | "maxTableHeaderAssociations";

export class TableWorkBudgetExceeded extends Error {
  public readonly budget: TableBudgetName;
  public constructor(budget: TableBudgetName) {
    super(`Table work budget exhausted: ${budget}.`);
    this.name = "TableWorkBudgetExceeded";
    this.budget = budget;
  }
}

export interface TableSlotInterval {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly cell: FormattingNodeId;
}

export interface TableRowTrack {
  readonly index: number;
  readonly formattingNode: FormattingNodeId;
  readonly rowGroup: FormattingNodeId | null;
  readonly source: DocumentNodeRef | null;
  readonly collapsed: boolean;
}

export interface TableColumnTrack {
  readonly index: number;
  readonly formattingNode: FormattingNodeId | null;
  readonly columnGroup: FormattingNodeId | null;
  readonly source: DocumentNodeRef | null;
  readonly collapsed: boolean;
}

export interface TableCellSlot {
  readonly formattingNode: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly rowGroup: FormattingNodeId | null;
  readonly columnGroup: FormattingNodeId | null;
  readonly intervals: readonly TableSlotInterval[];
  readonly htmlMetadata: HtmlTableCellMetadata | null;
}

export interface TableMissingCellInterval {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

export interface TableStructuralError {
  readonly kind: "overlap" | "rowspan-crosses-row-group" | "orphan-internal-box" | "track-limit";
  readonly formattingNode: FormattingNodeId | null;
}

export interface TableOutOfFlowBox {
  readonly formattingNode: FormattingNodeId;
  readonly containingTableBox: FormattingNodeId;
}

export interface TableSlotGrid {
  readonly table: FormattingNodeId;
  readonly captions: readonly FormattingNodeId[];
  readonly rowGroups: readonly FormattingNodeId[];
  readonly columnGroups: readonly FormattingNodeId[];
  readonly rows: readonly TableRowTrack[];
  readonly columns: readonly TableColumnTrack[];
  readonly cells: readonly TableCellSlot[];
  readonly slotIntervals: readonly TableSlotInterval[];
  readonly missingCells: readonly TableMissingCellInterval[];
  readonly outOfFlow: readonly TableOutOfFlowBox[];
  readonly errors: readonly TableStructuralError[];
}

export interface TableColumnMeasure {
  readonly index: number;
  readonly minimum: CssNonNegativeLength;
  readonly preferred: CssNonNegativeLength;
  readonly percentage: number | null;
  readonly constrained: boolean;
  readonly collapsed: boolean;
}

export interface UsedTableColumn {
  readonly index: number;
  readonly offset: CssPixelLength;
  readonly size: CssNonNegativeLength;
  readonly collapsed: boolean;
}

export interface UsedTableRow {
  readonly index: number;
  readonly offset: CssPixelLength;
  readonly size: CssNonNegativeLength;
  readonly baseline: CssPixelLength | null;
  readonly collapsed: boolean;
}

export interface TableRowSizingResult {
  readonly rows: readonly UsedTableRow[];
  readonly usedGridHeight: CssNonNegativeLength;
}

export interface TableWidthResult {
  readonly mode: "auto" | "fixed";
  readonly columns: readonly UsedTableColumn[];
  readonly tableMinContentWidth: CssNonNegativeLength;
  readonly tableMaxContentWidth: CssNonNegativeLength;
  readonly usedGridWidth: CssNonNegativeLength;
}

export interface TableCollapsedBorderCandidate {
  readonly formattingNode: FormattingNodeId;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly style: CssBorderStyle;
  readonly width: CssNonNegativeLength;
  readonly color: CssColor | null;
  readonly origin: "table" | "column-group" | "column" | "row-group" | "row" | "cell";
  readonly sourceOrder: number;
}

export interface TableCollapsedBorderWinner extends TableCollapsedBorderCandidate {
  readonly axis: "horizontal" | "vertical";
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly ownerFormattingNode: FormattingNodeId;
  readonly ownerSide: "top" | "right" | "bottom" | "left";
}

export interface TableBorderOverride {
  readonly styles: Readonly<Record<"top" | "right" | "bottom" | "left", CssBorderStyle>>;
  readonly widths: Readonly<Record<"top" | "right" | "bottom" | "left", CssNonNegativeLength>>;
  readonly colors: Readonly<Record<"top" | "right" | "bottom" | "left", CssColor | null>>;
}

export interface TableLayoutOperationResult {
  readonly fragment: LayoutFragmentId;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
}

export interface TableUsedDimensions {
  readonly contentWidth: CssPixelLength;
  readonly specifiedHeight: CssPixelLength | null;
  readonly minHeight: CssPixelLength;
  readonly maxHeight: CssPixelLength | null;
  readonly marginLeft: CssPixelLength;
  readonly marginRight: CssPixelLength;
  readonly margin: Readonly<Record<"top" | "right" | "bottom" | "left", CssPixelLength>>;
  readonly padding: Readonly<Record<"top" | "right" | "bottom" | "left", CssNonNegativeLength>>;
  readonly border: Readonly<Record<"top" | "right" | "bottom" | "left", CssNonNegativeLength>>;
}

export interface TableSlotGridHost {
  readonly budgets: LayoutBudgets;
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  htmlTableCell(node: DocumentNodeRef): HtmlTableCellMetadata | null;
  htmlTableColumn(node: DocumentNodeRef): HtmlTableColumnMetadata | null;
  htmlTableColumnGroup(node: DocumentNodeRef): HtmlTableColumnGroupMetadata | null;
  isOutOfFlow(node: FormattingNode): boolean;
  consume(budget: TableBudgetName, amount?: number): void;
}

export interface TableColumnMeasureHost {
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  boxComputed(node: FormattingNode): ComputedStyle | null;
  consume(budget: TableBudgetName, amount?: number): void;
  usedLength(value: CssLength, basis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  intrinsicContributions(id: FormattingNodeId, availableInlineSize: CssPixelLength | null): IntrinsicSizeContributions;
}

export interface TableCollapsedBorderHost {
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  consume(budget: TableBudgetName, amount?: number): void;
  usedLength(value: CssLength, basis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  registerCollapsedBorderOverride(node: FormattingNodeId, value: TableBorderOverride): void;
}

export interface TableLayoutHost extends TableSlotGridHost, TableColumnMeasureHost, TableCollapsedBorderHost {
  dimensions(node: FormattingNode, width: CssPixelLength, height: CssPixelLength | null, forcedWidth?: CssPixelLength | null): TableUsedDimensions;
  layoutChild(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null,
    forcedContentHeight: CssPixelLength | null,
  ): TableLayoutOperationResult | null;
  layoutOutOfFlow(
    node: FormattingNode,
    staticX: CssCoordinate,
    staticY: CssCoordinate,
    clip: CssRect,
    depth: number,
    containingBlock?: CssRect,
  ): TableLayoutOperationResult | null;
  translate(result: TableLayoutOperationResult, x: CssPixelLength, y: CssPixelLength, clip: CssRect): TableLayoutOperationResult;
  translateChildren(result: TableLayoutOperationResult, y: CssPixelLength, clip: CssRect): void;
  fragment(id: LayoutFragmentId): LayoutFragment | undefined;
  clip(node: FormattingNode, padding: CssRect, border: CssRect, inherited: CssRect): CssRect;
  registerPositionedContainingBlock(node: FormattingNodeId, rect: CssRect): void;
  registerCollapsedBorderOverride(node: FormattingNodeId, value: TableBorderOverride): void;
  paintStyle(node: FormattingNode): LayoutPaintStyle;
  registerCollapsedBorderSegments(
    node: FormattingNodeId,
    segments: readonly LayoutTableCollapsedBorderSegment[],
  ): void;
  container(
    node: FormattingNode,
    content: CssRect,
    padding: CssRect,
    border: CssRect,
    margin: CssRect,
    clip: CssRect,
    children: readonly LayoutFragmentId[],
    lines: readonly LineBox[],
  ): TableLayoutOperationResult;
  withContainerReservation<T>(operation: () => T): T;
  tryContainerReservation<T>(operation: () => T): T | null;
  withTableBudget<T>(operation: () => T): T;
}
