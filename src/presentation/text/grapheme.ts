import {
  graphemeBreakClass,
  indicConjunctBreak,
  isExtendedPictographic,
  type GraphemeBreakClass
} from "./unicode-properties.js";

export interface GraphemeCluster {
  readonly text: string;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly codePointStart: number;
  readonly codePointEnd: number;
}

export interface GraphemeClusterBudgets {
  readonly maxGraphemeClusters: number;
}

export type GraphemeClusterOutcome =
  | { readonly status: "complete"; readonly clusters: number }
  | {
      readonly status: "truncated";
      readonly clusters: number;
      readonly budget: "maxGraphemeClusters";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-budget" };

export interface GraphemeClusterStream {
  readonly value: string;
  readonly clusters: readonly GraphemeCluster[];
  readonly outcome: GraphemeClusterOutcome;
}

interface CodePointUnit {
  readonly value: number;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly grapheme: GraphemeBreakClass;
}

function units(value: string, signal: AbortSignal | undefined): readonly CodePointUnit[] {
  const result: CodePointUnit[] = [];
  let offset = 0;
  for (const character of value) {
    signal?.throwIfAborted();
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    result.push(Object.freeze({
      value: codePoint,
      startCodeUnit: offset,
      endCodeUnit: offset + character.length,
      grapheme: graphemeBreakClass(codePoint)
    }));
    offset += character.length;
  }
  return result;
}

interface BoundaryState {
  readonly afterIndicLinker: boolean;
  readonly afterExtendedPictographicZwj: boolean;
  readonly precedingRegionalIndicators: number;
}

function boundaryStates(points: readonly CodePointUnit[]): readonly BoundaryState[] {
  const states: BoundaryState[] = [{
    afterIndicLinker: false,
    afterExtendedPictographicZwj: false,
    precedingRegionalIndicators: 0
  }];
  let indicState: 0 | 1 | 2 = 0;
  let pictographicState: 0 | 1 | 2 = 0;
  let regionalIndicators = 0;
  for (const point of points) {
    const indic = indicConjunctBreak(point.value);
    if (indic === "Consonant") indicState = 1;
    else if (indic === "Linker") indicState = indicState === 0 ? 0 : 2;
    else if (indic !== "Extend") indicState = 0;
    if (isExtendedPictographic(point.value)) pictographicState = 1;
    else if (point.grapheme === "Extend" && pictographicState === 1) pictographicState = 1;
    else if (point.grapheme === "ZWJ" && pictographicState === 1) pictographicState = 2;
    else pictographicState = 0;
    regionalIndicators = point.grapheme === "Regional_Indicator" ? regionalIndicators + 1 : 0;
    states.push(Object.freeze({
      afterIndicLinker: indicState === 2,
      afterExtendedPictographicZwj: pictographicState === 2,
      precedingRegionalIndicators: regionalIndicators
    }));
  }
  return states;
}

function breaksBefore(points: readonly CodePointUnit[], states: readonly BoundaryState[], index: number): boolean {
  const previous = points[index - 1];
  const current = points[index];
  if (previous === undefined || current === undefined) return true;
  const left = previous.grapheme;
  const right = current.grapheme;
  if (left === "CR" && right === "LF") return false;
  if (left === "Control" || left === "CR" || left === "LF") return true;
  if (right === "Control" || right === "CR" || right === "LF") return true;
  if (left === "L" && (right === "L" || right === "V" || right === "LV" || right === "LVT")) return false;
  if ((left === "LV" || left === "V") && (right === "V" || right === "T")) return false;
  if ((left === "LVT" || left === "T") && right === "T") return false;
  if (right === "Extend" || right === "ZWJ" || right === "SpacingMark") return false;
  if (left === "Prepend") return false;
  const state = states[index];
  if (indicConjunctBreak(current.value) === "Consonant" && state?.afterIndicLinker === true) return false;
  if (isExtendedPictographic(current.value) && state?.afterExtendedPictographicZwj === true) return false;
  if (left === "Regional_Indicator" && right === "Regional_Indicator") {
    return (state?.precedingRegionalIndicators ?? 0) % 2 === 0;
  }
  return true;
}

function asciiClusters(
  value: string,
  limit: number,
  signal: AbortSignal | undefined
): GraphemeClusterStream | null {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return null;
  }
  const clusters: GraphemeCluster[] = [];
  for (let index = 0; index < value.length;) {
    signal?.throwIfAborted();
    if (clusters.length >= limit) {
      return Object.freeze({
        value,
        clusters: Object.freeze(clusters),
        outcome: Object.freeze({ status: "truncated", clusters: clusters.length, budget: "maxGraphemeClusters", limit })
      });
    }
    const end = value.charCodeAt(index) === 0x0d && value.charCodeAt(index + 1) === 0x0a ? index + 2 : index + 1;
    clusters.push(Object.freeze({
      text: value.slice(index, end),
      startCodeUnit: index,
      endCodeUnit: end,
      codePointStart: index,
      codePointEnd: end
    }));
    index = end;
  }
  return Object.freeze({
    value,
    clusters: Object.freeze(clusters),
    outcome: Object.freeze({ status: "complete", clusters: clusters.length })
  });
}

/** Unicode 17.0.0 UAX #29 extended grapheme clusters with exact UTF-16 source ranges. */
export function segmentGraphemeClusters(
  value: string,
  budgets: Partial<GraphemeClusterBudgets> = {},
  signal?: AbortSignal
): GraphemeClusterStream {
  const limit = budgets.maxGraphemeClusters ?? 1_000_000;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return Object.freeze({
      value,
      clusters: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason: "invalid-budget" })
    });
  }
  const ascii = asciiClusters(value, limit, signal);
  if (ascii !== null) return ascii;
  const points = units(value, signal);
  const states = boundaryStates(points);
  const clusters: GraphemeCluster[] = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    signal?.throwIfAborted();
    if (index < points.length && !breaksBefore(points, states, index)) continue;
    if (clusters.length >= limit) {
      return Object.freeze({
        value,
        clusters: Object.freeze(clusters),
        outcome: Object.freeze({
          status: "truncated",
          clusters: clusters.length,
          budget: "maxGraphemeClusters",
          limit
        })
      });
    }
    const first = points[start];
    const last = points[index - 1];
    if (first !== undefined && last !== undefined) {
      clusters.push(Object.freeze({
        text: value.slice(first.startCodeUnit, last.endCodeUnit),
        startCodeUnit: first.startCodeUnit,
        endCodeUnit: last.endCodeUnit,
        codePointStart: start,
        codePointEnd: index
      }));
    }
    start = index;
  }
  return Object.freeze({
    value,
    clusters: Object.freeze(clusters),
    outcome: Object.freeze({ status: "complete", clusters: clusters.length })
  });
}
