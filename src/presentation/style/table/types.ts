import type { CssColor, CssLength } from "../types.js";

export type CssTableLayout = "auto" | "fixed";
export type CssBorderCollapse = "separate" | "collapse";
export type CssCaptionSide = "top" | "bottom";
export type CssEmptyCells = "show" | "hide";
export type CssBorderStyle = "none" | "hidden" | "solid";

export interface CssBorderSpacing {
  readonly horizontal: CssLength;
  readonly vertical: CssLength;
}

export interface CssBorderStyles {
  readonly top: CssBorderStyle;
  readonly right: CssBorderStyle;
  readonly bottom: CssBorderStyle;
  readonly left: CssBorderStyle;
}

export interface CssBorderColors {
  readonly top: CssColor | null;
  readonly right: CssColor | null;
  readonly bottom: CssColor | null;
  readonly left: CssColor | null;
}
