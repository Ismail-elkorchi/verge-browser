import type { DocumentNodeRef } from "../../document/index.js";
import type { LayoutFragmentId } from "../layout/index.js";
import { cssCoordinateFromFixed, cssIntersection, cssMultiply } from "../layout/index.js";
import type { TextSearchMatchId } from "../search/index.js";
import { terminalPaintBudgets, validTerminalRenderContext } from "./display-list.js";
import type {
  RasterizeTerminalDisplayListInput,
  TerminalAccessibilityBound,
  TerminalCell,
  TerminalCellBuffer,
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
  TerminalPaintCommand,
  TerminalRenderResult,
  TerminalScrollAnchor,
  TerminalSearchMatch,
  TerminalSearchRange,
  TerminalSearchResult,
  TerminalStyle
} from "./types.js";

interface PaintUnit {
  readonly command: TerminalPaintCommand;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly text: string;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
}

interface DocumentCellGeometry {
  readonly layoutFragments: readonly LayoutFragmentId[];
  readonly rects: readonly TerminalCellRect[];
}

function cellRect(
  row: number,
  column: number,
  width: number,
  height: number
): TerminalCellRect {
  return Object.freeze({
    row: Math.trunc(row), column: Math.trunc(column),
    width: Math.max(0, Math.trunc(width)), height: Math.max(0, Math.trunc(height))
  });
}

function intersection(left: TerminalCellRect, right: TerminalCellRect): TerminalCellRect {
  const row = Math.max(left.row, right.row);
  const column = Math.max(left.column, right.column);
  const bottom = Math.min(left.row + left.height, right.row + right.height);
  const edge = Math.min(left.column + left.width, right.column + right.width);
  return cellRect(row, column, Math.max(0, edge - column), Math.max(0, bottom - row));
}

function union(rectangles: readonly TerminalCellRect[]): TerminalCellRect | null {
  if (rectangles.length === 0) return null;
  const row = Math.min(...rectangles.map((value) => value.row));
  const column = Math.min(...rectangles.map((value) => value.column));
  const bottom = Math.max(...rectangles.map((value) => value.row + value.height));
  const edge = Math.max(...rectangles.map((value) => value.column + value.width));
  return cellRect(row, column, edge - column, bottom - row);
}

const ANSI_16 = Object.freeze([
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
] as const);

function terminalColor(
  color: NonNullable<TerminalPaintCommand["style"]["foreground"]> | null,
  depth: TerminalDisplayList["context"]["colorDepth"]
): NonNullable<TerminalStyle["foreground"]> | null {
  if (color === null || color.a <= 0 || depth === 0) return null;
  if (depth === 24) return Object.freeze({ r: color.r, g: color.g, b: color.b, a: 1 });
  if (depth === 8) {
    const levels = [0, 95, 135, 175, 215, 255] as const;
    const nearest = (component: number): number => levels.reduce(
      (best, candidate) => Math.abs(candidate - component) < Math.abs(best - component) ? candidate : best,
      levels[0]
    );
    return Object.freeze({ r: nearest(color.r), g: nearest(color.g), b: nearest(color.b), a: 1 });
  }
  const nearest = ANSI_16.reduce((best, candidate) => {
    const distance = (candidate[0] - color.r) ** 2 + (candidate[1] - color.g) ** 2 + (candidate[2] - color.b) ** 2;
    const bestDistance = (best[0] - color.r) ** 2 + (best[1] - color.g) ** 2 + (best[2] - color.b) ** 2;
    return distance < bestDistance ? candidate : best;
  }, ANSI_16[0]);
  return Object.freeze({ r: nearest[0], g: nearest[1], b: nearest[2], a: 1 });
}

function terminalStyle(command: TerminalPaintCommand, depth: TerminalDisplayList["context"]["colorDepth"]): TerminalStyle {
  return Object.freeze({
    foreground: terminalColor(command.kind === "border" ? command.style.borderColor : command.style.foreground, depth),
    background: terminalColor(command.style.background, depth),
    bold: command.style.bold,
    italic: command.style.italic,
    underline: command.style.underline,
    strikethrough: command.style.strikethrough
  });
}

function snapRect(command: TerminalPaintCommand, list: TerminalDisplayList): TerminalCellRect {
  const clipped = cssIntersection(command.rect, command.clipRect);
  const cellWidth = list.context.cellWidthCssPx;
  const rowHeight = list.context.rowHeightCssPx;
  const column = Math.floor(clipped.x / cellWidth);
  const row = Math.floor(clipped.y / rowHeight);
  const edge = Math.ceil((clipped.x + clipped.width) / cellWidth);
  const bottom = Math.ceil((clipped.y + clipped.height) / rowHeight);
  return intersection(
    cellRect(row, column, edge - column, bottom - row),
    cellRect(0, 0, list.context.columns, Number.MAX_SAFE_INTEGER)
  );
}

