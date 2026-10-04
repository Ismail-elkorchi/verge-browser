import type { CssGridTrackBreadth, CssGridTrackSizingFunction, CssGridTrackList, CssGridTrackListEntry, CssGridTemplateAreas } from "./grid/types.js";
import type {
  ComputedBoxStyle, ComputedDisplay, ComputedStyle, ComputedTextStyle,
  CssColor, CssEdges, CssLength, CssLengthPercentageExpression,
} from "./types.js";

export function sameCssColor(a: CssColor | null, b: CssColor | null): boolean {
  return a === b || (a !== null && b !== null
    && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);
}

export function sameCssLength(a: CssLength, b: CssLength): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "length" && b.kind === "length") return a.value === b.value && a.unit === b.unit;
  if (a.kind === "calculation" && b.kind === "calculation") return a.calculation === b.calculation
    || (a.calculation.percentageDependence === b.calculation.percentageDependence
      && sameExpression(a.calculation.expression, b.calculation.expression));
  return true;
}

function sameSequence<T>(a: readonly T[], b: readonly T[], same: (a: T, b: T) => boolean): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (const [index, value] of a.entries()) {
    const other = b[index];
    if (other === undefined || !same(value, other)) return false;
  }
  return true;
}

// These are bounded CSS value grammars, never arbitrary application object graphs.
function sameExpression(a: CssLengthPercentageExpression, b: CssLengthPercentageExpression): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "value": return b.kind === "value" && a.value === b.value && a.unit === b.unit;
    case "negate": return b.kind === "negate" && sameExpression(a.value, b.value);
    case "sum": return b.kind === "sum" && sameExpression(a.left, b.left) && sameExpression(a.right, b.right);
    case "product": return b.kind === "product" && a.factor === b.factor && sameExpression(a.value, b.value);
    case "minimum": case "maximum": return a.kind === b.kind && sameSequence(a.values, b.values, sameExpression);
    case "clamp": return b.kind === "clamp" && sameExpression(a.minimum, b.minimum)
      && sameExpression(a.preferred, b.preferred) && sameExpression(a.maximum, b.maximum);
  }
}
function sameBreadth(a: CssGridTrackBreadth, b: CssGridTrackBreadth): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "length": return b.kind === "length" && sameCssLength(a.value, b.value);
    case "flex": return b.kind === "flex" && a.factor === b.factor;
    case "auto": case "min-content": case "max-content": return a.kind === b.kind;
  }
}
function sameTrack(a: CssGridTrackSizingFunction, b: CssGridTrackSizingFunction): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "breadth": return b.kind === "breadth" && sameBreadth(a.breadth, b.breadth);
    case "minmax": return b.kind === "minmax" && sameBreadth(a.minimum, b.minimum) && sameBreadth(a.maximum, b.maximum);
    case "fit-content": return b.kind === "fit-content" && sameCssLength(a.limit, b.limit);
  }
}
function sameTrackEntry(a: CssGridTrackListEntry, b: CssGridTrackListEntry): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "line-names": return b.kind === "line-names" && sameSequence(a.names, b.names, (a, b) => a === b);
    case "track": return b.kind === "track" && sameTrack(a.sizing, b.sizing);
    case "repeat": return b.kind === "repeat" && a.repetition.kind === b.repetition.kind
      && (a.repetition.kind !== "fixed" || (b.repetition.kind === "fixed" && a.repetition.count === b.repetition.count))
      && sameSequence(a.entries, b.entries, sameTrackEntry);
  }
}
function sameTrackList(a: CssGridTrackList, b: CssGridTrackList): boolean {
  return a === b || (a.kind === b.kind && (a.kind === "none"
    || (b.kind === "track-list" && sameSequence(a.entries, b.entries, sameTrackEntry))));
}
function sameGridAreas(a: CssGridTemplateAreas, b: CssGridTemplateAreas): boolean {
  if (a === b) return true;
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  if (!sameSequence(a.rows, b.rows, (a, b) => sameSequence(a, b, (a, b) => a === b)) || a.areas.size !== b.areas.size) return false;
  for (const [name, area] of a.areas) {
    const other = b.areas.get(name);
    if (other === undefined || area.name !== other.name || area.rowStart !== other.rowStart || area.rowEnd !== other.rowEnd
      || area.columnStart !== other.columnStart || area.columnEnd !== other.columnEnd) return false;
  }
  return true;
}

function sameEdges(a: CssEdges, b: CssEdges): boolean {
  return a === b || (sameCssLength(a.top, b.top) && sameCssLength(a.right, b.right)
    && sameCssLength(a.bottom, b.bottom) && sameCssLength(a.left, b.left));
}

export function sameComputedDisplay(a: ComputedDisplay, b: ComputedDisplay): boolean {
  return a === b || (a.box === b.box && (a.box !== "principal" || (b.box === "principal"
    && a.outer === b.outer && a.inner === b.inner && a.listItem === b.listItem
    && a.internal === b.internal && a.replaced === b.replaced)));
}

