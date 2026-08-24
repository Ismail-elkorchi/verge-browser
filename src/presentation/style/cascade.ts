import {
  parseBlockContents,
  parseDeclaration,
  parseSelectorList,
  parseStylesheet,
  parseStylesheetBytes,
  querySelectorList,
  resolveCssProperty,
  serializeCssComponentValues,
  specificitiesOfSelectorList,
  validateCssPropertyValue,
  type ComplexSelector,
  type CssDeclaration,
  type CssQualifiedRule,
  type CssRule,
  type CssStylesheet,
  type SelectorEnvironment,
  type SelectorList,
  type SelectorSpecificity
} from "@ismail-elkorchi/css-parser";

import {
  type DocumentNodeRef,
  type WebDocumentNode,
  type WebDocumentSnapshotView,
  type WebElementNode
} from "../../document/index.js";
import { USER_AGENT_STYLESHEET, USER_AGENT_STYLESHEET_SOURCE } from "./user-agent.js";
import type {
  ComputedDisplay,
  ComputedStyle,
  CssClipPath,
  CssColor,
  CssDisplayInternal,
  CssEdges,
  CssGridBreadth,
  CssGridTrack,
  CssLegacyClip,
  CssLength,
  PseudoElementIdentity,
  ResolveStylesInput,
  StyleBudgets,
  StyleDiagnostic,
  StyleDiagnosticCode,
  StyleOutcome,
  StyleSnapshot,
  StylesheetResource
} from "./types.js";

const DEFAULT_STYLE_BUDGETS: StyleBudgets = Object.freeze({
  maxStylesheetSources: 64,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxInlineStylesheetBytes: 512 * 1024,
  maxSelectorQueries: 4_096,
  maxSelectorSteps: 500_000,
  maxComputedNodes: 100_000,
  maxDiagnostics: 128
});

const SUPPORTED_PROPERTIES = new Set([
  "display", "visibility", "white-space", "color", "background", "background-color",
  "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-transform",
  "text-align", "text-indent",
  "list-style", "list-style-type", "margin", "margin-top", "margin-right",
  "margin-bottom", "margin-left", "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end", "padding", "padding-top",
  "padding-right", "padding-bottom", "padding-left", "padding-block", "padding-block-start",
  "padding-block-end", "padding-inline", "padding-inline-start", "padding-inline-end",
  "width", "min-width", "max-width", "height", "min-height", "gap",
  "row-gap", "column-gap", "flex-direction", "flex-wrap", "justify-content", "align-items",
  "grid-template-columns", "grid-column", "border", "border-width", "border-style",
  "border-color", "overflow", "overflow-x", "overflow-y",
  "position", "clip", "clip-path",
  "content"
]);

const INHERITED_PROPERTIES = new Set([
  "visibility", "white-space", "color", "font-weight", "font-style", "text-transform",
  "text-align", "text-indent", "list-style", "list-style-type"
]);

const ASCII_INSENSITIVE_ATTRIBUTES = new Set([
  "align", "charset", "crossorigin", "dir", "draggable", "enctype", "formenctype",
  "frame", "hreflang", "http-equiv", "lang", "media", "method", "rel", "scope",
  "shape", "spellcheck", "target", "type", "wrap"
]);

const ZERO: CssLength = Object.freeze({ kind: "zero" });
const AUTO: CssLength = Object.freeze({ kind: "auto" });
const NONE: CssLength = Object.freeze({ kind: "none" });
const MEDIUM_BORDER: CssLength = Object.freeze({ kind: "length", value: 3, unit: "px" });
const TRANSPARENT: CssColor = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
const UTF8 = new TextEncoder();

