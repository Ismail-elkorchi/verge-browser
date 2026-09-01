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
  type CssQualifiedRule,
  type CssRule,
  type SelectorList,
} from "@ismail-elkorchi/css-parser";

import type { DocumentNodeRef } from "../../document/index.js";
import { USER_AGENT_STYLESHEET, USER_AGENT_STYLESHEET_SOURCE } from "./user-agent.js";
import type {
  CompileStylesheetProgramInput,
  CompiledSelectorProgram,
  CompiledDeclarationProgram,
  PseudoElementIdentity,
  SelectorStateDependency,
  StyleBudgets,
  StyleDiagnostic,
  StylesheetProgram,
  StylesheetProgramSource,
  StylesheetProgramDependencies,
  StylesheetSelectorRuntime,
  CustomPropertySubstitutionCache,
  SubstitutedCssValue,
} from "./types.js";

const DEFAULT_STYLE_BUDGETS: StyleBudgets = Object.freeze({
  maxStylesheetSources: 64,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxInlineStylesheetBytes: 512 * 1024,
  maxSelectorQueries: 4_096,
  maxSelectorSteps: 500_000,
  maxDiagnostics: 128,
});

const USER_AGENT_SYNTAX = (() => {
  const result = parseStylesheet(USER_AGENT_STYLESHEET);
  if (!result.ok) throw new Error("The built-in user-agent stylesheet is invalid.");
  return result.value;
})();

class BoundedSubstitutionCache implements CustomPropertySubstitutionCache {
  readonly #limit: number;
  readonly #values = new Map<string, SubstitutedCssValue | null>();

