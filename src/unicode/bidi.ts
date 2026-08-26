import {
  bidiClass,
  bidiMirroringGlyph,
  bidiPairedBracket,
  canonicalBidiBracket,
  type BidiClass
} from "./properties.js";

export type BidiLevel = number & { readonly __bidiLevel: unique symbol };
export type BidiParagraphDirection = "ltr" | "rtl" | "auto";
export type BidiParagraphDirectionInput = BidiParagraphDirection
  | ((itemStart: number, itemEnd: number) => BidiParagraphDirection);

export interface BidiItem<TIdentity = unknown> {
  readonly logicalIndex: number;
  readonly kind: "code-point" | "atomic-inline" | "structural-control";
  readonly text: string;
  readonly codePoint: number | null;
  readonly bidiClass: BidiClass;
  readonly sourceStartCodeUnit: number;
  readonly sourceEndCodeUnit: number;
  readonly identity: TIdentity;
}

export interface BidiRun {
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly level: BidiLevel;
  readonly direction: "ltr" | "rtl";
  readonly itemIndices: readonly number[];
}

export interface VisualRunOrder {
  readonly itemIndices: readonly number[];
  readonly runs: readonly BidiRun[];
}

export interface BidiBudgets {
  readonly maxCodePointsPerParagraph: number;
  readonly maxBidiItems: number;
  readonly maxEmbeddingDepth: number;
  readonly maxBidiRuns: number;
}

