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
  type GridTrackGrowthLimit,
  type GridTrackSizingFunctionCategory,
  type GridTrackSizingInput,
  type GridTrackSizingResult,
  type ResolvedGridTrack
} from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));
const INFINITE_GROWTH_LIMIT: GridTrackGrowthLimit = Object.freeze({ kind: "infinite" });

type ContributionPhase =
  | "intrinsic-minimum"
  | "content-based-minimum"
  | "max-content-minimum"
  | "intrinsic-maximum"
  | "max-content-maximum"
  | "flexible-crossing-minimum";

interface MutableTrack {
  readonly index: number;
  readonly sizing: CssGridTrackSizingFunction;
  readonly minimum: CssGridTrackBreadth;
  readonly maximum: CssGridTrackBreadth;
  readonly minimumCategory: GridTrackSizingFunctionCategory;
  readonly maximumCategory: GridTrackSizingFunctionCategory;
  readonly collapsed: boolean;
  readonly flexFactor: number;
  readonly fitContentLimit: CssNonNegativeLength | null;
  baseSize: CssNonNegativeLength;
  growthLimit: GridTrackGrowthLimit;
  infinitelyGrowable: boolean;
  plannedIncrease: CssNonNegativeLength;
  offset: CssPixelLength;
}

interface TrackSizingWork {
  used: number;
  readonly input: GridTrackSizingInput;
}

interface AlignmentResult {
  readonly leading: CssPixelLength;
  readonly boundaryExtra: CssNonNegativeLength;
}

interface IncurredIncreases {
  readonly affected: readonly MutableTrack[];
  readonly increases: ReadonlyMap<MutableTrack, CssNonNegativeLength>;
}

function consume(work: TrackSizingWork, amount = 1): void {
  work.input.signal?.throwIfAborted();
  if (amount > work.input.maxWork - work.used) {
    throw new GridWorkBudgetExceeded("maxGridTrackSizingWork", work.input.maxWork);
  }
  work.used += amount;
}

function sum(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return cssAdd(left, right);
}

function difference(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return cssAdd(left, cssMultiply(right, -1));
}

function nonNegative(value: CssPixelLength): CssNonNegativeLength {
  return cssNonNegativeLength(cssMax(ZERO, value));
}

function requiresPercentageBasis(value: CssLength): boolean {
  return value.kind === "length" ? value.unit === "%"
    : value.kind === "calculation" && value.calculation.percentageDependence !== "none";
}

function breadthLength(
  breadth: CssGridTrackBreadth,
  input: GridTrackSizingInput
): CssNonNegativeLength | null {
  if (breadth.kind !== "length") return null;
  const value = input.resolveLength(breadth.value, input.availableSize);
  return value === null ? null : nonNegative(value);
}

function minimumBreadth(sizing: CssGridTrackSizingFunction): CssGridTrackBreadth {
  if (sizing.kind === "minmax") return sizing.minimum;
  if (sizing.kind === "fit-content") return Object.freeze({ kind: "auto" });
  return sizing.breadth.kind === "flex" ? Object.freeze({ kind: "auto" }) : sizing.breadth;
}

function maximumBreadth(sizing: CssGridTrackSizingFunction): CssGridTrackBreadth {
  if (sizing.kind === "minmax") return sizing.maximum;
  if (sizing.kind === "fit-content") return Object.freeze({ kind: "max-content" });
  return sizing.breadth;
}

function breadthCategory(
  breadth: CssGridTrackBreadth,
  resolved: CssNonNegativeLength | null
): GridTrackSizingFunctionCategory {
  if (breadth.kind === "flex") return "flexible";
  if (breadth.kind === "auto") return "automatic";
  if (breadth.kind !== "length") return "content-based";
  return resolved === null && requiresPercentageBasis(breadth.value) ? "automatic" : "fixed";
}

function flexFactor(sizing: CssGridTrackSizingFunction): number {
  const maximum = maximumBreadth(sizing);
  return maximum.kind === "flex" ? maximum.factor : 0;
}

