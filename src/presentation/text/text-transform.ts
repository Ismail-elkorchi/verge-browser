import { PackedRows } from "../../memory/packed.js";
export interface TransformedText {
  readonly value: string;
  readonly sourceMapping: "identity" | "mapped";
  readonly sourceUnits: PackedRows;
}

export function transformTextWithSourceRanges(
  value: string,
  transform: "none" | "uppercase" | "lowercase" | "capitalize"
): TransformedText {
  if (transform === "none") {
    return Object.freeze({ value, sourceMapping: "identity", sourceUnits: new PackedRows(2).seal() });
  }
  let output = "";
  const sourceUnits = new PackedRows(2);
  let sourceOffset = 0;
  let capitalizeNext = true;
  for (const codePoint of value) {
    let transformed = codePoint;
    if (transform === "uppercase") transformed = codePoint.toUpperCase();
    else if (transform === "lowercase") transformed = codePoint.toLowerCase();
    else {
      if (capitalizeNext && /\p{L}/u.test(codePoint)) transformed = codePoint.toUpperCase();
      capitalizeNext = /[\s\p{P}]/u.test(codePoint);
    }
    output += transformed;
    for (let index = 0; index < transformed.length; index += 1) {
      sourceUnits.push(sourceOffset, sourceOffset + codePoint.length);
    }
    sourceOffset += codePoint.length;
  }
  return Object.freeze({ value: output, sourceMapping: "mapped", sourceUnits: sourceUnits.seal() });
}

export function transformedSourceRange(
  transformed: TransformedText,
  start: number,
  end: number
): readonly [number, number] {
  if (transformed.sourceMapping === "identity") return [start, end];
  return start < 0 || end > transformed.sourceUnits.length || end <= start ? [start, end]
    : [transformed.sourceUnits.get(start, 0), transformed.sourceUnits.get(end - 1, 1)];
}