type Comparisons<T> = { readonly [K in keyof T]: (a: T[K], b: T[K]) => boolean };
const identity = <T>(a: T, b: T): boolean => a === b;
const textComparisons: Comparisons<ComputedTextStyle> = {
  color: sameCssColor, background: sameCssColor,
  fontWeight: identity, fontStyle: identity, underline: identity, lineThrough: identity,
  textTransform: identity, whiteSpace: identity, direction: identity, unicodeBidi: identity,
  textAlign: identity, lineBreak: identity, wordBreak: identity, overflowWrap: identity,
  hyphens: identity, tabSize: identity, textIndent: sameCssLength, fontSize: sameCssLength,
  lineHeight: (a, b) => a === b || (a.kind === b.kind && (a.kind === "normal"
    || (a.kind === "number" && b.kind === "number" && a.value === b.value)
    || (a.kind === "length" && b.kind === "length" && sameCssLength(a.value, b.value)))),
  verticalAlign: (a, b) => a === b || (a.kind === b.kind && ((a.kind === "keyword"
    && b.kind === "keyword" && a.value === b.value)
    || (a.kind === "length" && b.kind === "length" && sameCssLength(a.value, b.value)))),
};
const boxComparisons: Comparisons<ComputedBoxStyle> = {
  margin: sameEdges, padding: sameEdges, width: sameCssLength, minWidth: sameCssLength,
  maxWidth: sameCssLength, height: sameCssLength, minHeight: sameCssLength, maxHeight: sameCssLength,
  boxSizing: identity,
  rowGap: (a, b) => a.kind === "normal" ? b.kind === "normal" : b.kind !== "normal" && sameCssLength(a, b),
  columnGap: (a, b) => a.kind === "normal" ? b.kind === "normal" : b.kind !== "normal" && sameCssLength(a, b),
  borderStyles: (a, b) => a === b || (a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left),
  borderWidths: sameEdges,
  borderColors: (a, b) => a === b || (sameCssColor(a.top, b.top) && sameCssColor(a.right, b.right)
    && sameCssColor(a.bottom, b.bottom) && sameCssColor(a.left, b.left)),
  tableLayout: identity, borderCollapse: identity,
  borderSpacing: (a, b) => a === b || (sameCssLength(a.horizontal, b.horizontal) && sameCssLength(a.vertical, b.vertical)),
  captionSide: identity, emptyCells: identity, flexDirection: identity, flexWrap: identity,
  flexGrow: identity, flexShrink: identity,
  flexBasis: (a, b) => a.kind === "content" ? b.kind === "content" : b.kind !== "content" && sameCssLength(a, b),
  order: identity,
  justifyContent: (a, b) => a === b || (a.value === b.value && a.overflow === b.overflow),
  alignItems: (a, b) => a === b || (a.position === b.position && a.overflow === b.overflow),
  alignSelf: (a, b) => a === b || (a.position === b.position && a.overflow === b.overflow),
  alignContent: (a, b) => a === b || (a.value === b.value && a.overflow === b.overflow),
  justifyItems: (a, b) => a === b || (a.position === b.position && a.overflow === b.overflow),
  justifySelf: (a, b) => a === b || (a.position === b.position && a.overflow === b.overflow),
  position: identity, inset: sameEdges, zIndex: identity, float: identity, clear: identity,
  legacyClip: (a, b) => a === b || (a.kind === b.kind && (a.kind === "auto"
    || (b.kind === "rect" && sameEdges(a.edges, b.edges)))),
  clipPath: (a, b) => a === b || (a.kind === b.kind && (a.kind === "none"
    || (b.kind === "inset" && sameEdges(a.offsets, b.offsets)))),
  transform: (a, b) => a === b || (a !== null && b !== null && sameSequence(a, b,
    (a, b) => sameCssLength(a.x, b.x) && sameCssLength(a.y, b.y))),
  gridTemplateColumns: sameTrackList, gridTemplateRows: sameTrackList, gridTemplateAreas: sameGridAreas,
  gridAutoColumns: (a, b) => sameSequence(a, b, sameTrack), gridAutoRows: (a, b) => sameSequence(a, b, sameTrack),
  gridAutoFlow: (a, b) => a === b || (a.axis === b.axis && a.packing === b.packing),
  gridPlacement: (a, b) => a === b || (sameGridLine(a.columnStart, b.columnStart)
    && sameGridLine(a.columnEnd, b.columnEnd) && sameGridLine(a.rowStart, b.rowStart)
    && sameGridLine(a.rowEnd, b.rowEnd)),
  overflowX: identity, overflowY: identity, contain: identity,
};

function sameGridLine(a: ComputedBoxStyle["gridPlacement"]["rowStart"], b: ComputedBoxStyle["gridPlacement"]["rowStart"]): boolean {
  return a === b || (a.kind === b.kind && (a.kind === "auto" || (b.kind === "line"
    && a.span === b.span && a.index === b.index && a.name === b.name)));
}

