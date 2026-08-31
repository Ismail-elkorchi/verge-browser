import {
  parseComponentValues,
  serializeCssComponentValues,
  type ComponentValue
} from "@ismail-elkorchi/css-parser";

export interface GridPair<T> {
  readonly first: T;
  readonly second: T;
}

function compact(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

export function parseGridPair<T>(source: string, parser: (value: string) => T | null): GridPair<T> | null {
  const parsed = parseComponentValues(source);
  if (!parsed.ok) return null;
  const values = compact(parsed.value);
  if (values.length === 0) return null;
  const whole = parser(serializeCssComponentValues(values));
  if (whole !== null) return Object.freeze({ first: whole, second: whole });
  let result: GridPair<T> | null = null;
  for (let boundary = 1; boundary < values.length; boundary += 1) {
    const first = parser(serializeCssComponentValues(values.slice(0, boundary)));
    const second = parser(serializeCssComponentValues(values.slice(boundary)));
    if (first === null || second === null) continue;
    if (result !== null) return null;
    result = Object.freeze({ first, second });
  }
  return result;
}