function initializeTrack(
  sizing: CssGridTrackSizingFunction,
  index: number,
  collapsed: boolean,
  input: GridTrackSizingInput
): MutableTrack {
  const minimum = minimumBreadth(sizing);
  const maximum = maximumBreadth(sizing);
  if (collapsed) return {
    index,
    sizing,
    minimum,
    maximum,
    minimumCategory: "fixed",
    maximumCategory: "fixed",
    collapsed,
    flexFactor: 0,
    fitContentLimit: ZERO,
    baseSize: ZERO,
    growthLimit: Object.freeze({ kind: "finite", value: ZERO }),
    infinitelyGrowable: false,
    plannedIncrease: ZERO,
    offset: ZERO
  };
  const resolvedMinimum = breadthLength(minimum, input);
  const resolvedMaximum = breadthLength(maximum, input);
  const minimumCategory = breadthCategory(minimum, resolvedMinimum);
  const maximumCategory = sizing.kind === "fit-content"
    ? "intrinsic"
    : breadthCategory(maximum, resolvedMaximum);
  const baseSize = minimumCategory === "fixed" ? resolvedMinimum ?? ZERO : ZERO;
  const growthLimit: GridTrackGrowthLimit = maximumCategory === "fixed"
    ? Object.freeze({ kind: "finite", value: nonNegative(cssMax(baseSize, resolvedMaximum ?? ZERO)) })
    : INFINITE_GROWTH_LIMIT;
  const resolvedFitContentLimit = sizing.kind === "fit-content"
    ? input.resolveLength(sizing.limit, input.availableSize)
    : null;
  return {
    index,
    sizing,
    minimum,
    maximum,
    minimumCategory,
    maximumCategory,
    collapsed,
    flexFactor: flexFactor(sizing),
    fitContentLimit: resolvedFitContentLimit === null ? null : nonNegative(resolvedFitContentLimit),
    baseSize,
    growthLimit,
    infinitelyGrowable: false,
    plannedIncrease: ZERO,
    offset: ZERO
  };
}

function activeGutterBoundaries(
  tracks: readonly MutableTrack[],
  work: TrackSizingWork
): readonly boolean[] {
  const boundaries: boolean[] = [];
  for (let index = 0; index + 1 < tracks.length; index += 1) {
    consume(work);
    boundaries.push(!(tracks[index]?.collapsed ?? true) && !(tracks[index + 1]?.collapsed ?? true));
  }
  return Object.freeze(boundaries);
}

function gutterTotal(
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  start = 0,
  end = boundaries.length + 1,
  work?: TrackSizingWork
): CssPixelLength {
  let total: CssPixelLength = ZERO;
  for (let boundary = Math.max(0, start); boundary < Math.min(boundaries.length, end - 1); boundary += 1) {
    if (work !== undefined) consume(work);
    if (boundaries[boundary]) total = sum(total, gap);
  }
  return total;
}

function validContribution(item: GridItemContribution, trackCount: number): boolean {
  return item.start >= 0 && item.end > item.start && item.end <= trackCount;
}

function tracksForItem(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  work: TrackSizingWork
): readonly MutableTrack[] {
  const result: MutableTrack[] = [];
  for (let index = item.start; index < item.end; index += 1) {
    consume(work);
    const track = tracks[index];
    if (track !== undefined && !track.collapsed) result.push(track);
  }
  return result;
}

function selectTracks(
  tracks: readonly MutableTrack[],
  predicate: (track: MutableTrack) => boolean,
  work: TrackSizingWork
): MutableTrack[] {
  const selected: MutableTrack[] = [];
  for (const track of tracks) {
    consume(work);
    if (predicate(track)) selected.push(track);
  }
  return selected;
}

function baseSpanSize(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  work: TrackSizingWork
): CssPixelLength {
  let result = gutterTotal(boundaries, gap, item.start, item.end, work);
  for (const track of tracksForItem(tracks, item, work)) result = sum(result, track.baseSize);
  return result;
}

