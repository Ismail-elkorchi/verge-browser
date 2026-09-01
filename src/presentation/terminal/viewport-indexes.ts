import type { DocumentNodeRef } from "../../document/index.js";
import type { CssRect, LayoutFragmentId } from "../layout/index.js";
import type {
  TextSearchLayoutProjection,
  TextSearchMatchId,
} from "../search/index.js";
import { terminalPaintBudgets } from "./display-list.js";
import {
  inheritedScrollAttachment,
  scrollAttachmentTranslation,
  translatedScrollAttachedRect,
} from "./viewport-display-list.js";
import type {
  DocumentGeometryIndex,
  TerminalAccessibilityBound,
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
    const column = Math.max(0, Math.floor(left / displayList.context.cellWidthCssPx));
    const row = Math.max(0, Math.floor(top / displayList.context.rowHeightCssPx));
    const endColumn = Math.min(
      displayList.context.columns,
      Math.ceil(right / displayList.context.cellWidthCssPx),
    );
    const endRow = Math.ceil(bottom / displayList.context.rowHeightCssPx);
    if (endColumn > column && endRow > row) {
      results.push(Object.freeze({ row, column, width: endColumn - column, height: endRow - row }));
    }
  }
  return Object.freeze(results);
}

function resolvedViewportRects(
  rects: readonly CssRect[],
  fragments: readonly LayoutFragmentId[],
  displayList: ViewportDisplayList,
): readonly TerminalCellRect[] {
  const resolved = rects.map((rect, index) => {
    const fragment = fragments[index] ?? fragments[0];
    if (fragment === undefined) return rect;
    const attachment = inheritedScrollAttachment(displayList.documentDisplayList.layout, fragment);
    if (attachment === null) return rect;
    const [inline, block] = scrollAttachmentTranslation(attachment, displayList.viewportRect);
    return translatedScrollAttachedRect(rect, inline, block);
  });
  return cssRectsToCellRects(resolved, displayList);
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
    for (const layoutSpan of projection.spansByFragment.get(fragment) ?? []) {
      for (const entry of visible) {
        const span = entry.span;
        if (span.contentStartCodeUnit === null || span.contentEndCodeUnit === null
          || layoutSpan.contentStartCodeUnit >= span.contentEndCodeUnit
          || layoutSpan.contentEndCodeUnit <= span.contentStartCodeUnit) continue;
        const exact = span.contentEndCodeUnit - span.contentStartCodeUnit === span.endCodeUnit - span.startCodeUnit;
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
          sourceRange: layoutSpan.sourceRange,
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
      cellRectsByDocumentNode: new Map(),
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
  const focusCandidates = new Map(input.documentGeometry
    .focusIntersecting(input.displayList.windowRect, input.signal)
    .map((target) => [target.node, target]));
  const actionPaintOrder = new Map<DocumentNodeRef, {
    readonly paintOrder: number;
    readonly layoutFragment: LayoutFragmentId;
  }>();
  for (const command of input.displayList.commands) {
    if (command.action === null) continue;
    const commandRects = rectsByCommand.get(command.id) ?? [];
    const actionRects = rectsByActionNode.get(command.action.node) ?? [];
    actionRects.push(...commandRects);
    rectsByActionNode.set(command.action.node, actionRects);
    actionPaintOrder.set(command.action.node, {
      paintOrder: command.paintOrder,
      layoutFragment: command.layoutFragment,
    });
    const target = input.documentGeometry.focusForNode(command.action.node);
    if (target !== null) focusCandidates.set(command.action.node, target);
  }
  const hitRegions: TerminalHitRegion[] = [];
  const hitCandidates = [...focusCandidates.values()].sort((left, right) =>
    (actionPaintOrder.get(left.node)?.paintOrder ?? -1)
      - (actionPaintOrder.get(right.node)?.paintOrder ?? -1));
  for (const target of hitCandidates) {
    const rects = resolvedViewportRects(target.rects, target.layoutFragments, input.displayList);
    for (const [index, rect] of rects.entries()) {
      if (hitRegions.length >= budgets.maxRetainedHitTestRegions) {
        retainTruncation(truncations, "maxRetainedHitTestRegions", budgets.maxRetainedHitTestRegions);
        break;
      }
      const layoutFragment = target.layoutFragments[index] ?? target.layoutFragments[0]
        ?? actionPaintOrder.get(target.node)?.layoutFragment;
      if (layoutFragment === undefined) continue;
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
    const rects = resolvedViewportRects(target.rects, target.layoutFragments, input.displayList);
    if (rects.length === 0) continue;
    if (focusRectangles + rects.length > budgets.maxRetainedFocusRectangles) {
      retainTruncation(truncations, "maxRetainedFocusRectangles", budgets.maxRetainedFocusRectangles);
      continue;
    }
    focusRectangles += rects.length;
    focusTargets.push(Object.freeze({
      node: target.node,
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
  const accessibilityCandidates = new Map(input.documentGeometry
    .accessibilityIntersecting(input.displayList.windowRect, input.signal)
    .map((entry) => [entry.documentNode, entry]));
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
    const semanticRects = resolvedViewportRects(entry.rects, entry.rectFragments, input.displayList);
    const candidateRects = [...semanticRects];
    const visibleAccessibilityRect = visibleAccessibilityRects.get(entry.documentNode);
    if (visibleAccessibilityRect !== undefined) candidateRects.push(visibleAccessibilityRect);
    const semanticFocus = input.documentGeometry.focusForNode(entry.documentNode);
    if (semanticFocus !== null) {
      candidateRects.push(...resolvedViewportRects(
        semanticFocus.rects,
        semanticFocus.layoutFragments,
        input.displayList,
      ));
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
  return Object.freeze({
    cellBuffer: input.cellBuffer,
    hitTestIndex: new ViewportHitTestIndex(hitRegions),
    focusMap: new ViewportFocusMap(focusTargets),
    accessibilityBounds: Object.freeze(accessibilityBounds),
    search: input.searchProjection === undefined || input.searchProjection === null
      ? null
      : searchResult(input.searchProjection, input.cellBuffer),
    commandById,
    cellRectsByDocumentNode: new Map([...rectsByNode].map(([node, rects]) => [node, Object.freeze(rects)])),
    truncations: Object.freeze(truncations),
  });
}