export type BidiOutcome =
  | { readonly status: "complete"; readonly items: number; readonly runs: number }
  | {
      readonly status: "truncated";
      readonly items: number;
      readonly runs: number;
      readonly budget: "maxCodePointsPerParagraph" | "maxBidiItems" | "maxEmbeddingDepth" | "maxBidiRuns";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-budget" | "invalid-item" };

export interface BidiParagraph<TIdentity = unknown> {
  readonly items: readonly BidiItem<TIdentity>[];
  readonly baseLevel: BidiLevel;
  /** Null marks an explicit-formatting item removed by UAX #9 rule X9. */
  readonly embeddingLevels: readonly (BidiLevel | null)[];
  readonly resolvedClasses: readonly BidiClass[];
  readonly visualOrder: VisualRunOrder;
  readonly outcome: BidiOutcome;
}

export interface BidiParagraphSlice<TIdentity = unknown> {
  readonly itemStart: number;
  readonly itemEnd: number;
  readonly paragraph: BidiParagraph<TIdentity>;
}

export interface BidiParagraphCollection<TIdentity = unknown> {
  readonly items: readonly BidiItem<TIdentity>[];
  readonly paragraphs: readonly BidiParagraphSlice<TIdentity>[];
}

const DEFAULT_BIDI_BUDGETS: BidiBudgets = Object.freeze({
  maxCodePointsPerParagraph: 1_000_000,
  maxBidiItems: 1_000_000,
  maxEmbeddingDepth: 125,
  maxBidiRuns: 250_000
});

const X9_CLASSES = new Set<BidiClass>(["RLE", "LRE", "RLO", "LRO", "PDF", "BN"]);
const ISOLATE_INITIATORS = new Set<BidiClass>(["LRI", "RLI", "FSI"]);
const NEUTRAL_CLASSES = new Set<BidiClass>(["B", "S", "WS", "ON", "FSI", "LRI", "RLI", "PDI"]);
const TRAILING_CLASSES = new Set<BidiClass>(["B", "S", "WS", "FSI", "LRI", "RLI", "PDI"]);

function checkCancellation(signal: AbortSignal | undefined, position: number): void {
  if ((position & 0x3ff) === 0) signal?.throwIfAborted();
}

interface DirectionalStatus {
  readonly level: number;
  readonly override: "L" | "R" | null;
  readonly isolate: boolean;
  readonly initiator: number | null;
}

interface LevelRun {
  readonly indices: readonly number[];
  readonly level: number;
  readonly startsWithPdi: boolean;
  readonly endsWithIsolate: boolean;
}

function normalizedBudgets(value: Partial<BidiBudgets>): BidiBudgets | null {
  const read = (name: keyof BidiBudgets): number | null => {
    const candidate = value[name] ?? DEFAULT_BIDI_BUDGETS[name];
    return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  };
  const result = {
    maxCodePointsPerParagraph: read("maxCodePointsPerParagraph"),
    maxBidiItems: read("maxBidiItems"),
    maxEmbeddingDepth: read("maxEmbeddingDepth"),
    maxBidiRuns: read("maxBidiRuns")
  };
  if (Object.values(result).some((candidate) => candidate === null)
    || (result.maxEmbeddingDepth ?? 126) > 125) return null;
  return result as BidiBudgets;
}

function matchingIsolates(types: readonly BidiClass[], signal?: AbortSignal): Int32Array {
  const matches = new Int32Array(types.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < types.length; index += 1) {
    checkCancellation(signal, index);
    const type = types[index];
    if (type !== undefined && ISOLATE_INITIATORS.has(type)) stack.push(index);
    else if (type === "PDI") {
      const initiator = stack.pop();
      if (initiator !== undefined) {
        matches[initiator] = index;
        matches[index] = initiator;
      }
    } else if (type === "B") stack.length = 0;
  }
  return matches;
}

function paragraphLevel(
  types: readonly BidiClass[],
  direction: BidiParagraphDirection,
  start = 0,
  end = types.length,
  isolateMatches = matchingIsolates(types),
  signal?: AbortSignal
): number {
  if (direction === "ltr") return 0;
  if (direction === "rtl") return 1;
  for (let index = start; index < end; index += 1) {
    checkCancellation(signal, index - start);
    const type = types[index];
    if (type === "R" || type === "AL") return 1;
    if (type === "L" || type === "B") return 0;
    if (type !== undefined && ISOLATE_INITIATORS.has(type)) {
      const matching = isolateMatches[index] ?? -1;
      index = matching < 0 ? end : matching;
    }
  }
  return 0;
}

function fsiClass(
  types: readonly BidiClass[],
  index: number,
  end: number,
  isolateMatches: Int32Array,
  signal?: AbortSignal
): "LRI" | "RLI" {
  const stop = isolateMatches[index] ?? -1;
  const level = paragraphLevel(types, "auto", index + 1, stop < 0 ? end : stop, isolateMatches, signal);
  return level === 0 ? "LRI" : "RLI";
}

function previousRetainedLevel(
  levels: readonly number[],
  original: readonly BidiClass[],
  start: number,
  paragraphBase: number
): number {
  for (let index = start - 1; index >= 0; index -= 1) {
    const type = original[index];
    if (type !== undefined && !X9_CLASSES.has(type)) return levels[index] ?? paragraphBase;
  }
  return paragraphBase;
}

function nextRetainedLevel(
  levels: readonly number[],
  original: readonly BidiClass[],
  start: number,
  paragraphBase: number
): number {
  for (let index = start + 1; index < original.length; index += 1) {
    const type = original[index];
    if (type !== undefined && !X9_CLASSES.has(type)) return levels[index] ?? paragraphBase;
  }
  return paragraphBase;
}

function strongDirection(type: BidiClass): "L" | "R" | null {
  if (type === "L") return "L";
  if (type === "R" || type === "EN" || type === "AN") return "R";
  return null;
}

function resolveSequence(
  sequence: readonly number[],
  levels: readonly number[],
  types: BidiClass[],
  original: readonly BidiClass[],
  items: readonly BidiItem[],
  sos: "L" | "R",
  eos: "L" | "R",
  signal: AbortSignal | undefined
): void {
  if (sequence.length === 0) return;

  // W1
  let preceding: BidiClass = sos;
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    if (index === undefined) continue;
    const type = types[index];
    if (type === "NSM") {
      const isolateBoundary = (["LRI", "RLI", "FSI", "PDI"] as readonly BidiClass[]).includes(preceding);
      const resolved: BidiClass = isolateBoundary ? "ON" : preceding;
      types[index] = resolved;
      preceding = resolved;
    } else if (type !== undefined) preceding = type;
  }

  // W2
  let previousStrong: BidiClass = sos;
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    if (index === undefined) continue;
    const type = types[index];
    if (type === "EN" && previousStrong === "AL") types[index] = "AN";
    if (type === "R" || type === "L" || type === "AL") previousStrong = type;
  }

  // W3
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    if (index !== undefined && types[index] === "AL") types[index] = "R";
  }

  // W4
  for (let position = 1; position + 1 < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    const before = types[sequence[position - 1] ?? -1];
    const after = types[sequence[position + 1] ?? -1];
    const current = index === undefined ? undefined : types[index];
    if (index !== undefined && current === "ES" && before === "EN" && after === "EN") types[index] = "EN";
    else if (index !== undefined && current === "CS" && before === after && (before === "EN" || before === "AN")) {
      types[index] = before;
    }
  }

  // W5
  for (let position = 0; position < sequence.length;) {
    checkCancellation(signal, position);
    const first = sequence[position];
    if (first === undefined || types[first] !== "ET") {
      position += 1;
      continue;
    }
    let end = position + 1;
    while (end < sequence.length && types[sequence[end] ?? -1] === "ET") {
      checkCancellation(signal, end);
      end += 1;
    }
    const before = position > 0 ? types[sequence[position - 1] ?? -1] : undefined;
    const after = end < sequence.length ? types[sequence[end] ?? -1] : undefined;
    if (before === "EN" || after === "EN") {
      for (let cursor = position; cursor < end; cursor += 1) {
        checkCancellation(signal, cursor);
        const index = sequence[cursor];
        if (index !== undefined) types[index] = "EN";
      }
    }
    position = end;
  }

  // W6
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    if (index === undefined) continue;
    const type = types[index];
    if (type === "ES" || type === "ET" || type === "CS") types[index] = "ON";
  }

  // W7
  let precedingStrong: "L" | "R" = sos;
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    if (index === undefined) continue;
    const type = types[index];
    if (type === "EN" && precedingStrong === "L") types[index] = "L";
    else if (type === "L" || type === "R") precedingStrong = type;
  }

  // N0, BD16
  const embeddingDirection: "L" | "R" = ((levels[sequence[0] ?? 0] ?? 0) & 1) === 0 ? "L" : "R";
  const openerStack: { readonly sequencePosition: number; readonly codePoint: number; readonly paired: number }[] = [];
  const pairs: [number, number][] = [];
  for (let position = 0; position < sequence.length; position += 1) {
    checkCancellation(signal, position);
    const index = sequence[position];
    const item = index === undefined ? undefined : items[index];
    if (index === undefined || item?.codePoint === null || item === undefined || types[index] !== "ON") continue;
    const bracket = bidiPairedBracket(item.codePoint);
    if (bracket?.kind === "open") {
      if (openerStack.length >= 63) break;
      openerStack.push({ sequencePosition: position, codePoint: item.codePoint, paired: bracket.pairedCodePoint });
    } else if (bracket?.kind === "close") {
      for (let stackIndex = openerStack.length - 1; stackIndex >= 0; stackIndex -= 1) {
        const opener = openerStack[stackIndex];
        if (opener === undefined) continue;
        const matches = canonicalBidiBracket(opener.paired) === canonicalBidiBracket(item.codePoint)
          || canonicalBidiBracket(opener.codePoint) === canonicalBidiBracket(bracket.pairedCodePoint);
        if (!matches) continue;
        pairs.push([opener.sequencePosition, position]);
        openerStack.length = stackIndex;
        break;
      }
    }
  }
  pairs.sort((left, right) => left[0] - right[0]);
  for (const [open, close] of pairs) {
    let opposite: "L" | "R" | null = null;
    let chosen: "L" | "R" | null = null;
    for (let position = open + 1; position < close; position += 1) {
      checkCancellation(signal, position);
      const index = sequence[position];
      const direction = index === undefined ? null : strongDirection(types[index] ?? "ON");
      if (direction === embeddingDirection) {
        chosen = embeddingDirection;
        break;
      }
      if (direction !== null) opposite = direction;
    }
    if (chosen === null && opposite !== null) {
      let context: "L" | "R" = sos;
      for (let position = open - 1; position >= 0; position -= 1) {
        checkCancellation(signal, open - position);
        const index = sequence[position];
        const direction = index === undefined ? null : strongDirection(types[index] ?? "ON");
        if (direction !== null) {
          context = direction;
          break;
        }
      }
      chosen = context === opposite ? opposite : embeddingDirection;
    }
    if (chosen === null) continue;
    const openIndex = sequence[open];
    const closeIndex = sequence[close];
    if (openIndex === undefined || closeIndex === undefined) continue;
    types[openIndex] = chosen;
    types[closeIndex] = chosen;
    for (const position of [open, close]) {
      for (let cursor = position + 1; cursor < sequence.length; cursor += 1) {
        const following = sequence[cursor];
        if (following === undefined) break;
        if (original[following] === "NSM") types[following] = chosen;
        break;
      }
    }
  }

  // N1 and N2
  for (let position = 0; position < sequence.length;) {
    checkCancellation(signal, position);
    const first = sequence[position];
    const firstType = first === undefined ? undefined : types[first];
    if (firstType === undefined || !NEUTRAL_CLASSES.has(firstType)) {
      position += 1;
      continue;
    }
    let end = position + 1;
    while (end < sequence.length) {
      checkCancellation(signal, end);
      const index = sequence[end];
      const type = index === undefined ? undefined : types[index];
      if (type === undefined || !NEUTRAL_CLASSES.has(type)) break;
      end += 1;
    }
    const beforeIndex = position > 0 ? sequence[position - 1] : undefined;
    const afterIndex = end < sequence.length ? sequence[end] : undefined;
    const before = beforeIndex === undefined ? sos : strongDirection(types[beforeIndex] ?? "ON") ?? embeddingDirection;
    const after = afterIndex === undefined ? eos : strongDirection(types[afterIndex] ?? "ON") ?? embeddingDirection;
    const resolved = before === after ? before : embeddingDirection;
    for (let cursor = position; cursor < end; cursor += 1) {
      checkCancellation(signal, cursor);
      const index = sequence[cursor];
      if (index !== undefined) types[index] = resolved;
    }
    position = end;
  }
}

