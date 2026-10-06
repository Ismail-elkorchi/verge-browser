import type { ComplexSelector, CompoundSelector, SelectorList, SimpleSelector } from "@ismail-elkorchi/css-parser";
import type { StylesheetNamespaces } from "./types.js";

const IMPLEMENTED_PSEUDO_CLASSES = new Set([
  "active", "any-link", "checked", "disabled", "empty", "enabled", "first-child",
  "first-of-type", "focus", "focus-visible", "focus-within", "has", "hover", "is",
  "last-child", "last-of-type", "link", "not", "nth-child", "nth-last-child",
  "nth-last-of-type", "nth-of-type", "only-child", "only-of-type", "open", "root",
  "scope", "target", "visited", "where",
]);

const PSEUDO_ELEMENT_STATES = new Set([
  "hover", "active", "focus", "focus-visible", "focus-within", "is", "where", "not",
]);

/** One contextual admission boundary for ordinary styles and strict selector() queries. */
export function admitSelectorList(
  list: SelectorList,
  namespaces: StylesheetNamespaces,
  mode: "stylesheet" | "supports",
): SelectorList | null {
  if (mode === "supports" && (list.selectors.length !== 1 || list.source.discardedInvalidBranches.length > 0)) return null;
  const bound = (prefix: string | null): boolean => prefix === null || prefix === "" || prefix === "*" || namespaces.prefixes.has(prefix);
  const admitComplex = (selector: ComplexSelector, pseudoElementState = false): ComplexSelector | null => {
    if (pseudoElementState && (selector.leadingCombinator !== null || selector.compounds.length !== 1)) return null;
    const compounds: CompoundSelector[] = [];
    for (const [compoundIndex, compound] of selector.compounds.entries()) {
      if (!bound(compound.type?.namespace ?? null) || (pseudoElementState && compound.type !== null)) return null;
      let afterPseudoElement = pseudoElementState;
      const simples: SimpleSelector[] = [];
      for (const [simpleIndex, simple] of compound.simples.entries()) {
        if (simple.kind === "attribute" && !bound(simple.namespace)) return null;
        if (afterPseudoElement && simple.kind !== "pseudo-class") return null;
        if (simple.kind === "pseudo-element") {
          // Name compatibility never bypasses structural or state validity.
          if (compoundIndex !== selector.compounds.length - 1) return null;
          afterPseudoElement = true;
          // Normative Selectors 4 WebKit compatibility elements remain AST nodes
          // that match nothing. They do not claim implementation support.
          if (simple.argument.kind === "none" && simple.name.startsWith("-webkit-")) {
            if (mode === "supports") return null;
          } else if (simple.argument.kind !== "none" || !["before", "after", "marker"].includes(simple.name)
            || simpleIndex !== compound.simples.length - 1) return null;
        }
        if (simple.kind !== "pseudo-class") {
          simples.push(simple);
          continue;
        }
        if (!IMPLEMENTED_PSEUDO_CLASSES.has(simple.name)
          || (afterPseudoElement && !PSEUDO_ELEMENT_STATES.has(simple.name))) return null;
        const argument = simple.argument;
        if (argument.kind === "selector-list") {
          const selectors: ComplexSelector[] = [];
          for (const nested of argument.selectors) {
            const admitted = admitComplex(nested, afterPseudoElement);
            if (admitted !== null) selectors.push(admitted);
            else if (mode === "supports" || !argument.forgiving) return null;
          }
          simples.push(Object.freeze({ ...simple, argument: Object.freeze({ ...argument, selectors: Object.freeze(selectors) }) }));
        } else if (argument.kind === "nth") {
          const of: ComplexSelector[] = [];
          for (const nested of argument.of) {
            const admitted = admitComplex(nested, afterPseudoElement);
            if (admitted === null) return null;
            of.push(admitted);
          }
          simples.push(Object.freeze({ ...simple, argument: Object.freeze({ ...argument, of: Object.freeze(of) }) }));
        } else if (argument.kind === "none") simples.push(simple);
        else return null;
      }
      compounds.push(Object.freeze({ ...compound, simples: Object.freeze(simples) }));
    }
    return Object.freeze({ ...selector, compounds: Object.freeze(compounds) });
  };
  const selectors: ComplexSelector[] = [];
  for (const selector of list.selectors) {
    const admitted = admitComplex(selector);
    if (admitted === null) return null;
    selectors.push(admitted);
  }
  return Object.freeze({ ...list, selectors: Object.freeze(selectors) });
}
