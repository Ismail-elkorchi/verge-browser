import type { DocumentNodeRef } from "../../document/index.js";
import type { CssRect, LayoutFragmentId } from "../layout/index.js";
import type {
  TextSearchLayoutProjection,
  TextSearchMatchId,
} from "../search/index.js";
import { terminalPaintBudgets } from "./display-list.js";
import type {
  DocumentGeometryIndex,
  TerminalAccessibilityBound,
  TerminalControlGeometry,
  TerminalScrollPort,
  TerminalCellRect,
  TerminalFocusMap,
  TerminalFocusTarget,
  TerminalHitRegion,
  TerminalHitTestIndex,
  TerminalSearchMatch,
  TerminalSearchRange,
  TerminalSearchResult,
  TerminalTruncation,
  ViewportCellBuffer,
  ViewportDisplayList,
  ViewportTerminalResult,
} from "./types.js";

function cssRectsToCellRects(
  rects: readonly CssRect[],
  displayList: ViewportDisplayList,
): readonly TerminalCellRect[] {
  const leftBoundary = displayList.windowRect.x;
  const topBoundary = displayList.windowRect.y;
  const rightBoundary = leftBoundary + displayList.windowRect.width;
  const bottomBoundary = topBoundary + displayList.windowRect.height;
  const results: TerminalCellRect[] = [];
  for (const rect of rects) {
    const left = Math.max(leftBoundary, rect.x);
    const top = Math.max(topBoundary, rect.y);
    const right = Math.min(rightBoundary, rect.x + rect.width);
    const bottom = Math.min(bottomBoundary, rect.y + rect.height);
    if (left >= right || top >= bottom) continue;
    const column = Math.floor(left / displayList.context.cellWidthCssPx);
    const row = Math.max(0, Math.floor(top / displayList.context.rowHeightCssPx));
    const endColumn = Math.ceil(right / displayList.context.cellWidthCssPx);
    const endRow = Math.ceil(bottom / displayList.context.rowHeightCssPx);
    if (endColumn > column && endRow > row) {
      results.push(Object.freeze({ row, column, width: endColumn - column, height: endRow - row }));
    }
  }
  return Object.freeze(results);
}

function resolvedViewportGeometry(
  rects: readonly CssRect[],
  fragments: readonly LayoutFragmentId[],
  displayList: ViewportDisplayList,
): readonly { readonly rect: TerminalCellRect; readonly fragment: LayoutFragmentId }[] {
  return rects.flatMap((rect, index) => {
    const fragment = fragments[index];
    if (fragment === undefined) throw new Error("Semantic rectangle is missing its layout owner.");
    const resolved = displayList.projection.visible(fragment, rect);
    return cssRectsToCellRects([resolved], displayList).map((cellRect) => ({ rect: cellRect, fragment }));
  });
}

function retainTruncation(
  values: TerminalTruncation[],
  budget: TerminalTruncation["budget"],
  limit: number,
): void {
  if (!values.some((entry) => entry.budget === budget)) values.push(Object.freeze({ budget, limit }));
}

function unionCellRects(rects: readonly TerminalCellRect[]): TerminalCellRect | null {
  if (rects.length === 0) return null;
  let row = Number.MAX_SAFE_INTEGER;
  let column = Number.MAX_SAFE_INTEGER;
  let bottom = Number.MIN_SAFE_INTEGER;
  let right = Number.MIN_SAFE_INTEGER;
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    row = Math.min(row, rect.row);
    column = Math.min(column, rect.column);
    bottom = Math.max(bottom, rect.row + rect.height);
    right = Math.max(right, rect.column + rect.width);
  }
  return row === Number.MAX_SAFE_INTEGER ? null : Object.freeze({ row, column, width: right - column, height: bottom - row });
}

