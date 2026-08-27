export interface GridPair<T> {
  readonly first: T;
  readonly second: T;
}

export function parseGridPair<T>(source: string, parser: (value: string) => T | null): GridPair<T> | null {
  const parts = source.trim().split(/\s+/u);
  if (parts.length < 1 || parts.length > 2) return null;
  const first = parser(parts[0] as string);
  const second = parser((parts[1] ?? parts[0]) as string);
  return first === null || second === null ? null : Object.freeze({ first, second });
}