function growthSpanSize(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  work: TrackSizingWork
): CssPixelLength {
  let result = gutterTotal(boundaries, gap, item.start, item.end, work);
  for (const track of tracksForItem(tracks, item, work)) {
    result = sum(result, track.growthLimit.kind === "finite" ? track.growthLimit.value : track.baseSize);
  }
  return result;
}

function baseTarget(track: MutableTrack, item: GridItemContribution): CssNonNegativeLength | null {
  if (track.minimumCategory === "fixed" || track.flexFactor > 0) return null;
  if (track.minimum.kind === "max-content") return item.maxContent;
  if (track.minimum.kind === "min-content") return item.minContent;
  return item.minimumContribution;
}

function growthTarget(track: MutableTrack, item: GridItemContribution): CssNonNegativeLength | null {
  if (track.maximumCategory === "fixed" || track.maximumCategory === "flexible") return null;
  const target = track.maximum.kind === "min-content" ? item.minContent : item.maxContent;
  return track.fitContentLimit === null ? target : nonNegative(cssMin(target, track.fitContentLimit));
}

function resolveNonSpanningItems(
  tracks: readonly MutableTrack[],
  contributions: readonly GridItemContribution[],
  work: TrackSizingWork
): void {
  const baseCandidates = tracks.map(() => ZERO);
  const growthCandidates: (CssNonNegativeLength | null)[] = tracks.map(() => null);
  for (const item of contributions) {
    consume(work);
    if (!validContribution(item, tracks.length) || item.end - item.start !== 1) continue;
    const track = tracks[item.start];
    if (track === undefined || track.collapsed) continue;
    const base = baseTarget(track, item);
    if (base !== null) baseCandidates[track.index] = nonNegative(cssMax(baseCandidates[track.index] ?? ZERO, base));
    const growth = growthTarget(track, item);
    if (growth !== null) {
      growthCandidates[track.index] = nonNegative(cssMax(growthCandidates[track.index] ?? ZERO, growth));
    }
  }
  for (const track of tracks) {
    consume(work);
    if (track.collapsed) continue;
    const base = baseCandidates[track.index] ?? ZERO;
    track.baseSize = nonNegative(cssMax(track.baseSize, base));
    const growth = growthCandidates[track.index];
    if (growth !== null && growth !== undefined) {
      track.growthLimit = Object.freeze({
        kind: "finite",
        value: nonNegative(cssMax(track.baseSize, growth))
      });
    } else if (track.growthLimit.kind === "finite" && track.growthLimit.value < track.baseSize) {
      track.growthLimit = Object.freeze({ kind: "finite", value: track.baseSize });
    }
  }
}

function phaseTarget(phase: ContributionPhase, item: GridItemContribution): CssNonNegativeLength {
  if (phase === "max-content-minimum" || phase === "max-content-maximum") return item.maxContent;
  if (phase === "content-based-minimum" || phase === "intrinsic-maximum") return item.minContent;
  return item.minimumContribution;
}

function intrinsicMinimum(track: MutableTrack): boolean {
  return track.minimumCategory !== "fixed" && track.minimumCategory !== "flexible";
}

function intrinsicMaximum(track: MutableTrack): boolean {
  return track.maximumCategory !== "fixed" && track.maximumCategory !== "flexible";
}

function maxContentMaximum(track: MutableTrack): boolean {
  return track.maximum.kind === "max-content" || track.maximum.kind === "auto";
}

function participates(
  track: MutableTrack,
  phase: ContributionPhase,
  sizingConstraint: GridTrackSizingInput["sizingConstraint"]
): boolean {
  if (track.collapsed) return false;
  if (phase === "flexible-crossing-minimum") return track.flexFactor > 0;
  if (phase === "intrinsic-minimum") return intrinsicMinimum(track);
  if (phase === "content-based-minimum") {
    return track.minimum.kind === "min-content" || track.minimum.kind === "max-content";
  }
  if (phase === "max-content-minimum") {
    return track.minimum.kind === "max-content"
      || (sizingConstraint === "max-content" && track.minimum.kind === "auto");
  }
  if (phase === "intrinsic-maximum") return intrinsicMaximum(track);
  return track.infinitelyGrowable || maxContentMaximum(track);
}

