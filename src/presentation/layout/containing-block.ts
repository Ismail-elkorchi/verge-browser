import type { FormattingNodeId } from "../formatting/index.js";
import type { CssPixelLength, CssRect } from "./fixed.js";

/**
 * One CSS containing block, supplied by the formatting context that owns it.
 * Used geometry is independent of whether either axis resolves percentages.
 * The builder finalizes/translates rect; percentage bases never come from a
 * descendant's final fragment rectangle or an anonymous item wrapper.
 */
export interface LayoutContainingBlock {
  readonly owner: FormattingNodeId | null;
  rect: CssRect;
  readonly percentageWidth: CssPixelLength | null;
  /** A flex owner may finalize an unchanged stretch allocation without rebuilding its contents. */
  percentageHeight: CssPixelLength | null;
}