function unionCellRectPair(left: TerminalCellRect | undefined, right: TerminalCellRect): TerminalCellRect {
  if (left === undefined) return right;
  const row = Math.min(left.row, right.row);
  const column = Math.min(left.column, right.column);
  return Object.freeze({
    row,
    column,
    width: Math.max(left.column + left.width, right.column + right.width) - column,
    height: Math.max(left.row + left.height, right.row + right.height) - row,
  });
}

class ViewportHitTestIndex implements TerminalHitTestIndex {
  readonly regions: readonly TerminalHitRegion[];
  readonly #rows: ReadonlyMap<number, readonly TerminalHitRegion[]>;

  public constructor(regions: readonly TerminalHitRegion[]) {
    this.regions = Object.freeze([...regions]);
    const rows = new Map<number, TerminalHitRegion[]>();
    for (const region of regions) {
      for (let row = region.rect.row; row < region.rect.row + region.rect.height; row += 1) {
        const bucket = rows.get(row) ?? [];
        bucket.push(region);
        rows.set(row, bucket);
      }
    }
    this.#rows = new Map([...rows].map(([row, entries]) => [row, Object.freeze(entries)]));
    Object.freeze(this);
  }

  public at(row: number, column: number): TerminalHitRegion | null {
    const bucket = this.#rows.get(row) ?? [];
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const region = bucket[index];
      if (region !== undefined && column >= region.rect.column
        && column < region.rect.column + region.rect.width) return region;
    }
    return null;
  }
}

class ViewportFocusMap implements TerminalFocusMap {
  readonly targets: readonly TerminalFocusTarget[];
  readonly #byNode: ReadonlyMap<DocumentNodeRef, TerminalFocusTarget>;

  public constructor(targets: readonly TerminalFocusTarget[]) {
    this.targets = Object.freeze([...targets]);
    this.#byNode = new Map(targets.map((target) => [target.node, target]));
    Object.freeze(this);
  }

  public forNode(node: DocumentNodeRef): TerminalFocusTarget | null {
    return this.#byNode.get(node) ?? null;
  }
}

function searchResult(
  projection: TextSearchLayoutProjection,
  cells: ViewportCellBuffer,
): TerminalSearchResult {
  const spansByFragment = new Map<LayoutFragmentId, {
    readonly row: number;
    readonly span: ViewportCellBuffer["rows"][number]["spans"][number];
  }[]>();
  for (const row of cells.rows) {
    for (const span of row.spans) {
      const entries = spansByFragment.get(span.layoutFragment) ?? [];
      entries.push({ row: row.row, span });
      spansByFragment.set(span.layoutFragment, entries);
    }
  }
  const byMatch = new Map<TextSearchMatchId, TerminalSearchRange[]>();
  for (const [fragment, visible] of spansByFragment) {
    // Logical source order must not depend on whether the index coalesced a run.
    visible.sort((left, right) => (left.span.contentStartCodeUnit ?? 0) - (right.span.contentStartCodeUnit ?? 0));
    for (const layoutSpan of projection.spansByFragment.get(fragment) ?? []) {
      for (const entry of visible) {
        const span = entry.span;
        if (span.contentStartCodeUnit === null || span.contentEndCodeUnit === null
          || layoutSpan.contentStartCodeUnit >= span.contentEndCodeUnit
          || layoutSpan.contentEndCodeUnit <= span.contentStartCodeUnit) continue;
        const exact = span.contentEndCodeUnit - span.contentStartCodeUnit === span.endCodeUnit - span.startCodeUnit;
        let sourceRange = layoutSpan.sourceRange;
        if (sourceRange !== null && span.sourceRange !== null) {
          const start = Math.max(sourceRange.start, span.sourceRange.start);
          const end = Math.min(sourceRange.end, span.sourceRange.end);
          sourceRange = end > start
            ? Object.freeze({ start, end, provenance: sourceRange.provenance })
            : null;
        }
        const range = Object.freeze({
          match: layoutSpan.match,
          row: entry.row,
          startCodeUnit: exact
            ? span.startCodeUnit + Math.max(layoutSpan.contentStartCodeUnit, span.contentStartCodeUnit) - span.contentStartCodeUnit
            : span.startCodeUnit,
          endCodeUnit: exact
            ? span.startCodeUnit + Math.min(layoutSpan.contentEndCodeUnit, span.contentEndCodeUnit) - span.contentStartCodeUnit
            : span.endCodeUnit,
          layoutFragment: layoutSpan.fragment,
          documentNode: layoutSpan.documentNode,
          sourceRange,
        });
        const ranges = byMatch.get(layoutSpan.match) ?? [];
        ranges.push(range);
        byMatch.set(layoutSpan.match, ranges);
      }
    }
  }
  const matches: TerminalSearchMatch[] = projection.matches.flatMap((match) => {
    const ranges = byMatch.get(match.id) ?? [];
    return ranges.length === 0 ? [] : [Object.freeze({ id: match.id, ranges: Object.freeze(ranges) })];
  });
  return Object.freeze({
    query: projection.query,
    matches: Object.freeze(matches),
    ranges: Object.freeze(matches.flatMap((match) => match.ranges)),
    truncated: projection.truncated,
  });
}