function textUnits(command: Extract<TerminalPaintCommand, { readonly kind: "text" }>, list: TerminalDisplayList): readonly PaintUnit[] {
  const clip = snapRect(command, list);
  const row = Math.floor(command.rect.y / list.context.rowHeightCssPx);
  const graphemes = list.context.cellMeasurer.graphemes(command.text);
  const measuredCells = graphemes.reduce((total, grapheme) => total + grapheme.cells, 0);
  let consumedCells = 0;
  const units: PaintUnit[] = [];
  for (const grapheme of graphemes) {
    const cssStart = cssCoordinateFromFixed(
      command.rect.x + cssMultiply(command.rect.width, consumedCells / Math.max(1, measuredCells))
    );
    const start = Math.floor(cssStart / list.context.cellWidthCssPx);
    const end = start + grapheme.cells;
    consumedCells += grapheme.cells;
    if (grapheme.cells <= 0 || row < clip.row || row >= clip.row + clip.height
      || start < clip.column || end > clip.column + clip.width) continue;
    units.push(Object.freeze({
      command, row, column: start, width: grapheme.cells, text: grapheme.text,
      startCodeUnit: grapheme.startCodeUnit, endCodeUnit: grapheme.endCodeUnit
    }));
  }
  return units;
}

function borderUnits(command: Extract<TerminalPaintCommand, { readonly kind: "border" }>, list: TerminalDisplayList): readonly PaintUnit[] {
  const box = snapRect(command, list);
  if (box.width <= 0 || box.height <= 0) return [];
  const horizontal = list.context.unicode ? "─" : "-";
  const vertical = list.context.unicode ? "│" : "|";
  const topLeft = list.context.unicode ? "┌" : "+";
  const topRight = list.context.unicode ? "┐" : "+";
  const bottomLeft = list.context.unicode ? "└" : "+";
  const bottomRight = list.context.unicode ? "┘" : "+";
  const units: PaintUnit[] = [];
  const add = (row: number, column: number, text: string): void => {
    units.push(Object.freeze({ command, row, column, width: 1, text, startCodeUnit: 0, endCodeUnit: text.length }));
  };
  for (let column = box.column; column < box.column + box.width; column += 1) {
    if (command.borderWidths.top > 0) {
      add(box.row, column, column === box.column ? topLeft : column === box.column + box.width - 1 ? topRight : horizontal);
    }
    if (box.height > 1 && command.borderWidths.bottom > 0) {
      add(box.row + box.height - 1, column, column === box.column ? bottomLeft : column === box.column + box.width - 1 ? bottomRight : horizontal);
    }
  }
  for (let row = box.row + 1; row < box.row + box.height - 1; row += 1) {
    if (command.borderWidths.left > 0) add(row, box.column, vertical);
    if (box.width > 1 && command.borderWidths.right > 0) add(row, box.column + box.width - 1, vertical);
  }
  return units;
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
      if (region !== undefined && row >= region.rect.row && row < region.rect.row + region.rect.height
        && column >= region.rect.column && column < region.rect.column + region.rect.width) return region;
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
  readonly #documentGeometry: ReadonlyMap<DocumentNodeRef, DocumentCellGeometry>;
  readonly #spansByFragment: ReadonlyMap<LayoutFragmentId, readonly { readonly row: number; readonly span: TerminalCellSpan }[]>;
  readonly #searchCache = new Map<string, TerminalSearchResult>();
  readonly #maxSearchMatches: number;

  public constructor(
    displayList: TerminalDisplayList,
    cellBuffer: TerminalCellBuffer,
    hitTestIndex: TerminalHitTestIndex,
    focusMap: TerminalFocusMap,
    accessibilityBounds: readonly TerminalAccessibilityBound[],
    scrollAnchors: readonly TerminalScrollAnchor[],
    documentGeometry: ReadonlyMap<DocumentNodeRef, DocumentCellGeometry>
  ) {
    this.layout = displayList.layout;
    this.displayList = displayList;
    this.cellBuffer = cellBuffer;
    this.hitTestIndex = hitTestIndex;
    this.focusMap = focusMap;
    this.accessibilityBounds = Object.freeze([...accessibilityBounds]);
    this.scrollAnchors = Object.freeze([...scrollAnchors]);
    this.#documentGeometry = documentGeometry;
    this.#maxSearchMatches = terminalPaintBudgets(displayList.context.budgets).maxSearchMatches;
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
    return this.#documentGeometry.get(node)?.rects ?? [];
  }

  public search(query: string): TerminalSearchResult {
    const bounded = query.slice(0, 1_024);
    const cached = this.#searchCache.get(bounded);
    if (cached !== undefined) return cached;
    const indexed = this.layout.searchIndex.search(bounded, this.#maxSearchMatches);
    const spans = this.layout.searchSpans(bounded, this.#maxSearchMatches);
    const byMatch = new Map<TextSearchMatchId, TerminalSearchRange[]>();
    for (const layoutSpan of spans) {
      for (const entry of this.#spansByFragment.get(layoutSpan.fragment) ?? []) {
        const cellSpan = entry.span;
        if (cellSpan.contentStartCodeUnit === null || cellSpan.contentEndCodeUnit === null
          || layoutSpan.contentStartCodeUnit >= cellSpan.contentEndCodeUnit
          || layoutSpan.contentEndCodeUnit <= cellSpan.contentStartCodeUnit) continue;
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
      truncated: indexed.truncated
    });
    if (this.#searchCache.size >= 8) {
      const oldest = this.#searchCache.keys().next().value;
      if (oldest !== undefined) this.#searchCache.delete(oldest);
    }
    this.#searchCache.set(bounded, result);
    return result;
  }
}

function geometryForUnits(
  list: TerminalDisplayList,
  visibleUnits: readonly PaintUnit[]
): ReadonlyMap<DocumentNodeRef, DocumentCellGeometry> {
  const geometry = new Map<DocumentNodeRef, DocumentCellGeometry>();
  for (const unit of visibleUnits) {
    let node = unit.command.documentNode;
    while (node !== null) {
      const current = geometry.get(node);
      geometry.set(node, {
        layoutFragments: current?.layoutFragments.includes(unit.command.layoutFragment) === true
          ? current.layoutFragments : [...(current?.layoutFragments ?? []), unit.command.layoutFragment],
        rects: [...(current?.rects ?? []), cellRect(unit.row, unit.column, unit.width, 1)]
      });
      node = list.layout.formatting.document.parent(node)?.ref ?? null;
    }
  }
  const pending = [list.layout.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) continue;
    const fragment = list.layout.fragment(id);
    pending.push(...fragment.children);
    if (!fragment.style.visible || fragment.documentNode === null || fragment.semantic === null
      || geometry.has(fragment.documentNode)) continue;
    geometry.set(fragment.documentNode, {
      layoutFragments: [fragment.id],
      rects: [cellRect(
        Math.floor(fragment.borderRect.y / list.context.rowHeightCssPx),
        Math.floor(fragment.borderRect.x / list.context.cellWidthCssPx),
        0,
        0
      )]
    });
  }
  return new Map([...geometry].map(([node, value]) => [node, Object.freeze({
    layoutFragments: Object.freeze(value.layoutFragments),
    rects: Object.freeze(value.rects)
  })]));
}

function interactionIndexes(
  list: TerminalDisplayList,
  visibleUnits: readonly PaintUnit[],
  geometry: ReadonlyMap<DocumentNodeRef, DocumentCellGeometry>
): {
  readonly hitTestIndex: TerminalHitTestIndex;
  readonly focusMap: TerminalFocusMap;
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
} {
  const hitRegions: TerminalHitRegion[] = [];
  const actionUnits = new Map<string, PaintUnit[]>();
  for (const unit of visibleUnits) {
    if (unit.command.action === null) continue;
    const key = `${unit.command.action.kind}:${unit.command.action.node}:${unit.command.id}`;
    const entries = actionUnits.get(key) ?? [];
    entries.push(unit);
    actionUnits.set(key, entries);
  }
  for (const units of actionUnits.values()) {
    const sorted = [...units].sort((left, right) => left.row - right.row || left.column - right.column);
    let start = sorted[0];
    let width = start?.width ?? 0;
    for (let index = 1; index <= sorted.length; index += 1) {
      const next = sorted[index];
      if (start !== undefined && next !== undefined && next.row === start.row && next.column === start.column + width) {
        width += next.width;
        continue;
      }
      if (start !== undefined && start.command.action !== null) {
        hitRegions.push(Object.freeze({
          action: start.command.action,
          layoutFragment: start.command.layoutFragment,
          rect: cellRect(start.row, start.column, width, 1)
        }));
      }
      start = next;
      width = next?.width ?? 0;
    }
  }
  const focusByNode = new Map<DocumentNodeRef, { action: NonNullable<TerminalPaintCommand["action"]>; fragments: LayoutFragmentId[]; rects: TerminalCellRect[] }>();
  for (const hit of hitRegions) {
    const current = focusByNode.get(hit.action.node) ?? { action: hit.action, fragments: [], rects: [] };
    current.fragments.push(hit.layoutFragment);
    current.rects.push(hit.rect);
    focusByNode.set(hit.action.node, current);
  }
  const targets = [...focusByNode].map(([node, value]): TerminalFocusTarget => Object.freeze({
    node,
    action: value.action,
    layoutFragments: Object.freeze(value.fragments),
    rects: Object.freeze(value.rects),
    label: list.layout.formatting.document.semantic(node)?.accessibleName || "Action"
  }));
  const accessibilityBounds: TerminalAccessibilityBound[] = [];
  const scrollAnchors: TerminalScrollAnchor[] = [];
  for (const [node, value] of geometry) {
    const semantic = list.layout.formatting.document.semantic(node);
    const documentNode = list.layout.formatting.document.node(node);
    if (documentNode.kind !== "element" || semantic === null || semantic.accessibilityHidden) continue;
    const style = list.layout.formatting.styles.style(node);
    if (style.display.box === "none" || style.visibility !== "visible") continue;
    const rect = union(value.rects);
    if (rect === null) continue;
    accessibilityBounds.push(Object.freeze({
      documentNode: node,
      layoutFragments: Object.freeze(value.layoutFragments),
      role: semantic.role,
      name: semantic.accessibleName,
      description: semantic.accessibleDescription,
      rect
    }));
    scrollAnchors.push(Object.freeze({
      id: `terminal-scroll-anchor:${node}`,
      documentNode: node,
      layoutFragment: value.layoutFragments[0] ?? list.layout.root,
      row: rect.row
    }));
  }
  return {
    hitTestIndex: new ImmutableHitTestIndex(hitRegions),
    focusMap: new ImmutableFocusMap(targets),
    accessibilityBounds: Object.freeze(accessibilityBounds),
    scrollAnchors: Object.freeze(scrollAnchors)
  };
}

export function rasterizeTerminalDisplayList(input: RasterizeTerminalDisplayListInput): TerminalRenderResult {
  const list = input.displayList;
  const budgets = terminalPaintBudgets(list.context.budgets);
  if (!validTerminalRenderContext(list.context)) {
    const buffer: TerminalCellBuffer = Object.freeze({
      columns: Math.max(0, list.context.columns), viewportRows: Math.max(0, list.context.rows),
      rows: Object.freeze([]), outcome: Object.freeze({ status: "rejected", reason: "invalid-context" })
    });
    return new ImmutableTerminalRenderResult(
      list, buffer, new ImmutableHitTestIndex([]), new ImmutableFocusMap([]), [], [], new Map()
    );
  }
  const ownerByPosition = new Map<string, PaintUnit>();
  let paintedCells = 0;
  let truncated = false;
  for (const command of list.commands) {
    list.context.signal?.throwIfAborted();
    const units = command.kind === "text" ? textUnits(command, list) : borderUnits(command, list);
    for (const unit of units) {
      if (paintedCells + unit.width > budgets.maxPaintCells) { truncated = true; break; }
      for (let cell = unit.column; cell < unit.column + unit.width; cell += 1) {
        ownerByPosition.set(`${String(unit.row)}:${String(cell)}`, unit);
      }
      paintedCells += unit.width;
    }
    if (truncated) break;
  }
  const visibleUnits = [...new Set(ownerByPosition.values())].filter((unit) => {
    for (let cell = unit.column; cell < unit.column + unit.width; cell += 1) {
      if (ownerByPosition.get(`${String(unit.row)}:${String(cell)}`) !== unit) return false;
    }
    return true;
  }).sort((left, right) => left.row - right.row || left.column - right.column || left.command.paintOrder - right.command.paintOrder);
  const unitsByRow = new Map<number, PaintUnit[]>();
  for (const unit of visibleUnits) {
    const entries = unitsByRow.get(unit.row) ?? [];
    entries.push(unit);
    unitsByRow.set(unit.row, entries);
  }
  const root = list.layout.fragment(list.layout.root);
  const rootRows = Math.max(1, Math.ceil((root.overflowRect.y + root.overflowRect.height) / list.context.rowHeightCssPx));
  const paintedRows = visibleUnits.reduce((maximum, unit) => Math.max(maximum, unit.row + 1), 1);
  const rowCount = Math.max(rootRows, paintedRows);
  const rows: TerminalCellRow[] = [];
  const actualStyles = new Map<string, TerminalStyle>();
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const units = (unitsByRow.get(rowIndex) ?? []).sort((left, right) => left.column - right.column);
    let text = "";
    let column = 0;
    const cells: TerminalCell[] = [];
    const spans: TerminalCellSpan[] = [];
    const styles: TerminalCellStyleSpan[] = [];
    for (const unit of units) {
      const gap = Math.max(0, unit.column - column);
      if (gap > 0) { text += " ".repeat(gap); column += gap; }
      const startCodeUnit = text.length;
      text += unit.text;
      const endCodeUnit = text.length;
      const command = unit.command;
      let style = actualStyles.get(command.id);
      if (style === undefined) {
        style = terminalStyle(command, list.context.colorDepth);
        actualStyles.set(command.id, style);
      }
      cells.push(Object.freeze({
        column: unit.column, text: unit.text, width: unit.width, style,
        command: command.id, layoutFragment: command.layoutFragment,
        formattingNode: command.formattingNode, documentNode: command.documentNode,
        paintOrder: command.paintOrder
      }));
      let sourceRange = command.sourceRange;
      if (sourceRange !== null && command.kind === "text"
        && sourceRange.end - sourceRange.start === command.text.length) {
        sourceRange = Object.freeze({
          start: sourceRange.start + unit.startCodeUnit,
          end: sourceRange.start + unit.endCodeUnit,
          provenance: sourceRange.provenance
        });
      }
      const exactContentRange = command.kind === "text"
        && command.contentStartCodeUnit !== null
        && command.contentEndCodeUnit !== null
        && command.contentEndCodeUnit - command.contentStartCodeUnit === command.text.length;
      const span: TerminalCellSpan = Object.freeze({
        command: command.id,
        layoutFragment: command.layoutFragment,
        formattingNode: command.formattingNode,
        documentNode: command.documentNode,
        sourceRange,
        contentStartCodeUnit: command.contentStartCodeUnit === null ? null
          : exactContentRange ? command.contentStartCodeUnit + unit.startCodeUnit : command.contentStartCodeUnit,
        contentEndCodeUnit: command.contentEndCodeUnit === null ? null
          : exactContentRange ? command.contentStartCodeUnit + unit.endCodeUnit : command.contentEndCodeUnit,
        startCodeUnit,
        endCodeUnit,
        column: unit.column,
        width: unit.width
      });
      const previousSpan = spans.at(-1);
      if (previousSpan !== undefined && previousSpan.command === span.command
        && previousSpan.column + previousSpan.width === span.column
        && previousSpan.endCodeUnit === span.startCodeUnit
        && previousSpan.contentEndCodeUnit === span.contentStartCodeUnit) {
        spans[spans.length - 1] = Object.freeze({
          ...previousSpan,
          sourceRange: previousSpan.sourceRange === null || span.sourceRange === null
            ? previousSpan.sourceRange ?? span.sourceRange
            : Object.freeze({
                start: Math.min(previousSpan.sourceRange.start, span.sourceRange.start),
                end: Math.max(previousSpan.sourceRange.end, span.sourceRange.end),
                provenance: previousSpan.sourceRange.provenance
              }),
          contentEndCodeUnit: span.contentEndCodeUnit,
          endCodeUnit: span.endCodeUnit,
          width: previousSpan.width + span.width
        });
      } else spans.push(span);
      const previousStyle = styles.at(-1);
      if (previousStyle !== undefined && previousStyle.style === style
        && previousStyle.endCodeUnit === startCodeUnit) {
        styles[styles.length - 1] = Object.freeze({ ...previousStyle, endCodeUnit });
      } else styles.push(Object.freeze({ startCodeUnit, endCodeUnit, style }));
      column = unit.column + unit.width;
    }
    rows.push(Object.freeze({
      row: rowIndex, text, cells: Object.freeze(cells), spans: Object.freeze(spans), styles: Object.freeze(styles)
    }));
  }
  const outcome: TerminalCellBufferOutcome = truncated
    ? { status: "truncated", cells: paintedCells, rows: rows.length, budget: "maxPaintCells", limit: budgets.maxPaintCells }
    : { status: "complete", cells: paintedCells, rows: rows.length };
  const buffer: TerminalCellBuffer = Object.freeze({
    columns: list.context.columns,
    viewportRows: list.context.rows,
    rows: Object.freeze(rows),
    outcome: Object.freeze(outcome)
  });
  const geometry = geometryForUnits(list, visibleUnits);
  const indexes = interactionIndexes(list, visibleUnits, geometry);
  return new ImmutableTerminalRenderResult(
    list, buffer, indexes.hitTestIndex, indexes.focusMap,
    indexes.accessibilityBounds, indexes.scrollAnchors, geometry
  );
}