function roomForBase(track: MutableTrack): CssPixelLength | null {
  return track.growthLimit.kind === "infinite"
    ? null
    : nonNegative(difference(track.growthLimit.value, track.baseSize));
}

function distributeEqually(
  amount: CssNonNegativeLength,
  candidates: readonly MutableTrack[],
  room: (track: MutableTrack) => CssPixelLength | null,
  work: TrackSizingWork
): ReadonlyMap<MutableTrack, CssNonNegativeLength> {
  const increases = new Map<MutableTrack, CssNonNegativeLength>();
  let remaining: CssPixelLength = amount;
  let growable = [...candidates];
  for (const track of candidates) increases.set(track, ZERO);
  while (remaining > 0 && growable.length > 0) {
    consume(work, growable.length);
    const share = cssDivide(remaining, growable.length);
    let distributed: CssPixelLength = ZERO;
    const next: MutableTrack[] = [];
    for (const track of growable) {
      const already = increases.get(track) ?? ZERO;
      const available = room(track);
      const remainingRoom = available === null ? null : nonNegative(difference(available, already));
      const increase = remainingRoom === null ? share : cssMin(share, remainingRoom);
      increases.set(track, nonNegative(sum(already, increase)));
      distributed = sum(distributed, increase);
      if (remainingRoom === null || increase < remainingRoom) next.push(track);
    }
    if (distributed <= 0) break;
    remaining = nonNegative(difference(remaining, distributed));
    growable = next;
  }
  return increases;
}

function distributeToFlexibleTracks(
  amount: CssNonNegativeLength,
  candidates: readonly MutableTrack[],
  work: TrackSizingWork
): ReadonlyMap<MutableTrack, CssNonNegativeLength> {
  const increases = new Map<MutableTrack, CssNonNegativeLength>();
  const flexible = selectTracks(candidates, (track) => track.flexFactor > 0, work);
  if (flexible.length === 0) return distributeEqually(amount, candidates, roomForBase, work);
  let factorSum = 0;
  for (const track of flexible) {
    consume(work);
    factorSum += track.flexFactor;
  }
  const divisor = Math.max(1, factorSum);
  for (const track of candidates) increases.set(track, ZERO);
  let distributed: CssPixelLength = ZERO;
  for (const track of flexible) {
    const increase = nonNegative(cssMultiply(cssDivide(amount, divisor), track.flexFactor));
    increases.set(track, increase);
    distributed = sum(distributed, increase);
  }
  const remaining = nonNegative(difference(amount, distributed));
  if (remaining > 0 && factorSum < 1) {
    for (const [track, increase] of distributeEqually(remaining, flexible, () => null, work)) {
      increases.set(track, nonNegative(sum(increases.get(track) ?? ZERO, increase)));
    }
  }
  return increases;
}

type AffectedSize = "base" | "growth";

function affectedSize(phase: ContributionPhase): AffectedSize {
  return phase === "intrinsic-maximum" || phase === "max-content-maximum" ? "growth" : "base";
}

function increaseLimit(track: MutableTrack, size: AffectedSize): CssPixelLength | null {
  if (size === "base") {
    const growthRoom = track.growthLimit.kind === "infinite"
      ? null
      : nonNegative(difference(track.growthLimit.value, track.baseSize));
    const fitRoom = track.fitContentLimit === null
      ? null
      : nonNegative(difference(track.fitContentLimit, track.baseSize));
    if (growthRoom === null) return fitRoom;
    if (fitRoom === null) return growthRoom;
    return nonNegative(cssMin(growthRoom, fitRoom));
  }
  if (track.growthLimit.kind === "finite" && !track.infinitelyGrowable) return ZERO;
  if (track.fitContentLimit === null) return null;
  return nonNegative(difference(
    track.fitContentLimit,
    track.growthLimit.kind === "finite" ? track.growthLimit.value : track.baseSize
  ));
}

