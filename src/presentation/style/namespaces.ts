import type { ComponentValue, CssStylesheet } from "@ismail-elkorchi/css-parser";
import type { StylesheetNamespaces } from "./types.js";

export const EMPTY_NAMESPACES: StylesheetNamespaces = Object.freeze({
  defaultNamespace: Object.freeze({ kind: "any" }),
  prefixes: new Map<string, string | null>(),
  fingerprint: "[]",
});

function namespaceUrl(value: ComponentValue | undefined): string | null {
  if (value?.kind === "string" || value?.kind === "url") return value.value;
  if (value?.kind !== "function-block" || value.name.toLowerCase() !== "url") return null;
  const tokens = value.value.filter((token) => token.kind !== "whitespace");
  return tokens.length === 1 && tokens[0]?.kind === "string" ? tokens[0].value : null;
}

/** Namespace bindings belong to one stylesheet, including each imported stylesheet. */
export function stylesheetNamespaces(stylesheet: CssStylesheet): StylesheetNamespaces {
  const prefixes = new Map<string, string | null>();
  let defaultNamespace = EMPTY_NAMESPACES.defaultNamespace;
  let declarationsAllowed = true;
  let namespaceSeen = false;
  for (const rule of stylesheet.rules) {
    const name = rule.kind === "at-rule" ? rule.name.toLowerCase() : null;
    if (!namespaceSeen && (name === "charset" || name === "import")) continue;
    if (name !== "namespace") {
      declarationsAllowed = false;
      continue;
    }
    if (!declarationsAllowed || rule.block !== null) continue;
    namespaceSeen = true;
    const tokens = rule.prelude.filter((token) => token.kind !== "whitespace");
    const prefix = tokens.length === 2 && tokens[0]?.kind === "ident" ? tokens[0].value : null;
    if (tokens.length !== (prefix === null ? 1 : 2)) continue;
    const uri = namespaceUrl(tokens[prefix === null ? 0 : 1]);
    if (uri === null) continue;
    if (prefix === null) defaultNamespace = Object.freeze({ kind: "namespace", namespace: uri === "" ? null : uri });
    else prefixes.set(prefix, uri === "" ? null : uri);
  }
  if (prefixes.size === 0 && defaultNamespace.kind === "any") return EMPTY_NAMESPACES;
  return Object.freeze({ defaultNamespace, prefixes, fingerprint: JSON.stringify([defaultNamespace, [...prefixes].sort(([left], [right]) => left.localeCompare(right))]) });
}