function visualRuns(
  levels: readonly (number | null)[],
  maxRuns: number,
  signal: AbortSignal | undefined
): { readonly order: VisualRunOrder; readonly truncated: boolean } {
  const indices: number[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    checkCancellation(signal, index);
    if (levels[index] !== null) indices.push(index);
  }
  let maximum = 0;
  let minimumOdd = Number.POSITIVE_INFINITY;
  for (const index of indices) {
    checkCancellation(signal, index);
    const level = levels[index] ?? 0;
    maximum = Math.max(maximum, level);
    if ((level & 1) === 1) minimumOdd = Math.min(minimumOdd, level);
  }
  for (let level = maximum; level >= minimumOdd; level -= 1) {
    signal?.throwIfAborted();
    for (let start = 0; start < indices.length;) {
      checkCancellation(signal, start);
      if ((levels[indices[start] ?? -1] ?? -1) < level) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < indices.length && (levels[indices[end] ?? -1] ?? -1) >= level) end += 1;
      for (let left = start, right = end - 1; left < right; left += 1, right -= 1) {
        const temporary = indices[left];
        if (temporary === undefined || indices[right] === undefined) continue;
        indices[left] = indices[right] as number;
        indices[right] = temporary;
      }
      start = end;
    }
  }
  const runs: BidiRun[] = [];
  for (let start = 0; start < indices.length;) {
    checkCancellation(signal, start);
    const first = indices[start];
    if (first === undefined) break;
    const level = levels[first] ?? 0;
    let end = start + 1;
    const step = (level & 1) === 0 ? 1 : -1;
    while (end < indices.length && levels[indices[end] ?? -1] === level
      && (indices[end] ?? 0) === (indices[end - 1] ?? 0) + step) end += 1;
    if (runs.length >= maxRuns) {
      return {
        order: Object.freeze({ itemIndices: Object.freeze(indices.slice(0, start)), runs: Object.freeze(runs) }),
        truncated: true
      };
    }
    const itemIndices = Object.freeze(indices.slice(start, end));
    let logicalStart = itemIndices[0] ?? 0;
    let logicalEnd = logicalStart;
    for (const index of itemIndices) {
      logicalStart = Math.min(logicalStart, index);
      logicalEnd = Math.max(logicalEnd, index);
    }
    runs.push(Object.freeze({
      logicalStart,
      logicalEnd: logicalEnd + 1,
      level: level as BidiLevel,
      direction: (level & 1) === 0 ? "ltr" : "rtl",
      itemIndices
    }));
    start = end;
  }
  return {
    order: Object.freeze({ itemIndices: Object.freeze(indices), runs: Object.freeze(runs) }),
    truncated: false
  };
}