function addIncreases(
  target: Map<MutableTrack, CssNonNegativeLength>,
  additions: ReadonlyMap<MutableTrack, CssNonNegativeLength>
): CssNonNegativeLength {
  let total: CssPixelLength = ZERO;
  for (const [track, increase] of additions) {
    target.set(track, nonNegative(sum(target.get(track) ?? ZERO, increase)));
    total = sum(total, increase);
  }
  return nonNegative(total);
}

function beyondLimitCandidates(
  affected: readonly MutableTrack[],
  phase: ContributionPhase,
  work: TrackSizingWork
): readonly MutableTrack[] {
  if (phase === "intrinsic-maximum" || phase === "max-content-maximum") {
    return selectTracks(affected, (track) => intrinsicMaximum(track), work);
  }
  if (phase === "max-content-minimum") {
    const preferred = selectTracks(affected, (track) => maxContentMaximum(track), work);
    return preferred.length > 0 ? preferred : affected;
  }
  const preferred = selectTracks(affected, (track) => intrinsicMaximum(track), work);
  return preferred.length > 0 ? preferred : affected;
}

function incurredIncreases(
  tracks: readonly MutableTrack[],
  item: GridItemContribution,
  phase: ContributionPhase,
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  sizingConstraint: GridTrackSizingInput["sizingConstraint"],
  work: TrackSizingWork
): IncurredIncreases {
  const size = affectedSize(phase);
  const spanned = tracksForItem(tracks, item, work);
  const affected = selectTracks(
    spanned,
    (track) => participates(track, phase, sizingConstraint),
    work
  );
  const affectedSet = new Set(affected);
  const increases = new Map<MutableTrack, CssNonNegativeLength>();
  if (affected.length === 0) return { affected, increases };
  const current = size === "growth"
    ? growthSpanSize(tracks, item, boundaries, gap, work)
    : baseSpanSize(tracks, item, boundaries, gap, work);
  let remaining = nonNegative(difference(phaseTarget(phase, item), current));
  if (remaining <= 0) return { affected, increases };

  const initial = phase === "flexible-crossing-minimum"
    ? distributeToFlexibleTracks(remaining, affected, work)
    : distributeEqually(remaining, affected, (track) => increaseLimit(track, size), work);
  remaining = nonNegative(difference(remaining, addIncreases(increases, initial)));

  const unaffected = selectTracks(spanned, (track) => !affectedSet.has(track), work);
  if (remaining > 0 && unaffected.length > 0) {
    const distributed = distributeEqually(
      remaining,
      unaffected,
      (track) => increaseLimit(track, size),
      work
    );
    remaining = nonNegative(difference(remaining, addIncreases(increases, distributed)));
  }

  if (remaining > 0) {
    const beyond = beyondLimitCandidates(affected, phase, work);
    if (beyond.length > 0) {
      const distributed = phase === "flexible-crossing-minimum"
        ? distributeToFlexibleTracks(remaining, beyond, work)
        : distributeEqually(remaining, beyond, () => null, work);
      addIncreases(increases, distributed);
    }
  }
  return { affected, increases };
}

