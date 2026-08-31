import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { ComputedStyle, CssGap, CssLength } from "../../style/index.js";
import { GRID_AUTO_LINE } from "../../style/grid/index.js";
import type { IntrinsicSizeContributions } from "../intrinsic/index.js";
import {
  cssAdd,
  cssMax,
  cssMin,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
  type CssSignedEdges
} from "../fixed.js";
import type { LayoutBudgets } from "../types.js";
import { buildGridTrackSequence } from "./implicit-grid.js";
import { expandExplicitGridAxis } from "./explicit-grid.js";
import {
  occupiedExplicitGridTracks,
  offsetGridPlacements,
  placeGridItems
} from "./placement.js";
import { sizeGridTracks } from "./track-sizing.js";
import type { GridItemContribution, ResolvedGridTrack } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));
const START_CONTENT_ALIGNMENT = Object.freeze({ value: "start" as const, overflow: "default" as const });

export interface GridIntrinsicSizingHost {
  readonly budgets: LayoutBudgets;
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  boxComputed(node: FormattingNode): ComputedStyle | null;
  isOutOfFlow(node: FormattingNode): boolean;
  usedGap(value: CssGap, percentageBasis: CssPixelLength | null, style: ComputedStyle): CssPixelLength | null;
  usedLength(value: CssLength, percentageBasis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  edges(style: ComputedStyle | null, containingWidth: CssPixelLength): { readonly margin: CssSignedEdges };
  intrinsicContributions(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength | null
  ): IntrinsicSizeContributions;
  gridItemMinimumInlineContribution(
    id: FormattingNodeId,
    contributions: IntrinsicSizeContributions
  ): CssNonNegativeLength;
  intrinsicOuterBlockSize(
    id: FormattingNodeId,
    availableInlineSize: CssPixelLength,
    depth: number,
    itemStyle: boolean
  ): CssNonNegativeLength;
  withGridBudget<T>(operation: () => T): T;
}

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  let result: CssPixelLength = ZERO;
  for (const value of values) result = cssAdd(result, value);
  return result;
}

function negate(value: CssPixelLength): CssPixelLength {
  return cssMultiply(value, -1);
}

function nonNegative(value: CssPixelLength): CssNonNegativeLength {
  return cssNonNegativeLength(cssMax(ZERO, value));
}

function usedContentAlignment(
  alignment: ComputedStyle["box"]["justifyContent"]
): ComputedStyle["box"]["justifyContent"] {
  return alignment.value === "normal"
    ? Object.freeze({ value: "stretch", overflow: alignment.overflow })
    : alignment;
}

