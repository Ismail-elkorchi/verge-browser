import { segmentGraphemeClusters } from "./grapheme.js";
import {
  eastAsianWidth,
  generalCategory,
  isExtendedPictographic,
  lineBreakClass,
  type GeneralCategory,
  type LineBreakClass
} from "./unicode-properties.js";

export type BreakOpportunityKind = "prohibited" | "allowed" | "mandatory";
export type CssLineBreak = "auto" | "normal" | "anywhere";
export type CssWordBreak = "normal" | "break-all" | "keep-all";
export type CssOverflowWrap = "normal" | "anywhere" | "break-word";
export type CssHyphens = "none" | "manual";

export interface BreakOpportunity {
  readonly codePointIndex: number;
  readonly codeUnitOffset: number;
  readonly kind: BreakOpportunityKind;
  readonly rule: string;
}

export interface LineBreakTailoring {
  readonly lineBreak: CssLineBreak;
  readonly wordBreak: CssWordBreak;
  readonly overflowWrap: CssOverflowWrap;
  readonly hyphens: CssHyphens;
  readonly language: string | null;
  readonly preserveGraphemeClusters: boolean;
}

export interface LineBreakBoundary {
  readonly codePointIndex: number;
  readonly codeUnitOffset: number;
}

export type LineBreakTailoringInput = Partial<LineBreakTailoring>
  | ((boundary: LineBreakBoundary) => Partial<LineBreakTailoring>);

export interface LineBreakBudgets {
  readonly maxBreakOpportunities: number;
}

export interface LineBreakConstructionOptions extends Partial<LineBreakBudgets> {
  /** Optional sorted UTF-16 boundaries from an already established UAX #29 cluster stream. */
  readonly graphemeClusterBoundaries?: readonly number[];
}