  public constructor(limit: number) { this.#limit = limit; }
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

function selectorRuntime(): StylesheetSelectorRuntime {
  return {
    state: null,
    authorSession: null,
    userAgentSession: null,
    sessionMaxSteps: 0,
    matches: new Map(),
    computedSnapshot: null,
    computedEnvironment: null,
    clear() {
      this.state = null;
      this.authorSession = null;
      this.userAgentSession = null;
      this.sessionMaxSteps = 0;
      this.matches.clear();
      this.computedSnapshot = null;
      this.computedEnvironment = null;
    },
  };
}

function normalizedBudgets(overrides: Partial<StyleBudgets> | undefined): StyleBudgets {
  const result = { ...DEFAULT_STYLE_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
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

function compileDeclaration(declaration: CssDeclaration): CompiledDeclarationProgram {
  return Object.freeze({
    declaration,
    property: declaration.name.startsWith("--")
      ? declaration.name
      : resolveCssProperty(declaration.name.toLowerCase())?.name ?? null,
    value: declaration.value,
    serializedValue: serializeCssComponentValues(declaration.value).trim(),
    containsVariableReference: containsVariableReference(declaration.value),
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
  addDiagnostic: (diagnostic: StyleDiagnostic) => void,
  signal?: AbortSignal,
): readonly CompiledSelectorProgram[] {
  const parsed = parseSelectorListFromComponentValues(rule.prelude, {
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
  return Object.freeze(parsed.value.selectors.map((selector) => {
    const target = selectorTarget(selector);
    const list: SelectorList = Object.freeze({
      ...parsed.value,
      selectors: Object.freeze([target.selector]),
    });
    return Object.freeze({
      selector: list,
      fingerprint: selectorSemanticFingerprint(target.selector),
      pseudoElement: target.pseudoElement,
      specificity: specificityOfComplexSelector(selector),
      dependencies: selectorDependencies(selector),
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

function stylesheetDependencies(
  sources: readonly StylesheetProgramSource[],
  inlineDeclarations: ReadonlyMap<DocumentNodeRef, readonly CssDeclaration[]>,
): StylesheetProgramDependencies {
  const dependency = {
    mediaInlineSize: false,
    mediaBlockSize: false,
    mediaColorScheme: false,
    mediaReducedMotion: false,
    mediaHover: false,
    mediaPointer: false,
    viewportBlockSize: false,
  };
  const inspectMedia = (condition: string): void => {
    const value = condition.toLowerCase();
    if (/\b(?:min-|max-)?width\b|\borientation\b|\baspect-ratio\b/u.test(value)) dependency.mediaInlineSize = true;
    if (/\b(?:min-|max-)?height\b|\borientation\b|\baspect-ratio\b/u.test(value)) dependency.mediaBlockSize = true;
    if (/prefers-color-scheme/u.test(value)) dependency.mediaColorScheme = true;
    if (/prefers-reduced-motion/u.test(value)) dependency.mediaReducedMotion = true;
    if (/\bhover\b/u.test(value)) dependency.mediaHover = true;
    if (/\bpointer\b/u.test(value)) dependency.mediaPointer = true;
  };
  const containsValue = (
    values: readonly ComponentValue[],
    predicate: (value: ComponentValue) => boolean,
  ): boolean => values.some((value) => predicate(value)
    || ((value.kind === "function-block" || value.kind === "simple-block")
      && containsValue(value.value, predicate)));
  const inspectDeclaration = (declaration: CssDeclaration): void => {
    const property = declaration.name.toLowerCase();
    const percentageDependent = containsValue(declaration.value, (value) => value.kind === "percentage");
    const blockViewportUnit = containsValue(declaration.value, (value) =>
      value.kind === "dimension" && value.unit.toLowerCase() === "vh"
    );
    const viewportPosition = containsValue(declaration.value, (value) => value.kind === "ident"
      && (value.value.toLowerCase() === "fixed" || value.value.toLowerCase() === "sticky"));
    if (blockViewportUnit) dependency.viewportBlockSize = true;
    if ((property === "height" || property === "min-height" || property === "max-height"
      || property === "top" || property === "bottom" || property === "inset"
      || property === "inset-block" || property === "inset-block-start" || property === "inset-block-end")
      && percentageDependent) dependency.viewportBlockSize = true;
    if (property === "position" && viewportPosition) dependency.viewportBlockSize = true;
  };
  const visit = (rules: readonly CssRule[]): void => {
    for (const rule of rules) {
      if (rule.kind === "at-rule" && rule.name.toLowerCase() === "media") {
        inspectMedia(serializeCssComponentValues(rule.prelude));
      }
      if (rule.kind === "qualified-rule") {
        for (const item of rule.block.items) if (item.kind === "declaration") inspectDeclaration(item);
      }
      if (rule.block !== null) visit(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"));
    }
  };
  for (const source of sources) {
    for (const condition of source.mediaConditions) inspectMedia(condition);
    visit(source.stylesheet.rules);
  }
  for (const declarations of inlineDeclarations.values()) {
    for (const declaration of declarations) inspectDeclaration(declaration);
  }
  return Object.freeze({
    ...dependency,
    viewportBlockSize: dependency.viewportBlockSize || dependency.mediaBlockSize,
  });
}

/** Compiles immutable stylesheet selectors and inline declarations once per document snapshot. */
export function compileStylesheetProgram(input: CompileStylesheetProgramInput): StylesheetProgram {
  const limits = normalizedBudgets(input.budgets);
  const diagnostics: StyleDiagnostic[] = [];
  const diagnosticIndex = new Map<string, number>();
  const addDiagnostic = (diagnostic: StyleDiagnostic): void => {
    const key = `${diagnostic.code}\u0000${diagnostic.sourceUrl}\u0000${diagnostic.detail}`;
    const index = diagnosticIndex.get(key);
    if (index !== undefined) {
      const current = diagnostics[index];
      if (current !== undefined) diagnostics[index] = Object.freeze({ ...current, occurrences: current.occurrences + diagnostic.occurrences });
      return;
    }
    if (diagnostics.length >= limits.maxDiagnostics) return;
    diagnosticIndex.set(key, diagnostics.length);
    diagnostics.push(diagnostic);
  };
  for (const diagnostic of input.initialDiagnostics ?? []) addDiagnostic(diagnostic);
  const sources: StylesheetProgramSource[] = [Object.freeze({
    sourceUrl: USER_AGENT_STYLESHEET_SOURCE,
    origin: "user-agent",
    stylesheet: USER_AGENT_SYNTAX,
    mediaConditions: Object.freeze([]),
    supportsConditions: Object.freeze([]),
    layer: null,
    predeclaredLayers: Object.freeze([]),
  })];
  const truncatedBudgets = new Set<keyof StyleBudgets>();
  let retainedByteSize = 0;
  const ordered = [...input.resources].sort((left, right) =>
    left.rootOrder - right.rootOrder || left.dependencyOrder - right.dependencyOrder
  );
  for (const resource of ordered) {
    input.signal?.throwIfAborted();
    if (sources.length - 1 >= limits.maxStylesheetSources) {
      truncatedBudgets.add("maxStylesheetSources");
      break;
    }
    if (resource.sourceKind === "embedded" && resource.byteSize > limits.maxInlineStylesheetBytes) {
      truncatedBudgets.add("maxInlineStylesheetBytes");
      continue;
    }
    if (retainedByteSize + resource.byteSize > limits.maxStylesheetBytes) {
      truncatedBudgets.add("maxStylesheetBytes");
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
      origin: "author",
      stylesheet: resource.syntax,
      mediaConditions: resource.mediaConditions,
      supportsConditions: resource.supportsConditions,
      layer: resource.importLayer,
      predeclaredLayers: resource.predeclaredLayers,
    }));
    retainedByteSize += resource.byteSize;
  }
  const compiledSelectors = new Map<CssQualifiedRule, readonly CompiledSelectorProgram[]>();
  const compiledDeclarations = new Map<CssDeclaration, CompiledDeclarationProgram>();
  const stateDependencies = new Set<SelectorStateDependency>();
  const authorStateDependencies = new Set<SelectorStateDependency>();
  const visit = (rules: readonly CssRule[], source: StylesheetProgramSource): void => {
    for (const rule of rules) {
      input.signal?.throwIfAborted();
      if (rule.kind === "qualified-rule") {
        const compiled = compileSelectorRule(rule, source.sourceUrl, addDiagnostic, input.signal);
        compiledSelectors.set(rule, compiled);
        for (const selector of compiled) {
          for (const dependency of selector.dependencies) stateDependencies.add(dependency);
          if (source.origin === "author") {
            for (const dependency of selector.dependencies) authorStateDependencies.add(dependency);
          }
        }
        for (const item of rule.block.items) {
          if (item.kind === "declaration") compiledDeclarations.set(item, compileDeclaration(item));
        }
      }
      if (rule.block !== null) {
        visit(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"), source);
      }
    }
  };
  for (const source of sources) visit(source.stylesheet.rules, source);
  const nodes = styleNodes(input);
  const inlineDeclarations = new Map<DocumentNodeRef, readonly CssDeclaration[]>();
  let inlineBytes = 0;
  let inlineFingerprint = 0x811c9dc5;
  for (const node of nodes.elements) {
    const source = input.document.attribute(node, "style");
    if (source === null) continue;
    inlineBytes += new TextEncoder().encode(source).byteLength;
    inlineFingerprint = fingerprintText(inlineFingerprint, `${node}\u0000${source}\u0000`);
    if (inlineBytes > limits.maxInlineStylesheetBytes) {
      truncatedBudgets.add("maxInlineStylesheetBytes");
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
      if (item.kind === "declaration") compiledDeclarations.set(item, compileDeclaration(item));
    }
  }
  const fingerprint = [
    input.document.finalUrl,
    ...ordered.map((resource) => `${String(resource.rootOrder)}:${String(resource.dependencyOrder)}:${resource.contentFingerprint}`),
    `inline:${String(inlineBytes)}:${inlineFingerprint.toString(16).padStart(8, "0")}`,
  ].join("|");
  const dependencies = stylesheetDependencies(sources, inlineDeclarations);
  return Object.freeze({
    document: input.document,
    sources: Object.freeze(sources),
    compiledSelectors,
    compiledDeclarations,
    selectorRuntime: selectorRuntime(),
    propertyValidation: createPropertyValidationSession({ maxEntries: 2_048 }),
    substitutedValues: new BoundedSubstitutionCache(4_096),
    inlineDeclarations,
    elementNodes: nodes.elements,
    totalNodes: nodes.totalNodes,
    stateDependencies,
    authorStateDependencies,
    dependencies,
    diagnostics: Object.freeze(diagnostics),
    authorStylesheetCount: sources.length - 1,
    retainedByteSize,
    fingerprint,
    truncatedBudgets,
  });
}
