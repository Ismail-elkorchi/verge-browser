import type { ComponentValue } from "@ismail-elkorchi/css-parser";
import { parseCssLengthComponents } from "./css-values.js";
import type { ComputedStyle, CssLength } from "./types.js";

export type FontSizeValue = CssLength | { readonly kind: "keyword"; readonly value: string };
export type FontWeightValue = number | "bolder" | "lighter";
export interface FontShorthandValue {
  readonly weight: FontWeightValue;
  readonly style: ComputedStyle["text"]["fontStyle"];
  readonly size: FontSizeValue;
  readonly lineHeight: ComputedStyle["text"]["lineHeight"];
}

const SIZE_KEYWORDS = new Set([
  "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large", "smaller", "larger",
]);
const RESERVED_FAMILIES = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "cursive", "fantasy", "monospace", "system-ui", "emoji", "math", "fangsong",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
]);

export function fontSizeValue(values: readonly ComponentValue[]): FontSizeValue | null {
  const significant = values.filter((value) => value.kind !== "whitespace");
  const first = significant[0];
  if (significant.length === 1 && first?.kind === "ident" && SIZE_KEYWORDS.has(first.value.toLowerCase())) {
    return Object.freeze({ kind: "keyword", value: first.value.toLowerCase() });
  }
  return parseCssLengthComponents(significant, { allowAuto: false });
}

export function lineHeightValue(values: readonly ComponentValue[]): ComputedStyle["text"]["lineHeight"] | null {
  const significant = values.filter((value) => value.kind !== "whitespace");
  const first = significant[0];
  if (significant.length === 1 && first?.kind === "ident" && first.value.toLowerCase() === "normal") {
    return Object.freeze({ kind: "normal" });
  }
  if (significant.length === 1 && first?.kind === "number") {
    return first.value >= 0 && Number.isFinite(first.value) ? Object.freeze({ kind: "number", value: first.value }) : null;
  }
  const length = parseCssLengthComponents(significant, { allowAuto: false });
  return length === null ? null : Object.freeze({ kind: "length", value: length });
}

function familySupported(values: readonly ComponentValue[]): boolean {
  let group: ComponentValue[] = [];
  const validGroup = (): boolean => {
    if (group.length === 1 && group[0]?.kind === "string") return true;
    return group.length > 0 && group.every((item) => item.kind === "ident"
      && !RESERVED_FAMILIES.has(item.value.toLowerCase())
      && (group.length === 1 || !GENERIC_FAMILIES.has(item.value.toLowerCase())));
  };
  for (const value of values) {
    if (value.kind === "comma") {
      if (!validGroup()) return false;
      group = [];
    } else group.push(value);
  }
  return validGroup();
}

/** A bounded terminal font subset. Family syntax is validated without selecting a terminal font. */
export function fontShorthandValue(values: readonly ComponentValue[]): FontShorthandValue | null {
  // Declaration limits bound the input; cap family work as well before allocating a compact copy.
  if (values.length > 4096) return null;
  const significant = values.filter((value) => value.kind !== "whitespace");
  let style: FontShorthandValue["style"] = "normal";
  let weight: FontWeightValue = 400;
  let styleSeen = false;
  let weightSeen = false;
  let normalCount = 0;
  let cursor = 0;
  let size: FontSizeValue | null = null;
  for (; cursor < significant.length; cursor += 1) {
    const component = significant[cursor];
    if (component === undefined) return null;
    size = fontSizeValue([component]);
    if (size !== null) break;
    const word = component.kind === "ident" ? component.value.toLowerCase() : "";
    if (word === "normal") { normalCount += 1; continue; }
    if (word === "italic" || word === "oblique") {
      if (styleSeen) return null;
      styleSeen = true;
      style = word;
    } else if (word === "bold" || word === "bolder" || word === "lighter"
      || (component.kind === "number" && component.value >= 1 && component.value <= 1000)) {
      if (weightSeen) return null;
      weightSeen = true;
      weight = component.kind === "number" ? component.value : word === "bold" ? 700 : word as "bolder" | "lighter";
    } else return null; // System fonts, variants, stretch and angled oblique are outside the modeled subset.
    if (cursor >= 4) return null;
  }
  if (size === null || normalCount + Number(styleSeen) + Number(weightSeen) > 4) return null;
  cursor += 1;
  let lineHeight: FontShorthandValue["lineHeight"] = Object.freeze({ kind: "normal" });
  const next = significant[cursor];
  if (next?.kind === "delim" && next.value === 47) {
    const component = significant[cursor + 1];
    if (component === undefined) return null;
    const parsed = lineHeightValue([component]);
    if (parsed === null) return null;
    lineHeight = parsed;
    cursor += 2;
  }
  if (!familySupported(significant.slice(cursor))) return null;
  return Object.freeze({ weight, style, size, lineHeight });
}
