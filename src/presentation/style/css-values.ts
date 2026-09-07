import {
  cloneCssComponentValues,
  parseComponentValues,
  serializeCssComponentValues,
  type ComponentValue,
  type CssFunction
} from "@ismail-elkorchi/css-parser";

import type {
  CssColor,
  CssLength,
  CssLengthPercentageExpression,
  CssLengthUnit
} from "./types.js";

const LENGTH_UNITS = new Set<CssLengthUnit>(["px", "em", "rem", "ch", "%", "vw", "vh"]);

type MathResult =
  | { readonly dimension: "number"; readonly value: number }
  | {
      readonly dimension: "length-percentage";
      readonly expression: CssLengthPercentageExpression;
      readonly percentageDependence: "none" | "percentage" | "mixed";
    };

function compact(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

/** Splits a CSS value at top-level component boundaries without inspecting nested function text. */
export function splitCssComponentValues(
  source: string,
  separator: "space" | "comma"
): readonly string[] | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const groups: ComponentValue[][] = [[]];
  for (const value of parsed.value) {
    const boundary = separator === "comma"
      ? value.kind === "comma"
      : value.kind === "whitespace";
    if (boundary) {
      if ((groups.at(-1)?.length ?? 0) > 0) groups.push([]);
      continue;
    }
    groups.at(-1)?.push(value);
  }
  const result = groups
    .filter((group) => group.length > 0)
    .map((group) => serializeCssComponentValues(group).trim());
  return result.some((value) => value.length === 0) ? null : Object.freeze(result);
}

function valueExpression(value: number, unit: CssLengthUnit): CssLengthPercentageExpression {
  return Object.freeze({ kind: "value", value, unit });
}

function lengthResult(
  expression: CssLengthPercentageExpression,
  percentageDependence: "none" | "percentage" | "mixed"
): MathResult {
  return Object.freeze({ dimension: "length-percentage", expression, percentageDependence });
}

function combinedPercentageDependence(
  values: readonly ("none" | "percentage" | "mixed")[]
): "none" | "percentage" | "mixed" {
  if (values.some((value) => value === "mixed")) return "mixed";
  const hasAbsolute = values.some((value) => value === "none");
  const hasPercentage = values.some((value) => value === "percentage");
  return hasAbsolute && hasPercentage ? "mixed" : hasPercentage ? "percentage" : "none";
}

class MathParser {
  readonly #values: readonly ComponentValue[];
  #position = 0;

  public constructor(values: readonly ComponentValue[]) {
    this.#values = compact(values);
  }

  public parse(): MathResult | null {
    const result = this.#sum();
    return result !== null && this.#position === this.#values.length ? result : null;
  }

  #peek(): ComponentValue | undefined { return this.#values[this.#position]; }