const NAMED_COLORS: Readonly<Record<string, CssColor>> = Object.freeze({
  aliceblue: { r: 240, g: 248, b: 255, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  brown: { r: 165, g: 42, b: 42, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  darkgray: { r: 169, g: 169, b: 169, a: 1 },
  darkgreen: { r: 0, g: 100, b: 0, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
  gold: { r: 255, g: 215, b: 0, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  lightgray: { r: 211, g: 211, b: 211, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  pink: { r: 255, g: 192, b: 203, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  violet: { r: 238, g: 130, b: 238, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 }
});

interface StylesheetSource {
  readonly sourceUrl: string;
  readonly origin: "user-agent" | "author";
  readonly stylesheet: CssStylesheet;
  readonly media: string | null;
}

interface CascadeCandidate {
  readonly declaration: CssDeclaration;
  readonly sourceUrl: string;
  readonly origin: "user-agent" | "author";
  readonly important: boolean;
  readonly inline: boolean;
  readonly specificity: SelectorSpecificity;
  readonly sourceOrder: number;
}

type CandidateMap = Map<string, Map<string, CascadeCandidate[]>>;

class ImmutableStringMap implements ReadonlyMap<string, string> {
  readonly #values: ReadonlyMap<string, string>;

  public constructor(values: Iterable<readonly [string, string]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  public get size(): number { return this.#values.size; }
  public get(key: string): string | undefined { return this.#values.get(key); }
  public has(key: string): boolean { return this.#values.has(key); }
  public entries(): MapIterator<[string, string]> { return this.#values.entries(); }
  public keys(): MapIterator<string> { return this.#values.keys(); }
  public values(): MapIterator<string> { return this.#values.values(); }
  public forEach(
    callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  public [Symbol.iterator](): MapIterator<[string, string]> { return this.entries(); }
}

class DiagnosticCollector {
  readonly #values: StyleDiagnostic[] = [];
  readonly #indices = new Map<string, number>();
  readonly #limit: number;

  public constructor(limit: number, initial: readonly StyleDiagnostic[]) {
    this.#limit = limit;
    for (const diagnostic of initial) {
      for (let occurrence = 0; occurrence < diagnostic.occurrences; occurrence += 1) {
        this.add(diagnostic.code, diagnostic.sourceUrl, diagnostic.detail);
      }
    }
  }

  public add(code: StyleDiagnosticCode, sourceUrl: string, detail: string): void {
    const identity = `${code}\u0000${sourceUrl}\u0000${detail}`;
    const index = this.#indices.get(identity);
    if (index !== undefined) {
      const current = this.#values[index];
      if (current !== undefined) this.#values[index] = { ...current, occurrences: current.occurrences + 1 };
      return;
    }
    if (this.#values.length >= this.#limit) return;
    this.#indices.set(identity, this.#values.length);
    this.#values.push({ code, sourceUrl, detail, occurrences: 1 });
  }

  public result(): readonly StyleDiagnostic[] {
    return Object.freeze(this.#values.map((value) => Object.freeze(value)));
  }
}

function budgets(overrides: Partial<StyleBudgets> | undefined): StyleBudgets {
  const result = { ...DEFAULT_STYLE_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function styleKey(node: DocumentNodeRef, pseudo: PseudoElementIdentity | null = null): string {
  return pseudo === null ? node : `${node}::${pseudo}`;
}

function compareSpecificity(left: SelectorSpecificity, right: SelectorSpecificity): number {
  return left.a - right.a || left.b - right.b || left.c - right.c;
}

function outranks(left: CascadeCandidate, right: CascadeCandidate): boolean {
  if (left.important !== right.important) return left.important;
  if (left.origin !== right.origin) {
    if (left.important) return left.origin === "user-agent";
    return left.origin === "author";
  }
  if (left.inline !== right.inline) return left.inline;
  const specificity = compareSpecificity(left.specificity, right.specificity);
  return specificity === 0 ? left.sourceOrder >= right.sourceOrder : specificity > 0;
}

function canonicalProperty(name: string): string | null {
  const semantics = resolveCssProperty(name.toLowerCase());
  return semantics?.name ?? null;
}

function selectorListFor(selector: ComplexSelector, list: SelectorList): SelectorList {
  return { ...list, selectors: [selector] };
}

function selectorEnvironment(input: ResolveStylesInput): SelectorEnvironment<WebDocumentNode> {
  const { document, state } = input;
  const attributeCache = new Map<DocumentNodeRef, readonly {
    readonly namespace: string | null;
    readonly localName: string;
    readonly value: string;
  }[]>();
  const attributesFor = (node: WebElementNode) => {
    const cached = attributeCache.get(node.ref);
    if (cached !== undefined) return cached;
    const attributes = node.attributes.map((attribute) => ({
      namespace: attribute.namespace,
      localName: attribute.name,
      value: attribute.value
    }));
    const disclosure = document.disclosure(node.ref);
    if (disclosure !== null) {
      const hasOpen = attributes.some((attribute) => attribute.namespace === null && attribute.localName === "open");
      const isOpen = state.open.has(node.ref);
      if (isOpen && !hasOpen) attributes.push({ namespace: null, localName: "open", value: "" });
      if (!isOpen && hasOpen) {
        const filtered = Object.freeze(attributes.filter((attribute) => attribute.namespace !== null || attribute.localName !== "open"));
        attributeCache.set(node.ref, filtered);
        return filtered;
      }
    }
    const control = document.control(node.ref);
    const controlState = state.controls.get(node.ref);
    if (control !== null && (control.kind === "checkbox" || control.kind === "radio")) {
      const hasChecked = attributes.some((attribute) => attribute.namespace === null && attribute.localName === "checked");
      const checked = controlState?.checked ?? control.defaultChecked;
      if (checked && !hasChecked) attributes.push({ namespace: null, localName: "checked", value: "" });
      if (!checked && hasChecked) {
        const filtered = Object.freeze(attributes.filter((attribute) => attribute.namespace !== null || attribute.localName !== "checked"));
        attributeCache.set(node.ref, filtered);
        return filtered;
      }
    }
    const frozen = Object.freeze(attributes);
    attributeCache.set(node.ref, frozen);
    return frozen;
  };
  return {
    tree: {
      data(node) {
        if (node.kind === "element") {
          return {
            kind: "element",
            namespace: node.namespace,
            localName: node.name,
            attributes: attributesFor(node)
          };
        }
        if (node.kind === "text") return { kind: "text", value: node.value };
        return { kind: "other" };
      },
      children(node) {
        return node.children.map((child) => document.node(child));
      }
    },
    documentMode: { syntax: "html", quirks: "no-quirks" },
    defaultNamespace: { kind: "any" },
    idValues(_node, element) {
      return element.attributes.filter((attribute) => attribute.namespace === null && attribute.localName === "id")
        .map((attribute) => attribute.value);
    },
    classNames(_node, element) {
      return element.attributes.filter((attribute) => attribute.namespace === null && attribute.localName === "class")
        .flatMap((attribute) => attribute.value.split(/\s+/u).filter(Boolean));
    },
    resolveNamespacePrefix(prefix) {
      const namespace: Readonly<Record<string, string>> = {
        html: "http://www.w3.org/1999/xhtml",
        svg: "http://www.w3.org/2000/svg",
        math: "http://www.w3.org/1998/Math/MathML",
        xlink: "http://www.w3.org/1999/xlink",
        xml: "http://www.w3.org/XML/1998/namespace",
        xmlns: "http://www.w3.org/2000/xmlns/"
      };
      const resolved = namespace[prefix.toLowerCase()];
      return resolved === undefined ? { status: "unknown" } : { status: "resolved", namespace: resolved };
    },
    attributeValueCaseSensitivity(_element, attribute) {
      return attribute.namespace === null && ASCII_INSENSITIVE_ATTRIBUTES.has(attribute.localName.toLowerCase())
        ? "ascii-insensitive"
        : "sensitive";
    },
    matchPseudoClass(node, pseudo) {
      if (node.kind !== "element") return "no-match";
      if (pseudo.name === "link" || pseudo.name === "any-link") return document.link(node.ref) === null ? "no-match" : "match";
      if (pseudo.name === "visited") return "no-match";
      if (pseudo.name === "target") return state.urlTarget === node.ref ? "match" : "no-match";
      if (pseudo.name === "hover") return state.hover === node.ref ? "match" : "no-match";
      if (pseudo.name === "active") return state.active === node.ref ? "match" : "no-match";
      if (pseudo.name === "focus" || pseudo.name === "focus-visible") return state.focus === node.ref ? "match" : "no-match";
      if (pseudo.name === "focus-within") {
        let current = state.focus;
        while (current !== null) {
          if (current === node.ref) return "match";
          current = document.parent(current)?.ref ?? null;
        }
        return "no-match";
      }
      if (pseudo.name === "checked") {
        const control = document.control(node.ref);
        if (control?.kind === "checkbox" || control?.kind === "radio") {
          return (state.controls.get(node.ref)?.checked ?? control.defaultChecked) ? "match" : "no-match";
        }
        const option = document.option(node.ref);
        if (option === null) return "no-match";
        const select = state.controls.get(option.select);
        return (select?.selected.includes(option.node) ?? option.defaultSelected) ? "match" : "no-match";
      }
      if (pseudo.name === "open") {
        const disclosure = document.disclosure(node.ref);
        return disclosure === null
          ? "no-match"
          : state.open.has(disclosure.node) ? "match" : "no-match";
      }
      if (pseudo.name === "disabled" || pseudo.name === "enabled") {
        const disabled = document.control(node.ref)?.disabled;
        if (disabled === undefined) return "no-match";
        return (pseudo.name === "disabled") === disabled ? "match" : "no-match";
      }
      return "unknown";
    }
  };
}

function splitMediaQueries(value: string): readonly string[] {
  const queries: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      queries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  queries.push(value.slice(start));
  return queries;
}

function mediaLengthPx(value: string): number | null {
  const match = /^([+]?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|ch)$/iu.exec(value.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  if (match[2].toLowerCase() === "px") return number;
  if (match[2].toLowerCase() === "ch") return number * 8;
  return number * 16;
}

function mediaFeature(feature: string, input: ResolveStylesInput): boolean | null {
  const normalized = feature.replaceAll(/\/\*[\s\S]*?\*\//gu, "").trim().toLowerCase();
  if (normalized === "prefers-reduced-motion" || normalized === "prefers-reduced-motion: reduce") {
    return input.environment.reducedMotion;
  }
  if (normalized === "prefers-color-scheme: dark") return input.environment.prefersColorScheme === "dark";
  if (normalized === "prefers-color-scheme: light") return input.environment.prefersColorScheme === "light";
  if (normalized === "hover:hover" || normalized === "hover: hover") return false;
  const legacy = /^(min-width|max-width|width)\s*:\s*(.+)$/u.exec(normalized);
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    const boundary = mediaLengthPx(legacy[2]);
    if (boundary === null) return null;
    if (legacy[1] === "min-width") return input.environment.viewportWidthPx >= boundary;
    if (legacy[1] === "max-width") return input.environment.viewportWidthPx <= boundary;
    return input.environment.viewportWidthPx === boundary;
  }
  const range = /^width\s*(<=|>=|<|>)\s*(.+)$/u.exec(normalized);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const boundary = mediaLengthPx(range[2]);
    if (boundary === null) return null;
    if (range[1] === "<=") return input.environment.viewportWidthPx <= boundary;
    if (range[1] === ">=") return input.environment.viewportWidthPx >= boundary;
    if (range[1] === "<") return input.environment.viewportWidthPx < boundary;
    return input.environment.viewportWidthPx > boundary;
  }
  return null;
}

function mediaApplies(
  value: string | null,
  input: ResolveStylesInput,
  diagnostics: DiagnosticCollector,
  sourceUrl: string
): boolean {
  if (value === null || value.trim().length === 0) return true;
  return splitMediaQueries(value).some((part) => {
    let normalized = part.trim().toLowerCase();
    const negated = normalized.startsWith("not ");
    if (negated) normalized = normalized.slice(4).trim();
    normalized = normalized.replace(/^only\s+/u, "");
    const mediaType = normalized.match(/^(all|screen|print)\b/u)?.[1];
    const conditionOnly = normalized.startsWith("(");
    let applies = mediaType === "all" || mediaType === "screen" || conditionOnly;
    if (mediaType === undefined && !conditionOnly) {
      diagnostics.add("stylesheet-media", sourceUrl, `Unsupported media type: ${normalized.split(/\s+/u)[0] ?? ""}`);
    }
    for (const match of normalized.matchAll(/\(([^()]*)\)/gu)) {
      const result = mediaFeature(match[1] ?? "", input);
      if (result === null) {
        diagnostics.add("stylesheet-media", sourceUrl, `Unsupported media feature: ${match[1] ?? ""}`);
        applies = false;
      } else applies &&= result;
    }
    return negated ? !applies : applies;
  });
}

export function terminalMediaMayApply(value: string | null): boolean {
  if (value === null || value.trim().length === 0) return true;
  return splitMediaQueries(value).some((part) => {
    const normalized = part.trim().toLowerCase();
    if (normalized.startsWith("not ")) return true;
    return !/(?:^|\s)print(?:\s|$)/u.test(normalized) || /(?:^|\s)(?:all|screen)(?:\s|$)/u.test(normalized);
  });
}

function stylesheetSources(
  input: ResolveStylesInput,
  limits: StyleBudgets,
  diagnostics: DiagnosticCollector,
  truncate: (budget: keyof StyleBudgets) => void
): readonly StylesheetSource[] {
  const sources: StylesheetSource[] = [];
  const ua = parseStylesheet(USER_AGENT_STYLESHEET, {
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (!ua.ok) throw new Error("The built-in user-agent stylesheet is invalid.");
  sources.push({ sourceUrl: USER_AGENT_STYLESHEET_SOURCE, origin: "user-agent", stylesheet: ua.value, media: null });
  const resourceByOwner = new Map(input.resources.map((resource) => [resource.owner, resource]));
  let authorSources = 0;
  let authorBytes = 0;
  for (const reference of input.document.stylesheets) {
    input.signal?.throwIfAborted();
    if (authorSources >= limits.maxStylesheetSources) {
      truncate("maxStylesheetSources");
      diagnostics.add("stylesheet-limit", input.document.finalUrl, "Author stylesheet source budget exhausted.");
      break;
    }
    if (!terminalMediaMayApply(reference.media)) {
      diagnostics.add("stylesheet-media", input.document.finalUrl, "Stylesheet cannot apply to screen media.");
      continue;
    }
    if (reference.kind === "embedded") {
      const byteLength = UTF8.encode(reference.cssText).byteLength;
      if (byteLength > limits.maxInlineStylesheetBytes || authorBytes + byteLength > limits.maxStylesheetBytes) {
        truncate(byteLength > limits.maxInlineStylesheetBytes ? "maxInlineStylesheetBytes" : "maxStylesheetBytes");
        diagnostics.add("stylesheet-limit", input.document.finalUrl, "Embedded stylesheet byte budget exhausted.");
        continue;
      }
      const parsed = parseStylesheet(reference.cssText, {
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (!parsed.ok) {
        diagnostics.add("stylesheet-parse", input.document.finalUrl, "Embedded stylesheet was rejected by the CSS parser.");
        continue;
      }
      for (const error of parsed.errors) diagnostics.add("stylesheet-parse", input.document.finalUrl, error.message);
      sources.push({
        sourceUrl: `${input.document.finalUrl}#style-${String(reference.order)}`,
        origin: "author",
        stylesheet: parsed.value,
        media: reference.media
      });
      authorSources += 1;
      authorBytes += byteLength;
      continue;
    }
    const resource = resourceByOwner.get(reference.owner);
    if (resource === undefined) continue;
    if (authorBytes + resource.bytes.byteLength > limits.maxStylesheetBytes) {
      truncate("maxStylesheetBytes");
      diagnostics.add("stylesheet-limit", resource.finalUrl, "Author stylesheet byte budget exhausted.");
      break;
    }
    const parsed = parseStylesheetBytes(resource.bytes, {
      ...(resource.transportEncodingLabel === null ? {} : { transportEncodingLabel: resource.transportEncodingLabel }),
      limits: {
        maxInputBytes: resource.bytes.byteLength,
        maxTokens: 200_000,
        maxNodes: 100_000,
        maxDepth: 128,
        maxSteps: 2_000_000
      },
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!parsed.ok) {
      diagnostics.add("stylesheet-parse", resource.finalUrl, "External stylesheet was rejected by the CSS parser.");
      continue;
    }
    for (const error of parsed.errors) diagnostics.add("stylesheet-parse", resource.finalUrl, error.message);
    sources.push({
      sourceUrl: resource.finalUrl,
      origin: "author",
      stylesheet: parsed.value,
      media: resource.media
    });
    authorSources += 1;
    authorBytes += resource.bytes.byteLength;
  }
  return sources;
}

function recordCandidate(
  candidates: CandidateMap,
  key: string,
  declaration: CssDeclaration,
  source: StylesheetSource,
  specificity: SelectorSpecificity,
  sourceOrder: number,
  inline: boolean
): void {
  const property = canonicalProperty(declaration.name) ?? declaration.name.toLowerCase();
  const byProperty = candidates.get(key) ?? new Map<string, CascadeCandidate[]>();
  const next: CascadeCandidate = {
    declaration,
    sourceUrl: source.sourceUrl,
    origin: source.origin,
    important: declaration.important,
    inline,
    specificity,
    sourceOrder
  };
  const entries = byProperty.get(property) ?? [];
  const sameOrigin = entries.findIndex((entry) => entry.origin === next.origin);
  if (sameOrigin < 0) entries.push(next);
  else {
    const current = entries[sameOrigin];
    if (current !== undefined && outranks(next, current)) entries[sameOrigin] = next;
  }
  byProperty.set(property, entries);
  candidates.set(key, byProperty);
}

function declarationsOf(rule: CssQualifiedRule): readonly CssDeclaration[] {
  return rule.block.items.filter((item): item is CssDeclaration => item.kind === "declaration");
}

function selectorPseudo(selectorText: string): { readonly text: string; readonly pseudo: PseudoElementIdentity | null } {
  const match = /::(before|after|marker)\s*$/iu.exec(selectorText);
  if (match?.[1] === undefined) return { text: selectorText, pseudo: null };
  return {
    text: selectorText.slice(0, match.index).trim() || "*",
    pseudo: match[1].toLowerCase() as PseudoElementIdentity
  };
}

function splitSelectorBranches(value: string): readonly string[] {
  const branches: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      branches.push(value.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(value.slice(start));
  return branches.map((branch) => branch.trim()).filter(Boolean);
}

function collectStyleNodes(
  input: ResolveStylesInput,
  limit: number
): { readonly nodes: readonly DocumentNodeRef[]; readonly truncated: boolean } {
  const nodes: DocumentNodeRef[] = [];
  const pending = [input.document.root];
  while (pending.length > 0) {
    input.signal?.throwIfAborted();
    const ref = pending.pop();
    if (ref === undefined) continue;
    const node = input.document.node(ref);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
    if (node.kind !== "element") continue;
    if (nodes.length >= limit) return { nodes: Object.freeze(nodes), truncated: true };
    nodes.push(ref);
  }
  return { nodes: Object.freeze(nodes), truncated: false };
}

function collectCandidates(
  input: ResolveStylesInput,
  sources: readonly StylesheetSource[],
  styleNodes: readonly DocumentNodeRef[],
  limits: StyleBudgets,
  diagnostics: DiagnosticCollector,
  truncate: (budget: keyof StyleBudgets) => void
): CandidateMap {
  const candidates: CandidateMap = new Map();
  const eligible = new Set(styleNodes);
  const environment = selectorEnvironment(input);
  const root = input.document.node(input.document.root);
  let sourceOrder = 0;
  let queryCount = 0;
  let selectorSteps = 0;
  let exhausted = false;
  const selectorExhaustion = new Set<"maxSelectorQueries" | "maxSelectorSteps">();
  for (const source of sources) {
    if (selectorExhaustion.size > 0) break;
    if (!mediaApplies(source.media, input, diagnostics, source.sourceUrl)) continue;
    const visitRules = (rules: readonly CssRule[]): void => {
      for (const rule of rules) {
        if (exhausted) return;
        input.signal?.throwIfAborted();
        if (rule.kind === "at-rule") {
          const name = rule.name.toLowerCase();
          if (name === "namespace" || name === "charset") continue;
          if (name === "media" && rule.block !== null) {
            const media = serializeCssComponentValues(rule.prelude).trim();
            if (mediaApplies(media, input, diagnostics, source.sourceUrl)) {
              visitRules(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"));
            }
          } else diagnostics.add("unsupported-at-rule", source.sourceUrl, `Unsupported @${rule.name} rule.`);
          continue;
        }
        const rawSelector = serializeCssComponentValues(rule.prelude).trim();
        const matchingByPseudo = new Map<PseudoElementIdentity | null, Map<DocumentNodeRef, SelectorSpecificity>>();
        for (const branch of splitSelectorBranches(rawSelector)) {
          const pseudo = selectorPseudo(branch);
          const parsed = parseSelectorList(pseudo.text, {
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          if (!parsed.ok) {
            diagnostics.add("selector-parse", source.sourceUrl, `Invalid selector: ${branch}`);
            continue;
          }
          for (const error of parsed.errors) diagnostics.add("selector-parse", source.sourceUrl, error.message);
          const specificities = specificitiesOfSelectorList(parsed.value);
          const matching = matchingByPseudo.get(pseudo.pseudo) ?? new Map<DocumentNodeRef, SelectorSpecificity>();
          matchingByPseudo.set(pseudo.pseudo, matching);
          for (const [index, selector] of parsed.value.selectors.entries()) {
            if (queryCount >= limits.maxSelectorQueries) {
              truncate("maxSelectorQueries");
              selectorExhaustion.add("maxSelectorQueries");
              exhausted = true;
              break;
            }
            if (selectorSteps >= limits.maxSelectorSteps) {
              truncate("maxSelectorSteps");
              selectorExhaustion.add("maxSelectorSteps");
              exhausted = true;
              break;
            }
            queryCount += 1;
            try {
              const result = querySelectorList(selectorListFor(selector, parsed.value), root, environment, {
                limits: {
                  maxNodes: limits.maxSelectorSteps,
                  maxDepth: 2_048,
                  maxSteps: limits.maxSelectorSteps - selectorSteps
                },
                ...(input.signal === undefined ? {} : { signal: input.signal })
              });
              selectorSteps += result.usage.steps;
              const parsedSpecificity = specificities[index] ?? { a: 0, b: 0, c: 0 };
              const specificity = pseudo.pseudo === null
                ? parsedSpecificity
                : { ...parsedSpecificity, c: parsedSpecificity.c + 1 };
              for (const match of result.matches) {
                if (match.kind !== "element" || !eligible.has(match.ref)) continue;
                const current = matching.get(match.ref);
                if (current === undefined || compareSpecificity(specificity, current) > 0) matching.set(match.ref, specificity);
              }
              for (const unknown of result.unknown) {
                for (const reason of unknown.reasons) {
                  diagnostics.add("selector-unknown", source.sourceUrl, `Unsupported selector feature ${reason.code}:${reason.name}.`);
                }
              }
            } catch (error) {
              input.signal?.throwIfAborted();
              if (error !== null && typeof error === "object" && "code" in error && error.code === "CSS_RESOURCE_LIMIT_EXCEEDED") {
                truncate("maxSelectorSteps");
                selectorExhaustion.add("maxSelectorSteps");
                exhausted = true;
                break;
              }
              diagnostics.add("selector-unknown", source.sourceUrl, error instanceof Error ? error.name : "Selector evaluation failed.");
            }
          }
          if (exhausted) break;
        }
        for (const declaration of declarationsOf(rule)) {
          const property = canonicalProperty(declaration.name);
          if (property === null) {
            diagnostics.add("property-invalid", source.sourceUrl, `Unknown property ${declaration.name.toLowerCase()}.`);
            continue;
          }
          if (!property.startsWith("--") && !SUPPORTED_PROPERTIES.has(property)) {
            diagnostics.add("property-unsupported", source.sourceUrl, `Unsupported property ${property}.`);
            continue;
          }
          sourceOrder += 1;
          for (const [pseudo, matching] of matchingByPseudo) {
            for (const [ref, specificity] of matching) {
              recordCandidate(candidates, styleKey(ref, pseudo), declaration, source, specificity, sourceOrder, false);
            }
          }
        }
      }
    };
    visitRules(source.stylesheet.rules);
  }

  const inlineSource: StylesheetSource = {
    sourceUrl: "inline-style",
    origin: "author",
    stylesheet: sources[0]?.stylesheet ?? (() => { throw new Error("Missing UA stylesheet"); })(),
    media: null
  };
  for (const ref of styleNodes) {
    const value = input.document.attribute(ref, "style");
    if (value === null) continue;
    const parsed = parseBlockContents(value, {
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!parsed.ok) {
      diagnostics.add("stylesheet-parse", "inline-style", "Inline style was rejected by the CSS parser.");
      continue;
    }
    for (const error of parsed.errors) diagnostics.add("stylesheet-parse", "inline-style", error.message);
    for (const item of parsed.value) {
      if (item.kind !== "declaration") continue;
      const property = canonicalProperty(item.name);
      if (property === null) {
        diagnostics.add("property-invalid", "inline-style", `Unknown property ${item.name.toLowerCase()}.`);
        continue;
      }
      if (!property.startsWith("--") && !SUPPORTED_PROPERTIES.has(property)) {
        diagnostics.add("property-unsupported", "inline-style", `Unsupported property ${property}.`);
        continue;
      }
      sourceOrder += 1;
      recordCandidate(candidates, styleKey(ref), item, inlineSource, { a: 1, b: 0, c: 0 }, sourceOrder, true);
    }
  }
  return candidates;
}

function cssValue(declaration: CssDeclaration): string {
  return serializeCssComponentValues(declaration.value).trim();
}

function cssWide(value: string): "initial" | "inherit" | "unset" | "revert" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "initial" || normalized === "inherit" || normalized === "unset") return normalized;
  if (normalized === "revert" || normalized === "revert-layer" || normalized === "revert-rule") return "revert";
  return null;
}

function bestCandidate(entries: readonly CascadeCandidate[]): CascadeCandidate | null {
  let best: CascadeCandidate | null = null;
  for (const candidate of entries) {
    if (best === null || outranks(candidate, best)) best = candidate;
  }
  return best;
}

function cascadedCandidate(entries: readonly CascadeCandidate[]): CascadeCandidate | null {
  let remaining = [...entries];
  while (remaining.length > 0) {
    const candidate = bestCandidate(remaining);
    if (candidate === null) return null;
    if (cssWide(cssValue(candidate.declaration)) !== "revert") return candidate;
    remaining = remaining.filter((entry) => entry.origin !== candidate.origin);
  }
  return null;
}

function resolveVariables(value: string, properties: ReadonlyMap<string, string>, stack = new Set<string>()): string | null {
  let output = value;
  for (let pass = 0; pass < 32; pass += 1) {
    const match = /var\(\s*(--[-\w]+)\s*(?:,\s*([^()]*))?\)/u.exec(output);
    if (match === null || match[1] === undefined) return output;
    const name = match[1];
    if (stack.has(name)) return null;
    const raw = properties.get(name) ?? match[2] ?? null;
    if (raw === null) return null;
    const nextStack = new Set(stack);
    nextStack.add(name);
    const replacement = resolveVariables(raw, properties, nextStack);
    if (replacement === null) return null;
    output = `${output.slice(0, match.index)}${replacement}${output.slice(match.index + match[0].length)}`;
  }
  return null;
}

function customProperties(
  parent: ReadonlyMap<string, string>,
  candidates: ReadonlyMap<string, readonly CascadeCandidate[]> | undefined
): ReadonlyMap<string, string> {
  const result = new Map(parent);
  for (const [name, entries] of candidates ?? []) {
    if (!name.startsWith("--")) continue;
    const candidate = cascadedCandidate(entries);
    if (candidate === null) continue;
    const value = cssValue(candidate.declaration);
    const wide = cssWide(value);
    if (wide === "initial") result.delete(name);
    else if (wide === null) result.set(name, value);
  }
  for (const [name, value] of result) {
    const resolved = resolveVariables(value, result);
    if (resolved === null) result.delete(name);
    else result.set(name, resolved);
  }
  return new ImmutableStringMap(result);
}

function validatedValue(
  candidates: ReadonlyMap<string, readonly CascadeCandidate[]> | undefined,
  names: string | readonly string[],
  variables: ReadonlyMap<string, string>,
  diagnostics: DiagnosticCollector
): { readonly property: string; readonly value: string; readonly sourceUrl: string } | null {
  const properties = typeof names === "string" ? [names] : names;
  let selectedName: string | null = null;
  let selected: { readonly candidate: CascadeCandidate; readonly value: string } | null = null;
  for (const property of properties) {
    let entries = [...(candidates?.get(property) ?? [])];
    let resolved: { readonly candidate: CascadeCandidate; readonly value: string } | null = null;
    while (entries.length > 0) {
      const candidate = bestCandidate(entries);
      if (candidate === null) break;
      const candidateValue = resolveVariables(cssValue(candidate.declaration), variables);
      if (candidateValue === null) {
        diagnostics.add("property-invalid", candidate.sourceUrl, `Unresolved custom property in ${property}.`);
        break;
      }
      if (cssWide(candidateValue) === "revert") {
        entries = entries.filter((entry) => entry.origin !== candidate.origin);
        continue;
      }
      resolved = { candidate, value: candidateValue };
      break;
    }
    if (resolved !== null && (selected === null || outranks(resolved.candidate, selected.candidate))) {
      selected = resolved;
      selectedName = property;
    }
  }
  if (selected === null || selectedName === null) return null;
  const { candidate, value } = selected;
  if (selectedName !== "content") {
    const parsed = parseDeclaration(`${selectedName}:${value}`);
    if (!parsed.ok) {
      diagnostics.add("property-invalid", candidate.sourceUrl, `Invalid value for ${selectedName}.`);
      return null;
    }
    const validation = validateCssPropertyValue(parsed.value);
    if (validation.status === "invalid") {
      diagnostics.add("property-invalid", candidate.sourceUrl, `Invalid value for ${selectedName}.`);
      return null;
    }
    if (validation.status === "unsupported" && selectedName !== "clip") {
      diagnostics.add("property-unsupported", candidate.sourceUrl, `CSS parser cannot validate ${selectedName}.`);
      return null;
    }
  }
  return { property: selectedName, value, sourceUrl: candidate.sourceUrl };
}

function initialDisplay(replaced: boolean): ComputedDisplay {
  return { box: "principal", outer: "inline", inner: "flow", listItem: false, internal: null, replaced };
}

function edges(value: CssLength = ZERO): CssEdges {
  return { top: value, right: value, bottom: value, left: value };
}

function initialStyle(parent: ComputedStyle | null, replaced: boolean): ComputedStyle {
  return {
    display: initialDisplay(replaced),
    visibility: parent?.visibility ?? "visible",
    listStyleType: parent?.listStyleType ?? "disc",
    text: {
      color: parent?.text.color ?? null,
      background: null,
      fontWeight: parent?.text.fontWeight ?? 400,
      fontStyle: parent?.text.fontStyle ?? "normal",
      underline: false,
      lineThrough: false,
      textTransform: parent?.text.textTransform ?? "none",
      whiteSpace: parent?.text.whiteSpace ?? "normal",
      textAlign: parent?.text.textAlign ?? "left",
      textIndent: parent?.text.textIndent ?? ZERO
    },
    box: {
      margin: edges(),
      padding: edges(),
      width: AUTO,
      minWidth: AUTO,
      maxWidth: NONE,
      height: AUTO,
      minHeight: AUTO,
      rowGap: ZERO,
      columnGap: ZERO,
      borderStyle: "none",
      borderWidth: MEDIUM_BORDER,
      borderColor: null,
      flexDirection: "row",
      flexWrap: "nowrap",
      justifyContent: "start",
      alignItems: "stretch",
      position: "static",
      legacyClip: { kind: "auto" },
      clipPath: { kind: "none" },
      gridTemplateColumns: [],
      gridColumn: null,
      overflowX: "visible",
      overflowY: "visible"
    },
    generatedBefore: null,
    generatedAfter: null,
    customProperties: parent?.customProperties ?? new Map()
  };
}

function resolvedWide(property: string, value: string, initial: string, inherited: string | null): string {
  const wide = cssWide(value);
  if (wide === null) return value;
  if (wide === "inherit") return inherited ?? initial;
  if (wide === "unset") return INHERITED_PROPERTIES.has(property) ? inherited ?? initial : initial;
  return initial;
}

function parseDisplay(
  value: string,
  initial: ComputedDisplay,
  inherited: ComputedDisplay | null
): ComputedDisplay | null {
  const wide = cssWide(value);
  if (wide !== null) {
    if (wide !== "inherit") return initial;
    if (inherited === null || inherited.box !== "principal" || initial.box !== "principal") return inherited ?? initial;
    return { ...inherited, replaced: initial.replaced };
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "contents") return { box: normalized };
  const replaced = initial.box === "principal" && initial.replaced;
  const internal = new Set<CssDisplayInternal>([
    "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-cell",
    "table-column-group", "table-column", "table-caption"
  ]);
  if (internal.has(normalized as CssDisplayInternal)) {
    return {
      box: "principal",
      outer: "block",
      inner: "flow",
      listItem: false,
      internal: normalized as CssDisplayInternal,
      replaced
    };
  }
  const aliases: Readonly<Record<string, readonly ["block" | "inline", "flow" | "flow-root" | "table" | "flex" | "grid", boolean]>> = {
    block: ["block", "flow", false],
    inline: ["inline", "flow", false],
    "inline-block": ["inline", "flow-root", false],
    "flow-root": ["block", "flow-root", false],
    "list-item": ["block", "flow", true],
    table: ["block", "table", false],
    "inline-table": ["inline", "table", false],
    flex: ["block", "flex", false],
    "inline-flex": ["inline", "flex", false],
    grid: ["block", "grid", false],
    "inline-grid": ["inline", "grid", false]
  };
  const alias = aliases[normalized];
  if (alias !== undefined) {
    return { box: "principal", outer: alias[0], inner: alias[1], listItem: alias[2], internal: null, replaced };
  }
  const parts = normalized.split(/\s+/u);
  const outer = parts.find((part): part is "block" | "inline" => part === "block" || part === "inline") ?? "block";
  const inner = parts.find((part): part is "flow" | "flow-root" | "table" | "flex" | "grid" =>
    part === "flow" || part === "flow-root" || part === "table" || part === "flex" || part === "grid"
  ) ?? "flow";
  if (parts.every((part) => ["block", "inline", "flow", "flow-root", "table", "flex", "grid", "list-item"].includes(part))) {
    return { box: "principal", outer, inner, listItem: parts.includes("list-item"), internal: null, replaced };
  }
  return null;
}

function parseLength(
  value: string,
  allowAuto = true,
  allowNegative = false,
  allowNone = false
): CssLength | null {
  const normalized = value.trim().toLowerCase();
  if (allowAuto && normalized === "auto") return AUTO;
  if (allowNone && normalized === "none") return NONE;
  if (normalized === "0" || normalized === "+0" || normalized === "-0") return ZERO;
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|ch|%|vw|vh)$/u.exec(normalized);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || (!allowNegative && number < 0)) return null;
  return Object.freeze({
    kind: "length",
    value: number,
    unit: match[2] as "px" | "em" | "rem" | "ch" | "%" | "vw" | "vh"
  });
}

function immutableComputedStyle(style: ComputedStyle): ComputedStyle {
  const color = (value: CssColor | null): CssColor | null => value === null
    ? null
    : Object.freeze({ ...value });
  const edge = (value: CssEdges): CssEdges => Object.freeze({ ...value });
  return Object.freeze({
    ...style,
    display: Object.freeze({ ...style.display }),
    text: Object.freeze({
      ...style.text,
      color: color(style.text.color),
      background: color(style.text.background)
    }),
    box: Object.freeze({
      ...style.box,
      margin: edge(style.box.margin),
      padding: edge(style.box.padding),
      borderColor: color(style.box.borderColor),
      legacyClip: Object.freeze(style.box.legacyClip.kind === "auto"
        ? { kind: "auto" }
        : { kind: "rect", edges: edge(style.box.legacyClip.edges) }),
      clipPath: Object.freeze(style.box.clipPath.kind === "none"
        ? { kind: "none" }
        : { kind: "inset", offsets: edge(style.box.clipPath.offsets) }),
      gridTemplateColumns: Object.freeze([...style.box.gridTemplateColumns])
    }),
    customProperties: style.customProperties instanceof ImmutableStringMap
      ? style.customProperties
      : new ImmutableStringMap(style.customProperties)
  });
}

function splitTopLevel(value: string, separator: "space" | "comma"): readonly string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && (separator === "comma" ? character === "," : /\s/u.test(character ?? ""))) {
      const part = value.slice(start, index).trim();
      if (part.length > 0) parts.push(part);
      start = index + 1;
    }
  }
  if (depth !== 0) return null;
  const final = value.slice(start).trim();
  if (final.length > 0) parts.push(final);
  return parts;
}

function parseGridBreadth(token: string): CssGridBreadth | null {
  if (token === "auto") return { kind: "auto" };
  const fraction = /^((?:\d+(?:\.\d+)?|\.\d+))fr$/u.exec(token);
  if (fraction?.[1] !== undefined) {
    const number = Number(fraction[1]);
    return Number.isFinite(number) && number > 0 ? { kind: "fraction", value: number } : null;
  }
  const length = parseLength(token, false);
  return length === null ? null : { kind: "length", value: length };
}

function parseGridTrack(token: string): CssGridTrack | null {
  const minmax = /^minmax\((.*)\)$/u.exec(token);
  if (minmax?.[1] !== undefined) {
    const parts = splitTopLevel(minmax[1], "comma");
    if (parts?.length !== 2) return null;
    const minimum = parts[0] === undefined ? null : parseGridBreadth(parts[0]);
    const maximum = parts[1] === undefined ? null : parseGridBreadth(parts[1]);
    return minimum === null || maximum === null ? null : { kind: "minmax", minimum, maximum };
  }
  return parseGridBreadth(token);
}

function parseGridTracks(
  value: string,
  nestingDepth = 0
): readonly CssGridTrack[] | null {
  if (nestingDepth > 32) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return [];
  const tokens = splitTopLevel(normalized, "space");
  if (tokens === null) return null;
  const tracks: CssGridTrack[] = [];
  for (const token of tokens) {
    const repeat = /^repeat\(\s*(\d+)\s*,(.*)\)$/u.exec(token);
    if (repeat?.[1] !== undefined && repeat[2] !== undefined) {
      const count = Number.parseInt(repeat[1], 10);
      const repeated = parseGridTracks(repeat[2], nestingDepth + 1);
      if (!Number.isSafeInteger(count) || count < 1 || count > 64 || repeated === null
        || repeated.length === 0 || tracks.length + repeated.length * count > 64) return null;
      for (let index = 0; index < count; index += 1) tracks.push(...repeated);
      continue;
    }
    const track = parseGridTrack(token);
    if (track === null || tracks.length >= 64) return null;
    tracks.push(track);
  }
  return tracks.length === 0 ? null : Object.freeze(tracks.map((track) => Object.freeze(
    track.kind === "minmax"
      ? { ...track, minimum: Object.freeze(track.minimum), maximum: Object.freeze(track.maximum) }
      : track
  )));
}

function fourSides(parts: readonly string[]): readonly [string, string, string, string] | null {
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => part.length === 0)) return null;
  const top = parts[0];
  if (top === undefined) return null;
  const right = parts[1] ?? top;
  const bottom = parts[2] ?? top;
  const left = parts[3] ?? right;
  return [top, right, bottom, left];
}

function parseLegacyClip(value: string): CssLegacyClip | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return { kind: "auto" };
  const match = /^rect\((.*)\)$/u.exec(normalized);
  if (match?.[1] === undefined) return null;
  const parts = match[1].replaceAll(",", " ").trim().split(/\s+/u);
  if (parts.length !== 4) return null;
  const values = parts.map((part) => parseLength(part, true, false));
  if (values.some((part) => part === null)) return null;
  return {
    kind: "rect",
    edges: {
      top: values[0] ?? AUTO,
      right: values[1] ?? AUTO,
      bottom: values[2] ?? AUTO,
      left: values[3] ?? AUTO
    }
  };
}

function parseClipPath(value: string): CssClipPath | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return { kind: "none" };
  const match = /^inset\(([^/]*?)\)$/u.exec(normalized);
  if (match?.[1] === undefined || /\bround\b/u.test(match[1])) return null;
  const sides = fourSides(match[1].trim().split(/\s+/u));
  if (sides === null) return null;
  const values = sides.map((part) => parseLength(part, false, false));
  if (values.some((part) => part === null)) return null;
  return {
    kind: "inset",
    offsets: {
      top: values[0] ?? ZERO,
      right: values[1] ?? ZERO,
      bottom: values[2] ?? ZERO,
      left: values[3] ?? ZERO
    }
  };
}

function boxParts(value: string): readonly string[] | null {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  if (parts.length === 1) return [parts[0] ?? "0", parts[0] ?? "0", parts[0] ?? "0", parts[0] ?? "0"];
  if (parts.length === 2) return [parts[0] ?? "0", parts[1] ?? "0", parts[0] ?? "0", parts[1] ?? "0"];
  if (parts.length === 3) return [parts[0] ?? "0", parts[1] ?? "0", parts[2] ?? "0", parts[1] ?? "0"];
  return parts;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseColor(value: string, current: CssColor | null): CssColor | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "transparent") return TRANSPARENT;
  if (normalized === "currentcolor") return current;
  if (normalized.startsWith("#")) {
    const raw = normalized.slice(1);
    if (!/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(raw)) return undefined;
    const expanded = raw.length <= 4 ? raw.replace(/[0-9a-f]/gu, (part) => `${part}${part}`) : raw;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) / 255 : 1
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u.exec(normalized);
  if (rgb !== null) {
    const component = (part: string | undefined): number => part?.endsWith("%")
      ? clampByte(Number(part.slice(0, -1)) * 2.55)
      : clampByte(Number(part));
    const alpha = rgb[4]?.endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4] ?? "1");
    if (!Number.isFinite(alpha)) return undefined;
    return { r: component(rgb[1]), g: component(rgb[2]), b: component(rgb[3]), a: Math.max(0, Math.min(1, alpha)) };
  }
  return NAMED_COLORS[normalized];
}

function generatedContent(value: string, document: WebDocumentSnapshotView, node: DocumentNodeRef): string | null | undefined {
  const normalized = value.trim();
  if (normalized === "none" || normalized === "normal") return null;
  const pieces: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|attr\(\s*([-\w]+)\s*\)/gu;
  let cursor = 0;
  for (const match of normalized.matchAll(pattern)) {
    if (normalized.slice(cursor, match.index).trim().length > 0) return undefined;
    cursor = match.index + match[0].length;
    if (match[3] !== undefined) pieces.push(document.attribute(node, match[3]) ?? "");
    else pieces.push((match[1] ?? match[2] ?? "").replace(/\\([\\"'])/gu, "$1"));
  }
  return pieces.length === 0 || normalized.slice(cursor).trim().length > 0 ? undefined : pieces.join("");
}

function computeStyle(
  document: WebDocumentSnapshotView,
  node: DocumentNodeRef,
  parent: ComputedStyle | null,
  candidates: ReadonlyMap<string, readonly CascadeCandidate[]> | undefined,
  diagnostics: DiagnosticCollector,
  pseudo: PseudoElementIdentity | null = null
): ComputedStyle {
  const replaced = document.replaced(node) !== null || document.control(node) !== null;
  let style = initialStyle(parent, replaced);
  const variables = customProperties(parent?.customProperties ?? new Map(), candidates);
  style = { ...style, customProperties: variables };
  const value = (names: string | readonly string[]) => validatedValue(candidates, names, variables, diagnostics);
  const unsupported = (entry: { readonly property: string; readonly value: string; readonly sourceUrl: string }): void => {
    diagnostics.add("value-unsupported", entry.sourceUrl, `Unsupported ${entry.property} value ${entry.value}.`);
  };

  const display = value("display");
  if (display !== null) {
    const computed = parseDisplay(display.value, style.display, parent?.display ?? null);
    if (computed === null) unsupported(display);
    else style = { ...style, display: computed };
  }
  const visibility = value("visibility");
  if (visibility !== null) {
    const computed = resolvedWide("visibility", visibility.value, "visible", parent?.visibility ?? null);
    if (computed === "visible" || computed === "hidden" || computed === "collapse") style = { ...style, visibility: computed };
    else unsupported(visibility);
  }
  const whiteSpace = value("white-space");
  if (whiteSpace !== null) {
    const computed = resolvedWide("white-space", whiteSpace.value, "normal", parent?.text.whiteSpace ?? null);
    if (["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"].includes(computed)) {
      style = { ...style, text: { ...style.text, whiteSpace: computed as ComputedStyle["text"]["whiteSpace"] } };
    } else unsupported(whiteSpace);
  }
  const transform = value("text-transform");
  if (transform !== null) {
    const computed = resolvedWide("text-transform", transform.value, "none", parent?.text.textTransform ?? null);
    if (["none", "uppercase", "lowercase", "capitalize"].includes(computed)) {
      style = { ...style, text: { ...style.text, textTransform: computed as ComputedStyle["text"]["textTransform"] } };
    } else unsupported(transform);
  }
  const textAlign = value("text-align");
  if (textAlign !== null) {
    const computed = resolvedWide("text-align", textAlign.value, "left", parent?.text.textAlign ?? null);
    const aligned = computed === "start" ? "left" : computed === "end" ? "right" : computed;
    if (aligned === "left" || aligned === "center" || aligned === "right") {
      style = { ...style, text: { ...style.text, textAlign: aligned } };
    } else unsupported(textAlign);
  }
  const textIndent = value("text-indent");
  if (textIndent !== null) {
    const wide = cssWide(textIndent.value);
    const computed = wide === "inherit" || wide === "unset"
      ? parent?.text.textIndent ?? ZERO
      : wide === "initial"
        ? ZERO
        : parseLength(textIndent.value, false, true);
    if (computed === null) unsupported(textIndent);
    else style = { ...style, text: { ...style.text, textIndent: computed } };
  }
  const listStyle = value(["list-style-type", "list-style"]);
  if (listStyle !== null) {
    const supported = ["none", "disc", "circle", "square", "decimal", "decimal-leading-zero", "lower-alpha", "upper-alpha"] as const;
    const wide = cssWide(listStyle.value);
    const marker = wide === "inherit" || wide === "unset"
      ? parent?.listStyleType ?? "disc"
      : wide === "initial"
        ? "disc"
        : listStyle.value.split(/\s+/u).find((part) => supported.includes(part as typeof supported[number]));
    if (marker === undefined) unsupported(listStyle);
    else style = { ...style, listStyleType: marker as ComputedStyle["listStyleType"] };
  }
  const color = value("color");
  if (color !== null) {
    const wide = cssWide(color.value);
    const computed = wide === "inherit" || wide === "unset"
      ? parent?.text.color ?? null
      : wide === "initial"
        ? null
        : parseColor(color.value, style.text.color);
    if (computed === undefined) unsupported(color);
    else style = { ...style, text: { ...style.text, color: computed } };
  }
  const background = value(["background-color", "background"]);
  if (background !== null) {
    const wide = cssWide(background.value);
    const candidates = wide === null
      ? background.value.split(/\s+/u).map((part) => parseColor(part, style.text.color))
      : [];
    const computed = wide === "inherit"
      ? parent?.text.background ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : candidates.find((candidate) => candidate !== undefined);
    if (computed === undefined) unsupported(background);
    else style = { ...style, text: { ...style.text, background: computed } };
  }
  const weight = value("font-weight");
  if (weight !== null) {
    const computed = resolvedWide("font-weight", weight.value, "400", String(parent?.text.fontWeight ?? 400)).toLowerCase();
    const numeric = computed === "normal" ? 400 : computed === "bold" || computed === "bolder" ? 700
      : computed === "lighter" ? 300 : Number.parseInt(computed, 10);
    if (!Number.isFinite(numeric) || numeric < 1 || numeric > 1000) unsupported(weight);
    else style = { ...style, text: { ...style.text, fontWeight: numeric } };
  }
  const fontStyle = value("font-style");
  if (fontStyle !== null) {
    const computed = resolvedWide("font-style", fontStyle.value, "normal", parent?.text.fontStyle ?? null).toLowerCase();
    const normalized = computed.startsWith("oblique") ? "oblique" : computed;
    if (normalized === "normal" || normalized === "italic" || normalized === "oblique") {
      style = { ...style, text: { ...style.text, fontStyle: normalized } };
    } else unsupported(fontStyle);
  }
  const decoration = value(["text-decoration-line", "text-decoration"]);
  if (decoration !== null) {
    const wide = cssWide(decoration.value);
    const inherited = wide === "inherit" ? parent?.text : null;
    style = {
      ...style,
      text: {
        ...style.text,
        underline: inherited?.underline ?? (wide === null && decoration.value.includes("underline")),
        lineThrough: inherited?.lineThrough ?? (wide === null && decoration.value.includes("line-through"))
      }
    };
  }

  const directionIsRtl = document.attribute(node, "dir")?.trim().toLowerCase() === "rtl";
  const sideSpecs = [
    ["margin-top", ["margin-top", "margin-block-start", "margin-block", "margin"], "top", 0, true],
    ["margin-right", ["margin-right", directionIsRtl ? "margin-inline-start" : "margin-inline-end", "margin-inline", "margin"], "right", 1, true],
    ["margin-bottom", ["margin-bottom", "margin-block-end", "margin-block", "margin"], "bottom", 2, true],
    ["margin-left", ["margin-left", directionIsRtl ? "margin-inline-end" : "margin-inline-start", "margin-inline", "margin"], "left", 3, true],
    ["padding-top", ["padding-top", "padding-block-start", "padding-block", "padding"], "top", 0, false],
    ["padding-right", ["padding-right", directionIsRtl ? "padding-inline-start" : "padding-inline-end", "padding-inline", "padding"], "right", 1, false],
    ["padding-bottom", ["padding-bottom", "padding-block-end", "padding-block", "padding"], "bottom", 2, false],
    ["padding-left", ["padding-left", directionIsRtl ? "padding-inline-end" : "padding-inline-start", "padding-inline", "padding"], "left", 3, false]
  ] as const;
  for (const [property, names, side, index, margin] of sideSpecs) {
    const entry = value(names);
    if (entry === null) continue;
    const key = margin ? "margin" : "padding";
    const wide = cssWide(entry.value);
    if (wide !== null) {
      const length = wide === "inherit" ? parent?.box[key][side] ?? ZERO : ZERO;
      style = { ...style, box: { ...style.box, [key]: { ...style.box[key], [side]: length } } };
      continue;
    }
    const shorthand = entry.property === "margin" || entry.property === "padding";
    const axis = entry.property === "margin-block" || entry.property === "margin-inline"
      || entry.property === "padding-block" || entry.property === "padding-inline";
    const raw = shorthand ? boxParts(entry.value)?.[index]
      : axis ? (() => {
        const parts = entry.value.trim().split(/\s+/u);
        const end = side === "right" || side === "bottom";
        return end ? parts[1] ?? parts[0] : parts[0];
      })() : entry.value;
    const length = raw === undefined ? null : parseLength(raw, margin, margin);
    if (length === null) unsupported({ ...entry, property });
    else {
      style = { ...style, box: { ...style.box, [key]: { ...style.box[key], [side]: length } } };
    }
  }

  const dimensionSpecs = [
    ["width", "width", true, false], ["min-width", "minWidth", true, false],
    ["max-width", "maxWidth", true, true], ["height", "height", true, false],
    ["min-height", "minHeight", true, false]
  ] as const;
  for (const [property, field, allowAuto, allowNone] of dimensionSpecs) {
    const entry = value(property);
    if (entry === null) continue;
    const wide = cssWide(entry.value);
    const initial = field === "maxWidth" ? NONE : AUTO;
    const length = wide === "inherit"
      ? parent?.box[field] ?? initial
      : wide === "initial" || wide === "unset"
        ? initial
        : parseLength(entry.value, allowAuto, false, allowNone);
    if (length === null) unsupported(entry);
    else style = { ...style, box: { ...style.box, [field]: length } };
  }
  const columnGap = value(["column-gap", "gap"]);
  const rowGap = value(["row-gap", "gap"]);
  if (columnGap !== null) {
    const part = columnGap.property === "gap" ? columnGap.value.trim().split(/\s+/u)[1] ?? columnGap.value.trim().split(/\s+/u)[0] : columnGap.value;
    const wide = cssWide(columnGap.value);
    const length = wide === "inherit"
      ? parent?.box.columnGap ?? ZERO
      : wide === "initial" || wide === "unset"
        ? ZERO
        : parseLength(part ?? "0", false);
    if (length === null) unsupported(columnGap);
    else style = { ...style, box: { ...style.box, columnGap: length } };
  }
  if (rowGap !== null) {
    const part = rowGap.value.trim().split(/\s+/u)[0] ?? "0";
    const wide = cssWide(rowGap.value);
    const length = wide === "inherit"
      ? parent?.box.rowGap ?? ZERO
      : wide === "initial" || wide === "unset"
        ? ZERO
        : parseLength(part, false);
    if (length === null) unsupported(rowGap);
    else style = { ...style, box: { ...style.box, rowGap: length } };
  }
  const flexDirection = value("flex-direction");
  if (flexDirection !== null) {
    const wide = cssWide(flexDirection.value);
    const computed = wide === "inherit"
      ? parent?.box.flexDirection ?? "row"
      : wide === "initial" || wide === "unset"
        ? "row"
        : flexDirection.value;
    if (["row", "row-reverse", "column", "column-reverse"].includes(computed)) {
      style = { ...style, box: { ...style.box, flexDirection: computed as ComputedStyle["box"]["flexDirection"] } };
    } else unsupported(flexDirection);
  }
  const flexWrap = value("flex-wrap");
  if (flexWrap !== null) {
    const wide = cssWide(flexWrap.value);
    const computed = wide === "inherit"
      ? parent?.box.flexWrap ?? "nowrap"
      : wide === "initial" || wide === "unset"
        ? "nowrap"
        : flexWrap.value.trim().toLowerCase();
    if (computed === "nowrap" || computed === "wrap" || computed === "wrap-reverse") {
      style = { ...style, box: { ...style.box, flexWrap: computed } };
    } else unsupported(flexWrap);
  }
  const justifyContent = value("justify-content");
  if (justifyContent !== null) {
    const wide = cssWide(justifyContent.value);
    const raw = wide === "inherit"
      ? parent?.box.justifyContent ?? "start"
      : wide === "initial" || wide === "unset"
        ? "start"
        : justifyContent.value.trim().toLowerCase();
    const computed = raw === "flex-start" ? "start" : raw === "flex-end" ? "end" : raw;
    if (computed === "start" || computed === "center" || computed === "end" || computed === "space-between") {
      style = { ...style, box: { ...style.box, justifyContent: computed } };
    } else unsupported(justifyContent);
  }
  const alignItems = value("align-items");
  if (alignItems !== null) {
    const wide = cssWide(alignItems.value);
    const raw = wide === "inherit"
      ? parent?.box.alignItems ?? "stretch"
      : wide === "initial" || wide === "unset"
        ? "stretch"
        : alignItems.value.trim().toLowerCase();
    const computed = raw === "flex-start" ? "start" : raw === "flex-end" ? "end" : raw;
    if (computed === "start" || computed === "center" || computed === "end" || computed === "stretch") {
      style = { ...style, box: { ...style.box, alignItems: computed } };
    } else unsupported(alignItems);
  }
  const gridTemplate = value("grid-template-columns");
  if (gridTemplate !== null) {
    const wide = cssWide(gridTemplate.value);
    const tracks = wide === "inherit"
      ? parent?.box.gridTemplateColumns ?? []
      : wide === "initial" || wide === "unset"
        ? []
        : parseGridTracks(gridTemplate.value);
    if (tracks === null) unsupported(gridTemplate);
    else style = { ...style, box: { ...style.box, gridTemplateColumns: tracks } };
  }
  const gridColumn = value("grid-column");
  if (gridColumn !== null) {
    const wide = cssWide(gridColumn.value);
    const column = wide === "inherit"
      ? parent?.box.gridColumn ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : /^\d+$/u.test(gridColumn.value.trim())
          ? Number.parseInt(gridColumn.value, 10)
          : Number.NaN;
    if (column !== null && (!Number.isSafeInteger(column) || column < 1)) unsupported(gridColumn);
    else style = { ...style, box: { ...style.box, gridColumn: column } };
  }
  const borderStyle = value(["border-style", "border"]);
  if (borderStyle !== null) {
    const wide = cssWide(borderStyle.value);
    const computed = wide === "inherit"
      ? parent?.box.borderStyle ?? "none"
      : wide === "initial" || wide === "unset"
        ? "none"
        : !/\b(?:none|hidden)\b/u.test(borderStyle.value)
          && /\b(?:solid|double|dashed|dotted|groove|ridge|inset|outset)\b/u.test(borderStyle.value)
          ? "solid"
          : "none";
    style = { ...style, box: { ...style.box, borderStyle: computed } };
  }
  const borderWidth = value(["border-width", "border"]);
  if (borderWidth !== null) {
    const wide = cssWide(borderWidth.value);
    const token = wide === null
      ? borderWidth.value.split(/\s+/u).find((part) => parseLength(part, false) !== null)
      : undefined;
    const width = wide === "inherit"
      ? parent?.box.borderWidth ?? MEDIUM_BORDER
      : wide === "initial" || wide === "unset"
        ? MEDIUM_BORDER
        : token === undefined ? null : parseLength(token, false);
    if (width !== null) style = { ...style, box: { ...style.box, borderWidth: width } };
  }
  const borderColor = value(["border-color", "border"]);
  if (borderColor !== null) {
    const wide = cssWide(borderColor.value);
    const color = wide === "inherit"
      ? parent?.box.borderColor ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : borderColor.value.split(/\s+/u)
          .map((part) => parseColor(part, style.text.color))
          .find((part) => part !== undefined);
    if (color !== undefined) style = { ...style, box: { ...style.box, borderColor: color } };
  }
  const overflow = value("overflow");
  const overflowX = value("overflow-x");
  const overflowY = value("overflow-y");
  const parseOverflow = (
    entry: typeof overflow,
    inherited: ComputedStyle["box"]["overflowX"] | undefined
  ): ComputedStyle["box"]["overflowX"] | null => {
    if (entry === null) return null;
    const wide = cssWide(entry.value);
    if (wide === "inherit") return inherited ?? "visible";
    if (wide === "initial" || wide === "unset") return "visible";
    return ["visible", "hidden", "clip"].includes(entry.value)
      ? entry.value as ComputedStyle["box"]["overflowX"] : null;
  };
  const commonOverflowX = parseOverflow(overflow, parent?.box.overflowX);
  const commonOverflowY = parseOverflow(overflow, parent?.box.overflowY);
  const x = parseOverflow(overflowX, parent?.box.overflowX) ?? commonOverflowX;
  const y = parseOverflow(overflowY, parent?.box.overflowY) ?? commonOverflowY;
  for (const [entry, inherited] of [
    [overflow, parent?.box.overflowX],
    [overflowX, parent?.box.overflowX],
    [overflowY, parent?.box.overflowY]
  ] as const) {
    if (entry !== null && parseOverflow(entry, inherited) === null) unsupported(entry);
  }
  style = { ...style, box: { ...style.box, ...(x === null ? {} : { overflowX: x }), ...(y === null ? {} : { overflowY: y }) } };
  const position = value("position");
  if (position !== null) {
    const wide = cssWide(position.value);
    const computed = wide === "inherit"
      ? parent?.box.position ?? "static"
      : wide === "initial" || wide === "unset"
        ? "static"
        : position.value.trim().toLowerCase();
    if (computed === "static" || computed === "relative" || computed === "absolute"
      || computed === "fixed" || computed === "sticky") {
      style = { ...style, box: { ...style.box, position: computed } };
    } else unsupported(position);
  }
  const legacyClip = value("clip");
  if (legacyClip !== null) {
    const wide = cssWide(legacyClip.value);
    const computed = wide === "inherit"
      ? parent?.box.legacyClip ?? { kind: "auto" as const }
      : wide === "initial" || wide === "unset"
        ? { kind: "auto" as const }
        : parseLegacyClip(legacyClip.value);
    if (computed === null) unsupported(legacyClip);
    else style = { ...style, box: { ...style.box, legacyClip: computed } };
  }
  const clipPath = value("clip-path");
  if (clipPath !== null) {
    const wide = cssWide(clipPath.value);
    const computed = wide === "inherit"
      ? parent?.box.clipPath ?? { kind: "none" as const }
      : wide === "initial" || wide === "unset"
        ? { kind: "none" as const }
        : parseClipPath(clipPath.value);
    if (computed === null) unsupported(clipPath);
    else style = { ...style, box: { ...style.box, clipPath: computed } };
  }
  const content = value("content");
  if (content !== null && pseudo !== null) {
    const wide = cssWide(content.value);
    const computed = wide === "inherit"
      ? pseudo === "before" ? parent?.generatedBefore ?? null : parent?.generatedAfter ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : generatedContent(content.value, document, node);
    if (computed === undefined) unsupported(content);
    else if (pseudo === "before") style = { ...style, generatedBefore: computed };
    else if (pseudo === "after") style = { ...style, generatedAfter: computed };
  }
  return immutableComputedStyle(style);
}

class ImmutableStyleSnapshot implements StyleSnapshot {
  readonly document: WebDocumentSnapshotView;
  readonly environment: ResolveStylesInput["environment"];
  readonly diagnostics: readonly StyleDiagnostic[];
  readonly stylesheetCount: number;
  readonly outcome: StyleOutcome;
  readonly #styles: ReadonlyMap<DocumentNodeRef, ComputedStyle>;
  readonly #pseudos: ReadonlyMap<string, ComputedStyle>;

  public constructor(
    input: ResolveStylesInput,
    styles: ReadonlyMap<DocumentNodeRef, ComputedStyle>,
    pseudos: ReadonlyMap<string, ComputedStyle>,
    diagnostics: readonly StyleDiagnostic[],
    stylesheetCount: number,
    outcome: StyleOutcome
  ) {
    this.document = input.document;
    this.environment = Object.freeze({ ...input.environment });
    this.#styles = styles;
    this.#pseudos = pseudos;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.stylesheetCount = stylesheetCount;
    this.outcome = Object.freeze(outcome);
    Object.freeze(this);
  }

  public style(node: DocumentNodeRef): ComputedStyle {
    const style = this.#styles.get(node);
    if (style === undefined) throw new RangeError(`No computed style for ${node}`);
    return style;
  }

  public has(node: DocumentNodeRef): boolean {
    return this.#styles.has(node);
  }

  public pseudo(node: DocumentNodeRef, identity: PseudoElementIdentity): ComputedStyle | null {
    return this.#pseudos.get(styleKey(node, identity)) ?? null;
  }
}

export function resolveStyles(input: ResolveStylesInput): StyleSnapshot {
  const mediaType: unknown = input.environment.mediaType;
  const colorScheme: unknown = input.environment.prefersColorScheme;
  const reducedMotion: unknown = input.environment.reducedMotion;
  if (!Number.isFinite(input.environment.viewportWidthPx) || input.environment.viewportWidthPx <= 0
    || !Number.isFinite(input.environment.viewportHeightPx) || input.environment.viewportHeightPx <= 0
    || mediaType !== "screen"
    || (colorScheme !== "light" && colorScheme !== "dark")
    || typeof reducedMotion !== "boolean") {
    return new ImmutableStyleSnapshot(input, new Map(), new Map(), [], 0, {
      status: "rejected", reason: "invalid-environment"
    });
  }
  const limits = budgets(input.budgets);
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics, input.initialDiagnostics ?? []);
  const truncatedBudgets = new Set<keyof StyleBudgets>();
  const truncate = (budget: keyof StyleBudgets): void => {
    truncatedBudgets.add(budget);
  };
  const styleNodes = collectStyleNodes(input, limits.maxComputedNodes);
  if (styleNodes.truncated) truncate("maxComputedNodes");
  const sources = stylesheetSources(input, limits, diagnostics, truncate);
  const candidates = collectCandidates(input, sources, styleNodes.nodes, limits, diagnostics, truncate);
  const styles = new Map<DocumentNodeRef, ComputedStyle>();
  const pseudos = new Map<string, ComputedStyle>();
  let computedNodes = 0;
  for (const ref of styleNodes.nodes) {
    input.signal?.throwIfAborted();
    const parentNode = input.document.parent(ref);
    const parentStyle = parentNode?.kind === "element" ? styles.get(parentNode.ref) ?? null : null;
    const style = computeStyle(
      input.document,
      ref,
      parentStyle,
      candidates.get(styleKey(ref)),
      diagnostics
    );
    styles.set(ref, style);
    for (const pseudo of ["before", "after", "marker"] as const) {
      const pseudoCandidates = candidates.get(styleKey(ref, pseudo));
      if (pseudoCandidates === undefined) continue;
      pseudos.set(styleKey(ref, pseudo), computeStyle(input.document, ref, style, pseudoCandidates, diagnostics, pseudo));
    }
    computedNodes += 1;
  }
  const truncatedBudget = truncatedBudgets.values().next().value;
  const outcome: StyleOutcome = truncatedBudget === undefined
    ? { status: "complete", computedNodes }
    : {
        status: "truncated",
        computedNodes,
        budget: truncatedBudget,
        limit: limits[truncatedBudget]
      };
  return new ImmutableStyleSnapshot(
    input,
    styles,
    pseudos,
    diagnostics.result(),
    Math.max(0, sources.length - 1),
    outcome
  );
}

export function transformComputedText(value: string, transform: ComputedStyle["text"]["textTransform"]): string {
  if (transform === "uppercase") return value.toUpperCase();
  if (transform === "lowercase") return value.toLowerCase();
  if (transform === "capitalize") {
    return value.replace(/(^|[\s\p{P}])(\p{L})/gu, (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`
    );
  }
  return value;
}

export type { StylesheetResource };
