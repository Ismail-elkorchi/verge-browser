import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import {
  cssCoordinateAdd,
  cssIntersection,
  type CssRect,
  type LayoutFragment,
  type LayoutFragmentId
} from "../layout/index.js";
import {
  mapTextSearchMatchesToLayout,
  type TextSearchIndex,
  type TextSearchMatchId
} from "../search/index.js";
import { terminalPaintBudgets, validTerminalRenderContext } from "./display-list.js";
import type {
  RasterizeTerminalDisplayListInput,
  TerminalAccessibilityBound,
  TerminalCell,
  TerminalCellBuffer,
  TerminalCellRasterizationResult,
  TerminalCellBufferOutcome,
  TerminalCellRect,
  TerminalCellRow,
  TerminalCellSpan,
  TerminalCellStyleSpan,
  TerminalDisplayList,
  TerminalFocusMap,
  TerminalFocusTarget,
  TerminalHitRegion,
  TerminalHitTestIndex,
  TerminalIndexConstructionResult,
  TerminalPaintBudgets,
  TerminalPaintCommand,
  TerminalRenderResult,
  TerminalScrollAnchor,
  TerminalSearchMatch,
  TerminalSearchRange,
  TerminalSearchResult,
  TerminalStyle,
  TerminalTruncation
} from "./types.js";

interface PaintUnit {
  readonly command: TerminalPaintCommand;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly text: string;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly visible: boolean;
}

interface PaintedUnit extends PaintUnit {
  readonly actualStyle: TerminalStyle;
}

interface MutableDocumentCellGeometry {
  readonly fragments: LayoutFragmentId[];
  readonly fragmentSet: Set<LayoutFragmentId>;
  readonly rects: TerminalCellRect[];
}

interface MutableAccessibilityCellGeometry {
  readonly fragments: LayoutFragmentId[];
  readonly fragmentSet: Set<LayoutFragmentId>;
  rect: TerminalCellRect | null;
}

interface DocumentCellGeometry {
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly rects: readonly TerminalCellRect[];
}

class InvalidTerminalCellMeasurement extends Error {}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MIN_SAFE = Number.MIN_SAFE_INTEGER;

function safeInteger(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? MIN_SAFE : MAX_SAFE;
  if (value >= MAX_SAFE) return MAX_SAFE;
  if (value <= MIN_SAFE) return MIN_SAFE;
  return Math.trunc(value);
}

function safeAdd(left: number, right: number): number {
  left = safeInteger(left);
  right = safeInteger(right);
  if (right > 0 && left > MAX_SAFE - right) return MAX_SAFE;
  if (right < 0 && left < MIN_SAFE - right) return MIN_SAFE;
  return left + right;
}

function safeSubtract(left: number, right: number): number {
  left = safeInteger(left);
  right = safeInteger(right);
  if (right < 0 && left > MAX_SAFE + right) return MAX_SAFE;
  if (right > 0 && left < MIN_SAFE + right) return MIN_SAFE;
  return left - right;
}

function cellRect(row: number, column: number, width: number, height: number): TerminalCellRect {
  return Object.freeze({
    row: safeInteger(row),
    column: safeInteger(column),
    width: Math.max(0, safeInteger(width)),
    height: Math.max(0, safeInteger(height))
  });
}

function cellIntersection(left: TerminalCellRect, right: TerminalCellRect): TerminalCellRect {
  if (left.width === 0 || left.height === 0 || right.width === 0 || right.height === 0) {
    return cellRect(Math.max(left.row, right.row), Math.max(left.column, right.column), 0, 0);
  }
  const row = Math.max(left.row, right.row);
  const column = Math.max(left.column, right.column);
  const bottom = Math.min(safeAdd(left.row, left.height), safeAdd(right.row, right.height));
  const edge = Math.min(safeAdd(left.column, left.width), safeAdd(right.column, right.width));
  return cellRect(row, column, Math.max(0, safeSubtract(edge, column)), Math.max(0, safeSubtract(bottom, row)));
}

function cellUnion(rectangles: Iterable<TerminalCellRect>): TerminalCellRect | null {
  let row = 0;
  let column = 0;
  let bottom = 0;
  let edge = 0;
  let initialized = false;
  for (const rectangle of rectangles) {
    if (rectangle.width === 0 || rectangle.height === 0) continue;
    const rectangleBottom = safeAdd(rectangle.row, rectangle.height);
    const rectangleEdge = safeAdd(rectangle.column, rectangle.width);
    if (!initialized) {
      row = rectangle.row;
      column = rectangle.column;
      bottom = rectangleBottom;
      edge = rectangleEdge;
      initialized = true;
      continue;
    }
    row = Math.min(row, rectangle.row);
    column = Math.min(column, rectangle.column);
    bottom = Math.max(bottom, rectangleBottom);
    edge = Math.max(edge, rectangleEdge);
  }
  return initialized ? cellRect(row, column, safeSubtract(edge, column), safeSubtract(bottom, row)) : null;
}

function snapCssRect(rect: CssRect, clip: CssRect, list: TerminalDisplayList, budgets: TerminalPaintBudgets): TerminalCellRect {
  if (rect.width === 0 || rect.height === 0 || clip.width === 0 || clip.height === 0) {
    return cellRect(
      Math.floor(rect.y / list.context.rowHeightCssPx),
      Math.floor(rect.x / list.context.cellWidthCssPx),
      0,
      0
    );
  }
  const clipped = cssIntersection(rect, clip);
  if (clipped.width === 0 || clipped.height === 0) {
    return cellRect(
      Math.floor(clipped.y / list.context.rowHeightCssPx),
      Math.floor(clipped.x / list.context.cellWidthCssPx),
      0,
      0
    );
  }
  const column = Math.floor(clipped.x / list.context.cellWidthCssPx);
  const row = Math.floor(clipped.y / list.context.rowHeightCssPx);
  const edge = Math.ceil(cssCoordinateAdd(clipped.x, clipped.width) / list.context.cellWidthCssPx);
  const bottom = Math.ceil(cssCoordinateAdd(clipped.y, clipped.height) / list.context.rowHeightCssPx);
  const snapped = cellRect(row, column, safeSubtract(edge, column), safeSubtract(bottom, row));
  return cellIntersection(snapped, cellRect(
    0,
    0,
    Math.min(list.context.columns, budgets.maxRetainedCellBufferColumns),
    budgets.maxRetainedCellBufferRows
  ));
}

