export interface TransformedText {
  readonly value: string;
  readonly sourceUnits: readonly { readonly start: number; readonly end: number }[];
}

export function transformTextWithSourceRanges(
  value: string,
  transform: "none" | "uppercase" | "lowercase" | "capitalize"
): TransformedText {
  let output = "";
  const sourceUnits: { readonly start: number; readonly end: number }[] = [];
  let sourceOffset = 0;
  let capitalizeNext = true;
  for (const codePoint of value) {
    let transformed = codePoint;
    if (transform === "uppercase") transformed = codePoint.toUpperCase();
    else if (transform === "lowercase") transformed = codePoint.toLowerCase();
    else if (transform === "capitalize") {
      if (capitalizeNext && /\p{L}/u.test(codePoint)) transformed = codePoint.toUpperCase();
      capitalizeNext = /[\s\p{P}]/u.test(codePoint);
    }
    output += transformed;
    for (let index = 0; index < transformed.length; index += 1) {
      sourceUnits.push({ start: sourceOffset, end: sourceOffset + codePoint.length });
    }
    sourceOffset += codePoint.length;
  }
  return Object.freeze({ value: output, sourceUnits: Object.freeze(sourceUnits) });
}

export function transformedSourceRange(
  transformed: TransformedText,
  start: number,
  end: number
): readonly [number, number] {
  const first = transformed.sourceUnits[start];
  const last = transformed.sourceUnits[end - 1];
  return first === undefined || last === undefined ? [start, end] : [first.start, last.end];
}
