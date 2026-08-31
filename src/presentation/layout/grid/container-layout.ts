import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type {
  ComputedStyle,
  CssGap,
  CssGridLine,
  CssLength
} from "../../style/index.js";
import { GRID_AUTO_LINE } from "../../style/grid/index.js";
import type { IntrinsicSizeContributions } from "../intrinsic/index.js";
import {
  cssAdd,
  cssCoordinateAdd,
  cssCoordinateDifference,
  cssMax,
  cssMin,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  cssRect,
  type CssCoordinate,
  type CssEdges,
  type CssNonNegativeLength,
  type CssPixelLength,
  type CssRect,
  type CssSignedEdges
} from "../fixed.js";
import type {
  LayoutBudgets,
  LayoutFragment,
  LayoutFragmentId,
  LineBox
} from "../types.js";
import { alignGridItem } from "./alignment.js";
import { expandExplicitGridAxis } from "./explicit-grid.js";
import { buildGridTrackSequence } from "./implicit-grid.js";
import { resolvedGridArea } from "./item-layout.js";
import {
  normalizeGridPlacement,
  occupiedExplicitGridTracks,
  offsetGridPlacements,
  placeGridItems
} from "./placement.js";
import { sizeGridTracks } from "./track-sizing.js";
import type {
  GridAreaPlacement,
  GridItemContribution
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface GridLayoutOperationResult {
  readonly fragment: LayoutFragmentId;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
}

export interface GridUsedDimensions {
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

export interface GridUsedEdges {
  readonly margin: CssSignedEdges;
  readonly padding: CssEdges;
  readonly border: CssEdges;
}

export interface GridContainerLayoutHost {
  readonly budgets: LayoutBudgets;
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  boxComputed(node: FormattingNode): ComputedStyle | null;
  dimensions(
    node: FormattingNode,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null,
    forcedContentWidth: CssPixelLength | null
  ): GridUsedDimensions;
  usedGap(value: CssGap, percentageBasis: CssPixelLength | null, style: ComputedStyle): CssPixelLength | null;
  usedLength(value: CssLength, percentageBasis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  isOutOfFlow(node: FormattingNode): boolean;
  intrinsicContributions(id: FormattingNodeId, availableInlineSize: CssPixelLength | null): IntrinsicSizeContributions;
  gridItemMinimumInlineContribution(
    id: FormattingNodeId,
    contributions: IntrinsicSizeContributions
  ): CssNonNegativeLength;
  edges(style: ComputedStyle | null, containingWidth: CssPixelLength): GridUsedEdges;
  clip(node: FormattingNode, paddingRect: CssRect, borderRect: CssRect, inheritedClip: CssRect): CssRect;
  registerPositionedContainingBlock(node: FormattingNodeId, paddingRect: CssRect): void;
  layoutChild(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    containingHeight: CssPixelLength,
    forcedContentWidth: CssPixelLength,
    forcedContentHeight: CssPixelLength | null
  ): GridLayoutOperationResult | null;
  translate(
    result: GridLayoutOperationResult,
    inlineOffset: CssPixelLength,
    blockOffset: CssPixelLength,
    containingClip: CssRect
  ): GridLayoutOperationResult;
  fragment(id: LayoutFragmentId): LayoutFragment | undefined;
  layoutOutOfFlow(
    node: FormattingNode,
    staticX: CssCoordinate,
    staticY: CssCoordinate,
    inheritedClip: CssRect,
    depth: number,
    containingBlockOverride?: CssRect
  ): GridLayoutOperationResult | null;
  container(
    node: FormattingNode,
    contentRect: CssRect,
    paddingRect: CssRect,
    borderRect: CssRect,
    marginRect: CssRect,
    clipRect: CssRect,
    children: readonly LayoutFragmentId[],
    lineBoxes: readonly LineBox[]
  ): GridLayoutOperationResult;
  withGridBudget<T>(operation: () => T): T;
}

export interface GridContainerLayoutInput {
  readonly node: FormattingNode;
  readonly x: CssCoordinate;
  readonly y: CssCoordinate;
  readonly width: CssPixelLength;
  readonly clip: CssRect;
  readonly depth: number;
  readonly forcedContentWidth: CssPixelLength | null;
  readonly forcedContentHeight: CssPixelLength | null;
}

function point(value: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return cssCoordinateAdd(value, offset);
}

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  let total: CssPixelLength = ZERO;
  for (const value of values) total = cssAdd(total, value);
  return total;
}

function negate(value: CssPixelLength): CssPixelLength {
  return cssMultiply(value, -1);
}

function nonNegative(value: CssPixelLength): CssNonNegativeLength {
  return cssNonNegativeLength(cssMax(ZERO, value));
}

function constrainedSize(
  automatic: CssPixelLength,
  specified: CssPixelLength | null,
  minimum: CssPixelLength,
  maximum: CssPixelLength | null
): CssNonNegativeLength {
  let used = specified ?? automatic;
  if (maximum !== null) used = cssMin(used, maximum);
  return nonNegative(cssMax(used, minimum));
}

function usedContentAlignment(alignment: ComputedStyle["box"]["justifyContent"]): ComputedStyle["box"]["justifyContent"] {
  return alignment.value === "normal"
    ? Object.freeze({ value: "stretch", overflow: alignment.overflow })
    : alignment;
}

function usedItemPosition(alignment: ComputedStyle["box"]["alignSelf"]): "start" | "end" | "center" | "stretch" | "baseline" {
  return alignment.position === "normal" || alignment.position === "auto" ? "stretch" : alignment.position;
}

function positionedAxisDefinite(start: CssGridLine, end: CssGridLine): boolean {
  const definiteStart = start.kind === "line" && !start.span;
  const definiteEnd = end.kind === "line" && !end.span;
  const spanStart = start.kind === "line" && start.span;
  const spanEnd = end.kind === "line" && end.span;
  return (definiteStart && (definiteEnd || spanEnd)) || (definiteEnd && spanStart);
}

function trackAreaInlineSize(
  item: GridAreaPlacement,
  tracks: ReturnType<typeof sizeGridTracks>["tracks"]
): CssNonNegativeLength {
  const first = tracks[item.columnStart];
  const last = tracks[item.columnEnd - 1];
  return first === undefined || last === undefined
    ? ZERO
    : nonNegative(sum(last.offset, last.baseSize, negate(first.offset)));
}

function placementInputs(host: GridContainerLayoutHost, ids: readonly FormattingNodeId[]) {
  return ids.map((id, sourceIndex) => {
    const itemStyle = host.computed(host.formattingNode(id));
    return Object.freeze({
      formattingNode: id,
      sourceIndex,
      order: itemStyle?.box.order ?? 0,
      ...(itemStyle?.box.gridPlacement ?? {
        columnStart: GRID_AUTO_LINE,
        columnEnd: GRID_AUTO_LINE,
        rowStart: GRID_AUTO_LINE,
        rowEnd: GRID_AUTO_LINE
      })
    });
  });
}

export function layoutGridContainer(
  host: GridContainerLayoutHost,
  input: GridContainerLayoutInput
): GridLayoutOperationResult {
  const { node } = input;
  const style = host.boxComputed(node) ?? host.computed(node);
  if (style === null) throw new RangeError("A grid container must have a computed style.");
  const dimensions = host.dimensions(node, input.width, null, input.forcedContentWidth);
  const borderX = point(input.x, dimensions.marginLeft);
  const contentX = point(borderX, sum(dimensions.border.left, dimensions.padding.left));
  const contentY = point(input.y, sum(dimensions.border.top, dimensions.padding.top));
  const contentWidth = dimensions.contentWidth;
  const specifiedHeight = input.forcedContentHeight ?? dimensions.specifiedHeight;
  return host.withGridBudget(() => {
    const columnGap = nonNegative(host.usedGap(style.box.columnGap, contentWidth, style) ?? ZERO);
    let rowGap = nonNegative(host.usedGap(style.box.rowGap, specifiedHeight, style) ?? ZERO);
    const resolveLength = (value: CssLength, basis: CssPixelLength | null): CssPixelLength | null =>
      host.usedLength(value, basis, style);
    const explicitColumns = expandExplicitGridAxis({
      list: style.box.gridTemplateColumns,
      areas: style.box.gridTemplateAreas,
      areaAxis: "column",
      automaticTrackSizing: style.box.gridAutoColumns,
      availableSize: contentWidth,
      gap: columnGap,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const explicitRows = expandExplicitGridAxis({
      list: style.box.gridTemplateRows,
      areas: style.box.gridTemplateAreas,
      areaAxis: "row",
      automaticTrackSizing: style.box.gridAutoRows,
      availableSize: specifiedHeight,
      gap: rowGap,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const gridItems: FormattingNodeId[] = [];
    const outOfFlow: FormattingNodeId[] = [];
    for (const child of node.children) {
      (host.isOutOfFlow(host.formattingNode(child)) ? outOfFlow : gridItems).push(child);
    }
    const placement = placeGridItems({
      items: placementInputs(host, gridItems),
      columns: explicitColumns,
      rows: explicitRows,
      autoFlow: style.box.gridAutoFlow,
      limits: host.budgets,
      signal: host.signal
    });
    const columnSequence = buildGridTrackSequence(
      explicitColumns,
      placement.minimumColumnLine,
      placement.maximumColumnLine,
      style.box.gridAutoColumns,
      occupiedExplicitGridTracks(placement, "column", explicitColumns.tracks.length)
    );
    const rowSequence = buildGridTrackSequence(
      explicitRows,
      placement.minimumRowLine,
      placement.maximumRowLine,
      style.box.gridAutoRows,
      occupiedExplicitGridTracks(placement, "row", explicitRows.tracks.length)
    );
    const placements = offsetGridPlacements(
      placement,
      columnSequence.explicitTrackOffset,
      rowSequence.explicitTrackOffset
    );
    const columnContributions: GridItemContribution[] = placements.map((item) => {
      const intrinsic = host.intrinsicContributions(item.formattingNode, null);
      const edges = host.edges(host.computed(host.formattingNode(item.formattingNode)), contentWidth);
      return Object.freeze({
        formattingNode: item.formattingNode,
        start: item.columnStart,
        end: item.columnEnd,
        minimumContribution: nonNegative(sum(
          host.gridItemMinimumInlineContribution(item.formattingNode, intrinsic),
          edges.margin.left,
          edges.margin.right
        )),
        minContent: nonNegative(sum(
          intrinsic.borderBox.minContentInlineSize,
          edges.margin.left,
          edges.margin.right
        )),
        maxContent: nonNegative(sum(
          intrinsic.borderBox.maxContentInlineSize,
          edges.margin.left,
          edges.margin.right
        ))
      });
    });
    const sizedColumns = sizeGridTracks({
      tracks: columnSequence.tracks,
      collapsedTracks: columnSequence.collapsedTracks,
      contributions: columnContributions,
      availableSize: contentWidth,
      gap: columnGap,
      resolveLength,
      alignment: usedContentAlignment(style.box.justifyContent),
      maxWork: host.budgets.maxGridTrackSizingWork,
      signal: host.signal
    });
    const rowContributions: GridItemContribution[] = placements.map((item) => {
      const areaWidth = trackAreaInlineSize(item, sizedColumns.tracks);
      const itemNode = host.formattingNode(item.formattingNode);
      const itemStyle = host.boxComputed(itemNode) ?? host.computed(itemNode);
      const intrinsic = host.intrinsicContributions(item.formattingNode, areaWidth);
      const edges = host.edges(itemStyle, areaWidth);
      const block = nonNegative(sum(
        intrinsic.borderBox.minimumBlockContribution,
        edges.margin.top,
        edges.margin.bottom
      ));
      return Object.freeze({
        formattingNode: item.formattingNode,
        start: item.rowStart,
        end: item.rowEnd,
        minimumContribution: block,
        minContent: block,
        maxContent: block
      });
    });
    let sizedRows = sizeGridTracks({
      tracks: rowSequence.tracks,
      collapsedTracks: rowSequence.collapsedTracks,
      contributions: rowContributions,
      availableSize: specifiedHeight,
      gap: rowGap,
      resolveLength,
      alignment: usedContentAlignment(style.box.alignContent),
      maxWork: host.budgets.maxGridTrackSizingWork,
      signal: host.signal
    });
    const contentHeight = constrainedSize(
      sizedRows.usedSize,
      specifiedHeight,
      dimensions.minHeight,
      dimensions.maxHeight
    );
    const finalRowGap = nonNegative(host.usedGap(style.box.rowGap, contentHeight, style) ?? ZERO);
    if (contentHeight !== sizedRows.usedSize || specifiedHeight !== null || finalRowGap !== rowGap) {
      rowGap = finalRowGap;
      sizedRows = sizeGridTracks({
        tracks: rowSequence.tracks,
        collapsedTracks: rowSequence.collapsedTracks,
        contributions: rowContributions,
        availableSize: contentHeight,
        gap: rowGap,
        resolveLength,
        alignment: usedContentAlignment(style.box.alignContent),
        maxWork: host.budgets.maxGridTrackSizingWork,
        signal: host.signal
      });
    }
    const contentRect = cssRect(contentX, contentY, contentWidth, contentHeight);
    const paddingRect = cssRect(
      point(contentX, negate(dimensions.padding.left)),
      point(contentY, negate(dimensions.padding.top)),
      sum(contentWidth, dimensions.padding.left, dimensions.padding.right),
      sum(contentHeight, dimensions.padding.top, dimensions.padding.bottom)
    );
    const borderRect = cssRect(
      point(paddingRect.x, negate(dimensions.border.left)),
      point(paddingRect.y, negate(dimensions.border.top)),
      sum(paddingRect.width, dimensions.border.left, dimensions.border.right),
      sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom)
    );
    const marginRect = cssRect(
      point(borderRect.x, negate(dimensions.marginLeft)),
      point(borderRect.y, negate(dimensions.margin.top)),
      sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight),
      sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom)
    );
    const finalClip = host.clip(node, paddingRect, borderRect, input.clip);
    if (style.box.position !== "static") host.registerPositionedContainingBlock(node.id, paddingRect);
    const children: LayoutFragmentId[] = [];
    const baselineItems: {
      readonly row: number;
      readonly result: GridLayoutOperationResult;
      readonly baseline: CssPixelLength;
    }[] = [];
    const paintOrderedPlacements = [...placements].sort((left, right) =>
      left.order - right.order || left.sourceIndex - right.sourceIndex);
    for (const item of paintOrderedPlacements) {
      const child = host.formattingNode(item.formattingNode);
      const childStyle = host.computed(child);
      const area = resolvedGridArea(item, sizedColumns.tracks, sizedRows.tracks);
      const edges = host.edges(childStyle, area.width);
      const horizontalChrome = sum(
        edges.margin.left,
        edges.border.left,
        edges.padding.left,
        edges.padding.right,
        edges.border.right,
        edges.margin.right
      );
      const verticalChrome = sum(
        edges.margin.top,
        edges.border.top,
        edges.padding.top,
        edges.padding.bottom,
        edges.border.bottom,
        edges.margin.bottom
      );
      const specifiedJustify = childStyle?.box.justifySelf.position === "auto"
        ? style.box.justifyItems
        : childStyle?.box.justifySelf ?? style.box.justifyItems;
      const specifiedAlign = childStyle?.box.alignSelf.position === "auto"
        ? style.box.alignItems
        : childStyle?.box.alignSelf ?? style.box.alignItems;
      const replacedItem = childStyle?.display.box === "principal" && childStyle.display.replaced;
      const justify = Object.freeze({
        position: specifiedJustify.position === "normal" && replacedItem
          ? "start" as const
          : usedItemPosition(specifiedJustify),
        overflow: specifiedJustify.overflow
      });
      const align = Object.freeze({
        position: specifiedAlign.position === "normal" && replacedItem
          ? "start" as const
          : usedItemPosition(specifiedAlign),
        overflow: specifiedAlign.overflow
      });
      const physicalJustify = Object.freeze({
        ...justify,
        position: style.text.direction === "rtl"
          ? justify.position === "start" ? "end" as const
            : justify.position === "end" ? "start" as const : justify.position
          : justify.position
      });
      const automaticWidth = childStyle === null || childStyle.box.width.kind === "auto"
        || childStyle.box.width.kind === "none";
      const automaticHeight = childStyle === null || childStyle.box.height.kind === "auto"
        || childStyle.box.height.kind === "none";
      const autoMarginLeft = childStyle?.box.margin.left.kind === "auto";
      const autoMarginRight = childStyle?.box.margin.right.kind === "auto";
      const autoMarginTop = childStyle?.box.margin.top.kind === "auto";
      const autoMarginBottom = childStyle?.box.margin.bottom.kind === "auto";
      const intrinsic = host.intrinsicContributions(item.formattingNode, area.width);
      const availableContentWidth = nonNegative(sum(area.width, negate(horizontalChrome)));
      let spansFlexibleColumn = false;
      let spansAutomaticMinimumColumn = false;
      for (let index = item.columnStart; index < item.columnEnd; index += 1) {
        const track = columnSequence.tracks[index];
        if (track === undefined) continue;
        if (item.columnEnd - item.columnStart > 1
          && ((track.kind === "breadth" && track.breadth.kind === "flex")
            || (track.kind === "minmax" && track.maximum.kind === "flex"))) spansFlexibleColumn = true;
        if (track.kind === "fit-content"
          || (track.kind === "breadth" && (track.breadth.kind === "auto" || track.breadth.kind === "flex"))
          || (track.kind === "minmax" && track.minimum.kind === "auto")) spansAutomaticMinimumColumn = true;
      }
      const automaticMinimumInline = childStyle?.box.overflowX !== "hidden"
        && !spansFlexibleColumn && spansAutomaticMinimumColumn
        ? intrinsic.automaticMinimumSize.inline
        : ZERO;
      const specifiedWidth = childStyle === null
        ? null
        : host.usedLength(childStyle.box.width, area.width, childStyle);
      const widthToContent = (candidate: CssPixelLength): CssPixelLength =>
        childStyle?.box.boxSizing === "border-box"
          ? nonNegative(sum(
              candidate,
              negate(edges.border.left),
              negate(edges.padding.left),
              negate(edges.padding.right),
              negate(edges.border.right)
            ))
          : nonNegative(candidate);
      let forcedWidth = automaticWidth
        ? justify.position === "stretch" && !autoMarginLeft && !autoMarginRight
          ? availableContentWidth
          : cssMin(availableContentWidth, intrinsic.contentBox.maxContentInlineSize)
        : widthToContent(specifiedWidth ?? availableContentWidth);
      const minimumWidth = childStyle === null ? ZERO
        : childStyle.box.minWidth.kind === "auto" ? automaticMinimumInline
          : widthToContent(host.usedLength(childStyle.box.minWidth, area.width, childStyle) ?? ZERO);
      const maximumWidthValue = childStyle === null
        ? null
        : host.usedLength(childStyle.box.maxWidth, area.width, childStyle);
      if (maximumWidthValue !== null) forcedWidth = cssMin(forcedWidth, widthToContent(maximumWidthValue));
      forcedWidth = cssMax(forcedWidth, minimumWidth);
      const specifiedItemHeight = childStyle === null
        ? null
        : host.usedLength(childStyle.box.height, area.height, childStyle);
      const heightToContent = (candidate: CssPixelLength): CssPixelLength =>
        childStyle?.box.boxSizing === "border-box"
          ? nonNegative(sum(
              candidate,
              negate(edges.border.top),
              negate(edges.padding.top),
              negate(edges.padding.bottom),
              negate(edges.border.bottom)
            ))
          : nonNegative(candidate);
      let forcedHeight = automaticHeight
        ? align.position === "stretch" && !autoMarginTop && !autoMarginBottom
          ? nonNegative(sum(area.height, negate(verticalChrome)))
          : null
        : heightToContent(specifiedItemHeight ?? area.height);
      if (forcedHeight !== null && childStyle !== null) {
        let spansFlexibleRow = false;
        let spansAutomaticMinimumRow = false;
        for (let index = item.rowStart; index < item.rowEnd; index += 1) {
          const track = rowSequence.tracks[index];
          if (track === undefined) continue;
          if (item.rowEnd - item.rowStart > 1
            && ((track.kind === "breadth" && track.breadth.kind === "flex")
              || (track.kind === "minmax" && track.maximum.kind === "flex"))) spansFlexibleRow = true;
          if (track.kind === "fit-content"
            || (track.kind === "breadth" && (track.breadth.kind === "auto" || track.breadth.kind === "flex"))
            || (track.kind === "minmax" && track.minimum.kind === "auto")) spansAutomaticMinimumRow = true;
        }
        const minimumHeightValue = childStyle.box.minHeight.kind === "auto"
          ? childStyle.box.overflowY !== "hidden" && !spansFlexibleRow && spansAutomaticMinimumRow
            ? intrinsic.automaticMinimumSize.block
            : ZERO
          : heightToContent(host.usedLength(childStyle.box.minHeight, area.height, childStyle) ?? ZERO);
        const maximumHeightValue = host.usedLength(childStyle.box.maxHeight, area.height, childStyle);
        forcedHeight = cssMax(forcedHeight, minimumHeightValue);
        if (maximumHeightValue !== null) forcedHeight = cssMin(forcedHeight, heightToContent(maximumHeightValue));
      }
      let result = host.layoutChild(
        item.formattingNode,
        point(contentX, style.text.direction === "rtl"
          ? sum(contentWidth, negate(area.x), negate(area.width))
          : area.x),
        point(contentY, sum(area.y, edges.margin.top)),
        area.width,
        finalClip,
        input.depth + 1,
        area.height,
        forcedWidth,
        forcedHeight
      );
      if (result === null) break;
      const inlineAlignment = alignGridItem({
        areaSize: area.width,
        itemSize: result.marginRect.width,
        marginStart: ZERO,
        marginEnd: ZERO,
        autoMarginStart: autoMarginLeft,
        autoMarginEnd: autoMarginRight,
        alignment: physicalJustify.position === "baseline"
          ? Object.freeze({ ...physicalJustify, position: "start" as const })
          : physicalJustify,
        stretchEligible: automaticWidth
      });
      const blockAlignment = alignGridItem({
        areaSize: area.height,
        itemSize: result.marginRect.height,
        marginStart: ZERO,
        marginEnd: ZERO,
        autoMarginStart: autoMarginTop,
        autoMarginEnd: autoMarginBottom,
        alignment: align.position === "baseline"
          ? Object.freeze({ ...align, position: "start" as const })
          : align,
        stretchEligible: automaticHeight
      });
      result = host.translate(result, inlineAlignment.offset, blockAlignment.offset, finalClip);
      children.push(result.fragment);
      if (align.position === "baseline") {
        const fragment = host.fragment(result.fragment);
        baselineItems.push({
          row: item.rowStart,
          result,
          baseline: fragment?.baseline === null || fragment?.baseline === undefined
            ? result.marginRect.height
            : sum(
                cssCoordinateDifference(fragment.borderRect.y, result.marginRect.y),
                fragment.baseline
              )
        });
      }
    }
    for (const row of new Set(baselineItems.map((item) => item.row))) {
      const entries = baselineItems.filter((item) => item.row === row);
      let baseline: CssPixelLength = ZERO;
      for (const entry of entries) baseline = cssMax(baseline, entry.baseline);
      for (const entry of entries) {
        host.translate(entry.result, ZERO, sum(baseline, negate(entry.baseline)), finalClip);
      }
    }
    for (const outOfFlowId of outOfFlow) {
      const outOfFlowNode = host.formattingNode(outOfFlowId);
      const outOfFlowStyle = host.computed(outOfFlowNode);
      let positionedContainingBlock: CssRect | undefined;
      if (outOfFlowStyle?.box.position === "absolute") {
        const normalizedStylePlacement = normalizeGridPlacement(outOfFlowStyle.box.gridPlacement);
        const positionedPlacement = placeGridItems({
          items: [{
            formattingNode: outOfFlowId,
            sourceIndex: node.children.indexOf(outOfFlowId),
            order: outOfFlowStyle.box.order,
            ...normalizedStylePlacement
          }],
          columns: explicitColumns,
          rows: explicitRows,
          autoFlow: style.box.gridAutoFlow,
          limits: host.budgets,
          signal: host.signal
        }).items[0];
        if (positionedPlacement !== undefined) {
          const normalized = {
            ...positionedPlacement,
            columnStart: positionedPlacement.columnStart + columnSequence.explicitTrackOffset,
            columnEnd: positionedPlacement.columnEnd + columnSequence.explicitTrackOffset,
            rowStart: positionedPlacement.rowStart + rowSequence.explicitTrackOffset,
            rowEnd: positionedPlacement.rowEnd + rowSequence.explicitTrackOffset
          };
          const gridArea = resolvedGridArea(normalized, sizedColumns.tracks, sizedRows.tracks);
          const columnsDefinite = positionedAxisDefinite(
            normalizedStylePlacement.columnStart,
            normalizedStylePlacement.columnEnd
          ) && normalized.columnStart >= 0 && normalized.columnEnd <= sizedColumns.tracks.length;
          const rowsDefinite = positionedAxisDefinite(
            normalizedStylePlacement.rowStart,
            normalizedStylePlacement.rowEnd
          ) && normalized.rowStart >= 0 && normalized.rowEnd <= sizedRows.tracks.length;
          positionedContainingBlock = cssRect(
            columnsDefinite
              ? point(contentX, style.text.direction === "rtl"
                  ? sum(contentWidth, negate(gridArea.x), negate(gridArea.width))
                  : gridArea.x)
              : paddingRect.x,
            rowsDefinite ? point(contentY, gridArea.y) : paddingRect.y,
            columnsDefinite ? gridArea.width : paddingRect.width,
            rowsDefinite ? gridArea.height : paddingRect.height
          );
        }
      }
      const positioned = host.layoutOutOfFlow(
        outOfFlowNode,
        positionedContainingBlock?.x ?? contentX,
        positionedContainingBlock?.y ?? contentY,
        finalClip,
        input.depth + 1,
        positionedContainingBlock
      );
      if (positioned === null) break;
      children.push(positioned.fragment);
    }
    return host.container(node, contentRect, paddingRect, borderRect, marginRect, finalClip, children, []);
  });
}