function snapUnclippedCssRect(rect: CssRect, list: TerminalDisplayList): TerminalCellRect {
  if (rect.width === 0 || rect.height === 0) {
    return cellRect(
      Math.floor(rect.y / list.context.rowHeightCssPx),
      Math.floor(rect.x / list.context.cellWidthCssPx),
      0,
      0
    );
  }
  const column = Math.floor(rect.x / list.context.cellWidthCssPx);
  const row = Math.floor(rect.y / list.context.rowHeightCssPx);
  const edge = Math.ceil(cssCoordinateAdd(rect.x, rect.width) / list.context.cellWidthCssPx);
  const bottom = Math.ceil(cssCoordinateAdd(rect.y, rect.height) / list.context.rowHeightCssPx);
  return cellRect(row, column, safeSubtract(edge, column), safeSubtract(bottom, row));
}

function textClip(command: Extract<TerminalPaintCommand, { readonly kind: "text" }>, list: TerminalDisplayList, budgets: TerminalPaintBudgets): TerminalCellRect {
  return snapCssRect(command.clipRect, command.clipRect, list, budgets);
}

interface PaintUnitGenerationState {
  readonly limit: number;
  generated: number;
  truncated: boolean;
}

function reservePaintUnit(state: PaintUnitGenerationState): boolean {
  if (state.generated >= state.limit) {
    state.truncated = true;
    return false;
  }
  state.generated += 1;
  return true;
}

function* textUnits(
  command: Extract<TerminalPaintCommand, { readonly kind: "text" }>,
  list: TerminalDisplayList,
  budgets: TerminalPaintBudgets,
  generation: PaintUnitGenerationState,
  signal: AbortSignal | undefined
): Generator<PaintUnit> {
  const clip = textClip(command, list, budgets);
  if (clip.width === 0 || clip.height === 0) return;
  const row = Math.floor(command.rect.y / list.context.rowHeightCssPx);
  const rowVisible = row >= clip.row && row < safeAdd(clip.row, clip.height);
  const clipEdge = safeAdd(clip.column, clip.width);
  let previousCodeUnit = 0;
  let cssCursor = command.rect.x;
  let previousEnd = Math.floor(command.rect.x / list.context.cellWidthCssPx);
  for (const grapheme of command.clusters) {
    if (!reservePaintUnit(generation)) return;
    signal?.throwIfAborted();
    const cells = list.context.cellMeasurer.width(grapheme.text);
    if (!Number.isSafeInteger(grapheme.visualStartCodeUnit)
      || !Number.isSafeInteger(grapheme.visualEndCodeUnit)
      || grapheme.visualStartCodeUnit !== previousCodeUnit
      || grapheme.visualEndCodeUnit <= grapheme.visualStartCodeUnit
      || grapheme.visualEndCodeUnit > command.text.length
      || grapheme.text !== command.text.slice(grapheme.visualStartCodeUnit, grapheme.visualEndCodeUnit)
      || !Number.isSafeInteger(grapheme.contentStartCodeUnit)
      || !Number.isSafeInteger(grapheme.contentEndCodeUnit)
      || grapheme.contentStartCodeUnit < 0
      || grapheme.contentEndCodeUnit < grapheme.contentStartCodeUnit
      || !Number.isSafeInteger(grapheme.advance)
      || grapheme.advance < 0
      || !Number.isSafeInteger(cells)
      || cells < 0) {
      throw new InvalidTerminalCellMeasurement();
    }
    previousCodeUnit = grapheme.visualEndCodeUnit;
    const width = Math.max(1, cells);
    const desiredStart = Math.floor(cssCursor / list.context.cellWidthCssPx);
    const column = Math.max(previousEnd, desiredStart);
    const end = safeAdd(column, width);
    previousEnd = end;
    cssCursor = cssCoordinateAdd(cssCursor, grapheme.advance);
    yield Object.freeze({
      command,
      row,
      column,
      width,
      text: grapheme.text,
      startCodeUnit: grapheme.visualStartCodeUnit,
      endCodeUnit: grapheme.visualEndCodeUnit,
      contentStartCodeUnit: grapheme.contentStartCodeUnit,
      contentEndCodeUnit: grapheme.contentEndCodeUnit,
      sourceRange: grapheme.sourceRange,
      visible: rowVisible && column >= clip.column && end <= clipEdge
    });
  }
  if (previousCodeUnit !== command.text.length) throw new InvalidTerminalCellMeasurement();
}

function* backgroundUnits(
  command: Extract<TerminalPaintCommand, { readonly kind: "background" }>,
  list: TerminalDisplayList,
  budgets: TerminalPaintBudgets,
  generation: PaintUnitGenerationState,
  signal: AbortSignal | undefined
): Generator<PaintUnit> {
  const box = snapCssRect(command.rect, command.clipRect, list, budgets);
  for (let row = box.row; row < safeAdd(box.row, box.height); row += 1) {
    for (let column = box.column; column < safeAdd(box.column, box.width); column += 1) {
      if (!reservePaintUnit(generation)) return;
      signal?.throwIfAborted();
      yield Object.freeze({
        command,
        row,
        column,
        width: 1,
        text: " ",
        startCodeUnit: 0,
        endCodeUnit: 0,
        contentStartCodeUnit: null,
        contentEndCodeUnit: null,
        sourceRange: null,
        visible: true
      });
    }
  }
}

