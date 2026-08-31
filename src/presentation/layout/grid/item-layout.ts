import type { GridAreaPlacement, ResolvedGridTrack } from "./types.js";
import {
  cssAdd,
  cssMax,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength
} from "../fixed.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface ResolvedGridArea {
  readonly x: CssPixelLength;
  readonly y: CssPixelLength;
  readonly width: CssNonNegativeLength;
  readonly height: CssNonNegativeLength;
}

function axisStart(
  start: number,
  tracks: readonly ResolvedGridTrack[]
): CssPixelLength {
  return tracks[start]?.offset ?? ZERO;
}

function axisSize(
  start: number,
  end: number,
  tracks: readonly ResolvedGridTrack[]
): CssNonNegativeLength {
  const first = tracks[start];
  const last = tracks[end - 1];
  if (first === undefined || last === undefined) return ZERO;
  return cssNonNegativeLength(cssMax(
    ZERO,
    cssAdd(cssAdd(last.offset, last.baseSize), cssMultiply(first.offset, -1))
  ));
}

export function resolvedGridArea(
  placement: GridAreaPlacement,
  columns: readonly ResolvedGridTrack[],
  rows: readonly ResolvedGridTrack[]
): ResolvedGridArea {
  return Object.freeze({
    x: axisStart(placement.columnStart, columns),
    y: axisStart(placement.rowStart, rows),
    width: axisSize(placement.columnStart, placement.columnEnd, columns),
    height: axisSize(placement.rowStart, placement.rowEnd, rows)
  });
}
