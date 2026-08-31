import type { FormattingNodeId } from "../../formatting/index.js";
import type { CssNonNegativeLength, CssPixelLength } from "../fixed.js";

export interface IntrinsicBoxContributions {
  readonly minContentInlineSize: CssNonNegativeLength;
  readonly maxContentInlineSize: CssNonNegativeLength;
  readonly minimumBlockContribution: CssNonNegativeLength;
  readonly maximumBlockContribution: CssNonNegativeLength;
}

export interface IntrinsicSizeContributions {
  readonly contentBox: IntrinsicBoxContributions;
  readonly borderBox: IntrinsicBoxContributions;
  readonly automaticMinimumSize: {
    readonly inline: CssNonNegativeLength;
    readonly block: CssNonNegativeLength;
  };
  readonly percentageDependence: {
    readonly inline: boolean;
    readonly block: boolean;
  };
}

export interface IntrinsicContributionRequest {
  readonly formattingNode: FormattingNodeId;
  readonly availableInlineSize: CssPixelLength | null;
}

export type IntrinsicContributionOutcome =
  | { readonly status: "complete"; readonly contributions: IntrinsicSizeContributions }
  | { readonly status: "cycle" }
  | { readonly status: "truncated"; readonly limit: number };

export class IntrinsicSizingCycleError extends Error {
  public readonly request: IntrinsicContributionRequest;

  public constructor(request: IntrinsicContributionRequest) {
    super(`Intrinsic sizing dependency cycle for ${request.formattingNode}.`);
    this.name = "IntrinsicSizingCycleError";
    this.request = request;
  }
}
