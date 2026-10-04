import type { ComponentValue } from "@ismail-elkorchi/css-parser";
import type { CascadeLayerPath } from "./types.js";

/** Layer names are CSS identifiers, separated by dots; escapes are already decoded. */
export function layerPath(values: readonly ComponentValue[]): CascadeLayerPath | null {
  const tokens = values.filter((value) => value.kind !== "whitespace");
  if (tokens.length === 0 || tokens.length % 2 !== 1) return null;
  const names: string[] = [];
  for (const [index, value] of tokens.entries()) {
    if (index % 2 === 0) {
      if (value.kind !== "ident" || ["initial", "inherit", "unset", "revert", "revert-layer"].includes(value.value.toLowerCase())) return null;
      names.push(value.value);
    } else if (value.kind !== "delim" || value.value !== 46) return null;
  }
  return Object.freeze(names);
}

export function layerNames(values: readonly ComponentValue[]): readonly CascadeLayerPath[] | null {
  const groups: ComponentValue[][] = [[]];
  for (const value of values) {
    if (value.kind === "comma") groups.push([]);
    else groups.at(-1)?.push(value);
  }
  const paths = groups.map(layerPath);
  return paths.some((path) => path === null) ? null : Object.freeze(paths as CascadeLayerPath[]);
}