function examineSpanningPhase(
  tracks: readonly MutableTrack[],
  items: readonly GridItemContribution[],
  phase: ContributionPhase,
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  work: TrackSizingWork
): void {
  const affectedTracks = new Set<MutableTrack>();
  for (const track of tracks) {
    consume(work);
    track.plannedIncrease = ZERO;
  }
  for (const item of items) {
    consume(work);
    const incurred = incurredIncreases(
      tracks,
      item,
      phase,
      boundaries,
      gap,
      work.input.sizingConstraint,
      work
    );
    for (const track of incurred.affected) affectedTracks.add(track);
    for (const [track, increase] of incurred.increases) {
      track.plannedIncrease = nonNegative(cssMax(track.plannedIncrease, increase));
    }
  }
  for (const track of tracks) {
    consume(work);
    if (!affectedTracks.has(track)) {
      track.plannedIncrease = ZERO;
      if (phase === "max-content-maximum") track.infinitelyGrowable = false;
      continue;
    }
    if (phase === "intrinsic-maximum" || phase === "max-content-maximum") {
      const previousGrowthLimit = track.growthLimit;
      const wasInfinite = previousGrowthLimit.kind === "infinite";
      const current = previousGrowthLimit.kind === "infinite" ? track.baseSize : previousGrowthLimit.value;
      track.growthLimit = Object.freeze({
        kind: "finite",
        value: nonNegative(cssMax(track.baseSize, sum(current, track.plannedIncrease)))
      });
      if (phase === "intrinsic-maximum" && wasInfinite) track.infinitelyGrowable = true;
      if (phase === "max-content-maximum") track.infinitelyGrowable = false;
    } else {
      track.baseSize = nonNegative(sum(track.baseSize, track.plannedIncrease));
      if (track.growthLimit.kind === "finite" && track.growthLimit.value < track.baseSize) {
        track.growthLimit = Object.freeze({ kind: "finite", value: track.baseSize });
      }
    }
    track.plannedIncrease = ZERO;
  }
}

function resolveSpanningItems(
  tracks: readonly MutableTrack[],
  contributions: readonly GridItemContribution[],
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  work: TrackSizingWork
): void {
  const ordinaryBySpan = new Map<number, GridItemContribution[]>();
  const flexible: GridItemContribution[] = [];
  for (const item of contributions) {
    consume(work);
    if (!validContribution(item, tracks.length)) continue;
    const crossesFlexible = tracksForItem(tracks, item, work).some((track) => track.flexFactor > 0);
    if (crossesFlexible) flexible.push(item);
    else if (item.end - item.start > 1) {
      const span = item.end - item.start;
      const group = ordinaryBySpan.get(span) ?? [];
      group.push(item);
      ordinaryBySpan.set(span, group);
    }
  }
  const spans = [...ordinaryBySpan.keys()].sort((left, right) => left - right);
  for (const span of spans) {
    const group = ordinaryBySpan.get(span) ?? [];
    for (const phase of [
      "intrinsic-minimum",
      "content-based-minimum",
      "max-content-minimum",
      "intrinsic-maximum",
      "max-content-maximum"
    ] as const) {
      examineSpanningPhase(tracks, group, phase, boundaries, gap, work);
    }
  }
  if (flexible.length > 0)
    examineSpanningPhase(tracks, flexible, "flexible-crossing-minimum", boundaries, gap, work);
  for (const track of tracks) {
    if (track.growthLimit.kind === "infinite" && track.maximumCategory !== "flexible") {
      track.growthLimit = Object.freeze({ kind: "finite", value: track.baseSize });
    }
    if (track.growthLimit.kind === "finite" && track.growthLimit.value < track.baseSize) {
      track.growthLimit = Object.freeze({ kind: "finite", value: track.baseSize });
    }
    track.infinitelyGrowable = false;
  }
}

function totalBaseSize(
  tracks: readonly MutableTrack[],
  boundaries: readonly boolean[],
  gap: CssPixelLength,
  work: TrackSizingWork
): CssPixelLength {
  let total = gutterTotal(boundaries, gap, 0, boundaries.length + 1, work);
  for (const track of tracks) {
    consume(work);
    total = sum(total, track.baseSize);
  }
  return total;
}

