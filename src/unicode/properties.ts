import {
  BIDI_BRACKET_MAP,
  BIDI_BRACKET_CANONICAL_MAP,
  BIDI_CLASS_RANGES,
  BIDI_CLASS_VALUES,
  BIDI_DEFAULT_RANGES,
  BIDI_DEFAULT_VALUES,
  BIDI_MIRRORED_RANGES,
  BIDI_MIRRORING_MAP,
  EAST_ASIAN_WIDTH_RANGES,
  EAST_ASIAN_WIDTH_VALUES,
  EXTENDED_PICTOGRAPHIC_RANGES,
  GENERAL_CATEGORY_RANGES,
  GENERAL_CATEGORY_VALUES,
  GRAPHEME_BREAK_RANGES,
  GRAPHEME_BREAK_VALUES,
  INDIC_CONJUNCT_BREAK_RANGES,
  INDIC_CONJUNCT_BREAK_VALUES,
  LINE_BREAK_RANGES,
  LINE_BREAK_VALUES,
  UNICODE_VERSION
} from "./generated/unicode-17.js";

export { UNICODE_VERSION };

export type BidiClass = typeof BIDI_CLASS_VALUES[number];
export type GraphemeBreakClass = typeof GRAPHEME_BREAK_VALUES[number] | "Other";
export type IndicConjunctBreak = typeof INDIC_CONJUNCT_BREAK_VALUES[number] | "None";
export type LineBreakClass = typeof LINE_BREAK_VALUES[number] | "XX";
export type EastAsianWidth = typeof EAST_ASIAN_WIDTH_VALUES[number] | "N";
export type GeneralCategory = typeof GENERAL_CATEGORY_VALUES[number] | "Cn";
export type BidiBracketKind = "open" | "close";

export interface BidiPairedBracket {
  readonly pairedCodePoint: number;
  readonly kind: BidiBracketKind;
}

function validCodePoint(codePoint: number): boolean {
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff;
}

function rangeProperty<T extends string>(
  codePoint: number,
  ranges: readonly number[],
  values: readonly T[],
  fallback: T
): T {
  if (!validCodePoint(codePoint)) return fallback;
  let low = 0;
  let high = ranges.length / 3 - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * 3;
    const start = ranges[offset];
    const end = ranges[offset + 1];
    if (start === undefined || end === undefined) return fallback;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else {
      const value = values[ranges[offset + 2] ?? -1];
      return value ?? fallback;
    }
  }
  return fallback;
}

function containsRange(codePoint: number, ranges: readonly number[]): boolean {
  if (!validCodePoint(codePoint)) return false;
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * 2;
    const start = ranges[offset];
    const end = ranges[offset + 1];
    if (start === undefined || end === undefined) return false;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function mappedCodePoint(codePoint: number, entries: readonly number[], stride: number): number | null {
  if (!validCodePoint(codePoint)) return null;
  let low = 0;
  let high = entries.length / stride - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * stride;
    const candidate = entries[offset];
    if (candidate === undefined) return null;
    if (codePoint < candidate) high = middle - 1;
    else if (codePoint > candidate) low = middle + 1;
    else return entries[offset + 1] ?? null;
  }
  return null;
}

function uncachedBidiClass(codePoint: number): BidiClass {
  const explicit = rangeProperty(codePoint, BIDI_CLASS_RANGES, BIDI_CLASS_VALUES, "L");
  if (explicit !== "L" || containsRange(codePoint, BIDI_CLASS_RANGES)) return explicit;
  let fallback: BidiClass = "L";
  for (let index = 0; index < BIDI_DEFAULT_RANGES.length; index += 3) {
    const start = BIDI_DEFAULT_RANGES[index];
    const end = BIDI_DEFAULT_RANGES[index + 1];
    if (start === undefined || end === undefined || codePoint < start || codePoint > end) continue;
    fallback = BIDI_DEFAULT_VALUES[BIDI_DEFAULT_RANGES[index + 2] ?? -1] ?? fallback;
  }
  return fallback;
}

