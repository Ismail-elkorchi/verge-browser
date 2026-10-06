import type { ComplexSelector, ComponentValue, SelectorSpecificity, SimpleSelector } from "@ismail-elkorchi/css-parser";
import type { CompiledSelectorProgram, SelectorStateDependency } from "./types.js";

export interface NestingContext {
  readonly selectors: readonly ComplexSelector[];
  readonly specificity: SelectorSpecificity;
  readonly identity: string;
  readonly dependencies: ReadonlySet<SelectorStateDependency>;
}

export function nestingContext(selectors: readonly CompiledSelectorProgram[], identity: string): NestingContext {
  let specificity: SelectorSpecificity = { a: 0, b: 0, c: 0 };
  for (const selector of selectors) {
    const next = selector.specificity;
    if (next.a > specificity.a || (next.a === specificity.a && (next.b > specificity.b
      || (next.b === specificity.b && next.c > specificity.c)))) specificity = next;
  }
  return Object.freeze({
    // The nesting selector cannot represent a pseudo-element.
    selectors: Object.freeze(selectors.filter((selector) => selector.pseudoElement === null)
      .flatMap((selector) => selector.selector.selectors)),
    specificity, identity,
    dependencies: new Set(selectors.flatMap((selector) => [...selector.dependencies])),
  });
}

/** A relative nested selector is equivalent to an explicit leading nesting selector. */
export function nestedPrelude(values: readonly ComponentValue[]): readonly ComponentValue[] {
  let start = true;
  const result: ComponentValue[] = [];
  for (const value of values) {
    if (value.kind === "comma") start = true;
    else if (start && value.kind !== "whitespace") {
      if (value.kind === "delim" && [62, 43, 126].includes(value.value)) {
        result.push(Object.freeze({ kind: "delim", value: 38, span: value.span }));
      }
      start = false;
    }
    result.push(value);
  }
  return Object.freeze(result);
}

/** Insert implicit descendant nesting without reparsing or expanding parent selector products. */
export function withImplicitNesting(selector: ComplexSelector): ComplexSelector {
  if (selector.source.containsNesting) return selector;
  const compound = Object.freeze({ type: null,
    simples: Object.freeze([{ kind: "nesting" as const, span: selector.span }]), span: selector.span });
  return Object.freeze({ ...selector,
    compounds: Object.freeze([compound, ...selector.compounds]),
    combinators: Object.freeze([" " as const, ...selector.combinators]),
  });
}

/** Shared :is(parent-list) nodes preserve nesting's maximum-parent specificity semantics. */
export function resolveNesting(selector: ComplexSelector, parent: NestingContext): ComplexSelector {
  const substitute = (simple: SimpleSelector): SimpleSelector => {
    if (simple.kind === "nesting") return Object.freeze({
      kind: "pseudo-class", name: "is", span: simple.span,
      argument: Object.freeze({ kind: "selector-list", selectors: parent.selectors, forgiving: true, relative: false }),
    });
    if (simple.kind !== "pseudo-class" && simple.kind !== "pseudo-element") return simple;
    const argument = simple.argument;
    if (argument.kind === "selector-list") return Object.freeze({ ...simple, argument: Object.freeze({
      ...argument, selectors: Object.freeze(argument.selectors.map((nested) => resolveNesting(nested, parent))),
    }) });
    if (argument.kind === "nth") return Object.freeze({ ...simple, argument: Object.freeze({
      ...argument, of: Object.freeze(argument.of.map((nested) => resolveNesting(nested, parent))),
    }) });
    return simple;
  };
  return Object.freeze({ ...selector,
    compounds: Object.freeze(selector.compounds.map((compound) => Object.freeze({
      ...compound, simples: Object.freeze(compound.simples.map(substitute)),
    }))),
  });
}