  #consume(): ComponentValue | undefined {
    const result = this.#peek();
    this.#position += 1;
    return result;
  }

  #delimiter(code: number): boolean {
    const value = this.#peek();
    if (value?.kind !== "delim" || value.value !== code) return false;
    this.#position += 1;
    return true;
  }

  #sum(): MathResult | null {
    let left = this.#product();
    if (left === null) return null;
    for (;;) {
      const operator = this.#peek();
      if (operator?.kind !== "delim" || (operator.value !== 43 && operator.value !== 45)) return left;
      this.#position += 1;
      const right = this.#product();
      if (right === null || left.dimension !== right.dimension) return null;
      if (left.dimension === "number" && right.dimension === "number") {
        left = Object.freeze({
          dimension: "number",
          value: operator.value === 45 ? left.value - right.value : left.value + right.value
        });
        continue;
      }
      if (left.dimension !== "length-percentage" || right.dimension !== "length-percentage") return null;
      const rightExpression: CssLengthPercentageExpression = operator.value === 45
        ? Object.freeze({ kind: "negate", value: right.expression })
        : right.expression;
      left = lengthResult(
        Object.freeze({ kind: "sum", left: left.expression, right: rightExpression }),
        combinedPercentageDependence([left.percentageDependence, right.percentageDependence])
      );
    }
  }

  #product(): MathResult | null {
    let left = this.#unary();
    if (left === null) return null;
    for (;;) {
      const operator = this.#peek();
      if (operator?.kind !== "delim" || (operator.value !== 42 && operator.value !== 47)) return left;
      this.#position += 1;
      const right = this.#unary();
      if (right === null) return null;
      if (operator.value === 42) {
        if (left.dimension === "number" && right.dimension === "length-percentage") {
          left = lengthResult(
            Object.freeze({ kind: "product", value: right.expression, factor: left.value }),
            right.percentageDependence
          );
        } else if (left.dimension === "length-percentage" && right.dimension === "number") {
          left = lengthResult(
            Object.freeze({ kind: "product", value: left.expression, factor: right.value }),
            left.percentageDependence
          );
        } else if (left.dimension === "number" && right.dimension === "number") {
          left = Object.freeze({ dimension: "number", value: left.value * right.value });
        } else return null;
      } else {
        if (right.dimension !== "number" || right.value === 0) return null;
        if (left.dimension === "number") {
          left = Object.freeze({ dimension: "number", value: left.value / right.value });
        } else {
          left = lengthResult(
            Object.freeze({ kind: "product", value: left.expression, factor: 1 / right.value }),
            left.percentageDependence
          );
        }
      }
    }
  }

  #unary(): MathResult | null {
    if (this.#delimiter(43)) return this.#unary();
    if (this.#delimiter(45)) {
      const value = this.#unary();
      if (value === null) return null;
      return value.dimension === "number"
        ? Object.freeze({ dimension: "number", value: -value.value })
        : lengthResult(Object.freeze({ kind: "negate", value: value.expression }), value.percentageDependence);
    }
    return this.#primary();
  }

  #primary(): MathResult | null {
    const value = this.#consume();
    if (value === undefined) return null;
    if (value.kind === "number") {
      return Number.isFinite(value.value) ? Object.freeze({ dimension: "number", value: value.value }) : null;
    }
    if (value.kind === "percentage") {
      return Number.isFinite(value.value) ? lengthResult(valueExpression(value.value, "%"), "percentage") : null;
    }
    if (value.kind === "dimension") {
      const unit = value.unit.toLowerCase() as CssLengthUnit;
      if (!LENGTH_UNITS.has(unit) || !Number.isFinite(value.value)) return null;
      return lengthResult(valueExpression(value.value, unit), "none");
    }
    if (value.kind === "simple-block" && value.associatedToken === "open-paren") {
      return new MathParser(value.value).parse();
    }
    if (value.kind !== "function-block") return null;
    const name = value.name.toLowerCase();
    if (name === "calc") return new MathParser(value.value).parse();
    if (name !== "min" && name !== "max" && name !== "clamp") return null;
    const argumentsList = splitArguments(value.value);
    const parsed = argumentsList.map((argument) => new MathParser(argument).parse());
    if (parsed.some((entry) => entry === null)
      || parsed.some((entry) => entry?.dimension !== "length-percentage")) return null;
    const lengths = parsed as readonly Extract<MathResult, { readonly dimension: "length-percentage" }>[];
    const expressions = lengths.map((entry) => entry.expression);
    const dependence = combinedPercentageDependence(lengths.map((entry) => entry.percentageDependence));
    if (name === "clamp") {
      if (expressions.length !== 3) return null;
      return lengthResult(
        Object.freeze({
          kind: "clamp",
          minimum: expressions[0] as CssLengthPercentageExpression,
          preferred: expressions[1] as CssLengthPercentageExpression,
          maximum: expressions[2] as CssLengthPercentageExpression
        }),
        dependence
      );
    }
    if (expressions.length === 0) return null;
    return lengthResult(
      Object.freeze({
        kind: name === "min" ? "minimum" : "maximum",
        values: Object.freeze(expressions)
      }),
      dependence
    );
  }
}

function splitArguments(values: readonly ComponentValue[]): readonly (readonly ComponentValue[])[] {
  const result: ComponentValue[][] = [[]];
  for (const value of values) {
    if (value.kind === "comma") result.push([]);
    else result.at(-1)?.push(value);
  }
  return result;
}

/** Parses supported length-percentage and CSS math values from parser component values. */
export function parseCssLength(
  source: string,
  options: { readonly allowAuto?: boolean; readonly allowNegative?: boolean; readonly allowNone?: boolean } = {}
): CssLength | null {
  const normalized = source.trim().toLowerCase();
  if (options.allowAuto !== false && normalized === "auto") return Object.freeze({ kind: "auto" });
  if (options.allowNone === true && normalized === "none") return Object.freeze({ kind: "none" });
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const values = compact(parsed.value);
  if (values.length === 1) {
    const value = values[0];
    if (value?.kind === "number" && value.value === 0) return Object.freeze({ kind: "zero" });
    if (value?.kind === "percentage" && Number.isFinite(value.value)) {
      if (options.allowNegative !== true && value.value < 0) return null;
      return Object.freeze({ kind: "length", value: value.value, unit: "%" });
    }
    if (value?.kind === "dimension") {
      const unit = value.unit.toLowerCase() as CssLengthUnit;
      if (!LENGTH_UNITS.has(unit) || !Number.isFinite(value.value)
        || (options.allowNegative !== true && value.value < 0)) return null;
      return Object.freeze({ kind: "length", value: value.value, unit });
    }
  }
  const math = new MathParser(parsed.value).parse();
  if (math?.dimension !== "length-percentage") return null;
  return Object.freeze({
    kind: "calculation",
    calculation: Object.freeze({
      expression: math.expression,
      percentageDependence: math.percentageDependence
    })
  });
}

function variableNameAndFallback(value: CssFunction): {
  readonly name: string;
  readonly fallback: readonly ComponentValue[] | null;
} | null {
  let name: string | null = null;
  let comma = -1;
  for (const [index, item] of value.value.entries()) {
    if (item.kind === "whitespace") continue;
    if (name === null && item.kind === "ident" && item.value.startsWith("--")) {
      name = item.value;
      continue;
    }
    if (name !== null && item.kind === "comma") {
      comma = index;
      break;
    }
    return null;
  }
  if (name === null) return null;
  return { name, fallback: comma < 0 ? null : value.value.slice(comma + 1) };
}

