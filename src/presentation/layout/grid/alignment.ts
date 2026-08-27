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

const ZERO = cssNonNegativeLength(cssPx(0));

export interface GridItemAlignmentInput {
  readonly areaSize: CssNonNegativeLength;
  readonly itemSize: CssNonNegativeLength;
  readonly marginStart: CssPixelLength;
  readonly marginEnd: CssPixelLength;
  readonly autoMarginStart: boolean;
  readonly autoMarginEnd: boolean;
  readonly alignment: "start" | "end" | "center" | "stretch" | "baseline";
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
  const free = cssMax(ZERO, cssAdd(
    input.areaSize,
    cssMultiply(cssAdd(input.itemSize, cssAdd(marginStart, marginEnd)), -1)
  ));
  if (input.autoMarginStart || input.autoMarginEnd) {
    const count = Number(input.autoMarginStart) + Number(input.autoMarginEnd);
    const share = count === 0 ? ZERO : cssDivide(free, count);
    if (input.autoMarginStart) marginStart = share;
    if (input.autoMarginEnd) marginEnd = share;
  }
  const positionedFree = input.autoMarginStart || input.autoMarginEnd ? ZERO : free;
  const offset = input.alignment === "end" ? positionedFree
    : input.alignment === "center" ? cssDivide(positionedFree, 2) : ZERO;
  const size = input.alignment === "stretch" && !input.autoMarginStart && !input.autoMarginEnd
    ? cssNonNegativeLength(cssMax(ZERO, cssAdd(input.areaSize, cssMultiply(cssAdd(marginStart, marginEnd), -1))))
    : input.itemSize;
  return Object.freeze({ offset: cssAdd(marginStart, offset), size, marginStart, marginEnd });
}

