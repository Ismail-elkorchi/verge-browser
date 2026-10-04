import type { CssOverflow } from "./types.js";

/** Scrollability is a computed policy, independent of whether content overflows. */
export function isScrollableOverflow(value: CssOverflow): boolean {
  return value === "hidden" || value === "auto" || value === "scroll";
}
export function isUserScrollableOverflow(value: CssOverflow): boolean {
  return value === "auto" || value === "scroll";
}
export function clipsOverflow(value: CssOverflow): boolean { return value !== "visible"; }
export function normalizedOverflow(value: CssOverflow, other: CssOverflow): CssOverflow {
  return !isScrollableOverflow(other) ? value : value === "visible" ? "auto" : value === "clip" ? "hidden" : value;
}
