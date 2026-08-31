import { parseComponentValues, serializeCssComponentValues } from "@ismail-elkorchi/css-parser";
import { parseCssLength } from "../css-values.js";
import type {
  CssBorderCollapse,
  CssBorderSpacing,
  CssBorderStyle,
  CssCaptionSide,
  CssEmptyCells,
  CssTableLayout,
} from "./types.js";

function oneKeyword<T extends string>(source: string, values: readonly T[]): T | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const significant = parsed.value.filter((value) => value.kind !== "whitespace");
  if (significant.length !== 1 || significant[0]?.kind !== "ident") return null;
  const keyword = significant[0].value.toLowerCase() as T;
  return values.includes(keyword) ? keyword : null;
}

export const parseTableLayout = (source: string): CssTableLayout | null => oneKeyword(source, ["auto", "fixed"]);
export const parseBorderCollapse = (source: string): CssBorderCollapse | null => oneKeyword(source, ["separate", "collapse"]);
export const parseCaptionSide = (source: string): CssCaptionSide | null => oneKeyword(source, ["top", "bottom"]);
export const parseEmptyCells = (source: string): CssEmptyCells | null => oneKeyword(source, ["show", "hide"]);
export const parseTableBorderStyle = (source: string): CssBorderStyle | null => oneKeyword(source, ["none", "hidden", "solid"]);

function isLengthWithoutPercentage(value: ReturnType<typeof parseCssLength>): boolean {
  if (value === null || value.kind === "auto" || value.kind === "none") return false;
  if (value.kind === "zero") return true;
  if (value.kind === "calculation") return value.calculation.percentageDependence === "none";
  return value.unit !== "%";
}

export function parseBorderSpacing(source: string): CssBorderSpacing | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const significant = parsed.value.filter((value) => value.kind !== "whitespace");
  if (significant.length < 1 || significant.length > 2) return null;
  const lengths = significant.map((value) => parseCssLength(serializeCssComponentValues([value]), { allowNegative: false }));
  if (lengths.some((value) => !isLengthWithoutPercentage(value))) return null;
  const horizontal = lengths[0];
  const vertical = lengths[1] ?? horizontal;
  return horizontal === undefined || horizontal === null || vertical === undefined || vertical === null
    ? null : Object.freeze({ horizontal, vertical });
}

export const TABLE_PROPERTIES = Object.freeze(new Set([
  "table-layout", "border-collapse", "border-spacing", "caption-side", "empty-cells",
]));

export function tablePropertyValueSupported(property: string, value: string): boolean {
  if (property === "table-layout") return parseTableLayout(value) !== null;
  if (property === "border-collapse") return parseBorderCollapse(value) !== null;
  if (property === "border-spacing") return parseBorderSpacing(value) !== null;
  if (property === "caption-side") return parseCaptionSide(value) !== null;
  if (property === "empty-cells") return parseEmptyCells(value) !== null;
  return false;
}
