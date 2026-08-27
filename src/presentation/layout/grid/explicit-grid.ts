import type {
  CssGridTemplateAreas,
  CssGridTrackList,
  CssGridTrackListEntry,
  CssGridTrackSizingFunction,
  CssLength
} from "../../style/index.js";
import {
  cssAdd,
  cssDivide,
  cssMax,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength
} from "../fixed.js";
import { GridWorkBudgetExceeded, type ExpandedGridAxis, type GridWorkLimits } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function resolvedAutoRepeatSize(
  sizing: CssGridTrackSizingFunction,
  available: CssPixelLength | null,
  resolveLength: (value: CssLength, basis: CssPixelLength | null) => CssPixelLength | null
): CssNonNegativeLength {
  if (sizing.kind === "fit-content") return ZERO;
  if (sizing.kind === "breadth") {
    return sizing.breadth.kind === "length"
      ? cssNonNegativeLength(cssMax(ZERO, resolveLength(sizing.breadth.value, available) ?? ZERO))
      : ZERO;
  }
  const minimum = sizing.minimum.kind === "length"
    ? resolveLength(sizing.minimum.value, available)
    : null;
  const maximum = sizing.maximum.kind === "length"
    ? resolveLength(sizing.maximum.value, available)
    : null;
  return cssNonNegativeLength(cssMax(ZERO, cssMax(maximum ?? minimum ?? ZERO, minimum ?? ZERO)));
}

function repeatCount(
  entries: readonly Exclude<CssGridTrackListEntry, { readonly kind: "repeat" }>[],
  available: CssPixelLength | null,
  gap: CssNonNegativeLength,
  resolveLength: (value: CssLength, basis: CssPixelLength | null) => CssPixelLength | null
): number {
  const trackSizes = entries.filter((entry) => entry.kind === "track")
    .map((entry) => resolvedAutoRepeatSize(entry.sizing, available, resolveLength));
  if (available === null || trackSizes.length === 0) return 1;
  let cycle: CssPixelLength = cssMultiply(gap, Math.max(0, trackSizes.length - 1));
  for (const size of trackSizes) cycle = cssAdd(cycle, cssMax(cssPx(1), size));
  const cycleWithBoundaryGap = cssAdd(cycle, gap);
  if (cycleWithBoundaryGap <= 0) return 1;
  return Math.max(1, Math.floor(cssDivide(cssAdd(available, gap), cycleWithBoundaryGap)));
}

export function expandExplicitGridAxis(input: {
  readonly list: CssGridTrackList;
  readonly areas: CssGridTemplateAreas;
  readonly areaAxis: "row" | "column";
  readonly automaticTrackSizing: readonly CssGridTrackSizingFunction[];
  readonly availableSize: CssPixelLength | null;
  readonly gap: CssNonNegativeLength;
  readonly limits: GridWorkLimits;
  readonly resolveLength: (value: CssLength, basis: CssPixelLength | null) => CssPixelLength | null;
  readonly signal: AbortSignal | undefined;
}): ExpandedGridAxis {
  const tracks: CssGridTrackSizingFunction[] = [];
  const lineNames: string[][] = [[]];
  const autoFitTracks = new Set<number>();
  const appendNames = (names: readonly string[]): void => {
    lineNames.at(-1)?.push(...names);
  };
  const appendTrack = (sizing: CssGridTrackSizingFunction, autoFit: boolean): void => {
    input.signal?.throwIfAborted();
    if (tracks.length >= input.limits.maxExplicitGridTracks) {
      throw new GridWorkBudgetExceeded("maxExplicitGridTracks", input.limits.maxExplicitGridTracks);
    }
    tracks.push(sizing);
    if (autoFit) autoFitTracks.add(tracks.length - 1);
    lineNames.push([]);
  };
  const appendEntries = (
    entries: readonly Exclude<CssGridTrackListEntry, { readonly kind: "repeat" }>[],
    count: number,
    autoFit: boolean
  ): void => {
    for (let repetition = 0; repetition < count; repetition += 1) {
      for (const entry of entries) {
        if (entry.kind === "line-names") appendNames(entry.names);
        else appendTrack(entry.sizing, autoFit);
      }
    }
  };
  if (input.list.kind === "track-list") {
    let outsideSize: CssPixelLength = ZERO;
    let outsideTracks = 0;
    for (const entry of input.list.entries) {
      if (entry.kind === "track") {
        outsideSize = cssAdd(outsideSize, resolvedAutoRepeatSize(entry.sizing, input.availableSize, input.resolveLength));
        outsideTracks += 1;
      } else if (entry.kind === "repeat" && entry.repetition.kind === "fixed") {
        const repeatedTracks = entry.entries.filter((repeated) => repeated.kind === "track");
        for (const repeated of repeatedTracks) {
          outsideSize = cssAdd(
            outsideSize,
            cssMultiply(
              resolvedAutoRepeatSize(repeated.sizing, input.availableSize, input.resolveLength),
              entry.repetition.count
            )
          );
        }
        outsideTracks += repeatedTracks.length * entry.repetition.count;
      }
    }
    const autoRepeatAvailable = input.availableSize === null ? null : cssMax(
      ZERO,
      cssAdd(
        cssAdd(input.availableSize, cssMultiply(outsideSize, -1)),
        cssMultiply(input.gap, -outsideTracks)
      )
    );
    for (const entry of input.list.entries) {
      if (entry.kind === "line-names") appendNames(entry.names);
      else if (entry.kind === "track") appendTrack(entry.sizing, false);
      else {
        const count = entry.repetition.kind === "fixed" ? entry.repetition.count : repeatCount(
          entry.entries,
          autoRepeatAvailable,
          input.gap,
          input.resolveLength
        );
        const repeatedTrackCount = entry.entries.reduce(
          (total, repeated) => total + Number(repeated.kind === "track"),
          0
        ) * count;
        if (entry.repetition.kind !== "fixed" && repeatedTrackCount > input.limits.maxGridAutoRepeatTracks) {
          throw new GridWorkBudgetExceeded("maxGridAutoRepeatTracks", input.limits.maxGridAutoRepeatTracks);
        }
        appendEntries(entry.entries, count, entry.repetition.kind === "auto-fit");
      }
    }
  }
  if (input.areas.kind === "areas") {
    const areaTrackCount = input.areaAxis === "column" ? input.areas.rows[0]?.length ?? 0 : input.areas.rows.length;
    const firstUnsizedTrack = tracks.length;
    while (tracks.length < areaTrackCount) {
      const automatic = input.automaticTrackSizing[
        (tracks.length - firstUnsizedTrack) % input.automaticTrackSizing.length
      ];
      if (automatic === undefined) throw new RangeError("Automatic Grid track sizing sequence must not be empty.");
      appendTrack(automatic, false);
    }
    for (const area of input.areas.areas.values()) {
      const start = input.areaAxis === "column" ? area.columnStart : area.rowStart;
      const end = input.areaAxis === "column" ? area.columnEnd : area.rowEnd;
      lineNames[start]?.push(`${area.name}-start`);
      lineNames[end]?.push(`${area.name}-end`);
    }
  }
  const namedLines = new Map<string, number[]>();
  for (let line = 0; line < lineNames.length; line += 1) {
    for (const name of lineNames[line] ?? []) {
      const positions = namedLines.get(name) ?? [];
      positions.push(line);
      namedLines.set(name, positions);
    }
  }
  return Object.freeze({
    tracks: Object.freeze(tracks),
    lineNames: Object.freeze(lineNames.map((names) => Object.freeze([...new Set(names)]))),
    namedLines,
    autoFitTracks
  });
}
