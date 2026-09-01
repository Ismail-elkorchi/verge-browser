import type { DocumentSourceRange } from "../../document/index.js";
import {
  cssCoordinateAdd,
  cssIntersection,
  cssLengthFromFixed,
  type CssRect
} from "../layout/index.js";
import { terminalPaintBudgets, validTerminalRenderContext } from "./display-list.js";
import type {
  RasterizeViewportDisplayListInput,
  TerminalCell,
  ViewportCellBufferOutcome,
  TerminalCellRect,
  TerminalCellRow,
  TerminalCellSpan,
  TerminalCellStyleSpan,
  DocumentDisplayList,
  TerminalPaintBudgets,
  TerminalPaintCommand,
  TerminalStyle,
  TerminalTruncation,
  ViewportCellBuffer,
  ViewportCellRasterizationResult
} from "./types.js";

type RasterizationDisplayList = Pick<DocumentDisplayList,
  "layout" | "context" | "fragmentPaintOrder" | "commands" | "outcome">;

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

function snapCssRect(rect: CssRect, clip: CssRect, list: RasterizationDisplayList, budgets: TerminalPaintBudgets): TerminalCellRect {
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

function snapUnclippedCssRect(rect: CssRect, list: RasterizationDisplayList): TerminalCellRect {
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

function textClip(command: Extract<TerminalPaintCommand, { readonly kind: "text" }>, list: RasterizationDisplayList, budgets: TerminalPaintBudgets): TerminalCellRect {
  return snapCssRect(command.clipRect, command.clipRect, list, budgets);
}

interface PaintUnitGenerationState {
  readonly limit: number;
  generated: number;
  truncated: boolean;
}

function cancellationCheckpoint(
  state: PaintUnitGenerationState,
  signal: AbortSignal | undefined,
): void {
  if ((state.generated & 255) === 0) signal?.throwIfAborted();
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
  list: RasterizationDisplayList,
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
    cancellationCheckpoint(generation, signal);
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
    yield {
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
    };
  }
  if (previousCodeUnit !== command.text.length) throw new InvalidTerminalCellMeasurement();
}

function* backgroundUnits(
  command: Extract<TerminalPaintCommand, { readonly kind: "background" }>,
  list: RasterizationDisplayList,
  budgets: TerminalPaintBudgets,
  generation: PaintUnitGenerationState,
  signal: AbortSignal | undefined
): Generator<PaintUnit> {
  const box = snapCssRect(command.rect, command.clipRect, list, budgets);
  for (let row = box.row; row < safeAdd(box.row, box.height); row += 1) {
    for (let column = box.column; column < safeAdd(box.column, box.width); column += 1) {
      if (!reservePaintUnit(generation)) return;
      cancellationCheckpoint(generation, signal);
      yield {
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
      };
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
  list: RasterizationDisplayList,
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
    cancellationCheckpoint(generation, signal);
    const glyph = borderGlyph(command, whole, row, column, list.context.unicode);
    return {
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
    };
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
  list: RasterizationDisplayList,
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

function terminalColor(color: TerminalColor | null, depth: RasterizationDisplayList["context"]["colorDepth"]): TerminalColor | null {
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

function actualStyle(command: TerminalPaintCommand, under: PaintedUnit | undefined, depth: RasterizationDisplayList["context"]["colorDepth"]): TerminalStyle {
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

function addTruncation(truncations: TerminalTruncation[], budget: TerminalTruncation["budget"], limit: number): void {
  if (truncations.some((entry) => entry.budget === budget)) return;
  truncations.push(Object.freeze({ budget, limit }));
}

function initialTruncations(list: RasterizationDisplayList, budgets: TerminalPaintBudgets): TerminalTruncation[] {
  const truncations: TerminalTruncation[] = [];
  if (list.outcome.status === "truncated") {
    addTruncation(truncations, list.outcome.budget, list.outcome.limit);
  }
  if (list.context.columns > budgets.maxRetainedCellBufferColumns) {
    addTruncation(truncations, "maxRetainedCellBufferColumns", budgets.maxRetainedCellBufferColumns);
  }
  return truncations;
}

function viewportLocalCommand(command: TerminalPaintCommand, blockOffset: number): TerminalPaintCommand {
  const move = (rect: CssRect): CssRect => Object.freeze({
    ...rect,
    y: cssCoordinateAdd(rect.y, cssLengthFromFixed(-blockOffset))
  });
  const moved = {
    ...command,
    rect: move(command.rect),
    clipRect: move(command.clipRect)
  };
  return command.kind === "border-side"
    ? Object.freeze({ ...moved, borderRect: move(command.borderRect) })
    : Object.freeze(moved);
}

function rejectedViewportBuffer(
  input: RasterizeViewportDisplayListInput,
  reason: "invalid-context" | "invalid-budget" | "invalid-cell-measurement"
): ViewportCellRasterizationResult {
  const list = input.displayList;
  const start = Math.max(0, list.window.scrollRow - list.window.overscanBefore);
  return Object.freeze({
    cellBuffer: Object.freeze({
      columns: Math.max(0, safeInteger(list.context.columns)),
      documentRowCount: 0,
      windowStartRow: start,
      viewportRows: Math.max(0, safeInteger(list.window.viewportRows)),
      overscanBefore: list.window.scrollRow - start,
      overscanAfter: list.window.overscanAfter,
      rows: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason })
    }),
    truncations: Object.freeze([])
  });
}

/** Rasterizes only the selected viewport and overscan commands into numeric row buckets. */
export function rasterizeViewportDisplayList(
  input: RasterizeViewportDisplayListInput
): ViewportCellRasterizationResult {
  const viewport = input.displayList;
  const budgets = terminalPaintBudgets(viewport.context.budgets);
  if (!validTerminalRenderContext(viewport.context)) return rejectedViewportBuffer(input, "invalid-context");
  if (budgets === null) return rejectedViewportBuffer(input, "invalid-budget");
  const windowStartRow = Math.max(0, viewport.window.scrollRow - viewport.window.overscanBefore);
  const overscanBefore = viewport.window.scrollRow - windowStartRow;
  const requestedRows = viewport.window.viewportRows + overscanBefore + viewport.window.overscanAfter;
  const rowCount = Math.min(requestedRows, budgets.maxRetainedCellBufferRows);
  const blockOffset = windowStartRow * viewport.context.rowHeightCssPx;
  const localCommands = viewport.commands.map((command) => viewportLocalCommand(command, blockOffset));
  const localList: RasterizationDisplayList = Object.freeze({
    layout: viewport.documentDisplayList.layout,
    context: Object.freeze({ ...viewport.context, rows: Math.max(1, rowCount) }),
    fragmentPaintOrder: viewport.documentDisplayList.fragmentPaintOrder,
    commands: Object.freeze(localCommands),
    outcome: viewport.outcome
  });
  const truncations = initialTruncations(localList, budgets);
  if (requestedRows > budgets.maxRetainedCellBufferRows) {
    addTruncation(truncations, "maxRetainedCellBufferRows", budgets.maxRetainedCellBufferRows);
  }
  const owners: (PaintedUnit | undefined)[][] = Array.from({ length: rowCount }, () => []);
  const terminalStyles = new Map<TerminalPaintCommand, Map<TerminalStyle | null, TerminalStyle>>();
  const styleFor = (command: TerminalPaintCommand, under: PaintedUnit | undefined): TerminalStyle => {
    const byUnder = terminalStyles.get(command) ?? new Map<TerminalStyle | null, TerminalStyle>();
    terminalStyles.set(command, byUnder);
    const underStyle = under?.actualStyle ?? null;
    const retained = byUnder.get(underStyle);
    if (retained !== undefined) return retained;
    const style = actualStyle(command, under, localList.context.colorDepth);
    byUnder.set(underStyle, style);
    return style;
  };
  let generatedUnits = 0;
  let retainedCells = 0;
  let paintStopped = false;
  try {
    for (const command of localList.commands) {
      input.signal?.throwIfAborted();
      const generation: PaintUnitGenerationState = {
        limit: Math.max(0, budgets.maxGeneratedPaintUnits - generatedUnits),
        generated: 0,
        truncated: false
      };
      for (const unit of unitsFor(command, localList, budgets, generation, input.signal)) {
        if (!unit.visible || unit.row < 0 || unit.row >= rowCount
          || unit.column < 0 || safeAdd(unit.column, unit.width) > budgets.maxRetainedCellBufferColumns) continue;
        const row = owners[unit.row];
        if (row === undefined) continue;
        const collided: PaintedUnit[] = [];
        for (let column = unit.column; column < safeAdd(unit.column, unit.width); column += 1) {
          const previous = row[column];
          if (previous !== undefined && !collided.includes(previous)) collided.push(previous);
        }
        let removed = 0;
        for (const previous of collided) {
          for (let column = previous.column; column < safeAdd(previous.column, previous.width); column += 1) {
            if (row[column] === previous) {
              row[column] = undefined;
              removed += 1;
            }
          }
        }
        let added = 0;
        for (let column = unit.column; column < safeAdd(unit.column, unit.width); column += 1) {
          if (row[column] === undefined) added += 1;
        }
        if (retainedCells - removed + added > budgets.maxRetainedPaintCells) {
          addTruncation(truncations, "maxRetainedPaintCells", budgets.maxRetainedPaintCells);
          paintStopped = true;
          break;
        }
        const under = collided[0];
        const painted: PaintedUnit = {
          ...unit,
          actualStyle: styleFor(command, under)
        };
        for (let column = unit.column; column < safeAdd(unit.column, unit.width); column += 1) row[column] = painted;
        retainedCells = retainedCells - removed + added;
      }
      generatedUnits += generation.generated;
      if (!paintStopped && generation.truncated) {
        addTruncation(truncations, "maxGeneratedPaintUnits", budgets.maxGeneratedPaintUnits);
        paintStopped = true;
      }
      if (paintStopped) break;
    }
  } catch (error) {
    if (error instanceof InvalidTerminalCellMeasurement) return rejectedViewportBuffer(input, "invalid-cell-measurement");
    throw error;
  }
  const rows: TerminalCellRow[] = [];
  let retainedTextSpans = 0;
  for (let localRow = 0; localRow < rowCount; localRow += 1) {
    input.signal?.throwIfAborted();
    const visibleUnits = [...new Set((owners[localRow] ?? []).filter((unit): unit is PaintedUnit => unit !== undefined))]
      .sort((left, right) => left.column - right.column || left.command.paintOrder - right.command.paintOrder);
    let text = "";
    let column = 0;
    const cells: TerminalCell[] = [];
    const spans: TerminalCellSpan[] = [];
    const styles: TerminalCellStyleSpan[] = [];
    for (const unit of visibleUnits) {
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
          action: command.action,
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
      row: windowStartRow + localRow,
      text,
      cells: Object.freeze(cells),
      spans: Object.freeze(spans),
      styles: Object.freeze(styles)
    }));
  }
  const root = localList.layout.fragment(localList.layout.root);
  const rootBottom = cssCoordinateAdd(root.overflowRect.y, root.overflowRect.height);
  const documentRowCount = Math.max(1, Math.ceil(rootBottom / localList.context.rowHeightCssPx));
  const outcome: ViewportCellBufferOutcome = truncations.length === 0
    ? { status: "complete", cells: retainedCells, rows: rows.length }
    : {
        status: "truncated",
        cells: retainedCells,
        rows: rows.length,
        truncations: Object.freeze([...truncations])
      };
  const cellBuffer: ViewportCellBuffer = Object.freeze({
    columns: Math.min(localList.context.columns, budgets.maxRetainedCellBufferColumns),
    documentRowCount,
    windowStartRow,
    viewportRows: viewport.window.viewportRows,
    overscanBefore,
    overscanAfter: Math.max(0, rowCount - viewport.window.viewportRows - overscanBefore),
    rows: Object.freeze(rows),
    outcome: Object.freeze(outcome)
  });
  return Object.freeze({ cellBuffer, truncations: Object.freeze(truncations) });
}
