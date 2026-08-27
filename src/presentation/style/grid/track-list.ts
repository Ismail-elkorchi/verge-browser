import {
  parseComponentValues,
  serializeCssComponentValues,
  type ComponentValue,
  type CssFunction
} from "@ismail-elkorchi/css-parser";

import { parseCssLength } from "../css-values.js";
import type {
  CssGridAutoTrackList,
  CssGridLineNames,
  CssGridRepeatEntry,
  CssGridTrackBreadth,
  CssGridTrackEntry,
  CssGridTrackList,
  CssGridTrackListEntry,
  CssGridTrackSizingFunction
} from "./types.js";

const CSS_WIDE = new Set(["initial", "inherit", "unset", "revert", "revert-layer", "default", "auto", "span"]);

function compact(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

function customIdent(value: ComponentValue): string | null {
  if (value.kind !== "ident") return null;
  const name = value.value;
  return CSS_WIDE.has(name.toLowerCase()) ? null : name;
}

function lineNames(value: ComponentValue): CssGridLineNames | null {
  if (value.kind !== "simple-block" || value.associatedToken !== "open-square") return null;
  const names = compact(value.value).map(customIdent);
  if (names.some((name) => name === null)) return null;
  return Object.freeze({ kind: "line-names", names: Object.freeze(names as string[]) });
}

function splitArguments(value: CssFunction): readonly (readonly ComponentValue[])[] | null {
  const result: ComponentValue[][] = [[]];
  for (const component of value.value) {
    if (component.kind === "comma") result.push([]);
    else result.at(-1)?.push(component);
  }
  return result.some((part) => compact(part).length === 0) ? null : result.map(compact);
}

function length(component: ComponentValue): ReturnType<typeof parseCssLength> {
  return parseCssLength(serializeCssComponentValues([component]), { allowNegative: false });
}

export function parseGridTrackBreadth(component: ComponentValue): CssGridTrackBreadth | null {
  if (component.kind === "ident") {
    const keyword = component.value.toLowerCase();
    if (keyword === "auto" || keyword === "min-content" || keyword === "max-content") {
      return Object.freeze({ kind: keyword });
    }
  }
  if (component.kind === "dimension" && component.unit.toLowerCase() === "fr") {
    return Number.isFinite(component.value) && component.value >= 0
      ? Object.freeze({ kind: "flex", factor: component.value })
      : null;
  }
  const parsed = length(component);
  return parsed === null ? null : Object.freeze({ kind: "length", value: parsed });
}

export function parseGridTrackSizingFunction(component: ComponentValue): CssGridTrackSizingFunction | null {
  if (component.kind === "function-block") {
    const name = component.name.toLowerCase();
    const argumentsList = splitArguments(component);
    if (name === "minmax") {
      if (argumentsList?.length !== 2) return null;
      const minimumValue = argumentsList[0];
      const maximumValue = argumentsList[1];
      if (minimumValue?.length !== 1 || maximumValue?.length !== 1) return null;
      const minimum = parseGridTrackBreadth(minimumValue[0] as ComponentValue);
      const maximum = parseGridTrackBreadth(maximumValue[0] as ComponentValue);
      if (minimum === null || maximum === null || minimum.kind === "flex") return null;
      return Object.freeze({ kind: "minmax", minimum, maximum });
    }
    if (name === "fit-content") {
      if (argumentsList?.length !== 1 || argumentsList[0]?.length !== 1) return null;
      const limit = length(argumentsList[0][0] as ComponentValue);
      return limit === null ? null : Object.freeze({ kind: "fit-content", limit });
    }
    return null;
  }
  const breadth = parseGridTrackBreadth(component);
  return breadth === null ? null : Object.freeze({ kind: "breadth", breadth });
}

function fixedBreadth(breadth: CssGridTrackBreadth): boolean {
  return breadth.kind === "length";
}

function fixedTrack(sizing: CssGridTrackSizingFunction): boolean {
  if (sizing.kind === "breadth") return fixedBreadth(sizing.breadth);
  if (sizing.kind === "fit-content") return false;
  return fixedBreadth(sizing.minimum) || fixedBreadth(sizing.maximum);
}

function parseRepeat(component: CssFunction): CssGridRepeatEntry | null {
  const argumentsList = splitArguments(component);
  if (argumentsList?.length !== 2) return null;
  const repetitionValues = argumentsList[0];
  const repeatedValues = argumentsList[1];
  if (repetitionValues?.length !== 1 || repeatedValues === undefined) return null;
  const repetitionValue = repetitionValues[0] as ComponentValue;
  let repetition: CssGridRepeatEntry["repetition"];
  if (repetitionValue.kind === "number" && Number.isSafeInteger(repetitionValue.value) && repetitionValue.value > 0) {
    repetition = Object.freeze({ kind: "fixed", count: repetitionValue.value });
  } else if (repetitionValue.kind === "ident"
    && (repetitionValue.value.toLowerCase() === "auto-fill" || repetitionValue.value.toLowerCase() === "auto-fit")) {
    repetition = Object.freeze({ kind: repetitionValue.value.toLowerCase() as "auto-fill" | "auto-fit" });
  } else return null;
  const entries = parseTrackEntries(repeatedValues, false);
  if (entries === null || !entries.some((entry) => entry.kind === "track")) return null;
  if (repetition.kind !== "fixed"
    && entries.some((entry) => entry.kind === "track" && !fixedTrack(entry.sizing))) return null;
  return Object.freeze({ kind: "repeat", repetition, entries });
}

function parseTrackEntries(
  values: readonly ComponentValue[],
  allowRepeat: boolean
): readonly (CssGridLineNames | CssGridTrackEntry)[] | null {
  const entries: (CssGridLineNames | CssGridTrackEntry)[] = [];
  for (const component of compact(values)) {
    const names = lineNames(component);
    if (names !== null) {
      entries.push(names);
      continue;
    }
    if (component.kind === "function-block" && component.name.toLowerCase() === "repeat") {
      if (!allowRepeat) return null;
      return null;
    }
    const sizing = parseGridTrackSizingFunction(component);
    if (sizing === null) return null;
    entries.push(Object.freeze({ kind: "track", sizing }));
  }
  return entries;
}

export function parseGridTrackList(source: string): CssGridTrackList | null {
  if (source.trim().toLowerCase() === "none") return Object.freeze({ kind: "none" });
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  return parseGridTrackListComponents(parsed.value);
}

export function parseGridTrackListComponents(values: readonly ComponentValue[]): CssGridTrackList | null {
  const entries: CssGridTrackListEntry[] = [];
  let autoRepeatCount = 0;
  for (const component of compact(values)) {
    const names = lineNames(component);
    if (names !== null) {
      entries.push(names);
      continue;
    }
    if (component.kind === "function-block" && component.name.toLowerCase() === "repeat") {
      const repeat = parseRepeat(component);
      if (repeat === null) return null;
      if (repeat.repetition.kind !== "fixed") autoRepeatCount += 1;
      if (autoRepeatCount > 1) return null;
      entries.push(repeat);
      continue;
    }
    const sizing = parseGridTrackSizingFunction(component);
    if (sizing === null) return null;
    entries.push(Object.freeze({ kind: "track", sizing }));
  }
  if (autoRepeatCount > 0 && entries.some((entry) => {
    if (entry.kind === "line-names") return false;
    if (entry.kind === "track") return !fixedTrack(entry.sizing);
    return entry.repetition.kind === "fixed"
      && entry.entries.some((repeated) => repeated.kind === "track" && !fixedTrack(repeated.sizing));
  })) return null;
  if (!entries.some((entry) => entry.kind === "track" || entry.kind === "repeat")) return null;
  return Object.freeze({ kind: "track-list", entries: Object.freeze(entries) });
}

export function parseGridAutoTracks(source: string): CssGridAutoTrackList | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const values = compact(parsed.value);
  if (values.length === 0) return null;
  const result = values.map(parseGridTrackSizingFunction);
  return result.some((entry) => entry === null)
    ? null
    : Object.freeze(result as CssGridTrackSizingFunction[]);
}