function borderGlyph(
  command: Extract<TerminalPaintCommand, { readonly kind: "border-side" }>,
  box: TerminalCellRect,
  row: number,
  column: number,
  unicode: boolean
): string {
  const atTop = row === box.row;
  const atBottom = row === safeAdd(box.row, box.height) - 1;
  const atLeft = column === box.column;
  const atRight = column === safeAdd(box.column, box.width) - 1;
  const top = command.borderWidths.top > 0;
  const right = command.borderWidths.right > 0;
  const bottom = command.borderWidths.bottom > 0;
  const left = command.borderWidths.left > 0;
  if (!unicode) return atTop || atBottom || atLeft || atRight ? "+" : command.side === "top" || command.side === "bottom" ? "-" : "|";
  if (box.width === 1 && box.height === 1) return "┼";
  if (atTop && atLeft && top && left) return "┌";
  if (atTop && atRight && top && right) return "┐";
  if (atBottom && atLeft && bottom && left) return "└";
  if (atBottom && atRight && bottom && right) return "┘";
  return command.side === "top" || command.side === "bottom" ? "─" : "│";
}

function* borderUnits(
  command: Extract<TerminalPaintCommand, { readonly kind: "border-side" }>,
  list: TerminalDisplayList,
  budgets: TerminalPaintBudgets,
  generation: PaintUnitGenerationState,
  signal: AbortSignal | undefined
): Generator<PaintUnit> {
  const whole = snapUnclippedCssRect(command.borderRect, list);
  const clipped = snapCssRect(command.borderRect, command.clipRect, list, budgets);
  if (whole.width === 0 || whole.height === 0 || clipped.width === 0 || clipped.height === 0) return;
  const top = whole.row;
  const bottom = safeAdd(whole.row, whole.height) - 1;
  const left = whole.column;
  const right = safeAdd(whole.column, whole.width) - 1;
  const emit = (row: number, column: number): PaintUnit | null => {
    if (row < clipped.row || row >= safeAdd(clipped.row, clipped.height)
      || column < clipped.column || column >= safeAdd(clipped.column, clipped.width)) return null;
    if (!reservePaintUnit(generation)) return null;
    signal?.throwIfAborted();
    const glyph = borderGlyph(command, whole, row, column, list.context.unicode);
    return Object.freeze({
      command,
      row,
      column,
      width: 1,
      text: glyph,
      startCodeUnit: 0,
      endCodeUnit: 0,
      contentStartCodeUnit: null,
      contentEndCodeUnit: null,
      sourceRange: null,
      visible: true
    });
  };
  if (command.side === "top" || command.side === "bottom") {
    const row = command.side === "top" ? top : bottom;
    if (row < clipped.row || row >= safeAdd(clipped.row, clipped.height)) return;
    const firstColumn = Math.max(left, clipped.column);
    const lastColumn = Math.min(right, safeAdd(clipped.column, clipped.width) - 1);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const unit = emit(row, column);
      if (unit !== null) yield unit;
      if (generation.truncated) return;
    }
    return;
  }
  const column = command.side === "left" ? left : right;
  if (column < clipped.column || column >= safeAdd(clipped.column, clipped.width)) return;
  const firstRow = Math.max(top, clipped.row);
  const lastRow = Math.min(bottom, safeAdd(clipped.row, clipped.height) - 1);
  for (let row = firstRow; row <= lastRow; row += 1) {
    const unit = emit(row, column);
    if (unit !== null) yield unit;
    if (generation.truncated) return;
  }
}

function unitsFor(
  command: TerminalPaintCommand,
  list: TerminalDisplayList,
  budgets: TerminalPaintBudgets,
  generation: PaintUnitGenerationState,
  signal: AbortSignal | undefined
): Generator<PaintUnit> {
  if (command.kind === "text") return textUnits(command, list, budgets, generation, signal);
  if (command.kind === "background") return backgroundUnits(command, list, budgets, generation, signal);
  return borderUnits(command, list, budgets, generation, signal);
}

const ANSI_16 = Object.freeze([
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
] as const);

type TerminalColor = NonNullable<TerminalStyle["foreground"]>;

function composite(top: TerminalColor | null, bottom: TerminalColor | null): TerminalColor | null {
  if (top === null || top.a <= 0) return bottom;
  if (bottom === null || bottom.a <= 0 || top.a >= 1) return top;
  const alpha = top.a + bottom.a * (1 - top.a);
  const component = (topValue: number, bottomValue: number): number => Math.round(
    (topValue * top.a + bottomValue * bottom.a * (1 - top.a)) / alpha
  );
  return Object.freeze({
    r: component(top.r, bottom.r),
    g: component(top.g, bottom.g),
    b: component(top.b, bottom.b),
    a: alpha
  });
}

function terminalColor(color: TerminalColor | null, depth: TerminalDisplayList["context"]["colorDepth"]): TerminalColor | null {
  if (color === null || color.a <= 0 || depth === 0) return null;
  if (depth === 24) return color;
  if (depth === 8) {
    const levels = [0, 95, 135, 175, 215, 255] as const;
    const nearest = (component: number): number => levels.reduce(
      (best, candidate) => Math.abs(candidate - component) < Math.abs(best - component) ? candidate : best,
      levels[0]
    );
    return Object.freeze({ r: nearest(color.r), g: nearest(color.g), b: nearest(color.b), a: color.a });
  }
  const nearest = ANSI_16.reduce((best, candidate) => {
    const distance = (candidate[0] - color.r) ** 2 + (candidate[1] - color.g) ** 2 + (candidate[2] - color.b) ** 2;
    const bestDistance = (best[0] - color.r) ** 2 + (best[1] - color.g) ** 2 + (best[2] - color.b) ** 2;
    return distance < bestDistance ? candidate : best;
  }, ANSI_16[0]);
  return Object.freeze({ r: nearest[0], g: nearest[1], b: nearest[2], a: color.a });
}

function actualStyle(command: TerminalPaintCommand, under: PaintedUnit | undefined, depth: TerminalDisplayList["context"]["colorDepth"]): TerminalStyle {
  const background = composite(command.style.background, under?.actualStyle.background ?? null);
  const foregroundSource = command.kind === "border-side" ? command.style.borderColors[command.side]
    : command.kind === "text" ? command.style.foreground : null;
  return Object.freeze({
    foreground: terminalColor(composite(foregroundSource, background), depth),
    background: terminalColor(background, depth),
    bold: command.kind === "text" && command.style.bold,
    italic: command.kind === "text" && command.style.italic,
    underline: command.kind === "text" && command.style.underline,
    strikethrough: command.kind === "text" && command.style.strikethrough
  });
}