// Keys come from exhaustive framework contracts, never from a consumer model.
export function compareComputedRecord<T>(fields: Comparisons<T>, except?: keyof T): (a: T, b: T) => boolean {
  const keys = (Object.keys(fields) as (keyof T)[]).filter((key) => key !== except);
  return (a, b) => {
    if (a === b) return true;
    for (const key of keys) if (!fields[key](a[key], b[key])) return false;
    return true;
  };
}
export const sameComputedTextStyle = compareComputedRecord(textComparisons);
export const sameComputedTextStyleExceptBackground = compareComputedRecord(textComparisons, "background");
export const sameComputedBoxStyle = compareComputedRecord(boxComparisons);

function freezeRecord<T extends object>(value: T): T {
  return Object.isFrozen(value) ? value : Object.freeze({ ...value });
}
function freezeColor(value: CssColor | null): CssColor | null {
  return value === null ? null : freezeRecord(value);
}

/** Inputs are framework-owned computed descriptors; custom-property ownership is handled by the cascade. */
export function freezeComputedStyleRecords(style: ComputedStyle): ComputedStyle {
  const text = Object.isFrozen(style.text) ? style.text : Object.freeze({
    ...style.text, color: freezeColor(style.text.color), background: freezeColor(style.text.background),
  });
  const source = style.box;
  const box = Object.isFrozen(source) ? source : Object.freeze({
    ...source,
    margin: freezeRecord(source.margin), padding: freezeRecord(source.padding), inset: freezeRecord(source.inset),
    borderWidths: freezeRecord(source.borderWidths), borderStyles: freezeRecord(source.borderStyles),
    borderColors: Object.isFrozen(source.borderColors) ? source.borderColors : Object.freeze({
      top: freezeColor(source.borderColors.top), right: freezeColor(source.borderColors.right),
      bottom: freezeColor(source.borderColors.bottom), left: freezeColor(source.borderColors.left),
    }),
    borderSpacing: freezeRecord(source.borderSpacing),
    legacyClip: Object.isFrozen(source.legacyClip) ? source.legacyClip : Object.freeze(source.legacyClip.kind === "auto"
      ? { kind: "auto" as const } : { kind: "rect" as const, edges: freezeRecord(source.legacyClip.edges) }),
    clipPath: Object.isFrozen(source.clipPath) ? source.clipPath : Object.freeze(source.clipPath.kind === "none"
      ? { kind: "none" as const } : { kind: "inset" as const, offsets: freezeRecord(source.clipPath.offsets) }),
    gridAutoColumns: Object.isFrozen(source.gridAutoColumns) ? source.gridAutoColumns : Object.freeze([...source.gridAutoColumns]),
    gridAutoRows: Object.isFrozen(source.gridAutoRows) ? source.gridAutoRows : Object.freeze([...source.gridAutoRows]),
    gridAutoFlow: freezeRecord(source.gridAutoFlow), gridPlacement: freezeRecord(source.gridPlacement),
  });
  return Object.freeze({ ...style, display: freezeRecord(style.display), text, box });
}

/** One construction transaction owns this bounded lookup and discards it on return. */
export class RecordSharing<T> {
  readonly #buckets = new Map<string, T[]>();
  readonly #equal: (a: T, b: T) => boolean;
  readonly #key: (value: T) => string;
  #count = 0;
  constructor(key: (value: T) => string, equal: (a: T, b: T) => boolean) {
    this.#key = key; this.#equal = equal;
  }
  share(value: T): T {
    const key = this.#key(value);
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) {
      for (const existing of bucket) if (this.#equal(existing, value)) return existing;
    }
    // Limits bound both lookup work and scratch ownership. A miss only loses sharing.
    if (this.#count < 4096 && (bucket?.length ?? 0) < 64) {
      if (bucket === undefined) this.#buckets.set(key, [value]); else bucket.push(value);
      this.#count += 1;
    }
    return value;
  }
}

function lengthPartition(value: CssLength): string {
  return value.kind === "length" ? `${String(value.value)}${value.unit}` : value.kind;
}

export class StyleRecordSharing {
  readonly #text = new RecordSharing<ComputedTextStyle>(
    (s) => `${String(s.fontWeight)}:${s.fontStyle}:${s.whiteSpace}:${s.direction}:${s.textAlign}:${s.fontSize.kind}:${s.lineHeight.kind}`, sameComputedTextStyle);
  readonly #box = new RecordSharing<ComputedBoxStyle>(
    (s) => `${s.position}:${s.float}:${lengthPartition(s.width)}:${lengthPartition(s.height)}:${lengthPartition(s.margin.top)}:${lengthPartition(s.padding.top)}:${lengthPartition(s.borderWidths.top)}:${s.borderStyles.top}:${s.overflowX}:${s.overflowY}:${s.flexDirection}:${String(s.order)}`, sameComputedBoxStyle);
  readonly #display = new RecordSharing<ComputedDisplay>(
    (s) => s.box === "principal" ? `${s.outer}:${s.inner}:${String(s.internal)}:${String(s.listItem)}:${String(s.replaced)}` : s.box, sameComputedDisplay);
  seed(style: ComputedStyle): void { this.share(style); }
  share(style: ComputedStyle): ComputedStyle {
    const text = this.#text.share(style.text);
    const box = this.#box.share(style.box);
    const display = this.#display.share(style.display);
    return text === style.text && box === style.box && display === style.display
      ? style : Object.freeze({ ...style, text, box, display });
  }
}
