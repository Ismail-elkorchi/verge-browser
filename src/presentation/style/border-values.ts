import type { ComponentValue } from "@ismail-elkorchi/css-parser";
import { parseCssColorComponents, parseCssLengthComponents } from "./css-values.js";
import type { CssBorderStyle } from "./table/types.js";
import type { CssColor, CssLength } from "./types.js";

export const MEDIUM_BORDER: CssLength = Object.freeze({ kind: "length", value: 3, unit: "px" });
type Side = "top" | "right" | "bottom" | "left";
type Aspect = "width" | "style" | "color";
export interface BorderValue {
  readonly width: CssLength;
  readonly style: CssBorderStyle;
  readonly color: CssColor | null;
}

export function borderWidthValue(values: readonly ComponentValue[]): CssLength | null {
  const compact = values.filter((value) => value.kind !== "whitespace");
  const token = compact[0];
  if (compact.length === 1 && token?.kind === "ident") {
    const name = token.value.toLowerCase();
    if (name === "thin") return Object.freeze({ kind: "length", value: 1, unit: "px" });
    if (name === "medium") return MEDIUM_BORDER;
    if (name === "thick") return Object.freeze({ kind: "length", value: 5, unit: "px" });
  }
  const length = parseCssLengthComponents(compact, { allowAuto: false });
  if (length?.kind === "length" && length.unit === "%") return null;
  if (length?.kind === "calculation" && length.calculation.percentageDependence !== "none") return null;
  return length;
}

export function borderStyleValue(values: readonly ComponentValue[]): CssBorderStyle | null {
  const compact = values.filter((value) => value.kind !== "whitespace");
  const token = compact[0];
  const word = compact.length === 1 && token?.kind === "ident" ? token.value.toLowerCase() : "";
  return word === "none" || word === "hidden" || word === "solid" ? word : null;
}

export function borderShorthandValue(values: readonly ComponentValue[], current: CssColor | null): BorderValue | null {
  if (values.length > 4096) return null;
  const compact = values.filter((value) => value.kind !== "whitespace");
  if (compact.length < 1 || compact.length > 3) return null;
  let width: CssLength | null = null;
  let style: CssBorderStyle | null = null;
  let color: CssColor | null | undefined;
  for (const component of compact) {
    const parsedWidth = borderWidthValue([component]);
    if (parsedWidth !== null) {
      if (width !== null) return null;
      width = parsedWidth;
      continue;
    }
    const parsedStyle = borderStyleValue([component]);
    if (parsedStyle !== null) {
      if (style !== null) return null;
      style = parsedStyle;
      continue;
    }
    const parsedColor = parseCssColorComponents([component], current);
    if (parsedColor === undefined || color !== undefined) return null;
    color = parsedColor;
  }
  return Object.freeze({ width: width ?? MEDIUM_BORDER, style: style ?? "none", color: color === undefined ? current : color });
}

export const LOGICAL_BORDER_PROPERTIES = Object.freeze([
  ...["block", "inline"].flatMap((axis) => [
    `border-${axis}`, ...["width", "style", "color"].map((aspect) => `border-${axis}-${aspect}`),
    ...["start", "end"].flatMap((edge) => [
      `border-${axis}-${edge}`, ...["width", "style", "color"].map((aspect) => `border-${axis}-${edge}-${aspect}`),
    ]),
  ]),
]);

/** Include mapped logical declarations in the physical ranked candidate set, before selecting a winner. */
export function borderSideCandidates(side: Side, aspect: Aspect, direction: "ltr" | "rtl"): readonly string[] {
  const axis = side === "top" || side === "bottom" ? "block" : "inline";
  const edge = side === "top" || side === (direction === "rtl" ? "right" : "left") ? "start" : "end";
  return [
    `border-${side}-${aspect}`, `border-${side}`, `border-${aspect}`, "border",
    `border-${axis}-${edge}-${aspect}`, `border-${axis}-${edge}`, `border-${axis}-${aspect}`, `border-${axis}`,
  ];
}

export function isBorderShorthand(property: string): boolean {
  return property === "border" || /^border-(?:top|right|bottom|left|(?:block|inline)(?:-(?:start|end))?)$/u.test(property);
}

/** Select one component of a physical quad or logical pair. Other properties are scalar. */
export function borderSideComponents(
  property: string, components: readonly ComponentValue[], side: Side, direction: "ltr" | "rtl"
): readonly ComponentValue[] {
  const compact = components.filter((value) => value.kind !== "whitespace");
  let index = 0;
  if (/^border-(?:width|style|color)$/u.test(property)) {
    const position = ["top", "right", "bottom", "left"].indexOf(side);
    index = compact.length === 1 ? 0 : compact.length === 2 ? position % 2
      : compact.length === 3 && position === 3 ? 1 : position;
  } else if (/^border-(?:block|inline)-(?:width|style|color)$/u.test(property)) {
    index = compact.length === 1 || side === "top" || side === (direction === "rtl" ? "right" : "left") ? 0 : 1;
  }
  const selected = compact[index];
  return selected === undefined ? [] : [selected];
}

export function borderPropertySupported(property: string, values: readonly ComponentValue[]): boolean | null {
  if (!property.startsWith("border-") && property !== "border") return null;
  if (isBorderShorthand(property)) return borderShorthandValue(values, null) !== null;
  const aspect = property.match(/-(width|style|color)$/u)?.[1];
  if (aspect === undefined) return null;
  const compact = values.filter((value) => value.kind !== "whitespace");
  const maximum = /^border-(width|style|color)$/u.test(property) ? 4
    : /^border-(block|inline)-(width|style|color)$/u.test(property) ? 2 : 1;
  if (compact.length < 1 || compact.length > maximum) return false;
  return compact.every((component) => aspect === "width" ? borderWidthValue([component]) !== null
    : aspect === "style" ? borderStyleValue([component]) !== null
      : parseCssColorComponents([component], null) !== undefined);
}

/** Logical inherit reads the corresponding logical edge on the parent, even across direction changes. */
export function borderInheritedSide(property: string, side: Side, direction: "ltr" | "rtl", parentDirection: "ltr" | "rtl"): Side {
  if (!property.startsWith("border-inline") || direction === parentDirection) return side;
  return side === "left" ? "right" : side === "right" ? "left" : side;
}
