import { parseDeclaration, type CssDeclaration } from "@ismail-elkorchi/css-parser";
import type { WebElementNode } from "../../document/index.js";
import type { CssColor } from "./types.js";
import { namedColor } from "./named-colors.js";

const BACKGROUND_ELEMENTS = new Set(["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th"]);

/** HTML's legacy color microsyntax is deliberately different from CSS color syntax. */
export function parseLegacyColor(source: string): CssColor | null {
  if (source.length === 0) return null;
  let value = source.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "").toLowerCase();
  if (value === "transparent") return null;
  const named = namedColor(value);
  if (named !== undefined) return named;
  if (/^#[0-9a-f]{3}$/u.test(value)) {
    return Object.freeze({ r: Number.parseInt(value[1] ?? "0", 16) * 17,
      g: Number.parseInt(value[2] ?? "0", 16) * 17, b: Number.parseInt(value[3] ?? "0", 16) * 17, a: 1 });
  }
  value = value.replace(/[\u{10000}-\u{10ffff}]/gu, "00").slice(0, 128);
  if (value.startsWith("#")) value = value.slice(1);
  value = value.replace(/[^0-9a-f]/gu, "0");
  while (value.length === 0 || value.length % 3 !== 0) value += "0";
  const length = value.length / 3;
  let parts = [value.slice(0, length), value.slice(length, length * 2), value.slice(length * 2)].map((part) => part.slice(-8));
  while ((parts[0]?.length ?? 0) > 2 && parts.every((part) => part.startsWith("0"))) parts = parts.map((part) => part.slice(1));
  const [r = 0, g = 0, b = 0] = parts.map((part) => Number.parseInt(part.slice(0, 2), 16));
  return Object.freeze({ r, g, b, a: 1 });
}

/** Element-specific HTML rendering hints enter the author-presentational-hint origin. */
export function presentationalHints(node: WebElementNode): readonly CssDeclaration[] {
  if (node.namespace !== "http://www.w3.org/1999/xhtml") return [];
  const declarations: CssDeclaration[] = [];
  const append = (source: string): void => {
    const declaration = parseDeclaration(source);
    if (!declaration.ok) throw new Error("Invalid generated HTML presentational hint.");
    declarations.push(declaration.value);
  };
  // Image attributes are presentation hints, not intrinsic dimensions. Author
  // declarations (including auto) must replace them through the normal cascade.
  if (node.name === "img") {
    for (const property of ["width", "height"] as const) {
      const attribute = node.attributes.find((entry) => entry.namespace === null && entry.name === property);
      if (attribute === undefined || !/^[\t\n\f\r ]*\d+(?:\.\d+)?[\t\n\f\r ]*$/u.test(attribute.value)) continue;
      const value = Number(attribute.value);
      if (Number.isFinite(value) && value >= 0) append(`${property}:${String(value)}px`);
    }
  }
  if (BACKGROUND_ELEMENTS.has(node.name)) {
    const attribute = node.attributes.find((entry) => entry.namespace === null && entry.name === "bgcolor");
    const color = attribute === undefined ? null : parseLegacyColor(attribute.value);
    if (color !== null) {
      const hex = [color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
      append(`background-color:#${hex}`);
    }
  }
  return Object.freeze(declarations);
}
