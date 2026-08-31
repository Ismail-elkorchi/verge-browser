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
import type { CssSelfAlignment } from "../../style/index.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface GridItemAlignmentInput {
  readonly areaSize: CssNonNegativeLength;
  readonly itemSize: CssNonNegativeLength;
  readonly marginStart: CssPixelLength;
  readonly marginEnd: CssPixelLength;
  readonly autoMarginStart: boolean;
  readonly autoMarginEnd: boolean;
  readonly alignment: CssSelfAlignment;
  readonly defaultOverflowAlignment?: "safe" | "unsafe";
  readonly stretchEligible?: boolean;
}

export interface GridItemAlignmentResult {
  readonly offset: CssPixelLength;
  readonly size: CssNonNegativeLength;
  readonly marginStart: CssPixelLength;
  readonly marginEnd: CssPixelLength;
}

export function alignGridItem(input: GridItemAlignmentInput): GridItemAlignmentResult {
  let marginStart = input.autoMarginStart ? ZERO : input.marginStart;
  let marginEnd = input.autoMarginEnd ? ZERO : input.marginEnd;
  const free = cssAdd(
    input.areaSize,
    cssMultiply(cssAdd(input.itemSize, cssAdd(marginStart, marginEnd)), -1)
  );
  if (free > 0 && (input.autoMarginStart || input.autoMarginEnd)) {
    const count = Number(input.autoMarginStart) + Number(input.autoMarginEnd);
    const share = count === 0 ? ZERO : cssDivide(free, count);
    if (input.autoMarginStart) marginStart = share;
    if (input.autoMarginEnd) marginEnd = share;
  }
  const positionedFree = input.autoMarginStart || input.autoMarginEnd ? ZERO : free;
  const position = input.alignment.position === "normal" || input.alignment.position === "auto"
    ? "stretch"
    : input.alignment.position;
  const safeOverflow = input.alignment.overflow === "safe"
    || (input.alignment.overflow === "default" && input.defaultOverflowAlignment === "safe");
  const offset = positionedFree < 0 && safeOverflow ? ZERO
    : position === "end" ? positionedFree
      : position === "center" ? cssDivide(positionedFree, 2) : ZERO;
  const size = position === "stretch" && (input.stretchEligible ?? true)
    && !input.autoMarginStart && !input.autoMarginEnd
    ? cssNonNegativeLength(cssMax(ZERO, cssAdd(input.areaSize, cssMultiply(cssAdd(marginStart, marginEnd), -1))))
    : input.itemSize;
  return Object.freeze({ offset: cssAdd(marginStart, offset), size, marginStart, marginEnd });
}