export type LineBreakOutcome =
  | { readonly status: "complete"; readonly opportunities: number }
  | {
      readonly status: "truncated";
      readonly opportunities: number;
      readonly budget: "maxBreakOpportunities";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-budget" | "invalid-grapheme-boundary-map" };

export interface LineBreakMap {
  readonly value: string;
  readonly opportunities: readonly BreakOpportunity[];
  readonly outcome: LineBreakOutcome;
  atCodePoint(index: number): BreakOpportunity | null;
  atCodeUnit(offset: number): BreakOpportunity | null;
}

interface LineUnit {
  readonly codePoint: number;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly original: LineBreakClass;
  readonly resolved: LineBreakClass;
  readonly effective: LineBreakClass;
  readonly category: GeneralCategory;
  readonly eastAsian: boolean;
  readonly extendedPictographic: boolean;
  readonly absorbedCombiningMark: boolean;
  readonly baseIndex: number;
}

const DEFAULT_TAILORING: LineBreakTailoring = Object.freeze({
  lineBreak: "auto",
  wordBreak: "normal",
  overflowWrap: "normal",
  hyphens: "manual",
  language: null,
  preserveGraphemeClusters: false
});

const HARD_BREAKS = new Set<LineBreakClass>(["BK", "CR", "LF", "NL"]);
const LETTERS = new Set<LineBreakClass>(["AL", "HL"]);
const HANGUL = new Set<LineBreakClass>(["JL", "JV", "JT", "H2", "H3"]);
const BRAHMIC_BASE = new Set<LineBreakClass>(["AK", "AS"]);
const EAST_ASIAN_WIDTHS = new Set(["F", "W", "H"]);

function resolvedClass(original: LineBreakClass, category: GeneralCategory): LineBreakClass {
  if (original === "AI" || original === "SG" || original === "XX") return "AL";
  if (original === "CJ") return "NS";
  if (original === "SA") return category === "Mn" || category === "Mc" ? "CM" : "AL";
  return original;
}

function lineUnits(
  value: string,
  maximumUnits: number,
  signal: AbortSignal | undefined
): { readonly units: readonly LineUnit[]; readonly complete: boolean } {
  const provisional: Omit<LineUnit, "effective" | "absorbedCombiningMark" | "baseIndex">[] = [];
  let offset = 0;
  for (const character of value) {
    if (provisional.length >= maximumUnits) break;
    signal?.throwIfAborted();
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const original = lineBreakClass(codePoint);
    const category = generalCategory(codePoint);
    provisional.push(Object.freeze({
      codePoint,
      startCodeUnit: offset,
      endCodeUnit: offset + character.length,
      original,
      resolved: resolvedClass(original, category),
      category,
      eastAsian: EAST_ASIAN_WIDTHS.has(eastAsianWidth(codePoint)),
      extendedPictographic: isExtendedPictographic(codePoint)
    }));
    offset += character.length;
  }
  const units: LineUnit[] = [];
  for (let index = 0; index < provisional.length; index += 1) {
    const entry = provisional[index];
    if (entry === undefined) continue;
    const before = units[index - 1];
    const combining = entry.resolved === "CM" || entry.resolved === "ZWJ";
    const absorbed = combining && before !== undefined
      && !HARD_BREAKS.has(before.resolved)
      && before.resolved !== "SP" && before.resolved !== "ZW";
    units.push(Object.freeze({
      ...entry,
      effective: absorbed ? before.effective : combining ? "AL" : entry.resolved,
      absorbedCombiningMark: absorbed,
      baseIndex: absorbed ? before.baseIndex : index
    }));
  }
  return Object.freeze({ units: Object.freeze(units), complete: offset === value.length });
}

function previousClass(units: readonly LineUnit[], index: number): LineBreakClass | "sot" {
  return index < 0 ? "sot" : units[index]?.effective ?? "sot";
}

function nextClass(units: readonly LineUnit[], index: number): LineBreakClass | "eot" {
  return index >= units.length ? "eot" : units[index]?.effective ?? "eot";
}

function representative(units: readonly LineUnit[], index: number): LineUnit | undefined {
  const unit = units[index];
  return unit === undefined ? undefined : units[unit.baseIndex] ?? unit;
}

function isInitialQuote(units: readonly LineUnit[], index: number): boolean {
  const unit = units[index];
  return unit?.effective === "QU" && representative(units, index)?.category === "Pi";
}

function isFinalQuote(units: readonly LineUnit[], index: number): boolean {
  const unit = units[index];
  return unit?.effective === "QU" && representative(units, index)?.category === "Pf";
}

interface LineBoundaryContext {
  readonly priorNonSpace: readonly number[];
  readonly priorNonNumericSeparator: readonly number[];
  readonly precedingRegionalIndicators: readonly number[];
}

function boundaryContext(units: readonly LineUnit[]): LineBoundaryContext {
  const priorNonSpace: number[] = [];
  const priorNonNumericSeparator: number[] = [];
  const precedingRegionalIndicators: number[] = [];
  let nonSpace = -1;
  let nonNumericSeparator = -1;
  let regionalIndicators = 0;
  for (let boundary = 0; boundary < units.length; boundary += 1) {
    priorNonSpace.push(nonSpace);
    priorNonNumericSeparator.push(nonNumericSeparator);
    precedingRegionalIndicators.push(regionalIndicators);
    const unit = units[boundary];
    if (unit === undefined) continue;
    if (unit.effective !== "SP") nonSpace = boundary;
    if (unit.effective !== "SY" && unit.effective !== "IS") nonNumericSeparator = boundary;
    if (unit.effective === "RI") {
      if (unit.baseIndex === boundary) regionalIndicators += 1;
    } else regionalIndicators = 0;
  }
  priorNonSpace.push(nonSpace);
  priorNonNumericSeparator.push(nonNumericSeparator);
  precedingRegionalIndicators.push(regionalIndicators);
  return Object.freeze({
    priorNonSpace: Object.freeze(priorNonSpace),
    priorNonNumericSeparator: Object.freeze(priorNonNumericSeparator),
    precedingRegionalIndicators: Object.freeze(precedingRegionalIndicators)
  });
}

function defaultOpportunity(
  units: readonly LineUnit[],
  boundary: number,
  context: LineBoundaryContext
): Omit<BreakOpportunity, "codePointIndex" | "codeUnitOffset"> {
  if (boundary === 0) return { kind: "prohibited", rule: "LB2" };
  if (boundary === units.length) return { kind: "mandatory", rule: "LB3" };
  const left = units[boundary - 1];
  const right = units[boundary];
  if (left === undefined || right === undefined) return { kind: "prohibited", rule: "LB2" };
  const before = left.effective;
  const after = right.effective;
  const leftRepresentative = representative(units, boundary - 1) ?? left;
  const rightRepresentative = representative(units, boundary) ?? right;
  if (before === "BK") return { kind: "mandatory", rule: "LB4" };
  if (left.original === "CR" && right.original === "LF") return { kind: "prohibited", rule: "LB5" };
  if (before === "CR" || before === "LF" || before === "NL") return { kind: "mandatory", rule: "LB5" };
  if (HARD_BREAKS.has(after)) return { kind: "prohibited", rule: "LB6" };
  if (after === "SP" || after === "ZW") return { kind: "prohibited", rule: "LB7" };
  const nonSpace = context.priorNonSpace[boundary] ?? -1;
  if (units[nonSpace]?.effective === "ZW") return { kind: "allowed", rule: "LB8" };
  if (left.original === "ZWJ") return { kind: "prohibited", rule: "LB8a" };
  if (right.absorbedCombiningMark) return { kind: "prohibited", rule: "LB9" };
  if (before === "WJ" || after === "WJ") return { kind: "prohibited", rule: "LB11" };
  if (before === "GL") return { kind: "prohibited", rule: "LB12" };
  if (after === "GL" && before !== "SP" && before !== "BA" && before !== "HY" && before !== "HH") {
    return { kind: "prohibited", rule: "LB12a" };
  }
  if (after === "CL" || after === "CP" || after === "EX" || after === "SY") {
    return { kind: "prohibited", rule: "LB13" };
  }
  if (units[nonSpace]?.effective === "OP") return { kind: "prohibited", rule: "LB14" };
  const quoteContext = previousClass(units, nonSpace - 1);
  if (isInitialQuote(units, nonSpace) && (quoteContext === "sot" || HARD_BREAKS.has(quoteContext)
    || quoteContext === "OP" || quoteContext === "QU" || quoteContext === "GL"
    || quoteContext === "SP" || quoteContext === "ZW")) return { kind: "prohibited", rule: "LB15a" };
  const afterRight = nextClass(units, boundary + 1);
  if (isFinalQuote(units, boundary) && (afterRight === "eot" || afterRight === "SP" || afterRight === "GL"
    || afterRight === "WJ" || afterRight === "CL" || afterRight === "QU" || afterRight === "CP"
    || afterRight === "EX" || afterRight === "IS" || afterRight === "SY" || afterRight === "ZW"
    || HARD_BREAKS.has(afterRight))) return { kind: "prohibited", rule: "LB15b" };
  if (before === "SP" && after === "IS" && nextClass(units, boundary + 1) === "NU") {
    return { kind: "allowed", rule: "LB15c" };
  }
  if (after === "IS") return { kind: "prohibited", rule: "LB15d" };
  if (after === "NS" && (units[nonSpace]?.effective === "CL" || units[nonSpace]?.effective === "CP")) {
    return { kind: "prohibited", rule: "LB16" };
  }
  if (after === "B2" && units[nonSpace]?.effective === "B2") return { kind: "prohibited", rule: "LB17" };
  if (before === "SP") return { kind: "allowed", rule: "LB18" };
  if (after === "QU" && rightRepresentative.category !== "Pi") return { kind: "prohibited", rule: "LB19" };
  if (before === "QU" && leftRepresentative.category !== "Pf") return { kind: "prohibited", rule: "LB19" };
  if (after === "QU") {
    const afterQuote = representative(units, boundary + 1);
    if (!leftRepresentative.eastAsian || afterQuote === undefined || !afterQuote.eastAsian) {
      return { kind: "prohibited", rule: "LB19a" };
    }
  }
  if (before === "QU") {
    const beforeQuote = representative(units, left.baseIndex - 1);
    if (!rightRepresentative.eastAsian || beforeQuote === undefined || !beforeQuote.eastAsian) {
      return { kind: "prohibited", rule: "LB19a" };
    }
  }
  if (before === "CB" || after === "CB") return { kind: "allowed", rule: "LB20" };
  const wordInitialContext = previousClass(units, left.baseIndex - 1);
  if ((before === "HY" || before === "HH") && (after === "AL" || after === "HL")
    && (wordInitialContext === "sot" || HARD_BREAKS.has(wordInitialContext) || wordInitialContext === "SP"
      || wordInitialContext === "ZW" || wordInitialContext === "CB" || wordInitialContext === "GL")) {
    return { kind: "prohibited", rule: "LB20a" };
  }
  if (after === "BA" || after === "HH" || after === "HY" || after === "NS" || before === "BB") {
    return { kind: "prohibited", rule: "LB21" };
  }
  if ((before === "HY" || before === "HH") && after !== "HL" && previousClass(units, left.baseIndex - 1) === "HL") {
    return { kind: "prohibited", rule: "LB21a" };
  }
  if (before === "SY" && after === "HL") return { kind: "prohibited", rule: "LB21b" };
  if (after === "IN") return { kind: "prohibited", rule: "LB22" };
  if ((LETTERS.has(before) && after === "NU") || (before === "NU" && LETTERS.has(after))) {
    return { kind: "prohibited", rule: "LB23" };
  }
  if ((before === "PR" && (after === "ID" || after === "EB" || after === "EM"))
    || ((before === "ID" || before === "EB" || before === "EM") && after === "PO")) {
    return { kind: "prohibited", rule: "LB23a" };
  }
  if (((before === "PR" || before === "PO") && LETTERS.has(after))
    || (LETTERS.has(before) && (after === "PR" || after === "PO"))) {
    return { kind: "prohibited", rule: "LB24" };
  }
  if (after === "PO" || after === "PR") {
    let cursor = boundary - 1;
    if (units[cursor]?.effective === "CL" || units[cursor]?.effective === "CP") {
      cursor = context.priorNonNumericSeparator[cursor] ?? -1;
    } else cursor = context.priorNonNumericSeparator[boundary] ?? -1;
    if (units[cursor]?.effective === "NU") return { kind: "prohibited", rule: "LB25" };
  }
  if (before === "PO" || before === "PR") {
    if (after === "NU" || (after === "OP" && (nextClass(units, boundary + 1) === "NU"
      || (nextClass(units, boundary + 1) === "IS" && nextClass(units, boundary + 2) === "NU")))) {
      return { kind: "prohibited", rule: "LB25" };
    }
  }
  if ((before === "HY" || before === "IS") && after === "NU") return { kind: "prohibited", rule: "LB25" };
  if (after === "NU") {
    const cursor = context.priorNonNumericSeparator[boundary] ?? -1;
    if (units[cursor]?.effective === "NU") return { kind: "prohibited", rule: "LB25" };
  }
  if ((before === "JL" && (after === "JL" || after === "JV" || after === "H2" || after === "H3"))
    || ((before === "JV" || before === "H2") && (after === "JV" || after === "JT"))
    || ((before === "JT" || before === "H3") && after === "JT")) {
    return { kind: "prohibited", rule: "LB26" };
  }
  if ((HANGUL.has(before) && after === "PO") || (before === "PR" && HANGUL.has(after))) {
    return { kind: "prohibited", rule: "LB27" };
  }
  if (LETTERS.has(before) && LETTERS.has(after)) return { kind: "prohibited", rule: "LB28" };
  const leftBrahmic = BRAHMIC_BASE.has(before) || leftRepresentative.codePoint === 0x25cc;
  const rightBrahmic = BRAHMIC_BASE.has(after) || rightRepresentative.codePoint === 0x25cc;
  if ((before === "AP" && rightBrahmic) || (leftBrahmic && (after === "VF" || after === "VI"))
    || (before === "VI" && rightBrahmic && left.baseIndex >= 1
      && (BRAHMIC_BASE.has(units[left.baseIndex - 1]?.effective ?? "XX")
        || representative(units, left.baseIndex - 1)?.codePoint === 0x25cc))
    || (leftBrahmic && rightBrahmic && nextClass(units, boundary + 1) === "VF")) {
    return { kind: "prohibited", rule: "LB28a" };
  }
  if (before === "IS" && LETTERS.has(after)) return { kind: "prohibited", rule: "LB29" };
  if ((LETTERS.has(before) || before === "NU") && after === "OP" && !rightRepresentative.eastAsian) {
    return { kind: "prohibited", rule: "LB30" };
  }
  if (before === "CP" && !leftRepresentative.eastAsian && (LETTERS.has(after) || after === "NU")) {
    return { kind: "prohibited", rule: "LB30" };
  }
  if (before === "RI" && after === "RI") {
    const count = context.precedingRegionalIndicators[boundary] ?? 0;
    if ((count & 1) === 1) return { kind: "prohibited", rule: "LB30a" };
  }
  if ((before === "EB" || (leftRepresentative.extendedPictographic && leftRepresentative.category === "Cn")) && after === "EM") {
    return { kind: "prohibited", rule: "LB30b" };
  }
  return { kind: "allowed", rule: "LB31" };
}

function tailoredOpportunity(
  base: Omit<BreakOpportunity, "codePointIndex" | "codeUnitOffset">,
  units: readonly LineUnit[],
  boundary: number,
  tailoring: LineBreakTailoring,
  graphemeBoundaries: { has(offset: number): boolean }
): Omit<BreakOpportunity, "codePointIndex" | "codeUnitOffset"> {
  if (base.kind === "mandatory" || boundary === 0 || boundary === units.length) return base;
  const right = units[boundary];
  const left = units[boundary - 1];
  if (right === undefined || left === undefined) return base;
  if (tailoring.preserveGraphemeClusters && !graphemeBoundaries.has(right.startCodeUnit)) {
    return { kind: "prohibited", rule: "CSS-GRAPHEME" };
  }
  if (tailoring.hyphens === "none" && left.codePoint === 0x00ad) return { kind: "prohibited", rule: "CSS-HYPHENS" };
  if (tailoring.lineBreak === "anywhere") return { kind: "allowed", rule: "CSS-LINE-BREAK-ANYWHERE" };
  if (tailoring.wordBreak === "break-all" && (LETTERS.has(left.effective) || left.effective === "NU")
    && (LETTERS.has(right.effective) || right.effective === "NU")) {
    return { kind: "allowed", rule: "CSS-WORD-BREAK-BREAK-ALL" };
  }
  if (tailoring.wordBreak === "keep-all" && (left.effective === "ID" || HANGUL.has(left.effective))
    && (right.effective === "ID" || HANGUL.has(right.effective))) {
    return { kind: "prohibited", rule: "CSS-WORD-BREAK-KEEP-ALL" };
  }
  if ((tailoring.overflowWrap === "anywhere" || tailoring.overflowWrap === "break-word")
    && base.kind === "prohibited") {
    return {
      kind: "allowed",
      rule: tailoring.overflowWrap === "anywhere"
        ? "CSS-OVERFLOW-WRAP-ANYWHERE" : "CSS-OVERFLOW-WRAP-BREAK-WORD"
    };
  }
  return base;
}

class ImmutableLineBreakMap implements LineBreakMap {
  readonly value: string;
  readonly opportunities: readonly BreakOpportunity[];
  readonly outcome: LineBreakOutcome;

  public constructor(value: string, opportunities: readonly BreakOpportunity[], outcome: LineBreakOutcome) {
    this.value = value;
    this.opportunities = Object.freeze(opportunities);
    this.outcome = Object.freeze(outcome);
    Object.freeze(this);
  }

  public atCodePoint(index: number): BreakOpportunity | null {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const opportunity = this.opportunities[index];
    return opportunity?.codePointIndex === index ? opportunity : null;
  }

  public atCodeUnit(offset: number): BreakOpportunity | null {
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    let low = 0;
    let high = this.opportunities.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const opportunity = this.opportunities[middle];
      if (opportunity === undefined) return null;
      if (offset < opportunity.codeUnitOffset) high = middle - 1;
      else if (offset > opportunity.codeUnitOffset) low = middle + 1;
      else return opportunity;
    }
    return null;
  }
}

