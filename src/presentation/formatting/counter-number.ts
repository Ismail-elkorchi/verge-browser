import type { CounterStyle } from "../style/generated-content.js";

/** Shared suffix-free representation for CSS generated content and HTML list markers. */
export function formatCounterNumber(value: number, style: CounterStyle): string {
  if (style === "none") return "";
  if (style === "disc") return "•";
  if (style === "circle") return "◦";
  if (style === "square") return "▪";
  const integer = Math.trunc(value);
  if (style === "decimal-leading-zero") {
    return `${integer < 0 ? "-" : ""}${String(Math.abs(integer)).padStart(integer < 0 ? 1 : 2, "0")}`;
  }
  if (style === "decimal" || integer <= 0) return String(integer);
  let current = integer;
  let output = "";
  while (current > 0) {
    current -= 1;
    output = String.fromCharCode((style === "upper-alpha" ? 65 : 97) + current % 26) + output;
    current = Math.floor(current / 26);
  }
  return output;
}

export function formatListMarker(value: number, style: CounterStyle): string {
  const representation = formatCounterNumber(value, style);
  return style === "decimal" || style === "decimal-leading-zero" || style === "lower-alpha" || style === "upper-alpha"
    ? `${representation}.` : representation;
}