function positionKey(row: number, column: number): string {
  return `${String(row)}:${String(column)}`;
}

class ImmutableHitTestIndex implements TerminalHitTestIndex {
  readonly regions: readonly TerminalHitRegion[];

  public constructor(regions: readonly TerminalHitRegion[]) {
    this.regions = Object.freeze([...regions]);
    Object.freeze(this);
  }

  public at(row: number, column: number): TerminalHitRegion | null {
    for (let index = this.regions.length - 1; index >= 0; index -= 1) {
      const region = this.regions[index];
      if (region !== undefined && row >= region.rect.row && row < safeAdd(region.rect.row, region.rect.height)
        && column >= region.rect.column && column < safeAdd(region.rect.column, region.rect.width)) return region;
    }
    return null;
  }
}

class ImmutableFocusMap implements TerminalFocusMap {
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

class ImmutableTerminalRenderResult implements TerminalRenderResult {
  readonly layout: TerminalRenderResult["layout"];
  readonly displayList: TerminalDisplayList;
  readonly cellBuffer: TerminalCellBuffer;
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
  readonly truncations: readonly TerminalTruncation[];
  readonly #cellRectsForDocumentNode: (node: DocumentNodeRef) => readonly TerminalCellRect[];
  readonly #spansByFragment: ReadonlyMap<LayoutFragmentId, readonly { readonly row: number; readonly span: TerminalCellSpan }[]>;
  readonly #searchCache = new Map<string, TerminalSearchResult>();
  readonly #textSearchIndex: TextSearchIndex;
  readonly #maxLogicalSearchMatches: number;
  readonly #maxRetainedSearchCellSpans: number;

  public constructor(
    displayList: TerminalDisplayList,
    textSearchIndex: TextSearchIndex,
    cellBuffer: TerminalCellBuffer,
    hitTestIndex: TerminalHitTestIndex,
    focusMap: TerminalFocusMap,
    accessibilityBounds: readonly TerminalAccessibilityBound[],
    scrollAnchors: readonly TerminalScrollAnchor[],
    cellRectsForDocumentNode: (node: DocumentNodeRef) => readonly TerminalCellRect[],
    truncations: readonly TerminalTruncation[],
    budgets: TerminalPaintBudgets | null
  ) {
    this.layout = displayList.layout;
    this.#textSearchIndex = textSearchIndex;
    this.displayList = displayList;
    this.cellBuffer = cellBuffer;
    this.hitTestIndex = hitTestIndex;
    this.focusMap = focusMap;
    this.accessibilityBounds = Object.freeze([...accessibilityBounds]);
    this.scrollAnchors = Object.freeze([...scrollAnchors]);
    this.truncations = Object.freeze([...truncations]);
    this.#cellRectsForDocumentNode = cellRectsForDocumentNode;
    this.#maxLogicalSearchMatches = budgets?.maxLogicalSearchMatches ?? 0;
    this.#maxRetainedSearchCellSpans = budgets?.maxRetainedSearchCellSpans ?? 0;
    const spans = new Map<LayoutFragmentId, { readonly row: number; readonly span: TerminalCellSpan }[]>();
    for (const row of cellBuffer.rows) {
      for (const span of row.spans) {
        const entries = spans.get(span.layoutFragment) ?? [];
        entries.push(Object.freeze({ row: row.row, span }));
        spans.set(span.layoutFragment, entries);
      }
    }
    this.#spansByFragment = spans;
    Object.freeze(this);
  }

  public cellRectsForDocumentNode(node: DocumentNodeRef): readonly TerminalCellRect[] {
    return this.#cellRectsForDocumentNode(node);
  }

