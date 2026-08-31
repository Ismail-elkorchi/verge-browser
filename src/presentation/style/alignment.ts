import { parseComponentValues } from "@ismail-elkorchi/css-parser";

export type CssOverflowAlignment = "default" | "safe" | "unsafe";
export type CssSelfAlignmentPosition =
  | "auto"
  | "normal"
  | "start"
  | "end"
  | "center"
  | "stretch"
  | "baseline";
export type CssContentAlignmentValue =
  | "normal"
  | "start"
  | "end"
  | "center"
  | "stretch"
  | "space-between"
  | "space-around"
  | "space-evenly";

export interface CssSelfAlignment {
  readonly position: CssSelfAlignmentPosition;
  readonly overflow: CssOverflowAlignment;
}

export interface CssContentAlignment {
  readonly value: CssContentAlignmentValue;
  readonly overflow: CssOverflowAlignment;
}

function keywords(source: string): readonly string[] | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const components = parsed.value.filter((component) => component.kind !== "whitespace");
  if (components.length < 1 || components.length > 2
    || components.some((component) => component.kind !== "ident")) return null;
  return Object.freeze(components.map((component) => component.kind === "ident"
    ? component.value.toLowerCase()
    : ""));
}

function normalizedPosition(value: string): string {
  return value === "self-start" || value === "flex-start" ? "start"
    : value === "self-end" || value === "flex-end" ? "end"
      : value;
}

function separatedOverflow(values: readonly string[]): {
  readonly value: string;
  readonly overflow: CssOverflowAlignment;
} | null {
  if (values.length === 1) return { value: normalizedPosition(values[0] ?? ""), overflow: "default" };
  if (values.length !== 2 || (values[0] !== "safe" && values[0] !== "unsafe")) return null;
  return { value: normalizedPosition(values[1] ?? ""), overflow: values[0] };
}

export function parseSelfAlignment(source: string, allowAuto: boolean): CssSelfAlignment | null {
  const values = keywords(source);
  if (values === null) return null;
  const separated = separatedOverflow(values);
  if (separated === null) return null;
  const position = separated.value;
  if ((position === "auto" && allowAuto)
    || position === "normal" || position === "start" || position === "end"
    || position === "center" || position === "stretch" || position === "baseline") {
    if (separated.overflow !== "default"
      && (position === "auto" || position === "normal" || position === "stretch" || position === "baseline")) return null;
    return Object.freeze({ position, overflow: separated.overflow });
  }
  return null;
}

export function parseContentAlignment(source: string): CssContentAlignment | null {
  const values = keywords(source);
  if (values === null) return null;
  const separated = separatedOverflow(values);
  if (separated === null) return null;
  const value = separated.value;
  if (value === "normal" || value === "start" || value === "end" || value === "center"
    || value === "stretch" || value === "space-between" || value === "space-around"
    || value === "space-evenly") {
    if (separated.overflow !== "default" && value.startsWith("space-")) return null;
    return Object.freeze({ value, overflow: separated.overflow });
  }
  return null;
}

export const NORMAL_SELF_ALIGNMENT: CssSelfAlignment = Object.freeze({ position: "normal", overflow: "default" });
export const AUTO_SELF_ALIGNMENT: CssSelfAlignment = Object.freeze({ position: "auto", overflow: "default" });
export const NORMAL_CONTENT_ALIGNMENT: CssContentAlignment = Object.freeze({ value: "normal", overflow: "default" });