export interface BuildViewportTerminalResultInput {
  readonly displayList: ViewportDisplayList;
  readonly cellBuffer: ViewportCellBuffer;
  readonly documentGeometry: DocumentGeometryIndex;
  readonly searchProjection?: TextSearchLayoutProjection | null;
  readonly truncations?: readonly ViewportTerminalResult["truncations"][number][];
  readonly signal?: AbortSignal;
}

/** Builds row-bucketed interaction indexes only from cells retained in the current window. */
export function buildViewportTerminalResult(input: BuildViewportTerminalResultInput): ViewportTerminalResult {
  const budgets = terminalPaintBudgets(input.displayList.context.budgets);
  if (budgets === null) {
    return Object.freeze({
      cellBuffer: input.cellBuffer,
      hitTestIndex: new ViewportHitTestIndex([]),
      focusMap: new ViewportFocusMap([]),
      accessibilityBounds: Object.freeze([]),
      search: null,
      commandById: new Map(),
      controls: Object.freeze([]),
      scrollPorts: Object.freeze([]),
      truncations: Object.freeze([...(input.truncations ?? [])]),
    });
  }
  const truncations = [...input.documentGeometry.truncations, ...(input.truncations ?? [])];
  const commandById = new Map(input.displayList.commands.map((command) => [command.id, command]));
  const rectsByCommand = new Map<string, TerminalCellRect[]>();
  const rectsByNode = new Map<DocumentNodeRef, TerminalCellRect[]>();
  const rectsByActionNode = new Map<DocumentNodeRef, TerminalCellRect[]>();
  for (const row of input.cellBuffer.rows) {
    input.signal?.throwIfAborted();
    for (const cell of row.cells) {
      const rect = Object.freeze({ row: row.row, column: cell.column, width: cell.width, height: 1 });
      const commandRects = rectsByCommand.get(cell.command) ?? [];
      commandRects.push(rect);
      rectsByCommand.set(cell.command, commandRects);
      if (cell.documentNode !== null) {
        const nodeRects = rectsByNode.get(cell.documentNode) ?? [];
        nodeRects.push(rect);
        rectsByNode.set(cell.documentNode, nodeRects);
      }
    }
  }
  const candidateWindows = [...input.displayList.projection.candidateWindows()];
  const focusCandidates = new Map(candidateWindows.flatMap(([owner, window]) =>
    input.documentGeometry.focusIntersecting(window, input.signal, owner)).map((target) => [target.node, target]));
  const actionPaintOrder = new Map<DocumentNodeRef, number>();
  for (const command of input.displayList.commands) {
    if (command.action === null) continue;
    const commandRects = rectsByCommand.get(command.id) ?? [];
    const actionRects = rectsByActionNode.get(command.action.node) ?? [];
    actionRects.push(...commandRects);
    rectsByActionNode.set(command.action.node, actionRects);
    actionPaintOrder.set(command.action.node, command.paintOrder);
    const target = input.documentGeometry.focusForNode(command.action.node);
    if (target !== null) focusCandidates.set(command.action.node, target);
  }
  const hitRegions: TerminalHitRegion[] = [];
  const hitCandidates = [...focusCandidates.values()].sort((left, right) =>
    (actionPaintOrder.get(left.node) ?? -1)
      - (actionPaintOrder.get(right.node) ?? -1));
  for (const target of hitCandidates) {
    const geometry = resolvedViewportGeometry(target.rects, target.rectFragments, input.displayList);
    for (const [index, { rect, fragment: layoutFragment }] of geometry.entries()) {
      if (hitRegions.length >= budgets.maxRetainedHitTestRegions) {
        retainTruncation(truncations, "maxRetainedHitTestRegions", budgets.maxRetainedHitTestRegions);
        break;
      }
      hitRegions.push(Object.freeze({
        id: `viewport-hit-region:${target.node}:${String(index)}`,
        action: target.action,
        layoutFragment,
        rect,
      }));
    }
  }
  const focusTargets: TerminalFocusTarget[] = [];
  let focusRectangles = 0;
  for (const target of focusCandidates.values()) {
    const rects = resolvedViewportGeometry(target.rects, target.rectFragments, input.displayList).map((entry) => entry.rect);
    if (rects.length === 0) continue;
    if (focusRectangles + rects.length > budgets.maxRetainedFocusRectangles) {
      retainTruncation(truncations, "maxRetainedFocusRectangles", budgets.maxRetainedFocusRectangles);
      continue;
    }
    focusRectangles += rects.length;
    focusTargets.push(Object.freeze({
      node: target.node,
      scrollOwner: target.scrollOwner,
      action: target.action,
      layoutFragments: target.layoutFragments,
      rects: Object.freeze(rects),
      label: target.label,
    }));
  }
  const document = input.displayList.documentDisplayList.layout.formatting.document;
  const visibleAccessibilityRects = new Map<DocumentNodeRef, TerminalCellRect>();
  for (const [node, rects] of rectsByNode) {
    let current: DocumentNodeRef | null = node;
    while (current !== null) {
      input.signal?.throwIfAborted();
      if (input.documentGeometry.accessibilityForNode(current) !== null) {
        for (const rect of rects) {
          visibleAccessibilityRects.set(
            current,
            unionCellRectPair(visibleAccessibilityRects.get(current), rect),
          );
        }
      }
      current = document.parent(current)?.ref ?? null;
    }
  }
  const accessibilityBounds: TerminalAccessibilityBound[] = [];
  const accessibilityCandidates = new Map(candidateWindows.flatMap(([owner, window]) =>
    input.documentGeometry.accessibilityIntersecting(window, input.signal, owner)).map((entry) => [entry.documentNode, entry]));
  for (const node of visibleAccessibilityRects.keys()) {
    const entry = input.documentGeometry.accessibilityForNode(node);
    if (entry !== null) accessibilityCandidates.set(node, entry);
  }
  for (const entry of accessibilityCandidates.values()) {
    if (accessibilityBounds.length >= budgets.maxRetainedAccessibilityRectangles) {
      retainTruncation(
        truncations,
        "maxRetainedAccessibilityRectangles",
        budgets.maxRetainedAccessibilityRectangles,
      );
      break;
    }
    const semanticRects = resolvedViewportGeometry(entry.rects, entry.rectFragments, input.displayList).map((value) => value.rect);
    const candidateRects = [...semanticRects];
    const visibleAccessibilityRect = visibleAccessibilityRects.get(entry.documentNode);
    if (visibleAccessibilityRect !== undefined) candidateRects.push(visibleAccessibilityRect);
    const semanticFocus = input.documentGeometry.focusForNode(entry.documentNode);
    if (semanticFocus !== null) {
      candidateRects.push(...resolvedViewportGeometry(
        semanticFocus.rects,
        semanticFocus.rectFragments,
        input.displayList,
      ).map((value) => value.rect));
    }
    candidateRects.push(...rectsByActionNode.get(entry.documentNode) ?? []);
    candidateRects.push(...rectsByNode.get(entry.documentNode) ?? []);
    let rect = unionCellRects(candidateRects);
    if (rect === null && entry.rect.width === 0 && entry.rect.height === 0) {
      rect = Object.freeze({
        row: Math.floor(entry.rect.y / input.displayList.context.rowHeightCssPx),
        column: Math.floor(entry.rect.x / input.displayList.context.cellWidthCssPx),
        width: 0,
        height: 0,
      });
    }
    if (rect === null) continue;
    accessibilityBounds.push(Object.freeze({
      documentNode: entry.documentNode,
      layoutFragments: entry.layoutFragments,
      role: entry.role,
      name: entry.name,
      description: entry.description,
      rect,
    }));
  }
  const scrollPorts: TerminalScrollPort[] = [];
  const layout = input.displayList.documentDisplayList.layout;
  for (const owner of input.displayList.projection.visibleScrollOwners()) {
    const rect = cssRectsToCellRects([input.displayList.projection.visible(owner.fragment, owner.scrollport)], input.displayList)[0];
    if (rect === undefined) continue;
    const [inline, block] = input.displayList.projection.offset(owner);
    scrollPorts.push(Object.freeze({ node: owner.documentNode,
      parent: owner.parent === null ? null : layout.scrollContainer(owner.parent)?.documentNode ?? null,
      rect, inline, block, minInline: owner.minInline, maxInline: owner.maxInline,
      minBlock: owner.minBlock, maxBlock: owner.maxBlock,
      userScrollInline: owner.overflowX === "auto" || owner.overflowX === "scroll",
      userScrollBlock: owner.overflowY === "auto" || owner.overflowY === "scroll",
    }));
  }
  const controls: TerminalControlGeometry[] = [];
  const controlCandidates = new Set(candidateWindows.flatMap(([owner, window]) =>
    input.documentGeometry.controlsIntersecting(window, input.signal, owner)));
  for (const control of controlCandidates) {
    const allocation = input.displayList.projection.rect(control.fragment, control.rect);
    const clipped = input.displayList.projection.visible(control.fragment, control.rect);
    const visible = cssRectsToCellRects([clipped], input.displayList)[0];
    if (visible === undefined) continue;
    const column = Math.floor(allocation.x / input.displayList.context.cellWidthCssPx);
    const row = Math.floor(allocation.y / input.displayList.context.rowHeightCssPx);
    controls.push(Object.freeze({
      node: control.node,
      layoutFragment: control.fragment,
      allocation: Object.freeze({
        column, row,
        width: Math.ceil((allocation.x + allocation.width) / input.displayList.context.cellWidthCssPx) - column,
        height: Math.ceil((allocation.y + allocation.height) / input.displayList.context.rowHeightCssPx) - row,
      }),
      visible,
    }));
  }
  return Object.freeze({
    cellBuffer: input.cellBuffer,
    hitTestIndex: new ViewportHitTestIndex(hitRegions),
    focusMap: new ViewportFocusMap(focusTargets),
    accessibilityBounds: Object.freeze(accessibilityBounds),
    search: input.searchProjection === undefined || input.searchProjection === null
      ? null
      : searchResult(input.searchProjection, input.cellBuffer),
    commandById,
    controls: Object.freeze(controls),
    scrollPorts: Object.freeze(scrollPorts),
    truncations: Object.freeze(truncations),
  });
}
