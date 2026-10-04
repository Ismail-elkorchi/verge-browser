import { SelectorResultCache } from "./selector-cache.js";
import { nestedPrelude, nestingContext, resolveNesting, withImplicitNesting, type NestingContext } from "./nesting.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { presentationalHints } from "./presentational-hints.js";
import { EMPTY_NAMESPACES, stylesheetNamespaces, bindSelectorNamespaces } from "./namespaces.js";
import { styleBudgets } from "./budgets.js";
import { compileMediaQuery } from "./media.js";
import { registerRetainedOwner } from "../../memory/retained-cost.js";
import {
  parseBlockContents,
  createPropertyValidationSession,
  parseSelectorListFromComponentValues,
  parseStylesheet,
  resolveCssProperty,
  serializeCssComponentValues,
  specificityOfComplexSelector,
  type ComplexSelector,
  type ComponentValue,
  type CssDeclaration,
  type CssBlockItem,
  type CssQualifiedRule,
  type CssRule,
  type SelectorList,
  type PropertyValidationSession,
} from "@ismail-elkorchi/css-parser";

import type { DocumentNodeRef } from "../../document/index.js";
import { USER_AGENT_STYLESHEET, USER_AGENT_STYLESHEET_SOURCE } from "./user-agent.js";
import type {
  CompileStylesheetProgramInput,
  CompiledSelectorProgram,
  CompiledDeclarationProgram,
  CompiledMediaQuery,
  PseudoElementIdentity,
  SelectorStateDependency,
  StyleBudgets,
  StyleDiagnostic,
  StylesheetProgram,
  StylesheetProgramSource,
  StylesheetNamespaces,
  StylesheetSelectorRuntime,
  CustomPropertySubstitutionCache,
  SubstitutedCssValue,
} from "./types.js";

const validationValueSizes = new WeakMap<PropertyValidationSession, number>();

/** Values may grow during substitution; charge the values actually submitted to validation. */
export function recordPropertyValidationValue(session: PropertyValidationSession, codeUnits: number): void {
  validationValueSizes.set(session, Math.max(validationValueSizes.get(session) ?? 0, codeUnits));
}

const USER_AGENT_SYNTAX = (() => {
  const result = parseStylesheet(USER_AGENT_STYLESHEET);
  if (!result.ok) throw new Error("The built-in user-agent stylesheet is invalid.");
  return result.value;
})();

class BoundedSubstitutionCache implements CustomPropertySubstitutionCache {
  readonly #limit: number;
  readonly #values = new Map<string, SubstitutedCssValue | null>();

