import type { ComputedStyle, CssLengthUnit, StyleValueDependencies } from "./types.js";

export type EvaluatedValueDependencies = { -readonly [Key in keyof StyleValueDependencies]: boolean };

/** Visits typed length/calculation values, after cascade and variable substitution. */
export function usesLengthUnit(value: unknown, unit: CssLengthUnit): boolean {
  if (value === null || typeof value !== "object") return false;
  if ("unit" in value && value.unit === unit) return true;
  return Object.values(value).some((child: unknown) => usesLengthUnit(child, unit));
}

/** Containing block dependence is conservative when its block size is unresolved. */
export function recordUsedValueDependencies(style: ComputedStyle, dependencies: EvaluatedValueDependencies): void {
  const box = style.box;
  dependencies.usedViewportBlockSize ||= box.position === "fixed" || box.position === "sticky"
    || usesLengthUnit(box, "vh") || usesLengthUnit(style.text, "vh")
    || [box.height, box.minHeight, box.maxHeight, box.inset.top, box.inset.bottom,
      box.rowGap, box.gridTemplateRows, box.gridAutoRows,
      ...(box.flexDirection.startsWith("column") ? [box.flexBasis] : []),
    ].some((value) => usesLengthUnit(value, "%"));
}
