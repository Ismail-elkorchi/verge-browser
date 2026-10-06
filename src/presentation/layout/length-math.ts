import type { CssLengthPercentageExpression, CssLengthUnit } from "../style/types.js";
import { cssAdd, cssMax, cssMin, cssMultiply, cssNegate, type CssPixelLength } from "./fixed.js";

/** Shared used-value evaluation for the style parser's bounded calculation AST.
 * Each operation preserves the engine's saturating 26.6 fixed-point arithmetic;
 * the caller supplies percentage/font/viewport bases for the current owner.
 */
export function evaluateUsedCssMath(expression: CssLengthPercentageExpression,
  resolveValue: (value: number, unit: CssLengthUnit) => CssPixelLength): CssPixelLength {
  if (expression.kind === "value") return resolveValue(expression.value, expression.unit);
  if (expression.kind === "negate") return cssNegate(evaluateUsedCssMath(expression.value, resolveValue));
  if (expression.kind === "sum") return cssAdd(evaluateUsedCssMath(expression.left, resolveValue),
    evaluateUsedCssMath(expression.right, resolveValue));
  if (expression.kind === "product") return cssMultiply(evaluateUsedCssMath(expression.value, resolveValue), expression.factor);
  if (expression.kind === "minimum" || expression.kind === "maximum") {
    let result: CssPixelLength | null = null;
    for (const value of expression.values) {
      const candidate = evaluateUsedCssMath(value, resolveValue);
      result = result === null ? candidate : expression.kind === "minimum" ? cssMin(result, candidate) : cssMax(result, candidate);
    }
    if (result === null) throw new RangeError("CSS min/max calculation has no arguments.");
    return result;
  }
  const minimum = evaluateUsedCssMath(expression.minimum, resolveValue);
  const preferred = evaluateUsedCssMath(expression.preferred, resolveValue);
  const maximum = evaluateUsedCssMath(expression.maximum, resolveValue);
  return cssMax(minimum, cssMin(preferred, maximum));
}