/** Applies UAX #9 rules L1 and L2 to one selected line of an already resolved paragraph. */
export function bidiVisualOrderForLine(
  paragraph: BidiParagraph,
  itemStart: number,
  itemEnd: number,
  maxRuns = 250_000,
  signal?: AbortSignal
): VisualRunOrder {
  const start = Math.max(0, Math.min(paragraph.items.length, itemStart));
  const end = Math.max(start, Math.min(paragraph.items.length, itemEnd));
  const levels: (number | null)[] = [];
  for (let index = start; index < end; index += 1) levels.push(paragraph.embeddingLevels[index] ?? null);
  for (let index = end - 1; index >= start; index -= 1) {
    const item = paragraph.items[index];
    if (item === undefined || X9_CLASSES.has(item.bidiClass)) continue;
    if (!TRAILING_CLASSES.has(item.bidiClass)) break;
    levels[index - start] = paragraph.baseLevel;
  }
  const order = visualRuns(levels, maxRuns, signal).order;
  return Object.freeze({
    itemIndices: Object.freeze(order.itemIndices.map((index) => index + start)),
    runs: Object.freeze(order.runs.map((run) => Object.freeze({
      ...run,
      logicalStart: run.logicalStart + start,
      logicalEnd: run.logicalEnd + start,
      itemIndices: Object.freeze(run.itemIndices.map((index) => index + start))
    })))
  });
}

