import type { FormattingNodeId } from "../../formatting/index.js";
import type {
  CssGridAutoFlow,
  CssGridLine,
  CssGridTrackSizingFunction,
  CssLength
} from "../../style/index.js";
import type { CssNonNegativeLength, CssPixelLength } from "../fixed.js";

export interface GridWorkLimits {
  readonly maxGridItems: number;
  readonly maxExplicitGridTracks: number;
  readonly maxImplicitGridTracks: number;
  readonly maxGridOccupancyIntervals: number;
  readonly maxGridPlacementSteps: number;
  readonly maxGridNamedLineResolutions: number;
  readonly maxGridAutoRepeatTracks: number;
  readonly maxGridTrackSizingWork: number;
}

export type GridWorkLimit = keyof GridWorkLimits;

export class GridWorkBudgetExceeded extends Error {
  public readonly budget: GridWorkLimit;
  public readonly limit: number;

  public constructor(budget: GridWorkLimit, limit: number) {
    super(`Grid ${budget} budget reached ${String(limit)}.`);
    this.name = "GridWorkBudgetExceeded";
    this.budget = budget;
    this.limit = limit;
  }
}

export interface ExpandedGridAxis {
  readonly tracks: readonly CssGridTrackSizingFunction[];
  readonly lineNames: readonly (readonly string[])[];
  readonly namedLines: ReadonlyMap<string, readonly number[]>;
  readonly autoFitTracks: ReadonlySet<number>;
}

export interface GridTrackSequence {
  readonly tracks: readonly CssGridTrackSizingFunction[];
  readonly explicitTrackOffset: number;
  readonly collapsedTracks: ReadonlySet<number>;
}

export interface GridItemPlacementInput {
  readonly formattingNode: FormattingNodeId;
  readonly sourceIndex: number;
  readonly order: number;
  readonly columnStart: CssGridLine;
  readonly columnEnd: CssGridLine;
  readonly rowStart: CssGridLine;
  readonly rowEnd: CssGridLine;
}

export interface GridAreaPlacement {
  readonly formattingNode: FormattingNodeId;
  readonly sourceIndex: number;
  readonly order: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly rowStart: number;
  readonly rowEnd: number;
}

export interface GridPlacementResult {
  readonly items: readonly GridAreaPlacement[];
  readonly minimumColumnLine: number;
  readonly maximumColumnLine: number;
  readonly minimumRowLine: number;
  readonly maximumRowLine: number;
  readonly placementSteps: number;
  readonly occupancyIntervals: number;
}

export interface GridPlacementInput {
  readonly items: readonly GridItemPlacementInput[];
  readonly columns: ExpandedGridAxis;
  readonly rows: ExpandedGridAxis;
  readonly autoFlow: CssGridAutoFlow;
  readonly limits: GridWorkLimits;
  readonly signal: AbortSignal | undefined;
}

export interface GridItemContribution {
  readonly formattingNode: FormattingNodeId;
  readonly start: number;
  readonly end: number;
  readonly minimumContribution: CssNonNegativeLength;
  readonly minContent: CssNonNegativeLength;
  readonly maxContent: CssNonNegativeLength;
}

export interface GridTrackSizingInput {
  readonly tracks: readonly CssGridTrackSizingFunction[];
  readonly collapsedTracks?: ReadonlySet<number>;
  readonly contributions: readonly GridItemContribution[];
  readonly availableSize: CssPixelLength | null;
  readonly gap: CssNonNegativeLength;
  readonly resolveLength: (value: CssLength, percentageBasis: CssPixelLength | null) => CssPixelLength | null;
  readonly alignment: "start" | "end" | "center" | "stretch" | "space-between" | "space-around" | "space-evenly";
  readonly maxWork: number;
  readonly signal: AbortSignal | undefined;
}

export interface ResolvedGridTrack {
  readonly index: number;
  readonly baseSize: CssNonNegativeLength;
  readonly growthLimit: CssNonNegativeLength | null;
  readonly flexFactor: number;
  readonly collapsed: boolean;
  readonly offset: CssPixelLength;
}

export interface GridTrackSizingResult {
  readonly tracks: readonly ResolvedGridTrack[];
  readonly usedSize: CssNonNegativeLength;
  readonly leadingSpace: CssPixelLength;
  readonly distributedGap: CssNonNegativeLength;
  readonly work: number;
}