  public search(query: string): TerminalSearchResult {
    const bounded = query.slice(0, 1_024);
    const cached = this.#searchCache.get(bounded);
    if (cached !== undefined) return cached;
    const indexed = this.#textSearchIndex.search(bounded, this.#maxLogicalSearchMatches);
    const spans = mapTextSearchMatchesToLayout(
      this.#textSearchIndex,
      this.layout,
      bounded,
      this.#maxLogicalSearchMatches
    );
    const byMatch = new Map<TextSearchMatchId, TerminalSearchRange[]>();
    let retainedRanges = 0;
    let cellSpanTruncated = false;
    outer: for (const layoutSpan of spans) {
      for (const entry of this.#spansByFragment.get(layoutSpan.fragment) ?? []) {
        const cellSpan = entry.span;
        if (cellSpan.contentStartCodeUnit === null || cellSpan.contentEndCodeUnit === null
          || layoutSpan.contentStartCodeUnit >= cellSpan.contentEndCodeUnit
          || layoutSpan.contentEndCodeUnit <= cellSpan.contentStartCodeUnit) continue;
        if (retainedRanges >= this.#maxRetainedSearchCellSpans) {
          cellSpanTruncated = true;
          break outer;
        }
        const contentLength = cellSpan.contentEndCodeUnit - cellSpan.contentStartCodeUnit;
        const rowLength = cellSpan.endCodeUnit - cellSpan.startCodeUnit;
        const exact = contentLength === rowLength;
        const startCodeUnit = exact
          ? cellSpan.startCodeUnit + Math.max(layoutSpan.contentStartCodeUnit, cellSpan.contentStartCodeUnit) - cellSpan.contentStartCodeUnit
          : cellSpan.startCodeUnit;
        const endCodeUnit = exact
          ? cellSpan.startCodeUnit + Math.min(layoutSpan.contentEndCodeUnit, cellSpan.contentEndCodeUnit) - cellSpan.contentStartCodeUnit
          : cellSpan.endCodeUnit;
        const range = Object.freeze({
          match: layoutSpan.match,
          row: entry.row,
          startCodeUnit,
          endCodeUnit,
          layoutFragment: layoutSpan.fragment,
          documentNode: layoutSpan.documentNode,
          sourceRange: layoutSpan.sourceRange
        });
        const ranges = byMatch.get(layoutSpan.match) ?? [];
        ranges.push(range);
        byMatch.set(layoutSpan.match, ranges);
        retainedRanges += 1;
      }
    }
    const matches: TerminalSearchMatch[] = indexed.matches.flatMap((match) => {
      const ranges = byMatch.get(match.id) ?? [];
      return ranges.length === 0 ? [] : [Object.freeze({ id: match.id, ranges: Object.freeze(ranges) })];
    });
    const ranges = matches.flatMap((match) => match.ranges);
    const result = Object.freeze({
      query: bounded,
      matches: Object.freeze(matches),
      ranges: Object.freeze(ranges),
      truncated: indexed.truncated || cellSpanTruncated
    });
    if (this.#searchCache.size >= 8) {
      const oldest = this.#searchCache.keys().next().value;
      if (oldest !== undefined) this.#searchCache.delete(oldest);
    }
    this.#searchCache.set(bounded, result);
    return result;
  }
}

function addTruncation(truncations: TerminalTruncation[], budget: TerminalTruncation["budget"], limit: number): void {
  if (truncations.some((entry) => entry.budget === budget)) return;
  truncations.push(Object.freeze({ budget, limit }));
}

function layoutFragmentsInPaintOrder(list: TerminalDisplayList, signal: AbortSignal | undefined): readonly LayoutFragment[] {
  const fragments: LayoutFragment[] = [];
  for (const id of list.fragmentPaintOrder) {
    signal?.throwIfAborted();
    fragments.push(list.layout.fragment(id));
  }
  return fragments;
}

function geometryAndIndexes(
  list: TerminalDisplayList,
  budgets: TerminalPaintBudgets,
  signal: AbortSignal | undefined,
  truncations: TerminalTruncation[]
): {
  readonly geometry: ReadonlyMap<DocumentNodeRef, DocumentCellGeometry>;
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
} {
  const document = list.layout.formatting.document;
  const fragments = layoutFragmentsInPaintOrder(list, signal);
  const geometry = new Map<DocumentNodeRef, MutableDocumentCellGeometry>();
  const accessibilityGeometry = new Map<DocumentNodeRef, MutableAccessibilityCellGeometry>();
  const directRectangleNodes = new Set<DocumentNodeRef>();
  const hitRegions: TerminalHitRegion[] = [];
  const scrollAnchors: TerminalScrollAnchor[] = [];
  const focus = new Map<DocumentNodeRef, {
    action: NonNullable<LayoutFragment["action"]>;
    fragments: LayoutFragmentId[];
    fragmentSet: Set<LayoutFragmentId>;
    rects: TerminalCellRect[];
  }>();
  let documentRectangles = 0;
  let focusRectangles = 0;
  const excludedFromAccessibility = new Map<DocumentNodeRef, boolean>();
  const accessibilityExcluded = (start: DocumentNodeRef): boolean => {
    const path: DocumentNodeRef[] = [];
    let node: DocumentNodeRef | null = start;
    let excluded = false;
    while (node !== null) {
      signal?.throwIfAborted();
      const cached = excludedFromAccessibility.get(node);
      if (cached !== undefined) {
        excluded = cached;
        break;
      }
      path.push(node);
      const semantic = document.semantic(node);
      if (semantic?.accessibilityHidden === true) {
        excluded = true;
        break;
      }
      node = document.parent(node)?.ref ?? null;
    }
    for (const ref of path) excludedFromAccessibility.set(ref, excluded);
    return excluded;
  };
  const ensureGeometry = (node: DocumentNodeRef): MutableDocumentCellGeometry => {
    let value = geometry.get(node);
    if (value === undefined) {
      value = { fragments: [], fragmentSet: new Set(), rects: [] };
      geometry.set(node, value);
    }
    return value;
  };
  const ensureAccessibilityGeometry = (node: DocumentNodeRef): MutableAccessibilityCellGeometry => {
    let value = accessibilityGeometry.get(node);
    if (value === undefined) {
      value = { fragments: [], fragmentSet: new Set(), rect: null };
      accessibilityGeometry.set(node, value);
    }
    return value;
  };
  const retainFragment = (
    value: MutableDocumentCellGeometry | MutableAccessibilityCellGeometry,
    fragment: LayoutFragmentId
  ): void => {
    if (value.fragmentSet.has(fragment)) return;
    value.fragmentSet.add(fragment);
    value.fragments.push(fragment);
  };
  for (const fragment of fragments) {
    signal?.throwIfAborted();
    let focusTarget: typeof focus extends Map<DocumentNodeRef, infer Value> ? Value | null : never = null;
    if (fragment.action !== null) {
      const control = document.control(fragment.action.node);
      if (control === null || !control.disabled) {
        focusTarget = focus.get(fragment.action.node) ?? null;
        if (focusTarget === null) {
          focusTarget = { action: fragment.action, fragments: [], fragmentSet: new Set(), rects: [] };
          focus.set(fragment.action.node, focusTarget);
        }
        if (!focusTarget.fragmentSet.has(fragment.id)) {
          focusTarget.fragmentSet.add(fragment.id);
          focusTarget.fragments.push(fragment.id);
        }
      }
    }
    const documentGeometry = fragment.documentNode === null ? null : ensureGeometry(fragment.documentNode);
    if (documentGeometry !== null) retainFragment(documentGeometry, fragment.id);
    const accessibleGeometry = fragment.documentNode !== null && fragment.style.visible
      && !accessibilityExcluded(fragment.documentNode)
      ? ensureAccessibilityGeometry(fragment.documentNode)
      : null;
    if (accessibleGeometry !== null) retainFragment(accessibleGeometry, fragment.id);
    if (!fragment.style.visible) continue;
    const boxes = function* (): Generator<CssRect> {
      if (fragment.kind !== "text" && fragment.inlineContinuations !== undefined) {
        for (const continuation of fragment.inlineContinuations) yield continuation.borderRect;
      } else yield fragment.borderRect;
    };
    for (const box of boxes()) {
      signal?.throwIfAborted();
      const rect = snapCssRect(box, fragment.clipRect, list, budgets);
      if (rect.width === 0 || rect.height === 0) continue;
      if (fragment.action !== null && focusTarget !== null) {
          if (hitRegions.length < budgets.maxRetainedHitTestRegions) {
            hitRegions.push(Object.freeze({
              id: `terminal-hit-region:${fragment.id}:${String(hitRegions.length + 1)}`,
              action: fragment.action,
              layoutFragment: fragment.id,
              rect
            }));
          } else addTruncation(truncations, "maxRetainedHitTestRegions", budgets.maxRetainedHitTestRegions);
          if (focusRectangles < budgets.maxRetainedFocusRectangles) {
            focusTarget.rects.push(rect);
            focusRectangles += 1;
          } else addTruncation(truncations, "maxRetainedFocusRectangles", budgets.maxRetainedFocusRectangles);
      }
      if (documentGeometry !== null) {
        if (documentRectangles < budgets.maxRetainedDocumentRectangles) {
          documentGeometry.rects.push(rect);
          if (fragment.documentNode !== null) directRectangleNodes.add(fragment.documentNode);
          documentRectangles += 1;
        } else addTruncation(truncations, "maxRetainedDocumentRectangles", budgets.maxRetainedDocumentRectangles);
      }
      if (accessibleGeometry !== null) {
        accessibleGeometry.rect = accessibleGeometry.rect === null
          ? rect
          : cellUnion([accessibleGeometry.rect, rect]);
      }
    }
  }
  const documentOrder: DocumentNodeRef[] = [];
  const documentPending = [document.root];
  while (documentPending.length > 0) {
    signal?.throwIfAborted();
    const node = documentPending.pop();
    if (node === undefined) continue;
    documentOrder.push(node);
    const children = document.node(node).children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) documentPending.push(child);
    }
  }
  for (let index = documentOrder.length - 1; index > 0; index -= 1) {
    signal?.throwIfAborted();
    const node = documentOrder[index];
    if (node === undefined) continue;
    const parent = document.parent(node)?.ref ?? null;
    if (parent === null) continue;
    const childGeometry = geometry.get(node);
    if (childGeometry !== undefined && !directRectangleNodes.has(parent)) {
      const parentGeometry = ensureGeometry(parent);
      for (const fragment of childGeometry.fragments) retainFragment(parentGeometry, fragment);
      for (const rect of childGeometry.rects) {
        if (documentRectangles < budgets.maxRetainedDocumentRectangles) {
          parentGeometry.rects.push(rect);
          documentRectangles += 1;
        } else addTruncation(truncations, "maxRetainedDocumentRectangles", budgets.maxRetainedDocumentRectangles);
      }
    }
    const childAccessibility = accessibilityGeometry.get(node);
    if (childAccessibility === undefined || accessibilityExcluded(parent)) continue;
    const parentAccessibility = ensureAccessibilityGeometry(parent);
    for (const fragment of childAccessibility.fragments) retainFragment(parentAccessibility, fragment);
    if (childAccessibility.rect !== null) {
      parentAccessibility.rect = parentAccessibility.rect === null
        ? childAccessibility.rect
        : cellUnion([parentAccessibility.rect, childAccessibility.rect]);
    }
  }
  const immutableGeometry = new Map<DocumentNodeRef, DocumentCellGeometry>();
  for (const [node, value] of geometry) {
    immutableGeometry.set(node, Object.freeze({
      layoutFragments: Object.freeze(value.fragments),
      rects: Object.freeze(value.rects)
    }));
  }
  const focusTargets: TerminalFocusTarget[] = [];
  for (const node of documentOrder) {
    const value = focus.get(node);
    if (value === undefined) continue;
    focusTargets.push(Object.freeze({
      node,
      action: value.action,
      layoutFragments: Object.freeze(value.fragments),
      rects: Object.freeze(value.rects),
      label: document.semantic(node)?.accessibleName || "Action"
    }));
  }
  const accessibilityBounds: TerminalAccessibilityBound[] = [];
  for (const node of documentOrder) {
    signal?.throwIfAborted();
    const semantic = document.semantic(node);
    const value = accessibilityGeometry.get(node);
    if (semantic === null || semantic.accessibilityHidden || value === undefined) continue;
    if (accessibilityBounds.length >= budgets.maxRetainedAccessibilityRectangles) {
      addTruncation(
        truncations,
        "maxRetainedAccessibilityRectangles",
        budgets.maxRetainedAccessibilityRectangles
      );
    } else {
      let rect = value.rect;
      if (rect === null) {
        const first = value.fragments[0] === undefined ? null : list.layout.fragment(value.fragments[0]);
        rect = first === null ? cellRect(0, 0, 0, 0) : cellRect(
          Math.floor(first.borderRect.y / list.context.rowHeightCssPx),
          Math.floor(first.borderRect.x / list.context.cellWidthCssPx),
          0,
          0
        );
      }
      accessibilityBounds.push(Object.freeze({
        documentNode: node,
        layoutFragments: Object.freeze(value.fragments),
        role: semantic.role,
        name: semantic.accessibleName,
        description: semantic.accessibleDescription,
        rect
      }));
    }
    const first = value.fragments[0];
    if (first === undefined) continue;
    if (scrollAnchors.length < budgets.maxRetainedScrollAnchors) {
      const fragment = list.layout.fragment(first);
      scrollAnchors.push(Object.freeze({
        id: `terminal-scroll-anchor:${node}`,
        documentNode: node,
        layoutFragment: fragment.id,
        row: Math.floor(fragment.borderRect.y / list.context.rowHeightCssPx)
      }));
    } else addTruncation(truncations, "maxRetainedScrollAnchors", budgets.maxRetainedScrollAnchors);
  }
  return {
    geometry: immutableGeometry,
    hitTestIndex: new ImmutableHitTestIndex(hitRegions),
    focusMap: new ImmutableFocusMap(focusTargets),
    accessibilityBounds: Object.freeze(accessibilityBounds),
    scrollAnchors: Object.freeze(scrollAnchors)
  };
}