/** Unicode 17.0.0 UAX #14 default opportunities with explicit CSS Text tailoring. */
export function buildLineBreakMap(
  value: string,
  tailoringInput: LineBreakTailoringInput = {},
  budgetOverrides: LineBreakConstructionOptions = {},
  signal?: AbortSignal
): LineBreakMap {
  const limit = budgetOverrides.maxBreakOpportunities ?? 1_000_001;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return new ImmutableLineBreakMap(value, [], { status: "rejected", reason: "invalid-budget" });
  }
  if (limit === 0) {
    return new ImmutableLineBreakMap(value, [], {
      status: "truncated", opportunities: 0, budget: "maxBreakOpportunities", limit
    });
  }
  const unitScan = lineUnits(value, Math.min(Number.MAX_SAFE_INTEGER, limit + 2), signal);
  const units = unitScan.units;
  const context = boundaryContext(units);
  const tailoringAt = (boundary: LineBreakBoundary): LineBreakTailoring => Object.freeze({
    ...DEFAULT_TAILORING,
    ...(typeof tailoringInput === "function" ? tailoringInput(boundary) : tailoringInput)
  });
  const preserveGraphemeClusters = typeof tailoringInput === "function"
    || (tailoringInput.preserveGraphemeClusters ?? DEFAULT_TAILORING.preserveGraphemeClusters);
  const providedBoundaries = budgetOverrides.graphemeClusterBoundaries;
  if (providedBoundaries !== undefined) {
    let previous = -1;
    for (const boundary of providedBoundaries) {
      if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > value.length || boundary <= previous) {
        return new ImmutableLineBreakMap(value, [], {
          status: "rejected", reason: "invalid-grapheme-boundary-map"
        });
      }
      previous = boundary;
    }
    if (providedBoundaries[0] !== 0 || providedBoundaries.at(-1) !== value.length) {
      return new ImmutableLineBreakMap(value, [], {
        status: "rejected", reason: "invalid-grapheme-boundary-map"
      });
    }
  }
  const grapheme = preserveGraphemeClusters && providedBoundaries === undefined
    ? segmentGraphemeClusters(value, { maxGraphemeClusters: Math.min(Number.MAX_SAFE_INTEGER, limit + 2) }, signal)
    : null;
  const graphemeBoundaries = providedBoundaries ?? [
    0,
    ...(grapheme?.clusters.map((cluster) => cluster.endCodeUnit) ?? []),
    ...(grapheme?.outcome.status === "complete" ? [] : [value.length])
  ];
  const hasGraphemeBoundary = (offset: number): boolean => {
    let low = 0;
    let high = graphemeBoundaries.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const boundary = graphemeBoundaries[middle];
      if (boundary === undefined) return false;
      if (offset < boundary) high = middle - 1;
      else if (offset > boundary) low = middle + 1;
      else return true;
    }
    return false;
  };
  const opportunities: BreakOpportunity[] = [];
  const availableBoundaries = unitScan.complete ? units.length + 1 : Math.min(limit, units.length);
  for (let boundary = 0; boundary < availableBoundaries; boundary += 1) {
    signal?.throwIfAborted();
    if (opportunities.length >= limit) {
      return new ImmutableLineBreakMap(value, opportunities, {
        status: "truncated", opportunities: opportunities.length,
        budget: "maxBreakOpportunities", limit
      });
    }
    const base = defaultOpportunity(units, boundary, context);
    const codeUnitOffset = boundary === units.length ? value.length : units[boundary]?.startCodeUnit ?? 0;
    const resolved = tailoredOpportunity(
      base,
      units,
      boundary,
      tailoringAt({ codePointIndex: boundary, codeUnitOffset }),
      { has: hasGraphemeBoundary }
    );
    opportunities.push(Object.freeze({
      codePointIndex: boundary,
      codeUnitOffset,
      ...resolved
    }));
  }
  if (!unitScan.complete || opportunities.length >= limit && opportunities.length < units.length + 1) {
    return new ImmutableLineBreakMap(value, opportunities, {
      status: "truncated", opportunities: opportunities.length,
      budget: "maxBreakOpportunities", limit
    });
  }
  return new ImmutableLineBreakMap(value, opportunities, {
    status: "complete", opportunities: opportunities.length
  });
}
