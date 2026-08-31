import {
  parseComponentValues,
  serializeCssComponentValues,
  type ComponentValue
} from "@ismail-elkorchi/css-parser";

import type {
  CssGridAutoFlow,
  CssGridLineNames,
  CssGridTemplate,
  CssGridTrackListEntry
} from "./types.js";
import { parseContentAlignment, parseSelfAlignment } from "../alignment.js";
import { parseGridPair } from "./shorthands.js";
import { parseGridAreaShorthand, parseGridAxisShorthand, parseGridLine, parseGridTemplateAreas } from "./placement-values.js";
import {
  parseGridAutoTracks,
  parseGridTrackList,
  parseGridTrackListComponents,
  parseGridTrackSizingFunction
} from "./track-list.js";

export const GRID_LONGHAND_PROPERTIES = Object.freeze(new Set([
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-template",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "grid-column", "grid-row", "grid-area",
  "justify-items", "align-items", "place-items", "justify-self", "align-self", "place-self",
  "justify-content", "align-content", "place-content", "row-gap", "column-gap", "gap"
]));

export function parseGridAutoFlow(source: string): CssGridAutoFlow | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const components = parsed.value.filter((value) => value.kind !== "whitespace");
  if (components.length < 1 || components.length > 2
    || components.some((value) => value.kind !== "ident")) return null;
  let axis: CssGridAutoFlow["axis"] | null = null;
  let packing: CssGridAutoFlow["packing"] = "sparse";
  for (const component of components) {
    if (component.kind !== "ident") return null;
    const keyword = component.value.toLowerCase();
    if (keyword === "row" || keyword === "column") {
      if (axis !== null) return null;
      axis = keyword;
    } else if (keyword === "dense") {
      if (packing === "dense") return null;
      packing = "dense";
    } else return null;
  }
  return Object.freeze({ axis: axis ?? "row", packing });
}

function splitSlash(values: readonly ComponentValue[]): readonly [readonly ComponentValue[], readonly ComponentValue[] | null] | null {
  const groups: ComponentValue[][] = [[]];
  for (const value of values) {
    if (value.kind === "delim" && value.value === 47) groups.push([]);
    else groups.at(-1)?.push(value);
  }
  return groups.length <= 2 && groups.every((group) => group.some((value) => value.kind !== "whitespace"))
    ? [groups[0] as readonly ComponentValue[], groups[1] ?? null]
    : null;
}

function templateTrackList(values: readonly ComponentValue[]): ReturnType<typeof parseGridTrackListComponents> {
  const significant = values.filter((value) => value.kind !== "whitespace");
  return significant.length === 1 && significant[0]?.kind === "ident"
    && significant[0].value.toLowerCase() === "none"
    ? Object.freeze({ kind: "none" })
    : parseGridTrackListComponents(values);
}

function shorthandLineNames(value: ComponentValue): CssGridLineNames | null {
  if (value.kind !== "simple-block" || value.associatedToken !== "open-square") return null;
  const names = value.value.filter((entry) => entry.kind !== "whitespace");
  const excluded = new Set(["auto", "span", "default", "initial", "inherit", "unset", "revert", "revert-layer"]);
  if (names.some((entry) => entry.kind !== "ident" || excluded.has(entry.value.toLowerCase()))) return null;
  return Object.freeze({
    kind: "line-names",
    names: Object.freeze(names.map((entry) => entry.kind === "ident" ? entry.value : ""))
  });
}

export function parseGridTemplateShorthand(source: string): CssGridTemplate | null {
  if (source.trim().toLowerCase() === "none") return Object.freeze({
    columns: Object.freeze({ kind: "none" }),
    rows: Object.freeze({ kind: "none" }),
    areas: Object.freeze({ kind: "none" })
  });
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const groups = splitSlash(parsed.value);
  if (groups === null) return null;
  const [rowValues, columnValues] = groups;
  const significantRows = rowValues.filter((value) => value.kind !== "whitespace");
  if (!significantRows.some((value) => value.kind === "string")) {
    if (columnValues === null) return null;
    const rows = templateTrackList(rowValues);
    const columns = templateTrackList(columnValues);
    return rows === null || columns === null
      ? null
      : Object.freeze({ rows, columns, areas: Object.freeze({ kind: "none" }) });
  }
  const columns = columnValues === null ? Object.freeze({ kind: "none" as const }) : templateTrackList(columnValues);
  if (columns === null) return null;
  // The ASCII-art form's row and column track listings use
  // <track-size>, not <track-repeat>. All repeat() forms are therefore
  // invalid here, including fixed repetitions.
  if (columns.kind === "track-list" && columns.entries.some((entry) => entry.kind === "repeat")) return null;
  const rowEntries: CssGridTrackListEntry[] = [];
  const areaRows: ComponentValue[] = [];
  let index = 0;
  while (index < significantRows.length) {
    while (significantRows[index]?.kind === "simple-block") {
      const names = shorthandLineNames(significantRows[index] as ComponentValue);
      if (names === null) return null;
      rowEntries.push(names);
      index += 1;
    }
    if (index === significantRows.length) break;
    const areaRow = significantRows[index];
    if (areaRow?.kind !== "string") return null;
    areaRows.push(areaRow);
    index += 1;
    const candidate = significantRows[index];
    if (candidate !== undefined && candidate.kind !== "string" && candidate.kind !== "simple-block") {
      const sizing = parseGridTrackSizingFunction(candidate);
      if (sizing === null) return null;
      rowEntries.push(Object.freeze({ kind: "track", sizing }));
      index += 1;
    } else {
      rowEntries.push(Object.freeze({
        kind: "track",
        sizing: Object.freeze({ kind: "breadth", breadth: Object.freeze({ kind: "auto" }) })
      }));
    }
  }
  const areas = parseGridTemplateAreas(serializeCssComponentValues(areaRows));
  return areas === null ? null : Object.freeze({
    columns,
    rows: Object.freeze({ kind: "track-list", entries: Object.freeze(rowEntries) }),
    areas
  });
}

export function gridPropertyValueSupported(property: string, value: string): boolean {
  switch (property) {
    case "grid-template-columns":
    case "grid-template-rows": return parseGridTrackList(value) !== null;
    case "grid-template-areas": return parseGridTemplateAreas(value) !== null;
    case "grid-template": return parseGridTemplateShorthand(value) !== null;
    case "grid-auto-columns":
    case "grid-auto-rows": return parseGridAutoTracks(value) !== null;
    case "grid-auto-flow": return parseGridAutoFlow(value) !== null;
    case "grid-column-start":
    case "grid-column-end":
    case "grid-row-start":
    case "grid-row-end": return parseGridLine(value) !== null;
    case "grid-column":
    case "grid-row": return parseGridAxisShorthand(value) !== null;
    case "grid-area": return parseGridAreaShorthand(value) !== null;
    case "justify-items": return parseSelfAlignment(value, false) !== null;
    case "align-items": return parseSelfAlignment(value, false) !== null;
    case "justify-self":
    case "align-self": return parseSelfAlignment(value, true) !== null;
    case "justify-content":
    case "align-content": return parseContentAlignment(value) !== null;
    case "place-items":
    case "place-self":
    case "place-content": {
      return property === "place-content"
        ? parseGridPair(value, parseContentAlignment) !== null
        : parseGridPair(value, (part) => parseSelfAlignment(part, property === "place-self")) !== null;
    }
    default: return false;
  }
}