function emptyRenderResult(
  list: TerminalDisplayList,
  textSearchIndex: TextSearchIndex,
  reason: "invalid-context" | "invalid-budget"
): TerminalRenderResult {
  const buffer: TerminalCellBuffer = Object.freeze({
    columns: Math.max(0, safeInteger(list.context.columns)),
    viewportRows: Math.max(0, safeInteger(list.context.rows)),
    rows: Object.freeze([]),
    outcome: Object.freeze({ status: "rejected", reason })
  });
  return new ImmutableTerminalRenderResult(
    list,
    textSearchIndex,
    buffer,
    new ImmutableHitTestIndex([]),
    new ImmutableFocusMap([]),
    [],
    [],
    () => [],
    [],
    null
  );
}

function emptyCellRasterization(
  list: TerminalDisplayList,
  reason: "invalid-context" | "invalid-budget" | "invalid-cell-measurement"
): TerminalCellRasterizationResult {
  return Object.freeze({
    cellBuffer: Object.freeze({
      columns: Math.max(0, safeInteger(list.context.columns)),
      viewportRows: Math.max(0, safeInteger(list.context.rows)),
      rows: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason })
    }),
    truncations: Object.freeze([])
  });
}

function initialTruncations(list: TerminalDisplayList, budgets: TerminalPaintBudgets): TerminalTruncation[] {
  const truncations: TerminalTruncation[] = [];
  if (list.outcome.status === "truncated") {
    addTruncation(truncations, list.outcome.budget, list.outcome.limit);
  }
  if (list.context.columns > budgets.maxRetainedCellBufferColumns) {
    addTruncation(truncations, "maxRetainedCellBufferColumns", budgets.maxRetainedCellBufferColumns);
  }
  return truncations;
}