function substituteVariableValues(
  values: readonly ComponentValue[],
  properties: ReadonlyMap<string, readonly ComponentValue[]>,
  stack: ReadonlySet<string>
): readonly ComponentValue[] | null {
  const result: ComponentValue[] = [];
  for (const value of values) {
    if (value.kind === "function-block" && value.name.toLowerCase() === "var") {
      const reference = variableNameAndFallback(value);
      if (reference === null || stack.has(reference.name)) return null;
      const raw = properties.get(reference.name);
      const replacement = raw ?? reference.fallback;
      if (replacement === null) return null;
      const nested = substituteVariableValues(replacement, properties, new Set([...stack, reference.name]));
      if (nested === null) return null;
      result.push(...nested);
      continue;
    }
    if (value.kind === "function-block") {
      const nested = substituteVariableValues(value.value, properties, stack);
      if (nested === null) return null;
      result.push(Object.freeze({ ...value, value: Object.freeze(nested) }));
      continue;
    }
    if (value.kind === "simple-block") {
      const nested = substituteVariableValues(value.value, properties, stack);
      if (nested === null) return null;
      result.push(Object.freeze({ ...value, value: Object.freeze(nested) }));
      continue;
    }
    result.push(value);
  }
  return Object.freeze(result);
}

/** Substitutes custom properties as component values, including nested fallbacks and cycle detection. */
export function resolveCssVariableValues(
  values: readonly ComponentValue[],
  properties: ReadonlyMap<string, readonly ComponentValue[]>
): readonly ComponentValue[] | null {
  const substituted = substituteVariableValues(values, properties, new Set());
  return substituted === null ? null : cloneCssComponentValues(substituted);
}

function channel(value: ComponentValue | undefined): number | null {
  if (value?.kind === "number") return Math.max(0, Math.min(255, value.value));
  if (value?.kind === "percentage") return Math.max(0, Math.min(255, value.value * 2.55));
  return null;
}

function alpha(value: ComponentValue | undefined): number | null {
  if (value?.kind === "number") return Math.max(0, Math.min(1, value.value));
  if (value?.kind === "percentage") return Math.max(0, Math.min(1, value.value / 100));
  return null;
}

function hslToRgb(hue: number, saturation: number, lightness: number): readonly [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const component = h / 60;
  const second = chroma * (1 - Math.abs(component % 2 - 1));
  const [r, g, b] = component < 1 ? [chroma, second, 0]
    : component < 2 ? [second, chroma, 0]
      : component < 3 ? [0, chroma, second]
        : component < 4 ? [0, second, chroma]
          : component < 5 ? [second, 0, chroma] : [chroma, 0, second];
  const offset = l - chroma / 2;
  return [r, g, b].map((entry) => Math.round((entry + offset) * 255)) as unknown as readonly [number, number, number];
}

/** Parses common CSS color functions from component-value trees. */
export function parseCssFunctionalColor(source: string): CssColor | undefined {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return undefined;
  const values = compact(parsed.value);
  if (values.length !== 1 || values[0]?.kind !== "function-block") return undefined;
  const fn = values[0];
  const name = fn.name.toLowerCase();
  const tokens = compact(fn.value).filter((value) => value.kind !== "comma");
  const slash = tokens.findIndex((value) => value.kind === "delim" && value.value === 47);
  const components = slash < 0 ? tokens : tokens.slice(0, slash);
  const opacity = slash < 0 ? 1 : alpha(tokens[slash + 1]);
  if ((name === "rgb" || name === "rgba") && components.length >= 3 && opacity !== null) {
    const r = channel(components[0]);
    const g = channel(components[1]);
    const b = channel(components[2]);
    const legacyAlpha = slash < 0 && components.length > 3 ? alpha(components[3]) : opacity;
    if (r !== null && g !== null && b !== null && legacyAlpha !== null) {
      return Object.freeze({ r: Math.round(r), g: Math.round(g), b: Math.round(b), a: legacyAlpha });
    }
  }
  if ((name === "hsl" || name === "hsla") && components.length >= 3 && opacity !== null) {
    const hue = components[0]?.kind === "number" ? components[0].value
      : components[0]?.kind === "dimension" && components[0].unit.toLowerCase() === "deg" ? components[0].value : null;
    const saturation = components[1]?.kind === "percentage" ? components[1].value / 100 : null;
    const lightness = components[2]?.kind === "percentage" ? components[2].value / 100 : null;
    const legacyAlpha = slash < 0 && components.length > 3 ? alpha(components[3]) : opacity;
    if (hue !== null && saturation !== null && lightness !== null && legacyAlpha !== null) {
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      return Object.freeze({ r, g, b, a: legacyAlpha });
    }
  }
  return undefined;
}