/** Resolves one complete UAX #9 bidi paragraph through rule L2. */
export function resolveBidiParagraph<TIdentity>(
  inputItems: readonly BidiItem<TIdentity>[],
  direction: BidiParagraphDirection = "auto",
  budgetOverrides: Partial<BidiBudgets> = {},
  signal?: AbortSignal
): BidiParagraph<TIdentity> {
  const budgets = normalizedBudgets(budgetOverrides);
  if (budgets === null) return Object.freeze({
    items: Object.freeze([]),
    baseLevel: 0 as BidiLevel,
    embeddingLevels: Object.freeze([]),
    resolvedClasses: Object.freeze([]),
    visualOrder: Object.freeze({ itemIndices: Object.freeze([]), runs: Object.freeze([]) }),
    outcome: Object.freeze({ status: "rejected", reason: "invalid-budget" })
  });
  let truncation: "maxCodePointsPerParagraph" | "maxBidiItems" | "maxEmbeddingDepth" | null = null;
  let itemLimit = inputItems.length;
  let codePoints = 0;
  for (let index = 0; index < inputItems.length; index += 1) {
    checkCancellation(signal, index);
    if (index >= budgets.maxBidiItems) {
      itemLimit = index;
      truncation = "maxBidiItems";
      break;
    }
    if (inputItems[index]?.kind === "code-point") {
      if (codePoints >= budgets.maxCodePointsPerParagraph) {
        itemLimit = index;
        truncation = "maxCodePointsPerParagraph";
        break;
      }
      codePoints += 1;
    }
  }
  const items = Object.freeze(inputItems.slice(0, itemLimit));
  for (let index = 0; index < items.length; index += 1) {
    checkCancellation(signal, index);
    const item = items[index];
    if (item === undefined || item.logicalIndex !== index || !Number.isSafeInteger(item.sourceStartCodeUnit)
      || !Number.isSafeInteger(item.sourceEndCodeUnit) || item.sourceStartCodeUnit < 0
      || item.sourceEndCodeUnit < item.sourceStartCodeUnit) {
      return Object.freeze({
        items: Object.freeze([]), baseLevel: 0 as BidiLevel, embeddingLevels: Object.freeze([]),
        resolvedClasses: Object.freeze([]),
        visualOrder: Object.freeze({ itemIndices: Object.freeze([]), runs: Object.freeze([]) }),
        outcome: Object.freeze({ status: "rejected", reason: "invalid-item" })
      });
    }
  }
  const original = items.map((item) => item.bidiClass);
  const types = [...original];
  const isolateMatches = matchingIsolates(original, signal);
  const base = paragraphLevel(original, direction, 0, original.length, isolateMatches, signal);
  const levels = new Array<number>(items.length).fill(base);
  const isolatePairs = new Map<number, number>();
  const stack: DirectionalStatus[] = [{ level: base, override: null, isolate: false, initiator: null }];
  let overflowIsolates = 0;
  let overflowEmbeddings = 0;
  let validIsolates = 0;
  const nextEven = (level: number): number => level + ((level & 1) === 0 ? 2 : 1);
  const nextOdd = (level: number): number => level + ((level & 1) === 0 ? 1 : 2);
  for (let index = 0; index < items.length; index += 1) {
    checkCancellation(signal, index);
    const originalType = original[index];
    if (originalType === undefined) continue;
    let type = originalType;
    let top = stack.at(-1) as DirectionalStatus;
    if (type === "RLE" || type === "LRE" || type === "RLO" || type === "LRO") {
      levels[index] = top.level;
      const level = type === "RLE" || type === "RLO" ? nextOdd(top.level) : nextEven(top.level);
      if (level > budgets.maxEmbeddingDepth && level <= 125) truncation ??= "maxEmbeddingDepth";
      if (level <= budgets.maxEmbeddingDepth && overflowIsolates === 0 && overflowEmbeddings === 0) {
        stack.push({
          level,
          override: type === "RLO" ? "R" : type === "LRO" ? "L" : null,
          isolate: false,
          initiator: null
        });
      } else if (overflowIsolates === 0) overflowEmbeddings += 1;
    } else if (ISOLATE_INITIATORS.has(type)) {
      if (type === "FSI") type = fsiClass(original, index, items.length, isolateMatches, signal);
      levels[index] = top.level;
      if (top.override !== null) types[index] = top.override;
      const level = type === "RLI" ? nextOdd(top.level) : nextEven(top.level);
      if (level > budgets.maxEmbeddingDepth && level <= 125) truncation ??= "maxEmbeddingDepth";
      if (level <= budgets.maxEmbeddingDepth && overflowIsolates === 0 && overflowEmbeddings === 0) {
        validIsolates += 1;
        stack.push({ level, override: null, isolate: true, initiator: index });
      } else overflowIsolates += 1;
    } else if (type === "PDI") {
      if (overflowIsolates > 0) overflowIsolates -= 1;
      else if (validIsolates > 0) {
        overflowEmbeddings = 0;
        while (stack.length > 1 && stack.at(-1)?.isolate !== true) stack.pop();
        const isolate = stack.pop();
        if (isolate?.initiator !== null && isolate?.initiator !== undefined) {
          isolatePairs.set(isolate.initiator, index);
          isolatePairs.set(index, isolate.initiator);
        }
        validIsolates -= 1;
      }
      top = stack.at(-1) as DirectionalStatus;
      levels[index] = top.level;
      if (top.override !== null) types[index] = top.override;
    } else if (type === "PDF") {
      if (overflowIsolates === 0) {
        if (overflowEmbeddings > 0) overflowEmbeddings -= 1;
        else if (!top.isolate && stack.length > 1) stack.pop();
      }
      levels[index] = (stack.at(-1) as DirectionalStatus).level;
    } else if (type === "B") levels[index] = base;
    else {
      levels[index] = top.level;
      if (top.override !== null && type !== "BN") types[index] = top.override;
    }
  }

  const levelRuns: LevelRun[] = [];
  let current: number[] = [];
  let currentLevel = -1;
  for (let index = 0; index < items.length; index += 1) {
    checkCancellation(signal, index);
    const type = original[index];
    if (type === undefined || X9_CLASSES.has(type)) continue;
    if (current.length > 0 && levels[index] !== currentLevel) {
      const first = current[0] as number;
      const last = current.at(-1) as number;
      levelRuns.push({
        indices: Object.freeze(current), level: currentLevel,
        startsWithPdi: original[first] === "PDI",
        endsWithIsolate: ISOLATE_INITIATORS.has(original[last] as BidiClass)
      });
      current = [];
    }
    currentLevel = levels[index] ?? base;
    current.push(index);
  }
  if (current.length > 0) {
    const first = current[0] as number;
    const last = current.at(-1) as number;
    levelRuns.push({
      indices: Object.freeze(current), level: currentLevel,
      startsWithPdi: original[first] === "PDI",
      endsWithIsolate: ISOLATE_INITIATORS.has(original[last] as BidiClass)
    });
  }
  const runByFirst = new Map<number, LevelRun>();
  for (const [runIndex, run] of levelRuns.entries()) {
    checkCancellation(signal, runIndex);
    const first = run.indices[0];
    if (first !== undefined) runByFirst.set(first, run);
  }
  for (const run of levelRuns) {
    signal?.throwIfAborted();
    const first = run.indices[0];
    if (first === undefined || (run.startsWithPdi && isolatePairs.has(first))) continue;
    const sequenceRuns = [run];
    let tail = run;
    const visited = new Set<LevelRun>(sequenceRuns);
    while (tail.endsWithIsolate) {
      const initiator = tail.indices.at(-1);
      const pdi = initiator === undefined ? undefined : isolatePairs.get(initiator);
      const following = pdi === undefined ? undefined : runByFirst.get(pdi);
      if (following === undefined || visited.has(following)) break;
      sequenceRuns.push(following);
      visited.add(following);
      tail = following;
    }
    const sequence = sequenceRuns.flatMap((entry) => entry.indices);
    const sequenceFirst = sequence[0];
    const sequenceLast = sequence.at(-1);
    if (sequenceFirst === undefined || sequenceLast === undefined) continue;
    const firstLevel = levels[sequenceFirst] ?? base;
    const previousLevel = previousRetainedLevel(levels, original, sequenceFirst, base);
    const lastLevel = levels[sequenceLast] ?? base;
    const lastOriginalType = original[sequenceLast];
    if (lastOriginalType === undefined) continue;
    const nextLevel = ISOLATE_INITIATORS.has(lastOriginalType)
      ? base : nextRetainedLevel(levels, original, sequenceLast, base);
    resolveSequence(
      sequence, levels, types, original, items,
      (Math.max(previousLevel, firstLevel) & 1) === 0 ? "L" : "R",
      (Math.max(nextLevel, lastLevel) & 1) === 0 ? "L" : "R",
      signal
    );
  }

  const publicLevels: (BidiLevel | null)[] = [];
  for (let index = 0; index < items.length; index += 1) {
    checkCancellation(signal, index);
    const originalType = original[index];
    if (originalType === undefined || X9_CLASSES.has(originalType)) {
      publicLevels.push(null);
      continue;
    }
    let level = levels[index] ?? base;
    const type = types[index];
    if ((level & 1) === 0) {
      if (type === "R") level += 1;
      else if (type === "AN" || type === "EN") level += 2;
    } else if (type === "L" || type === "AN" || type === "EN") level += 1;
    levels[index] = level;
    publicLevels.push(level as BidiLevel);
  }

  const resetTrailing = (end: number): void => {
    for (let index = end; index >= 0; index -= 1) {
      checkCancellation(signal, end - index);
      const type = original[index];
      if (type === undefined || X9_CLASSES.has(type)) continue;
      if (!TRAILING_CLASSES.has(type)) break;
      publicLevels[index] = base as BidiLevel;
    }
  };
  for (let index = 0; index < items.length; index += 1) {
    checkCancellation(signal, index);
    const type = original[index];
    if (type === "B" || type === "S") resetTrailing(index);
  }
  resetTrailing(items.length - 1);

  const visual = visualRuns(publicLevels, budgets.maxBidiRuns, signal);
  const outcome: BidiOutcome = truncation !== null
    ? { status: "truncated", items: items.length, runs: visual.order.runs.length, budget: truncation, limit: budgets[truncation] }
    : visual.truncated
      ? { status: "truncated", items: items.length, runs: visual.order.runs.length, budget: "maxBidiRuns", limit: budgets.maxBidiRuns }
      : { status: "complete", items: items.length, runs: visual.order.runs.length };
  return Object.freeze({
    items,
    baseLevel: base as BidiLevel,
    embeddingLevels: Object.freeze(publicLevels),
    resolvedClasses: Object.freeze(types),
    visualOrder: visual.order,
    outcome: Object.freeze(outcome)
  });
}

