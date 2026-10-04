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
  if (node.namespace !== "http://www.w3.org/1999/xhtml" || !BACKGROUND_ELEMENTS.has(node.name)) return [];
  const attribute = node.attributes.find((entry) => entry.namespace === null && entry.name === "bgcolor");
  if (attribute === undefined) return [];
  const color = parseLegacyColor(attribute.value);
  if (color === null) return [];
  const hex = [color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  const declaration = parseDeclaration(`background-color:#${hex}`);
  if (!declaration.ok) throw new Error("Invalid generated HTML color hint.");
  return Object.freeze([declaration.value]);
}