function maximizeTracks(
  tracks: readonly MutableTrack[],
  boundaries: readonly boolean[],
  input: GridTrackSizingInput,
  work: TrackSizingWork
): void {
  if (input.sizingConstraint === "min-content") return;
  if (input.availableSize === null) {
    if (input.sizingConstraint !== "max-content") return;
    for (const track of tracks) {
      consume(work);
      if (!track.collapsed && track.flexFactor === 0 && track.growthLimit.kind === "finite") {
        track.baseSize = track.growthLimit.value;
      }
    }
    return;
  }
  let free = nonNegative(difference(input.availableSize, totalBaseSize(tracks, boundaries, input.gap, work)));
  let growable = selectTracks(
    tracks,
    (track) => !track.collapsed && track.flexFactor === 0
      && (track.growthLimit.kind === "infinite" || track.baseSize < track.growthLimit.value),
    work
  );
  while (free > 0 && growable.length > 0) {
    const increases = distributeEqually(free, growable, roomForBase, work);
    let distributed: CssPixelLength = ZERO;
    for (const [track, increase] of increases) {
      track.baseSize = nonNegative(sum(track.baseSize, increase));
      distributed = sum(distributed, increase);
    }
    if (distributed <= 0) break;
    free = nonNegative(difference(free, distributed));
    growable = selectTracks(
      growable,
      (track) => track.growthLimit.kind === "infinite" || track.baseSize < track.growthLimit.value,
      work
    );
  }
}

function findFlexFraction(
  tracks: readonly MutableTrack[],
  spaceToFill: CssPixelLength,
  work: TrackSizingWork
): CssPixelLength {
  const flexible = selectTracks(tracks, (track) => !track.collapsed && track.flexFactor > 0, work);
  const frozen = new Set<MutableTrack>();
  let fraction: CssPixelLength = ZERO;
  for (;;) {
    consume(work, Math.max(1, flexible.length + tracks.length));
    let leftover = spaceToFill;
    let factorSum = 0;
    for (const track of tracks) {
      if (track.collapsed) continue;
      if (track.flexFactor === 0 || frozen.has(track)) leftover = difference(leftover, track.baseSize);
      else factorSum += track.flexFactor;
    }
    fraction = cssDivide(leftover, Math.max(1, factorSum));
    const newlyFrozen = selectTracks(
      flexible,
      (track) => !frozen.has(track) && cssMultiply(fraction, track.flexFactor) < track.baseSize,
      work
    );
    if (newlyFrozen.length === 0) return cssMax(ZERO, fraction);
    for (const track of newlyFrozen) frozen.add(track);
    if (frozen.size === flexible.length) return ZERO;
  }
}

function expandFlexibleTracks(
  tracks: readonly MutableTrack[],
  boundaries: readonly boolean[],
  input: GridTrackSizingInput,
  contributions: readonly GridItemContribution[],
  work: TrackSizingWork
): void {
  const flexible = selectTracks(tracks, (track) => !track.collapsed && track.flexFactor > 0, work);
  if (flexible.length === 0) return;
  let fraction: CssPixelLength = ZERO;
  if (input.availableSize !== null) {
    fraction = findFlexFraction(
      tracks,
      difference(input.availableSize, gutterTotal(boundaries, input.gap, 0, boundaries.length + 1, work)),
      work
    );
  } else {
    for (const track of flexible) {
      consume(work);
      fraction = cssMax(fraction, cssDivide(track.baseSize, track.flexFactor));
    }
    for (const item of contributions) {
      consume(work);
      if (!validContribution(item, tracks.length)) continue;
      const spanned = tracksForItem(tracks, item, work);
      if (!spanned.some((track) => track.flexFactor > 0)) continue;
      const space = difference(
        item.maxContent,
        gutterTotal(boundaries, input.gap, item.start, item.end, work)
      );
      fraction = cssMax(fraction, findFlexFraction(spanned, space, work));
    }
  }
  for (const track of flexible) {
    consume(work);
    track.baseSize = nonNegative(cssMax(track.baseSize, cssMultiply(fraction, track.flexFactor)));
  }
}