const ASCII_BIDI_CLASSES = Object.freeze(Array.from({ length: 128 }, (_, codePoint) => uncachedBidiClass(codePoint)));
const ASCII_GRAPHEME_BREAK_CLASSES = Object.freeze(Array.from(
  { length: 128 },
  (_, codePoint) => rangeProperty(codePoint, GRAPHEME_BREAK_RANGES, GRAPHEME_BREAK_VALUES, "Other" as const)
));
const ASCII_INDIC_CONJUNCT_BREAKS = Object.freeze(Array.from(
  { length: 128 },
  (_, codePoint) => rangeProperty(codePoint, INDIC_CONJUNCT_BREAK_RANGES, INDIC_CONJUNCT_BREAK_VALUES, "None" as const)
));
const ASCII_LINE_BREAK_CLASSES = Object.freeze(Array.from(
  { length: 128 },
  (_, codePoint) => rangeProperty(codePoint, LINE_BREAK_RANGES, LINE_BREAK_VALUES, "XX" as const)
));
const ASCII_EAST_ASIAN_WIDTHS = Object.freeze(Array.from(
  { length: 128 },
  (_, codePoint) => rangeProperty(codePoint, EAST_ASIAN_WIDTH_RANGES, EAST_ASIAN_WIDTH_VALUES, "N" as const)
));
const ASCII_GENERAL_CATEGORIES = Object.freeze(Array.from(
  { length: 128 },
  (_, codePoint) => rangeProperty(codePoint, GENERAL_CATEGORY_RANGES, GENERAL_CATEGORY_VALUES, "Cn" as const)
));

export function bidiClass(codePoint: number): BidiClass {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_BIDI_CLASSES.length) {
    return ASCII_BIDI_CLASSES[codePoint] ?? "L";
  }
  return uncachedBidiClass(codePoint);
}

export function graphemeBreakClass(codePoint: number): GraphemeBreakClass {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_GRAPHEME_BREAK_CLASSES.length) {
    return ASCII_GRAPHEME_BREAK_CLASSES[codePoint] ?? "Other";
  }
  return rangeProperty(codePoint, GRAPHEME_BREAK_RANGES, GRAPHEME_BREAK_VALUES, "Other");
}

export function indicConjunctBreak(codePoint: number): IndicConjunctBreak {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_INDIC_CONJUNCT_BREAKS.length) {
    return ASCII_INDIC_CONJUNCT_BREAKS[codePoint] ?? "None";
  }
  return rangeProperty(codePoint, INDIC_CONJUNCT_BREAK_RANGES, INDIC_CONJUNCT_BREAK_VALUES, "None");
}

export function lineBreakClass(codePoint: number): LineBreakClass {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_LINE_BREAK_CLASSES.length) {
    return ASCII_LINE_BREAK_CLASSES[codePoint] ?? "XX";
  }
  return rangeProperty(codePoint, LINE_BREAK_RANGES, LINE_BREAK_VALUES, "XX");
}

export function eastAsianWidth(codePoint: number): EastAsianWidth {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_EAST_ASIAN_WIDTHS.length) {
    return ASCII_EAST_ASIAN_WIDTHS[codePoint] ?? "N";
  }
  return rangeProperty(codePoint, EAST_ASIAN_WIDTH_RANGES, EAST_ASIAN_WIDTH_VALUES, "N");
}

export function generalCategory(codePoint: number): GeneralCategory {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < ASCII_GENERAL_CATEGORIES.length) {
    return ASCII_GENERAL_CATEGORIES[codePoint] ?? "Cn";
  }
  return rangeProperty(codePoint, GENERAL_CATEGORY_RANGES, GENERAL_CATEGORY_VALUES, "Cn");
}

export function isExtendedPictographic(codePoint: number): boolean {
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint < 128) return false;
  return containsRange(codePoint, EXTENDED_PICTOGRAPHIC_RANGES);
}

export function isBidiMirrored(codePoint: number): boolean {
  return containsRange(codePoint, BIDI_MIRRORED_RANGES);
}

export function bidiMirroringGlyph(codePoint: number): number | null {
  return mappedCodePoint(codePoint, BIDI_MIRRORING_MAP, 2);
}

export function bidiPairedBracket(codePoint: number): BidiPairedBracket | null {
  const paired = mappedCodePoint(codePoint, BIDI_BRACKET_MAP, 3);
  if (paired === null) return null;
  let low = 0;
  let high = BIDI_BRACKET_MAP.length / 3 - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * 3;
    const candidate = BIDI_BRACKET_MAP[offset];
    if (candidate === undefined) return null;
    if (codePoint < candidate) high = middle - 1;
    else if (codePoint > candidate) low = middle + 1;
    else return Object.freeze({
      pairedCodePoint: paired,
      kind: BIDI_BRACKET_MAP[offset + 2] === 1 ? "open" : "close"
    });
  }
  return null;
}

export function canonicalBidiBracket(codePoint: number): number {
  return mappedCodePoint(codePoint, BIDI_BRACKET_CANONICAL_MAP, 2) ?? codePoint;
}