function placementInputs(host: GridIntrinsicSizingHost, ids: readonly FormattingNodeId[]) {
  return ids.map((formattingNode, sourceIndex) => {
    const itemStyle = host.computed(host.formattingNode(formattingNode));
    return Object.freeze({
      formattingNode,
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

function contribution(
  host: GridIntrinsicSizingHost,
  formattingNode: FormattingNodeId,
  start: number,
  end: number,
  percentageBasis: CssPixelLength,
  mode: "min-content" | "max-content" = "max-content"
): GridItemContribution {
  const intrinsic = host.intrinsicContributions(formattingNode, null);
  const itemNode = host.formattingNode(formattingNode);
  const edges = host.edges(host.boxComputed(itemNode) ?? host.computed(itemNode), percentageBasis);
  return Object.freeze({
    formattingNode,
    start,
    end,
    minimumContribution: nonNegative(sum(
      host.gridItemMinimumInlineContribution(formattingNode, intrinsic),
      edges.margin.left,
      edges.margin.right
    )),
    minContent: nonNegative(sum(
      intrinsic.borderBox.minContentInlineSize,
      edges.margin.left,
      edges.margin.right
    )),
    maxContent: nonNegative(sum(
      mode === "min-content"
        ? intrinsic.borderBox.minContentInlineSize
        : intrinsic.borderBox.maxContentInlineSize,
      edges.margin.left,
      edges.margin.right
    ))
  });
}

function areaInlineSize(
  start: number,
  end: number,
  tracks: readonly ResolvedGridTrack[]
): CssNonNegativeLength {
  const first = tracks[start];
  const last = tracks[end - 1];
  return first === undefined || last === undefined
    ? ZERO
    : nonNegative(sum(last.offset, last.baseSize, negate(first.offset)));
}

export function intrinsicGridInlineSize(
  host: GridIntrinsicSizingHost,
  node: FormattingNode,
  mode: "min-content" | "max-content",
  maximum: CssPixelLength
): CssPixelLength {
  const style = host.boxComputed(node) ?? host.computed(node);
  if (style === null) return ZERO;
  const items = node.children.filter((child) => !host.isOutOfFlow(host.formattingNode(child)));
  if (items.length === 0) return ZERO;
  return host.withGridBudget(() => {
    const columnGap = nonNegative(host.usedGap(style.box.columnGap, null, style) ?? ZERO);
    const resolveLength = (value: CssLength, basis: CssPixelLength | null): CssPixelLength | null =>
      host.usedLength(value, basis, style);
    const columns = expandExplicitGridAxis({
      list: style.box.gridTemplateColumns,
      areas: style.box.gridTemplateAreas,
      areaAxis: "column",
      automaticTrackSizing: style.box.gridAutoColumns,
      availableSize: null,
      gap: columnGap,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const rows = expandExplicitGridAxis({
      list: style.box.gridTemplateRows,
      areas: style.box.gridTemplateAreas,
      areaAxis: "row",
      automaticTrackSizing: style.box.gridAutoRows,
      availableSize: null,
      gap: ZERO,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const placement = placeGridItems({
      items: placementInputs(host, items),
      columns,
      rows,
      autoFlow: style.box.gridAutoFlow,
      limits: host.budgets,
      signal: host.signal
    });
    const sequence = buildGridTrackSequence(
      columns,
      placement.minimumColumnLine,
      placement.maximumColumnLine,
      style.box.gridAutoColumns,
      occupiedExplicitGridTracks(placement, "column", columns.tracks.length)
    );
    const placements = offsetGridPlacements(placement, sequence.explicitTrackOffset, 0);
    const contributions = placements.map((item) => contribution(
      host,
      item.formattingNode,
      item.columnStart,
      item.columnEnd,
      ZERO,
      mode
    ));
    const sized = sizeGridTracks({
      tracks: sequence.tracks,
      collapsedTracks: sequence.collapsedTracks,
      contributions,
      availableSize: null,
      gap: columnGap,
      resolveLength,
      alignment: START_CONTENT_ALIGNMENT,
      sizingConstraint: mode,
      maxWork: host.budgets.maxGridTrackSizingWork,
      signal: host.signal
    });
    return cssMin(maximum, sized.usedSize);
  });
}

export function intrinsicGridBlockSize(
  host: GridIntrinsicSizingHost,
  node: FormattingNode,
  availableInlineSize: CssPixelLength,
  depth: number
): CssNonNegativeLength {
  const style = host.boxComputed(node) ?? host.computed(node);
  if (style === null) return ZERO;
  const items = node.children.filter((child) => !host.isOutOfFlow(host.formattingNode(child)));
  if (items.length === 0) return ZERO;
  return host.withGridBudget(() => {
    const columnGap = nonNegative(host.usedGap(style.box.columnGap, availableInlineSize, style) ?? ZERO);
    const rowGap = nonNegative(host.usedGap(style.box.rowGap, availableInlineSize, style) ?? ZERO);
    const resolveLength = (value: CssLength, basis: CssPixelLength | null): CssPixelLength | null =>
      host.usedLength(value, basis, style);
    const columns = expandExplicitGridAxis({
      list: style.box.gridTemplateColumns,
      areas: style.box.gridTemplateAreas,
      areaAxis: "column",
      automaticTrackSizing: style.box.gridAutoColumns,
      availableSize: availableInlineSize,
      gap: columnGap,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const rows = expandExplicitGridAxis({
      list: style.box.gridTemplateRows,
      areas: style.box.gridTemplateAreas,
      areaAxis: "row",
      automaticTrackSizing: style.box.gridAutoRows,
      availableSize: null,
      gap: rowGap,
      limits: host.budgets,
      resolveLength,
      signal: host.signal
    });
    const placement = placeGridItems({
      items: placementInputs(host, items),
      columns,
      rows,
      autoFlow: style.box.gridAutoFlow,
      limits: host.budgets,
      signal: host.signal
    });
    const columnSequence = buildGridTrackSequence(
      columns,
      placement.minimumColumnLine,
      placement.maximumColumnLine,
      style.box.gridAutoColumns,
      occupiedExplicitGridTracks(placement, "column", columns.tracks.length)
    );
    const rowSequence = buildGridTrackSequence(
      rows,
      placement.minimumRowLine,
      placement.maximumRowLine,
      style.box.gridAutoRows,
      occupiedExplicitGridTracks(placement, "row", rows.tracks.length)
    );
    const placements = offsetGridPlacements(
      placement,
      columnSequence.explicitTrackOffset,
      rowSequence.explicitTrackOffset
    );
    const sizedColumns = sizeGridTracks({
      tracks: columnSequence.tracks,
      collapsedTracks: columnSequence.collapsedTracks,
      contributions: placements.map((item) => contribution(
        host,
        item.formattingNode,
        item.columnStart,
        item.columnEnd,
        availableInlineSize
      )),
      availableSize: availableInlineSize,
      gap: columnGap,
      resolveLength,
      alignment: usedContentAlignment(style.box.justifyContent),
      maxWork: host.budgets.maxGridTrackSizingWork,
      signal: host.signal
    });
    const rowContributions = placements.map((item) => {
      const block = host.intrinsicOuterBlockSize(
        item.formattingNode,
        areaInlineSize(item.columnStart, item.columnEnd, sizedColumns.tracks),
        depth,
        true
      );
      return Object.freeze({
        formattingNode: item.formattingNode,
        start: item.rowStart,
        end: item.rowEnd,
        minimumContribution: block,
        minContent: block,
        maxContent: block
      });
    });
    return sizeGridTracks({
      tracks: rowSequence.tracks,
      collapsedTracks: rowSequence.collapsedTracks,
      contributions: rowContributions,
      availableSize: null,
      gap: rowGap,
      resolveLength,
      alignment: usedContentAlignment(style.box.alignContent),
      maxWork: host.budgets.maxGridTrackSizingWork,
      signal: host.signal
    }).usedSize;
  });
}
