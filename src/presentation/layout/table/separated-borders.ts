import type { ComputedStyle } from "../../style/index.js";
import { cssMax, cssNonNegativeLength, cssPx, type CssNonNegativeLength, type CssPixelLength } from "../fixed.js";
import type { TableLayoutHost } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface UsedTableBorderSpacing {
  readonly horizontal: CssNonNegativeLength;
  readonly vertical: CssNonNegativeLength;
}

export function usedTableBorderSpacing(
  host: TableLayoutHost,
  style: ComputedStyle,
  inlineBasis: CssPixelLength,
): UsedTableBorderSpacing {
  if (style.box.borderCollapse === "collapse") return Object.freeze({ horizontal: ZERO, vertical: ZERO });
  const horizontal = host.usedLength(style.box.borderSpacing.horizontal, inlineBasis, style) ?? ZERO;
  const vertical = host.usedLength(style.box.borderSpacing.vertical, inlineBasis, style) ?? ZERO;
  return Object.freeze({
    horizontal: cssNonNegativeLength(cssMax(ZERO, horizontal)),
    vertical: cssNonNegativeLength(cssMax(ZERO, vertical)),
  });
}
