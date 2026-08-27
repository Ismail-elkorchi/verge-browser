import {
  parseComponentValues,
  type ComponentValue
} from "@ismail-elkorchi/css-parser";

import {
  GRID_AUTO_LINE,
  type CssGridAreaBounds,
  type CssGridLine,
  type CssGridPlacement,
  type CssGridTemplateAreas
} from "./types.js";

const CSS_WIDE = new Set(["initial", "inherit", "unset", "revert", "revert-layer", "default", "span", "auto"]);

function compact(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

function ident(value: ComponentValue): string | null {
  if (value.kind !== "ident") return null;
  return CSS_WIDE.has(value.value.toLowerCase()) ? null : value.value;
}

export function parseGridLineComponents(values: readonly ComponentValue[]): CssGridLine | null {
  const significant = compact(values);
  if (significant.length === 1 && significant[0]?.kind === "ident"
    && significant[0].value.toLowerCase() === "auto") return GRID_AUTO_LINE;
  let span = false;
  let index: number | null = null;
  let name: string | null = null;
  for (const value of significant) {
    if (value.kind === "ident" && value.value.toLowerCase() === "span") {
      if (span) return null;
      span = true;
      continue;
    }
    if (value.kind === "number" && Number.isSafeInteger(value.value)) {
      if (index !== null || value.value === 0 || (span && value.value < 1)) return null;
      index = value.value;
      continue;
    }
    const candidate = ident(value);
    if (candidate === null || name !== null) return null;
    name = candidate;
  }
  if (significant.length === 0 || (index === null && name === null) || (span && (index ?? 1) < 1)) return null;
  return Object.freeze({ kind: "line", span, index: span && index === null ? 1 : index, name });
}

export function parseGridLine(source: string): CssGridLine | null {
  const parsed = parseComponentValues(source);
  return parsed.ok ? parseGridLineComponents(parsed.value) : null;
}

function slashGroups(values: readonly ComponentValue[]): readonly (readonly ComponentValue[])[] | null {
  const groups: ComponentValue[][] = [[]];
  for (const value of values) {
    if (value.kind === "delim" && value.value === 47) groups.push([]);
    else groups.at(-1)?.push(value);
  }
  return groups.length <= 4 && groups.every((group) => compact(group).length > 0) ? groups : null;
}

function copiedLine(source: CssGridLine): CssGridLine {
  return source.kind === "line" && !source.span && source.index === null && source.name !== null
    ? source
    : GRID_AUTO_LINE;
}

export function parseGridAxisShorthand(source: string): readonly [CssGridLine, CssGridLine] | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const groups = slashGroups(parsed.value);
  if (groups === null || groups.length > 2) return null;
  const start = parseGridLineComponents(groups[0] as readonly ComponentValue[]);
  const end = groups.length === 1 ? (start === null ? null : copiedLine(start))
    : parseGridLineComponents(groups[1] as readonly ComponentValue[]);
  return start === null || end === null ? null : Object.freeze([start, end]);
}

export function parseGridAreaShorthand(source: string): CssGridPlacement | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const groups = slashGroups(parsed.value);
  if (groups === null) return null;
  const rowStart = parseGridLineComponents(groups[0] as readonly ComponentValue[]);
  if (rowStart === null) return null;
  const columnStart = groups[1] === undefined ? copiedLine(rowStart) : parseGridLineComponents(groups[1]);
  const rowEnd = groups[2] === undefined ? copiedLine(rowStart) : parseGridLineComponents(groups[2]);
  const columnEnd = groups[3] === undefined
    ? (columnStart === null ? null : copiedLine(columnStart))
    : parseGridLineComponents(groups[3]);
  return columnStart === null || rowEnd === null || columnEnd === null ? null : Object.freeze({
    columnStart,
    columnEnd,
    rowStart,
    rowEnd
  });
}

export function parseGridTemplateAreas(source: string): CssGridTemplateAreas | null {
  if (source.trim().toLowerCase() === "none") return Object.freeze({ kind: "none" });
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const components = compact(parsed.value);
  if (components.length === 0 || components.some((value) => value.kind !== "string")) return null;
  const rows: (string | null)[][] = [];
  const cellsInRow = (value: string): readonly (string | null)[] | null => {
    const codePoints = Array.from(value);
    const cells: (string | null)[] = [];
    const whitespace = (codePoint: string): boolean =>
      codePoint === " " || codePoint === "\t" || codePoint === "\n"
      || codePoint === "\r" || codePoint === "\f";
    const identCodePoint = (codePoint: string): boolean => {
      const value = codePoint.codePointAt(0);
      return value !== undefined && (
        value >= 0x80
        || (value >= 0x41 && value <= 0x5a)
        || (value >= 0x61 && value <= 0x7a)
        || (value >= 0x30 && value <= 0x39)
        || value === 0x2d
        || value === 0x5f
      );
    };
    let index = 0;
    while (index < codePoints.length) {
      const first = codePoints[index] as string;
      if (whitespace(first)) {
        index += 1;
        continue;
      }
      if (first === ".") {
        while (codePoints[index] === ".") index += 1;
        cells.push(null);
        continue;
      }
      if (!identCodePoint(first)) return null;
      let name = "";
      while (index < codePoints.length && identCodePoint(codePoints[index] as string)) {
        name += codePoints[index] as string;
        index += 1;
      }
      cells.push(name);
    }
    return cells.length === 0 ? null : Object.freeze(cells);
  };
  for (const component of components) {
    if (component.kind !== "string") return null;
    const row = cellsInRow(component.value);
    if (row === null) return null;
    rows.push([...row]);
  }
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) return null;
  const bounds = new Map<string, CssGridAreaBounds>();
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const name = rows[row]?.[column];
      if (name === null || name === undefined) continue;
      const previous = bounds.get(name);
      bounds.set(name, Object.freeze({
        name,
        rowStart: Math.min(previous?.rowStart ?? row, row),
        rowEnd: Math.max(previous?.rowEnd ?? row + 1, row + 1),
        columnStart: Math.min(previous?.columnStart ?? column, column),
        columnEnd: Math.max(previous?.columnEnd ?? column + 1, column + 1)
      }));
    }
  }
  for (const area of bounds.values()) {
    for (let row = area.rowStart; row < area.rowEnd; row += 1) {
      for (let column = area.columnStart; column < area.columnEnd; column += 1) {
        if (rows[row]?.[column] !== area.name) return null;
      }
    }
  }
  return Object.freeze({
    kind: "areas",
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    areas: bounds
  });
}
