import type { ComponentValue, CssStylesheet, ComplexSelector, CompoundSelector, SimpleSelector } from "@ismail-elkorchi/css-parser";
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

/** Reject unbound prefixes, pruning only forgiving selector-list branches. */
export function bindSelectorNamespaces(selector: ComplexSelector, namespaces: StylesheetNamespaces): ComplexSelector | null {
  const bound = (prefix: string | null): boolean => prefix === null || prefix === "" || prefix === "*" || namespaces.prefixes.has(prefix);
  const compounds: CompoundSelector[] = [];
  for (const compound of selector.compounds) {
    if (!bound(compound.type?.namespace ?? null)) return null;
    const simples: SimpleSelector[] = [];
    for (const simple of compound.simples) {
      if (simple.kind === "attribute" && !bound(simple.namespace)) return null;
      if (simple.kind !== "pseudo-class" && simple.kind !== "pseudo-element") {
        simples.push(simple);
        continue;
      }
      const argument = simple.argument;
      if (argument.kind === "selector-list") {
        const selectors = argument.selectors.map((nested) => bindSelectorNamespaces(nested, namespaces));
        if (!argument.forgiving && selectors.some((nested) => nested === null)) return null;
        simples.push(Object.freeze({ ...simple, argument: Object.freeze({
          ...argument, selectors: Object.freeze(selectors.filter((nested): nested is ComplexSelector => nested !== null)),
        }) }));
      } else if (argument.kind === "nth") {
        const of = argument.of.map((nested) => bindSelectorNamespaces(nested, namespaces));
        if (of.some((nested) => nested === null)) return null;
        simples.push(Object.freeze({ ...simple, argument: Object.freeze({ ...argument, of: Object.freeze(of as ComplexSelector[]) }) }));
      } else simples.push(simple);
    }
    compounds.push(Object.freeze({ ...compound, simples: Object.freeze(simples) }));
  }
  return Object.freeze({ ...selector, compounds: Object.freeze(compounds) });
}