function bidiItemsFromTextBounded<TIdentity>(
  value: string,
  identity: (startCodeUnit: number, endCodeUnit: number, codePoint: number) => TIdentity,
  maximumItems: number,
  signal?: AbortSignal
): readonly BidiItem<TIdentity>[] {
  const items: BidiItem<TIdentity>[] = [];
  let offset = 0;
  for (const character of value) {
    if (items.length >= maximumItems) break;
    signal?.throwIfAborted();
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const end = offset + character.length;
    items.push(Object.freeze({
      logicalIndex: items.length,
      kind: "code-point",
      text: character,
      codePoint,
      bidiClass: bidiClass(codePoint),
      sourceStartCodeUnit: offset,
      sourceEndCodeUnit: end,
      identity: identity(offset, end, codePoint)
    }));
    offset = end;
  }
  return Object.freeze(items);
}

export function bidiItemsFromText<TIdentity>(
  value: string,
  identity: (startCodeUnit: number, endCodeUnit: number, codePoint: number) => TIdentity,
  signal?: AbortSignal
): readonly BidiItem<TIdentity>[] {
  return bidiItemsFromTextBounded(value, identity, Number.MAX_SAFE_INTEGER, signal);
}

/** Splits UAX #9 paragraphs at Bidi_Class=B while retaining global item ranges. */
export function resolveBidiParagraphs<TIdentity>(
  inputItems: readonly BidiItem<TIdentity>[],
  directionInput: BidiParagraphDirectionInput = "auto",
  budgets: Partial<BidiBudgets> = {},
  signal?: AbortSignal
): BidiParagraphCollection<TIdentity> {
  const slices: BidiParagraphSlice<TIdentity>[] = [];
  let remainingItems = budgets.maxBidiItems ?? DEFAULT_BIDI_BUDGETS.maxBidiItems;
  let remainingRuns = budgets.maxBidiRuns ?? DEFAULT_BIDI_BUDGETS.maxBidiRuns;
  let start = 0;
  for (let index = 0; index <= inputItems.length; index += 1) {
    signal?.throwIfAborted();
    if (index < inputItems.length && inputItems[index]?.bidiClass !== "B") continue;
    const end = index < inputItems.length ? index + 1 : index;
    if (end > start || inputItems.length === 0) {
      const local = inputItems.slice(start, end).map((item, logicalIndex) => Object.freeze({ ...item, logicalIndex }));
      const direction = typeof directionInput === "function" ? directionInput(start, end) : directionInput;
      const paragraph = resolveBidiParagraph(local, direction, {
        ...budgets,
        maxBidiItems: remainingItems,
        maxBidiRuns: remainingRuns
      }, signal);
      slices.push(Object.freeze({
        itemStart: start,
        itemEnd: end,
        paragraph
      }));
      if (paragraph.outcome.status === "rejected") break;
      remainingItems = Math.max(0, remainingItems - paragraph.outcome.items);
      remainingRuns = Math.max(0, remainingRuns - paragraph.outcome.runs);
      if (paragraph.outcome.status === "truncated") break;
    }
    start = end;
  }
  return Object.freeze({ items: Object.freeze([...inputItems]), paragraphs: Object.freeze(slices) });
}

export function resolveBidiText(
  value: string,
  direction: BidiParagraphDirection = "auto",
  budgets: Partial<BidiBudgets> = {},
  signal?: AbortSignal
): BidiParagraph<null> {
  const normalized = normalizedBudgets(budgets);
  if (normalized === null) return resolveBidiParagraph([], direction, budgets, signal);
  const retainedLimit = Math.min(normalized.maxCodePointsPerParagraph, normalized.maxBidiItems);
  const scanLimit = retainedLimit === Number.MAX_SAFE_INTEGER ? retainedLimit : retainedLimit + 1;
  return resolveBidiParagraph(
    bidiItemsFromTextBounded(value, () => null, scanLimit, signal),
    direction,
    normalized,
    signal
  );
}

export function mirroredBidiText(paragraph: BidiParagraph, itemIndex: number): string {
  const item = paragraph.items[itemIndex];
  const level = paragraph.embeddingLevels[itemIndex];
  if (item?.codePoint === null || item === undefined || level === null || level === undefined || (level & 1) === 0) {
    return item?.text ?? "";
  }
  const mirrored = bidiMirroringGlyph(item.codePoint);
  return mirrored === null ? item.text : String.fromCodePoint(mirrored);
}
