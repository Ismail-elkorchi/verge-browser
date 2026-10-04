import { parseComponentValues, serializeCssComponentValues, type ComponentValue } from "@ismail-elkorchi/css-parser";
import type { CompiledMediaQuery, MediaEnvironment } from "./types.js";

type Decision = boolean | null;
type MediaDiagnosticSink = (detail: string, identity: string) => void;
type Condition =
  | { readonly kind: "feature"; readonly values: readonly ComponentValue[] }
  | { readonly kind: "constant"; readonly value: boolean }
  | { readonly kind: "not"; readonly value: Condition }
  | { readonly kind: "and"; readonly values: readonly Condition[] }
  | { readonly kind: "or"; readonly values: readonly Condition[] };

/** The same admission contract applies before cascade evaluation or reuse. */
export function isValidMediaEnvironment(environment: MediaEnvironment): boolean {
  const mediaType: unknown = environment.mediaType;
  const colorScheme: unknown = environment.prefersColorScheme;
  const reducedMotion: unknown = environment.reducedMotion;
  const hover: unknown = environment.hover;
  const pointer: unknown = environment.pointer;
  return Number.isFinite(environment.viewportWidthCssPx) && environment.viewportWidthCssPx > 0
    && Number.isFinite(environment.viewportHeightCssPx) && environment.viewportHeightCssPx > 0
    && mediaType === "screen"
    && (colorScheme === "light" || colorScheme === "dark")
    && typeof reducedMotion === "boolean"
    && (hover === "none" || hover === "hover")
    && (pointer === "none" || pointer === "coarse" || pointer === "fine");
}

const significant = (values: readonly ComponentValue[]): readonly ComponentValue[] => values.filter((value) => value.kind !== "whitespace");
const ident = (value: ComponentValue | undefined): string | null => value?.kind === "ident" ? value.value.toLowerCase() : null;
const negate = (value: Decision): Decision => value === null ? null : !value;
const combine = (operator: "and" | "or", values: readonly Decision[]): Decision => operator === "and"
  ? values.includes(false) ? false : values.includes(null) ? null : true
  : values.includes(true) ? true : values.includes(null) ? null : false;

// Stable positions in immutable media syntax identify diagnostic events without
// copying potentially large authored values into retained artifact keys.
function diagnosticIdentity(kind: string, values: readonly ComponentValue[]): string {
  return `${kind}:${String(values[0]?.span.start.offset ?? 0)}:${String(values.at(-1)?.span.end.offset ?? 0)}`;
}

function inParens(value: ComponentValue | undefined): Condition | null {
  if (value?.kind === "function-block") return { kind: "feature", values: [value] };
  if (value?.kind !== "simple-block" || value.associatedToken !== "open-paren") return null;
  return condition(significant(value.value), true) ?? { kind: "feature", values: value.value };
}

function condition(values: readonly ComponentValue[], allowOr: boolean): Condition | null {
  if (ident(values[0]) === "not") {
    const child = values.length === 2 ? inParens(values[1]) : null;
    return child === null ? null : { kind: "not", value: child };
  }
  const first = inParens(values[0]);
  if (first === null) return null;
  if (values.length === 1) return first;
  const operator = ident(values[1]);
  if ((operator !== "and" && operator !== "or") || (!allowOr && operator === "or") || values.length % 2 !== 1) return null;
  const children: Condition[] = [first];
  for (let index = 1; index < values.length; index += 2) {
    if (ident(values[index]) !== operator) return null;
    const child = inParens(values[index + 1]);
    if (child === null) return null;
    children.push(child);
  }
  return { kind: operator, values: children };
}

function query(values: readonly ComponentValue[], unsupported?: MediaDiagnosticSink): Condition | null {
  const direct = condition(values, true);
  if (direct !== null) return direct;
  let index = 0;
  const modifier = ident(values[index]);
  if (modifier === "not" || modifier === "only") index += 1;
  const type = ident(values[index++]);
  if (type === null || ["not", "only", "and", "or", "layer"].includes(type)) return null;
  if (!["screen", "all", "print"].includes(type)) unsupported?.(`Unsupported media type: ${type}`, diagnosticIdentity("type", values));
  let result: Condition = { kind: "constant", value: type === "screen" || type === "all" };
  if (index < values.length) {
    if (ident(values[index++]) !== "and") return null;
    const child = condition(values.slice(index), false);
    if (child === null) return null;
    result = { kind: "and", values: [result, child] };
  }
  return modifier === "not" ? { kind: "not", value: result } : result;
}