function rasterizeTerminalCellsUnchecked(input: RasterizeTerminalDisplayListInput): TerminalCellRasterizationResult {
  const list = input.displayList;
  const budgets = terminalPaintBudgets(list.context.budgets);
  if (!validTerminalRenderContext(list.context)) return emptyCellRasterization(list, "invalid-context");
  if (budgets === null) return emptyCellRasterization(list, "invalid-budget");
  const truncations = initialTruncations(list, budgets);
  const ownerByPosition = new Map<string, PaintedUnit>();
  let generatedUnits = 0;
  let paintStopped = false;
  for (const command of list.commands) {
    input.signal?.throwIfAborted();
    const generation: PaintUnitGenerationState = {
      limit: Math.max(0, budgets.maxGeneratedPaintUnits - generatedUnits),
      generated: 0,
      truncated: false
    };
    for (const unit of unitsFor(command, list, budgets, generation, input.signal)) {
      if (!unit.visible || unit.row < 0 || unit.row >= budgets.maxRetainedCellBufferRows
        || unit.column < 0 || safeAdd(unit.column, unit.width) > budgets.maxRetainedCellBufferColumns) continue;
      const collided = new Set<PaintedUnit>();
      const positions: string[] = [];
      for (let cell = unit.column; cell < safeAdd(unit.column, unit.width); cell += 1) {
        const key = positionKey(unit.row, cell);
        positions.push(key);
        const previous = ownerByPosition.get(key);
        if (previous !== undefined) collided.add(previous);
      }
      const removedKeys = new Set<string>();
      for (const previous of collided) {
        for (let cell = previous.column; cell < safeAdd(previous.column, previous.width); cell += 1) {
          const key = positionKey(previous.row, cell);
          if (ownerByPosition.get(key) === previous) removedKeys.add(key);
        }
      }
      let added = 0;
      for (const key of positions) if (!ownerByPosition.has(key) || removedKeys.has(key)) added += 1;
      const projected = ownerByPosition.size - removedKeys.size + added;
      if (projected > budgets.maxRetainedPaintCells) {
        addTruncation(truncations, "maxRetainedPaintCells", budgets.maxRetainedPaintCells);
        paintStopped = true;
        break;
      }
      const under = collided.values().next().value;
      for (const key of removedKeys) ownerByPosition.delete(key);
      const painted = Object.freeze({
        ...unit,
        actualStyle: actualStyle(command, under, list.context.colorDepth)
      });
      for (const key of positions) ownerByPosition.set(key, painted);
    }
    generatedUnits += generation.generated;
    if (!paintStopped && generation.truncated) {
      addTruncation(truncations, "maxGeneratedPaintUnits", budgets.maxGeneratedPaintUnits);
      paintStopped = true;
    }
    if (paintStopped) break;
  }
  const visibleUnits = [...new Set(ownerByPosition.values())].sort(
    (left, right) => left.row - right.row || left.column - right.column || left.command.paintOrder - right.command.paintOrder
  );
  const unitsByRow = new Map<number, PaintedUnit[]>();
  for (const unit of visibleUnits) {
    const entries = unitsByRow.get(unit.row) ?? [];
    entries.push(unit);
    unitsByRow.set(unit.row, entries);
  }
  const root = list.layout.fragment(list.layout.root);
  const rootBottom = cssCoordinateAdd(root.overflowRect.y, root.overflowRect.height);
  const naturalRows = Math.max(1, Math.ceil(rootBottom / list.context.rowHeightCssPx));
  const rowCount = Math.min(naturalRows, budgets.maxRetainedCellBufferRows);
  if (naturalRows > budgets.maxRetainedCellBufferRows) {
    addTruncation(truncations, "maxRetainedCellBufferRows", budgets.maxRetainedCellBufferRows);
  }
  const rows: TerminalCellRow[] = [];
  let retainedTextSpans = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    input.signal?.throwIfAborted();
    const units = (unitsByRow.get(rowIndex) ?? []).sort((left, right) => left.column - right.column);
    let text = "";
    let column = 0;
    const cells: TerminalCell[] = [];
    const spans: TerminalCellSpan[] = [];
    const styles: TerminalCellStyleSpan[] = [];
    for (const unit of units) {
      const gap = Math.max(0, unit.column - column);
      if (gap > 0) {
        text += " ".repeat(gap);
        column += gap;
      }
      const startCodeUnit = text.length;
      text += unit.text;
      const endCodeUnit = text.length;
      const command = unit.command;
      cells.push(Object.freeze({
        column: unit.column,
        text: unit.text,
        width: unit.width,
        style: unit.actualStyle,
        command: command.id,
        layoutFragment: command.layoutFragment,
        formattingNode: command.formattingNode,
        documentNode: command.documentNode,
        paintOrder: command.paintOrder
      }));
      if (command.kind === "text") {
        const span: TerminalCellSpan = Object.freeze({
          command: command.id,
          layoutFragment: command.layoutFragment,
          formattingNode: command.formattingNode,
          documentNode: command.documentNode,
          sourceRange: unit.sourceRange,
          contentStartCodeUnit: unit.contentStartCodeUnit,
          contentEndCodeUnit: unit.contentEndCodeUnit,
          startCodeUnit,
          endCodeUnit,
          column: unit.column,
          width: unit.width
        });
        const previous = spans.at(-1);
        if (previous !== undefined && previous.command === span.command
          && safeAdd(previous.column, previous.width) === span.column
          && previous.endCodeUnit === span.startCodeUnit
          && previous.contentEndCodeUnit === span.contentStartCodeUnit) {
          spans[spans.length - 1] = Object.freeze({
            ...previous,
            sourceRange: previous.sourceRange === null || span.sourceRange === null
              ? previous.sourceRange ?? span.sourceRange
              : Object.freeze({
                  start: Math.min(previous.sourceRange.start, span.sourceRange.start),
                  end: Math.max(previous.sourceRange.end, span.sourceRange.end),
                  provenance: previous.sourceRange.provenance
                }),
            contentEndCodeUnit: span.contentEndCodeUnit,
            endCodeUnit: span.endCodeUnit,
            width: safeAdd(previous.width, span.width)
          });
        } else if (retainedTextSpans < budgets.maxRetainedSearchCellSpans) {
          spans.push(span);
          retainedTextSpans += 1;
        } else addTruncation(truncations, "maxRetainedSearchCellSpans", budgets.maxRetainedSearchCellSpans);
      }
      const previousStyle = styles.at(-1);
      if (previousStyle !== undefined && previousStyle.style === unit.actualStyle
        && previousStyle.endCodeUnit === startCodeUnit) {
        styles[styles.length - 1] = Object.freeze({ ...previousStyle, endCodeUnit });
      } else styles.push(Object.freeze({ startCodeUnit, endCodeUnit, style: unit.actualStyle }));
      column = safeAdd(unit.column, unit.width);
    }
    rows.push(Object.freeze({
      row: rowIndex,
      text,
      cells: Object.freeze(cells),
      spans: Object.freeze(spans),
      styles: Object.freeze(styles)
    }));
  }
  const outcome: TerminalCellBufferOutcome = truncations.length === 0
    ? { status: "complete", cells: ownerByPosition.size, rows: rows.length }
    : {
        status: "truncated",
        cells: ownerByPosition.size,
        rows: rows.length,
        truncations: Object.freeze([...truncations])
      };
  const buffer: TerminalCellBuffer = Object.freeze({
    columns: Math.min(list.context.columns, budgets.maxRetainedCellBufferColumns),
    viewportRows: list.context.rows,
    rows: Object.freeze(rows),
    outcome: Object.freeze(outcome)
  });
  return Object.freeze({ cellBuffer: buffer, truncations: Object.freeze(truncations) });
}