function alignTracks(
  tracks: readonly MutableTrack[],
  boundaries: readonly boolean[],
  input: GridTrackSizingInput,
  work: TrackSizingWork
): AlignmentResult {
  const available = input.availableSize;
  if (available === null) return { leading: ZERO, boundaryExtra: ZERO };
  let free = difference(available, totalBaseSize(tracks, boundaries, input.gap, work));
  const alignment = input.alignment.value === "normal" ? "stretch" : input.alignment.value;
  const safeOverflow = input.alignment.overflow === "safe"
    || (input.alignment.overflow === "default" && input.defaultOverflowAlignment === "safe");
  if (alignment === "stretch" && free > 0) {
    const automatic = selectTracks(
      tracks,
      (track) => !track.collapsed && track.maximumCategory === "automatic" && track.flexFactor === 0,
      work
    );
    if (automatic.length > 0) {
      const increases = distributeEqually(nonNegative(free), automatic, () => null, work);
      let distributed: CssPixelLength = ZERO;
      for (const [track, increase] of increases) {
        track.baseSize = nonNegative(sum(track.baseSize, increase));
        distributed = sum(distributed, increase);
      }
      free = difference(free, distributed);
    }
  }
  if (free < 0 && safeOverflow) return { leading: ZERO, boundaryExtra: ZERO };
  if (alignment === "end") return { leading: free, boundaryExtra: ZERO };
  if (alignment === "center") return { leading: cssDivide(free, 2), boundaryExtra: ZERO };
  if (free <= 0) return { leading: ZERO, boundaryExtra: ZERO };
  consume(work, boundaries.length + tracks.length);
  const boundaryCount = boundaries.reduce((count, active) => count + Number(active), 0);
  const activeTracks = tracks.reduce((count, track) => count + Number(!track.collapsed), 0);
  if (alignment === "space-between" && boundaryCount > 0) {
    return { leading: ZERO, boundaryExtra: nonNegative(cssDivide(free, boundaryCount)) };
  }
  if (alignment === "space-around" && activeTracks > 0) {
    const space = cssDivide(free, activeTracks);
    return { leading: cssDivide(space, 2), boundaryExtra: nonNegative(space) };
  }
  if (alignment === "space-evenly" && activeTracks > 0) {
    const space = cssDivide(free, activeTracks + 1);
    return { leading: space, boundaryExtra: nonNegative(space) };
  }
  return { leading: ZERO, boundaryExtra: ZERO };
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
  const boundaries = activeGutterBoundaries(tracks, work);
  resolveNonSpanningItems(tracks, input.contributions, work);
  resolveSpanningItems(tracks, input.contributions, boundaries, input.gap, work);
  maximizeTracks(tracks, boundaries, input, work);
  expandFlexibleTracks(tracks, boundaries, input, input.contributions, work);
  const alignment = alignTracks(tracks, boundaries, input, work);
  let offset: CssPixelLength = alignment.leading;
  for (const track of tracks) {
    consume(work);
    if (track.index > 0 && boundaries[track.index - 1]) {
      offset = sum(offset, sum(input.gap, alignment.boundaryExtra));
    }
    track.offset = offset;
    offset = sum(offset, track.baseSize);
  }
  let used = totalBaseSize(tracks, boundaries, input.gap, work);
  consume(work, boundaries.length);
  used = sum(used, cssMultiply(alignment.boundaryExtra, boundaries.reduce(
    (count, active) => count + Number(active),
    0
  )));
  const resolved: ResolvedGridTrack[] = [];
  for (const track of tracks) {
    consume(work);
    resolved.push(Object.freeze({
      index: track.index,
      baseSize: track.baseSize,
      growthLimit: track.growthLimit,
      flexFactor: track.flexFactor,
      collapsed: track.collapsed,
      gutterBefore: track.index > 0 && (boundaries[track.index - 1] ?? false),
      minimumCategory: track.minimumCategory,
      maximumCategory: track.maximumCategory,
      offset: track.offset
    }));
  }
  return Object.freeze({
    tracks: Object.freeze(resolved),
    usedSize: nonNegative(used),
    leadingSpace: alignment.leading,
    activeGutterBoundaries: boundaries,
    work: work.used
  });
}