  public constructor(limit: number) {
    this.#limit = limit;
    registerRetainedOwner(this, () => [this.#values]);
  }
  public get size(): number { return this.#values.size; }
  public get(key: string): SubstitutedCssValue | null | undefined {
    const value = this.#values.get(key);
    if (value === undefined && !this.#values.has(key)) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value ?? null);
    return value ?? null;
  }
  public set(key: string, value: SubstitutedCssValue | null): void {
    this.#values.delete(key);
    this.#values.set(key, value);
    while (this.#values.size > this.#limit) {
      const oldest = this.#values.keys().next().value;
      if (oldest === undefined) break;
      this.#values.delete(oldest);
    }
  }
  public clear(): void { this.#values.clear(); }
}

function selectorRuntime(maximumBytes: number): StylesheetSelectorRuntime {
  return {
    state: null,
    namespaces: EMPTY_NAMESPACES,
    session: null,
    matches: new SelectorResultCache(maximumBytes),
    computedSnapshot: null,
    computedEnvironment: null,
    clear() {
      this.state = null;
      this.namespaces = EMPTY_NAMESPACES;
      this.session = null;
      this.matches.clear();
      this.computedSnapshot = null;
      this.computedEnvironment = null;
    },
  };
}

function fingerprintText(seed: number, value: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function dependencyForPseudo(name: string): SelectorStateDependency {
  if (name === "target") return "target";
  if (name === "focus" || name === "focus-visible" || name === "focus-within") return "focus";
  if (name === "hover") return "hover";
  if (name === "active") return "active";
  if (name === "checked" || name === "selected") return "checked-selected";
  if (name === "open") return "disclosure-open";
  return "document-structural";
}

function selectorDependencies(selector: ComplexSelector): ReadonlySet<SelectorStateDependency> {
  const dependencies = new Set<SelectorStateDependency>(["document-structural"]);
  const visit = (complex: ComplexSelector): void => {
    for (const compound of complex.compounds) {
      for (const simple of compound.simples) {
        if (simple.kind === "attribute") {
          const name = simple.name.toLowerCase();
          if (name === "checked" || name === "selected") dependencies.add("checked-selected");
          if (name === "open") dependencies.add("disclosure-open");
        }
        if (simple.kind !== "pseudo-class") continue;
        dependencies.add(dependencyForPseudo(simple.name.toLowerCase()));
        if (simple.argument.kind === "selector-list") {
          for (const nested of simple.argument.selectors) visit(nested);
        } else if (simple.argument.kind === "nth") {
          for (const nested of simple.argument.of) visit(nested);
        }
      }
    }
  };
  visit(selector);
  return dependencies;
}

function containsVariableReference(values: readonly ComponentValue[]): boolean {
  for (const value of values) {
    if (value.kind === "function-block" && value.name.toLowerCase() === "var") return true;
    if ((value.kind === "function-block" || value.kind === "simple-block")
      && containsVariableReference(value.value)) return true;
  }
  return false;
}

function compileDeclaration(declaration: CssDeclaration, validationSession: PropertyValidationSession): CompiledDeclarationProgram {
  const serializedValue = serializeCssComponentValues(declaration.value).trim();
  const variable = containsVariableReference(declaration.value);
  if (!variable) recordPropertyValidationValue(validationSession, serializedValue.length);
  const validationStatus = variable ? "deferred" : validationSession.validate(declaration.name, declaration.value).status;
  return Object.freeze({
    declaration,
    property: declaration.name.startsWith("--")
      ? declaration.name
      : resolveCssProperty(declaration.name.toLowerCase())?.name ?? null,
    value: declaration.value,
    serializedValue,
    containsVariableReference: variable,
    validationStatus,
  });
}

function selectorTarget(selector: ComplexSelector): {
  readonly selector: ComplexSelector;
  readonly pseudoElement: PseudoElementIdentity | null;
} {
  const compounds = [...selector.compounds];
  const final = compounds.at(-1);
  if (final === undefined) return { selector, pseudoElement: null };
  const pseudoIndex = final.simples.findIndex((simple) => simple.kind === "pseudo-element");
  if (pseudoIndex < 0) return { selector, pseudoElement: null };
  const pseudo = final.simples[pseudoIndex];
  const identity = pseudo?.kind === "pseudo-element"
    && pseudo.argument.kind === "none"
    && (pseudo.name === "before" || pseudo.name === "after" || pseudo.name === "marker")
    ? pseudo.name
    : null;
  if (identity === null) return { selector, pseudoElement: null };
  compounds[compounds.length - 1] = Object.freeze({
    ...final,
    simples: Object.freeze(final.simples.filter((_, index) => index !== pseudoIndex)),
  });
  return {
    selector: Object.freeze({ ...selector, compounds: Object.freeze(compounds) }),
    pseudoElement: identity,
  };
}

function selectorSemanticFingerprint(selector: ComplexSelector): string {
  return JSON.stringify(selector, (key, value: unknown) => key === "span" ? undefined : value);
}

function compileSelectorRule(
  rule: CssQualifiedRule,
  sourceUrl: string,
  namespaces: StylesheetNamespaces,
  addDiagnostic: (diagnostic: StyleDiagnostic) => void,
  parent: NestingContext | null,
  identity: (key: string) => string,
  signal?: AbortSignal,
): readonly CompiledSelectorProgram[] {
  const parsed = parseSelectorListFromComponentValues(parent === null ? rule.prelude : nestedPrelude(rule.prelude), {
    ...(signal === undefined ? {} : { signal }),
  });
  if (!parsed.ok) {
    addDiagnostic(Object.freeze({
      code: "selector-parse",
      sourceUrl,
      detail: "Invalid selector syntax.",
      occurrences: 1,
    }));
    return Object.freeze([]);
  }
  for (const error of parsed.errors) {
    addDiagnostic(Object.freeze({
      code: "selector-parse",
      sourceUrl,
      detail: error.message,
      occurrences: 1,
    }));
  }
  const selectors = parsed.value.selectors.map((selector) => bindSelectorNamespaces(selector, namespaces));
  if (selectors.some((selector) => selector === null)) {
    addDiagnostic(Object.freeze({ code: "selector-parse", sourceUrl, detail: "Unbound stylesheet namespace prefix.", occurrences: 1 }));
    return Object.freeze([]);
  }
  return Object.freeze((selectors as ComplexSelector[]).map((selector) => {
    const normalized = parent === null ? selector : withImplicitNesting(selector);
    const expanded = parent === null ? normalized : resolveNesting(normalized, parent);
    const target = selectorTarget(expanded);
    const list: SelectorList = Object.freeze({
      ...parsed.value,
      selectors: Object.freeze([target.selector]),
    });
    return Object.freeze({
      selector: list,
      fingerprint: identity(`${parent?.identity ?? "root"}\u0000${selectorSemanticFingerprint(selectorTarget(normalized).selector)}`),
      pseudoElement: target.pseudoElement,
      specificity: specificityOfComplexSelector(normalized, parent === null ? {} : { nesting: parent.specificity }),
      dependencies: new Set([...selectorDependencies(normalized), ...(parent?.dependencies ?? [])]),
    });
  }));
}

function styleNodes(input: CompileStylesheetProgramInput): {
  readonly elements: readonly DocumentNodeRef[];
  readonly totalNodes: number;
} {
  const elements: DocumentNodeRef[] = [];
  let totalNodes = 0;
  const pending = [input.document.root];
  while (pending.length > 0) {
    input.signal?.throwIfAborted();
    const ref = pending.pop();
    if (ref === undefined) continue;
    const node = input.document.node(ref);
    totalNodes += 1;
    if (node.kind === "element") elements.push(node.ref);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return { elements: Object.freeze(elements), totalNodes };
}

function stylesheetMediaQueries(
  sources: readonly StylesheetProgramSource[],
  signal?: AbortSignal,
): StylesheetProgram["mediaQueries"] {
  const mediaQueries: CompiledMediaQuery[] = [];
  const visit = (rules: readonly CssRule[]): void => {
    for (const rule of rules) {
      signal?.throwIfAborted();
      if (rule.kind === "at-rule" && rule.name.toLowerCase() === "media") {
        mediaQueries.push(rule.prelude);
      }
      if (rule.block !== null) visit(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"));
    }
  };
  for (const source of sources) {
    signal?.throwIfAborted();
    for (const condition of source.mediaConditions) {
      signal?.throwIfAborted();
      mediaQueries.push(condition);
    }
    visit(source.stylesheet.rules);
  }
  return Object.freeze(mediaQueries);
}

/** Compiles immutable stylesheet selectors and inline declarations once per document snapshot. */
export function compileStylesheetProgram(input: CompileStylesheetProgramInput): StylesheetProgram {
  const limits = styleBudgets(input.budgets);
  const propertyValidation = createPropertyValidationSession({ maxEntries: 2_048 });
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics, input.initialDiagnostics, input.initialOmittedDiagnosticCount);
  const addDiagnostic = (diagnostic: StyleDiagnostic): void => {
    diagnostics.add(diagnostic.code, diagnostic.sourceUrl, diagnostic.detail, diagnostic.occurrences);
  };
  const sources: StylesheetProgramSource[] = [Object.freeze({
    sourceUrl: USER_AGENT_STYLESHEET_SOURCE,
    namespaces: stylesheetNamespaces(USER_AGENT_SYNTAX),
    origin: "user-agent",
    stylesheet: USER_AGENT_SYNTAX,
    mediaConditions: Object.freeze([]),
    supportsConditions: Object.freeze([]),
    layer: null,
    predeclaredLayers: Object.freeze([]),
  })];
  const truncatedBudgets = new Set<keyof StyleBudgets>();
  let stylesheetByteSize = 0;
  const ordered = [...input.resources].sort((left, right) =>
    left.rootOrder - right.rootOrder || left.dependencyOrder - right.dependencyOrder
  );
  for (const resource of ordered) {
    input.signal?.throwIfAborted();
    if (sources.length - 1 >= limits.maxStylesheetSources) {
      truncatedBudgets.add("maxStylesheetSources");
      diagnostics.add("stylesheet-limit", resource.finalUrl,
        `Stylesheet compilation exhausted maxStylesheetSources: consumed=${String(sources.length - 1)}, limit=${String(limits.maxStylesheetSources)}; fallback=admitted-stylesheets.`);
      break;
    }
    if (resource.sourceKind === "embedded" && resource.byteSize > limits.maxInlineStylesheetBytes) {
      truncatedBudgets.add("maxInlineStylesheetBytes");
      diagnostics.add("stylesheet-limit", resource.finalUrl,
        `Embedded stylesheet exceeds maxInlineStylesheetBytes: bytes=${String(resource.byteSize)}, limit=${String(limits.maxInlineStylesheetBytes)}; fallback=source-omitted.`);
      continue;
    }
    if (stylesheetByteSize + resource.byteSize > limits.maxStylesheetBytes) {
      truncatedBudgets.add("maxStylesheetBytes");
      diagnostics.add("stylesheet-limit", resource.finalUrl,
        `Stylesheet compilation exceeds maxStylesheetBytes: bytes=${String(stylesheetByteSize + resource.byteSize)}, admitted=${String(stylesheetByteSize)}, limit=${String(limits.maxStylesheetBytes)}; fallback=admitted-stylesheets.`);
      break;
    }
    for (const detail of resource.parserDiagnostics) addDiagnostic(Object.freeze({
      code: "stylesheet-parse",
      sourceUrl: resource.finalUrl,
      detail,
      occurrences: 1,
    }));
    sources.push(Object.freeze({
      sourceUrl: resource.finalUrl,
      namespaces: stylesheetNamespaces(resource.syntax),
      origin: "author",
      stylesheet: resource.syntax,
      mediaConditions: Object.freeze(resource.mediaConditions.map((condition) => {
        input.signal?.throwIfAborted();
        return compileMediaQuery(condition);
      })),
      supportsConditions: resource.supportsConditions,
      layer: resource.importLayer,
      predeclaredLayers: resource.predeclaredLayers,
    }));
    stylesheetByteSize += resource.byteSize;
  }
  const compiledSelectors = new Map<CssQualifiedRule, readonly CompiledSelectorProgram[]>();
  const compiledDeclarations = new Map<CssDeclaration, CompiledDeclarationProgram>();
  const stateDependencies = new Set<SelectorStateDependency>();
  const authorStateDependencies = new Set<SelectorStateDependency>();
  const selectorIdentities = new Map<string, string>();
  const identity = (key: string): string => {
    const retained = selectorIdentities.get(key);
    if (retained !== undefined) return retained;
    const created = String(selectorIdentities.size);
    selectorIdentities.set(key, created);
    return created;
  };
  const visit = (items: readonly CssBlockItem[], source: StylesheetProgramSource, parent: NestingContext | null): void => {
    for (const item of items) {
      input.signal?.throwIfAborted();
      if (item.kind === "declaration") {
        if (parent !== null) compiledDeclarations.set(item, compileDeclaration(item, propertyValidation));
        continue;
      }
      if (item.kind === "qualified-rule") {
        const compiled = compileSelectorRule(item, source.sourceUrl, source.namespaces, addDiagnostic, parent, identity, input.signal);
        compiledSelectors.set(item, compiled);
        for (const selector of compiled) {
          for (const dependency of selector.dependencies) stateDependencies.add(dependency);
          if (source.origin === "author") {
            for (const dependency of selector.dependencies) authorStateDependencies.add(dependency);
          }
        }
        const context = nestingContext(compiled, identity(`context:${compiled.map((selector) => `${selector.fingerprint}:${selector.pseudoElement ?? "element"}`).join(",")}`));
        visit(item.block.items, source, context);
      } else if (item.block !== null) visit(item.block.items, source, parent);
    }
  };
  for (const source of sources) visit(source.stylesheet.rules, source, null);
  const nodes = styleNodes(input);
  const inlineDeclarations = new Map<DocumentNodeRef, readonly CssDeclaration[]>();
  const hints = new Map<DocumentNodeRef, readonly CssDeclaration[]>();
  for (const ref of nodes.elements) {
    const node = input.document.node(ref);
    if (node.kind !== "element") continue;
    const declarations = presentationalHints(node);
    if (declarations.length === 0) continue;
    hints.set(ref, declarations);
    for (const declaration of declarations) compiledDeclarations.set(declaration, compileDeclaration(declaration, propertyValidation));
  }
  let inlineBytes = 0;
  let inlineFingerprint = 0x811c9dc5;
  for (const node of nodes.elements) {
    const source = input.document.attribute(node, "style");
    if (source === null) continue;
    inlineBytes += new TextEncoder().encode(source).byteLength;
    inlineFingerprint = fingerprintText(inlineFingerprint, `${node}\u0000${source}\u0000`);
    if (inlineBytes > limits.maxInlineStylesheetBytes) {
      truncatedBudgets.add("maxInlineStylesheetBytes");
      diagnostics.add("stylesheet-limit", "inline-style",
        `Inline declaration compilation exceeds maxInlineStylesheetBytes: bytes=${String(inlineBytes)}, limit=${String(limits.maxInlineStylesheetBytes)}; fallback=admitted-inline-declarations.`);
      break;
    }
    const parsed = parseBlockContents(source, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (!parsed.ok) {
      addDiagnostic(Object.freeze({
        code: "stylesheet-parse",
        sourceUrl: "inline-style",
        detail: "Inline style was rejected by the CSS parser.",
        occurrences: 1,
      }));
      continue;
    }
    inlineDeclarations.set(node, Object.freeze(parsed.value.filter((item) => item.kind === "declaration")));
    for (const item of parsed.value) {
      if (item.kind === "declaration") compiledDeclarations.set(item, compileDeclaration(item, propertyValidation));
    }
  }
  const fingerprint = [
    input.document.finalUrl,
    ...ordered.map((resource) => `${String(resource.rootOrder)}:${String(resource.dependencyOrder)}:${resource.contentFingerprint}`),
    `inline:${String(inlineBytes)}:${inlineFingerprint.toString(16).padStart(8, "0")}`,
  ].join("|");
  const mediaQueries = stylesheetMediaQueries(sources, input.signal);
  const program: StylesheetProgram = Object.freeze({
    document: input.document,
    sources: Object.freeze(sources),
    compiledSelectors,
    compiledDeclarations,
    selectorRuntime: selectorRuntime(limits.maxSelectorCacheBytes),
    propertyValidation,
    substitutedValues: new BoundedSubstitutionCache(4_096),
    inlineDeclarations,
    presentationalHints: hints,
    elementNodes: nodes.elements,
    totalNodes: nodes.totalNodes,
    stateDependencies,
    authorStateDependencies,
    mediaQueries,
    diagnostics: diagnostics.result(),
    omittedDiagnosticCount: diagnostics.omittedDiagnosticCount,
    fingerprint,
    truncatedBudgets,
  });
  // External sessions expose counts, not their private allocations. Charge explicit estimates.
  registerRetainedOwner(program.selectorRuntime, () => [], () =>
    Number(program.selectorRuntime.session !== null)
      * (nodes.totalNodes * 640 + nodes.elements.length * 320 + stylesheetByteSize * 4));
  registerRetainedOwner(program.propertyValidation, () => [], () => {
    return program.propertyValidation.statistics().entries * (512 + (validationValueSizes.get(program.propertyValidation) ?? 0) * 8);
  });
  return program;
}