export function rasterizeTerminalCells(input: RasterizeTerminalDisplayListInput): TerminalCellRasterizationResult {
  try {
    return rasterizeTerminalCellsUnchecked(input);
  } catch (error) {
    if (error instanceof InvalidTerminalCellMeasurement) {
      return emptyCellRasterization(input.displayList, "invalid-cell-measurement");
    }
    throw error;
  }
}

export function buildTerminalIndexes(input: RasterizeTerminalDisplayListInput): TerminalIndexConstructionResult {
  const list = input.displayList;
  const budgets = terminalPaintBudgets(list.context.budgets);
  if (!validTerminalRenderContext(list.context) || budgets === null) {
    const geometry = new Map<DocumentNodeRef, DocumentCellGeometry>();
    return Object.freeze({
      hitTestIndex: new ImmutableHitTestIndex([]),
      focusMap: new ImmutableFocusMap([]),
      accessibilityBounds: Object.freeze([]),
      scrollAnchors: Object.freeze([]),
      truncations: Object.freeze([]),
      cellRectsForDocumentNode: (node: DocumentNodeRef): readonly TerminalCellRect[] => geometry.get(node)?.rects ?? []
    });
  }
  const truncations = initialTruncations(list, budgets);
  const indexes = geometryAndIndexes(list, budgets, input.signal, truncations);
  return Object.freeze({
    hitTestIndex: indexes.hitTestIndex,
    focusMap: indexes.focusMap,
    accessibilityBounds: indexes.accessibilityBounds,
    scrollAnchors: indexes.scrollAnchors,
    truncations: Object.freeze(truncations),
    cellRectsForDocumentNode: (node: DocumentNodeRef): readonly TerminalCellRect[] => indexes.geometry.get(node)?.rects ?? []
  });
}

export function rasterizeTerminalDisplayList(input: RasterizeTerminalDisplayListInput): TerminalRenderResult {
  const list = input.displayList;
  const budgets = terminalPaintBudgets(list.context.budgets);
  if (!validTerminalRenderContext(list.context)) return emptyRenderResult(list, input.textSearchIndex, "invalid-context");
  if (budgets === null) return emptyRenderResult(list, input.textSearchIndex, "invalid-budget");
  const cells = rasterizeTerminalCells(input);
  const indexes = buildTerminalIndexes(input);
  const truncations: TerminalTruncation[] = [];
  for (const entry of [...cells.truncations, ...indexes.truncations]) {
    addTruncation(truncations, entry.budget, entry.limit);
  }
  return new ImmutableTerminalRenderResult(
    list,
    input.textSearchIndex,
    cells.cellBuffer,
    indexes.hitTestIndex,
    indexes.focusMap,
    indexes.accessibilityBounds,
    indexes.scrollAnchors,
    (node) => indexes.cellRectsForDocumentNode(node),
    truncations,
    budgets
  );
}