function lengthPx(value: ComponentValue | undefined): number | null {
  if (value?.kind === "number" && value.value === 0) return 0;
  if (value?.kind !== "dimension" || !Number.isFinite(value.value)) return null;
  const scale: Readonly<Record<string, number>> = { px: 1, em: 16, rem: 16, ch: 8, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
  const unit = value.unit.toLowerCase();
  const factor = Object.hasOwn(scale, unit) ? scale[unit] : undefined;
  return factor === undefined ? null : value.value * factor;
}

function compare(left: number, operator: string, right: number): boolean {
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  return left === right;
}

function rangeFeature(values: readonly ComponentValue[], environment: MediaEnvironment): Decision {
  const operands: ComponentValue[] = [];
  const operators: string[] = [];
  let index = 0;
  while (index < values.length) {
    const operand = values[index++];
    if (operand === undefined) return null;
    operands.push(operand);
    if (index === values.length) break;
    const delimiter = values[index++];
    if (delimiter?.kind !== "delim" || ![60, 61, 62].includes(delimiter.value)) return null;
    let operator = String.fromCharCode(delimiter.value);
    const equals = values[index];
    if (delimiter.value !== 61 && equals?.kind === "delim" && equals.value === 61) {
      if (delimiter.span.end.offset !== equals.span.start.offset) return null;
      operator += "=";
      index += 1;
    }
    operators.push(operator);
  }
  if (operands.length < 2 || operands.length > 3 || operands.length !== operators.length + 1) return null;
  const featureIndex = operands.findIndex((value) => value.kind === "ident");
  const name = ident(operands[featureIndex]);
  if ((name !== "width" && name !== "height") || operands.filter((value) => value.kind === "ident").length !== 1) return null;
  if (operands.length === 3 && (featureIndex !== 1 || operators[0]?.[0] !== operators[1]?.[0] || operators[0] === "=")) return null;
  const dimensions = operands.map((value, position) => position === featureIndex
    ? name === "width" ? environment.viewportWidthCssPx : environment.viewportHeightCssPx : lengthPx(value));
  if (dimensions.some((value) => value === null)) return null;
  return operators.every((operator, position) => compare(dimensions[position] as number, operator, dimensions[position + 1] as number));
}

function feature(values: readonly ComponentValue[], environment: MediaEnvironment): Decision {
  const tokens = significant(values);
  const name = ident(tokens[0]);
  if (name === null) return rangeFeature(tokens, environment);
  if (tokens.length > 1 && tokens[1]?.kind !== "colon") return rangeFeature(tokens, environment);
  if (tokens.length !== 1 && tokens.length !== 3) return null;
  const value = tokens[2];
  const keyword = ident(value);
  const boolean = tokens.length === 1;
  const dimension = /^(min-|max-)?(width|height)$/u.exec(name);
  if (dimension !== null) {
    const actual = dimension[2] === "width" ? environment.viewportWidthCssPx : environment.viewportHeightCssPx;
    if (boolean) return dimension[1] === undefined ? actual > 0 : null;
    const boundary = lengthPx(value);
    return boundary === null ? null : compare(actual, dimension[1] === "min-" ? ">=" : dimension[1] === "max-" ? "<=" : "=", boundary);
  }
  if (name === "prefers-reduced-motion") return boolean || keyword === "reduce" ? environment.reducedMotion
    : keyword === "no-preference" ? !environment.reducedMotion : null;
  if (name === "prefers-color-scheme") return boolean ? true
    : keyword === "dark" || keyword === "light" ? environment.prefersColorScheme === keyword : null;
  if (name === "hover" || name === "any-hover") return boolean ? environment.hover !== "none"
    : keyword === "hover" || keyword === "none" ? environment.hover === keyword : null;
  if (name === "pointer" || name === "any-pointer") return boolean ? environment.pointer !== "none"
    : keyword === "fine" || keyword === "coarse" || keyword === "none" ? environment.pointer === keyword : null;
  if (name === "orientation") return keyword === "portrait" ? environment.viewportHeightCssPx >= environment.viewportWidthCssPx
    : keyword === "landscape" ? environment.viewportWidthCssPx > environment.viewportHeightCssPx : null;
  return null;
}

function evaluate(value: Condition, environment: MediaEnvironment | null, unsupported?: MediaDiagnosticSink): Decision {
  if (value.kind === "constant") return value.value;
  if (value.kind === "not") return negate(evaluate(value.value, environment, unsupported));
  if (value.kind === "and" || value.kind === "or") return combine(value.kind, value.values.map((child) => evaluate(child, environment, unsupported)));
  if (environment === null) return null;
  const result = feature(value.values, environment);
  if (result === null) unsupported?.(`Unsupported media feature: ${serializeCssComponentValues(value.values).trim()}`, diagnosticIdentity("feature", value.values));
  return result;
}

/** Share parsed source conditions between cascade evaluation and invalidation. */
export function compileMediaQuery(source: string | readonly ComponentValue[] | null): CompiledMediaQuery {
  if (source === null || (typeof source === "string" && source.trim().length === 0)) return null;
  if (typeof source !== "string") return source;
  const parsed = parseComponentValues(source);
  return parsed.ok ? parsed.value : false;
}

/** Parse operators, grouping and comma recovery before evaluating supported media features. */
export function mediaApplies(source: string | CompiledMediaQuery, environment: MediaEnvironment | null, unsupported?: MediaDiagnosticSink): boolean {
  const compiled = typeof source === "string" ? compileMediaQuery(source) : source;
  if (compiled === null) return true;
  if (compiled === false) return false;
  const groups: ComponentValue[][] = [[]];
  for (const value of compiled) {
    if (value.kind === "comma") groups.push([]);
    else if (value.kind !== "whitespace") groups.at(-1)?.push(value);
  }
  return groups.some((values) => {
    const expression = query(values, unsupported);
    if (expression === null) {
      unsupported?.(`Invalid media query: ${serializeCssComponentValues(values).trim()}`, diagnosticIdentity("invalid", values));
      return false;
    }
    const result = evaluate(expression, environment, unsupported);
    return result === true || (environment === null && result === null);
  });
}

/** Fetch-time filtering is conservative for viewport- or preference-dependent conditions. */
export function terminalMediaMayApply(value: string | null): boolean { return mediaApplies(value, null); }
