import type { ComponentValue } from "@ismail-elkorchi/css-parser";
import type { ComputedStyle } from "./types.js";

type ListStyleType = ComputedStyle["listStyleType"];
type ListStylePosition = ComputedStyle["listStylePosition"];

function supportedType(value: string): ListStyleType | null {
  switch (value) {
    case "none": case "disc": case "circle": case "square": case "decimal":
    case "decimal-leading-zero": case "lower-alpha": case "upper-alpha": return value;
    default: return null;
  }
}

function keywords(values: readonly ComponentValue[]): readonly string[] | null {
  const output: string[] = [];
  for (const value of values) {
    if (value.kind === "whitespace") continue;
    if (value.kind !== "ident") return null;
    output.push(value.value.toLowerCase());
  }
  return output;
}

export function parseListStyleType(values: readonly ComponentValue[]): ListStyleType | null {
  const parts = keywords(values);
  return parts?.length === 1 ? supportedType(parts[0] ?? "") : null;
}

export function parseListStylePosition(values: readonly ComponentValue[]): ListStylePosition | null {
  const parts = keywords(values);
  const value = parts?.[0];
  return parts?.length === 1 && (value === "inside" || value === "outside") ? value : null;
}

/** The supported shorthand includes image:none, but never silently drops an image or unknown token. */
export function parseListStyle(values: readonly ComponentValue[]): {
  readonly type: ListStyleType;
  readonly position: ListStylePosition;
} | null {
  const parts = keywords(values);
  if (parts === null || parts.length < 1 || parts.length > 3) return null;
  let type: ListStyleType | null = null;
  let position: ListStylePosition | null = null;
  let noneCount = 0;
  for (const part of parts) {
    if (part === "inside" || part === "outside") {
      if (position !== null) return null;
      position = part;
    } else if (part === "none") noneCount += 1;
    else {
      if (type !== null) return null;
      type = supportedType(part);
      if (type === null) return null;
    }
  }
  if (noneCount > (type === null ? 2 : 1)) return null;
  return { type: type ?? (noneCount > 0 ? "none" : "disc"), position: position ?? "outside" };
}
