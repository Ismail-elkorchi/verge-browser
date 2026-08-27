import type { CssGridTrackBreadth, CssGridTrackSizingFunction, CssLength } from "../../style/index.js";
import {
  cssAdd,
  cssDivide,
  cssMax,
  cssMin,
  cssMultiply,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength
} from "../fixed.js";
import {
  GridWorkBudgetExceeded,
  type GridItemContribution,
  type GridTrackSizingInput,
  type GridTrackSizingResult,
  type ResolvedGridTrack
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

function requiresPercentageBasis(value: CssLength): boolean {
  return value.kind === "length" ? value.unit === "%"
    : value.kind === "calculation" && value.calculation.percentageDependence !== "none";
}

interface MutableTrack {
  readonly index: number;
  readonly sizing: CssGridTrackSizingFunction;
  readonly collapsed: boolean;
  readonly flexFactor: number;
  readonly intrinsicMinimum: boolean;
  readonly minContentMinimum: boolean;
  readonly maxContentMinimum: boolean;
  readonly intrinsicMaximum: boolean;
  readonly minContentMaximum: boolean;
  readonly automaticMaximum: boolean;
  readonly fitContentLimit: CssNonNegativeLength | null;
  base: CssNonNegativeLength;
  growth: CssNonNegativeLength | null;
  offset: CssPixelLength;
}

interface TrackSizingWork {
  used: number;
  readonly input: GridTrackSizingInput;
}

function consume(work: TrackSizingWork, amount = 1): void {
  work.input.signal?.throwIfAborted();
  if (amount > work.input.maxWork - work.used) {
    throw new GridWorkBudgetExceeded("maxGridTrackSizingWork", work.input.maxWork);
  }
  work.used += amount;
}

function breadthLength(
  breadth: CssGridTrackBreadth,
  input: GridTrackSizingInput
): CssNonNegativeLength | null {
  if (breadth.kind !== "length") return null;
  const value = input.resolveLength(breadth.value, input.availableSize);
  return value === null ? null : cssNonNegativeLength(cssMax(ZERO, value));
}

function flexFactor(sizing: CssGridTrackSizingFunction): number {
  if (sizing.kind === "breadth" && sizing.breadth.kind === "flex") return sizing.breadth.factor;
  if (sizing.kind === "minmax" && sizing.maximum.kind === "flex") return sizing.maximum.factor;
  return 0;
}

function initializeTrack(
  sizing: CssGridTrackSizingFunction,
  index: number,
  collapsed: boolean,
  input: GridTrackSizingInput
): MutableTrack {
  if (collapsed) return {
    index,
    sizing,
    collapsed,
    flexFactor: 0,
    intrinsicMinimum: false,
    minContentMinimum: false,
    maxContentMinimum: false,
    intrinsicMaximum: false,
    minContentMaximum: false,
    automaticMaximum: false,
    fitContentLimit: null,
    base: ZERO,
    growth: ZERO,
    offset: ZERO
  };
  const minimum = sizing.kind === "breadth" ? sizing.breadth
    : sizing.kind === "minmax" ? sizing.minimum : { kind: "auto" as const };
  const maximum = sizing.kind === "breadth" ? sizing.breadth
    : sizing.kind === "minmax" ? sizing.maximum : { kind: "auto" as const };
  const minimumLength = breadthLength(minimum, input);
  const maximumLength = breadthLength(maximum, input);
  const unresolvedMinimumPercentage = minimum.kind === "length" && minimumLength === null
    && requiresPercentageBasis(minimum.value);
  const unresolvedMaximumPercentage = maximum.kind === "length" && maximumLength === null
    && requiresPercentageBasis(maximum.value);
  const minimumIsIntrinsic = minimum.kind === "auto" || minimum.kind === "min-content" || minimum.kind === "max-content"
    || minimum.kind === "flex" || unresolvedMinimumPercentage;
  const maximumIsIntrinsic = maximum.kind === "auto" || maximum.kind === "min-content" || maximum.kind === "max-content"
    || unresolvedMaximumPercentage;
  const base = minimumLength ?? ZERO;
  let growth = maximumLength;
  const resolvedFitContentLimit = sizing.kind === "fit-content"
    ? input.resolveLength(sizing.limit, input.availableSize)
    : null;
  const fitContentLimit = resolvedFitContentLimit === null
    ? null
    : cssNonNegativeLength(cssMax(base, resolvedFitContentLimit));
  if (sizing.kind === "fit-content") growth = null;
  if (growth !== null) growth = cssNonNegativeLength(cssMax(base, growth));
  return {
    index,
    sizing,
    collapsed,
    flexFactor: flexFactor(sizing),
    intrinsicMinimum: minimumIsIntrinsic,
    minContentMinimum: minimum.kind === "min-content",
    maxContentMinimum: minimum.kind === "max-content",
    intrinsicMaximum: maximumIsIntrinsic || sizing.kind === "fit-content",
    minContentMaximum: maximum.kind === "min-content",
    automaticMaximum: sizing.kind !== "fit-content" && (maximum.kind === "auto" || unresolvedMaximumPercentage),
    fitContentLimit,
    base,
    growth,
    offset: ZERO
  };
}

function activeTrackCount(tracks: readonly MutableTrack[]): number {
  return tracks.reduce((count, track) => count + (track.collapsed ? 0 : 1), 0);
}

function trackGapTotal(tracks: readonly MutableTrack[], gap: CssPixelLength): CssPixelLength {
  return cssMultiply(gap, Math.max(0, activeTrackCount(tracks) - 1));
}

function spanBase(tracks: readonly MutableTrack[], item: GridItemContribution, gap: CssPixelLength): CssPixelLength {
  let total: CssPixelLength = ZERO;
  let active = 0;
  for (let index = item.start; index < item.end; index += 1) {
    const track = tracks[index];
    if (track === undefined || track.collapsed) continue;
    total = cssAdd(total, track.base);
    active += 1;
  }
  return cssAdd(total, cssMultiply(gap, Math.max(0, active - 1)));
}

function distributeBase(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  target: CssPixelLength,
  gap: CssPixelLength,
  work: TrackSizingWork,
  excludeFlexible: boolean
): void {
  let deficit = cssMax(ZERO, cssAdd(target, cssMultiply(spanBase(tracks, item, gap), -1)));
  let candidates = tracks.slice(item.start, item.end)
    .filter((track) => !track.collapsed && track.intrinsicMinimum && (!excludeFlexible || track.flexFactor === 0));
  if (candidates.length === 0) {
    candidates = tracks.slice(item.start, item.end)
      .filter((track) => !track.collapsed && track.intrinsicMinimum);
  }
  while (deficit > 0 && candidates.length > 0) {
    consume(work, candidates.length);
    const share = cssDivide(deficit, candidates.length);
    let distributed: CssPixelLength = ZERO;
    const next: MutableTrack[] = [];
    for (const track of candidates) {
      const growth = share;
      track.base = cssNonNegativeLength(cssAdd(track.base, growth));
      distributed = cssAdd(distributed, growth);
      next.push(track);
    }
    if (distributed <= 0) break;
    deficit = cssMax(ZERO, cssAdd(deficit, cssMultiply(distributed, -1)));
    candidates = next;
  }
}

function distributeGrowthLimit(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  target: CssPixelLength,
  gap: CssNonNegativeLength,
  work: TrackSizingWork,
  usesMinContent: boolean
): void {
  const spanned = tracks.slice(item.start, item.end).filter((track) => !track.collapsed);
  let current: CssPixelLength = cssMultiply(gap, Math.max(0, spanned.length - 1));
  for (const track of spanned) current = cssAdd(current, track.growth ?? track.base);
  let deficit = cssMax(ZERO, cssAdd(target, cssMultiply(current, -1)));
  let candidates = spanned.filter((track) => track.intrinsicMaximum && track.flexFactor === 0
    && track.minContentMaximum === usesMinContent);
  while (deficit > 0 && candidates.length > 0) {
    consume(work, candidates.length);
    const share = cssDivide(deficit, candidates.length);
    let distributed: CssPixelLength = ZERO;
    const next: MutableTrack[] = [];
    for (const track of candidates) {
      const currentLimit = track.growth ?? track.base;
      let permitted = share;
      if (track.fitContentLimit !== null) {
        permitted = cssMin(permitted, cssMax(ZERO, cssAdd(track.fitContentLimit, cssMultiply(currentLimit, -1))));
      }
      track.growth = cssNonNegativeLength(cssAdd(currentLimit, permitted));
      distributed = cssAdd(distributed, permitted);
      if (permitted === share) next.push(track);
    }
    if (distributed <= 0) break;
    deficit = cssMax(ZERO, cssAdd(deficit, cssMultiply(distributed, -1)));
    candidates = next;
  }
}

function resolveIntrinsicContributions(
  tracks: readonly MutableTrack[],
  contributions: readonly GridItemContribution[],
  gap: CssNonNegativeLength,
  work: TrackSizingWork
): void {
  const ordered = [...contributions].sort((left, right) =>
    (left.end - left.start) - (right.end - right.start) || left.start - right.start);
  for (const item of ordered) {
    consume(work);
    if (item.end <= item.start || item.start < 0 || item.end > tracks.length) continue;
    const spanned = tracks.slice(item.start, item.end).filter((track) => !track.collapsed);
    const baseTarget = spanned.some((track) => track.maxContentMinimum)
      ? item.maxContent
      : spanned.some((track) => track.minContentMinimum)
        ? item.minContent
        : item.minimumContribution;
    distributeBase(tracks, item, baseTarget, gap, work, true);
    distributeGrowthLimit(tracks, item, item.minContent, gap, work, true);
    distributeGrowthLimit(tracks, item, item.maxContent, gap, work, false);
  }
  for (const track of tracks) {
    if (track.intrinsicMaximum && track.growth === null) track.growth = track.base;
    if (track.growth !== null) track.growth = cssNonNegativeLength(cssMax(track.base, track.growth));
  }
}

function maximizeTracks(tracks: readonly MutableTrack[], input: GridTrackSizingInput, work: TrackSizingWork): void {
  if (input.availableSize === null) return;
  let used = trackGapTotal(tracks, input.gap);
  for (const track of tracks) used = cssAdd(used, track.base);
  let free = cssMax(ZERO, cssAdd(input.availableSize, cssMultiply(used, -1)));
  let growable = tracks.filter((track) => !track.collapsed && track.flexFactor === 0
    && (track.growth === null || track.base < track.growth));
  while (free > 0 && growable.length > 0) {
    consume(work, growable.length);
    const share = cssDivide(free, growable.length);
    let distributed: CssPixelLength = ZERO;
    const next: MutableTrack[] = [];
    for (const track of growable) {
      const room = track.growth === null ? share : cssAdd(track.growth, cssMultiply(track.base, -1));
      const growth = cssMin(share, cssMax(ZERO, room));
      track.base = cssNonNegativeLength(cssAdd(track.base, growth));
      distributed = cssAdd(distributed, growth);
      if (track.growth === null || track.base < track.growth) next.push(track);
    }
    if (distributed <= 0) break;
    free = cssMax(ZERO, cssAdd(free, cssMultiply(distributed, -1)));
    growable = next;
  }
}

function expandFlexibleTracks(
  tracks: readonly MutableTrack[],
  input: GridTrackSizingInput,
  contributions: readonly GridItemContribution[],
  work: TrackSizingWork
): void {
  const flexible = tracks.filter((track) => !track.collapsed && track.flexFactor > 0);
  if (flexible.length === 0) return;
  consume(work, flexible.length);
  let fraction: CssPixelLength = ZERO;
  if (input.availableSize !== null) {
    const frozen = new Set<MutableTrack>();
    for (;;) {
      consume(work, flexible.length);
      let occupied: CssPixelLength = trackGapTotal(tracks, input.gap);
      for (const track of tracks) {
        if (track.flexFactor === 0 || frozen.has(track)) occupied = cssAdd(occupied, track.base);
      }
      const remaining = cssMax(ZERO, cssAdd(input.availableSize, cssMultiply(occupied, -1)));
      const factors = flexible.reduce((sum, track) => frozen.has(track) ? sum : sum + track.flexFactor, 0);
      fraction = factors <= 0 ? ZERO : cssDivide(remaining, Math.max(1, factors));
      const newlyFrozen = flexible.filter((track) => !frozen.has(track)
        && track.base > cssMultiply(fraction, track.flexFactor));
      if (newlyFrozen.length === 0) break;
      for (const track of newlyFrozen) frozen.add(track);
      if (frozen.size === flexible.length) break;
    }
  } else {
    for (const track of flexible) fraction = cssMax(fraction, cssDivide(track.base, Math.max(1, track.flexFactor)));
    for (const item of contributions) {
      const spanned = tracks.slice(item.start, item.end).filter((track) => !track.collapsed);
      const itemFlexible = spanned.filter((track) => track.flexFactor > 0);
      if (itemFlexible.length === 0) continue;
      const frozen = new Set<MutableTrack>();
      let itemFraction: CssPixelLength = ZERO;
      for (;;) {
        consume(work, spanned.length);
        let occupied = cssMultiply(input.gap, Math.max(0, spanned.length - 1));
        for (const track of spanned) {
          if (track.flexFactor === 0 || frozen.has(track)) occupied = cssAdd(occupied, track.base);
        }
        const remaining = cssMax(ZERO, cssAdd(item.maxContent, cssMultiply(occupied, -1)));
        const factors = itemFlexible.reduce(
          (sum, track) => frozen.has(track) ? sum : sum + track.flexFactor,
          0
        );
        itemFraction = factors <= 0 ? ZERO : cssDivide(remaining, Math.max(1, factors));
        const newlyFrozen = itemFlexible.filter((track) => !frozen.has(track)
          && track.base > cssMultiply(itemFraction, track.flexFactor));
        if (newlyFrozen.length === 0 || frozen.size + newlyFrozen.length === itemFlexible.length) break;
        for (const track of newlyFrozen) frozen.add(track);
      }
      fraction = cssMax(fraction, itemFraction);
    }
  }
  for (const track of flexible) {
    track.base = cssNonNegativeLength(cssMax(track.base, cssMultiply(fraction, track.flexFactor)));
  }
  if (input.availableSize !== null
    && flexible.reduce((sum, track) => sum + track.flexFactor, 0) >= 1) {
    let used: CssPixelLength = trackGapTotal(tracks, input.gap);
    for (const track of tracks) used = cssAdd(used, track.base);
    let remainder = cssMax(ZERO, cssAdd(input.availableSize, cssMultiply(used, -1)));
    for (let index = 0; index < flexible.length && remainder > 0; index += 1) {
      const track = flexible[index];
      if (track === undefined) continue;
      const addition = cssDivide(remainder, flexible.length - index);
      track.base = cssNonNegativeLength(cssAdd(track.base, addition));
      remainder = cssMax(ZERO, cssAdd(remainder, cssMultiply(addition, -1)));
    }
  }
}

function alignTracks(tracks: readonly MutableTrack[], input: GridTrackSizingInput): {
  readonly leading: CssPixelLength;
  readonly gap: CssNonNegativeLength;
} {
  let used: CssPixelLength = trackGapTotal(tracks, input.gap);
  for (const track of tracks) used = cssAdd(used, track.base);
  const free = input.availableSize === null ? ZERO : cssMax(ZERO, cssAdd(input.availableSize, cssMultiply(used, -1)));
  const active = activeTrackCount(tracks);
  if (input.alignment === "stretch" && free > 0) {
    const automatic = tracks.filter((track) => !track.collapsed && track.automaticMaximum && track.flexFactor === 0);
    if (automatic.length > 0) {
      let remaining = free;
      for (let index = 0; index < automatic.length; index += 1) {
        const growth = cssDivide(remaining, automatic.length - index);
        const track = automatic[index];
        if (track === undefined) continue;
        track.base = cssNonNegativeLength(cssAdd(track.base, growth));
        remaining = cssAdd(remaining, cssMultiply(growth, -1));
      }
      return { leading: ZERO, gap: input.gap };
    }
  }
  if (input.alignment === "end") return { leading: free, gap: input.gap };
  if (input.alignment === "center") return { leading: cssDivide(free, 2), gap: input.gap };
  if (active <= 0) return { leading: ZERO, gap: input.gap };
  if (input.alignment === "space-between" && active > 1) {
    return { leading: ZERO, gap: cssNonNegativeLength(cssAdd(input.gap, cssDivide(free, active - 1))) };
  }
  if (input.alignment === "space-around") {
    const space = cssDivide(free, active);
    return { leading: cssDivide(space, 2), gap: cssNonNegativeLength(cssAdd(input.gap, space)) };
  }
  if (input.alignment === "space-evenly") {
    const space = cssDivide(free, active + 1);
    return { leading: space, gap: cssNonNegativeLength(cssAdd(input.gap, space)) };
  }
  return { leading: ZERO, gap: input.gap };
}

export function sizeGridTracks(input: GridTrackSizingInput): GridTrackSizingResult {
  const work: TrackSizingWork = { used: 0, input };
  const tracks: MutableTrack[] = [];
  for (let index = 0; index < input.tracks.length; index += 1) {
    consume(work);
    const sizing = input.tracks[index];
    if (sizing !== undefined) tracks.push(initializeTrack(
      sizing,
      index,
      input.collapsedTracks?.has(index) ?? false,
      input
    ));
  }
  resolveIntrinsicContributions(tracks, input.contributions, input.gap, work);
  maximizeTracks(tracks, input, work);
  expandFlexibleTracks(tracks, input, input.contributions, work);
  const alignment = alignTracks(tracks, input);
  let offset: CssPixelLength = alignment.leading;
  let previousActive = false;
  for (const track of tracks) {
    if (!track.collapsed && previousActive) offset = cssAdd(offset, alignment.gap);
    track.offset = offset;
    offset = cssAdd(offset, track.base);
    if (!track.collapsed) previousActive = true;
  }
  let used: CssPixelLength = trackGapTotal(tracks, alignment.gap);
  for (const track of tracks) used = cssAdd(used, track.base);
  const resolved: ResolvedGridTrack[] = tracks.map((track) => Object.freeze({
    index: track.index,
    baseSize: track.base,
    growthLimit: track.growth,
    flexFactor: track.flexFactor,
    collapsed: track.collapsed,
    offset: track.offset
  }));
  return Object.freeze({
    tracks: Object.freeze(resolved),
    usedSize: cssNonNegativeLength(cssMax(ZERO, used)),
    leadingSpace: alignment.leading,
    distributedGap: alignment.gap,
    work: work.used
  });
}
