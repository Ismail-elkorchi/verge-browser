import {
  parseBlockContents,
  parseComponentValues,
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
  type ComponentValue,
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
  type DocumentState,
  type WebDocumentNode,
  type IndexedWebDocumentSnapshot,
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
  CssFlexBasis,
  CssGridBreadth,
  CssGridTrack,
  CssLegacyClip,
  CssLength,
  CssMathExpression,
  PseudoElementIdentity,
  ResolveStylesInput,
  StyleBudgets,
  StyleDiagnostic,
  StyleDiagnosticCode,
  StyleOutcome,
  StyleSnapshot,
  StylesheetResource
} from "./types.js";
import {
  parseCssFunctionalColor,
  parseCssLength,
  resolveCssVariables,
  splitCssComponentValues
} from "./css-values.js";

const DEFAULT_STYLE_BUDGETS: StyleBudgets = Object.freeze({
  maxStylesheetSources: 64,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxInlineStylesheetBytes: 512 * 1024,
  maxSelectorQueries: 4_096,
  maxSelectorSteps: 500_000,
  maxDiagnostics: 128
});

const SUPPORTED_PROPERTIES = new Set([
  "display", "visibility", "white-space", "color", "background", "background-color",
  "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-transform",
  "font-size", "line-height", "vertical-align", "direction", "unicode-bidi", "text-align", "text-indent",
  "line-break", "word-break", "overflow-wrap", "hyphens", "tab-size",
  "list-style", "list-style-type", "margin", "margin-top", "margin-right",
  "margin-bottom", "margin-left", "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end", "padding", "padding-top",
  "padding-right", "padding-bottom", "padding-left", "padding-block", "padding-block-start",
  "padding-block-end", "padding-inline", "padding-inline-start", "padding-inline-end",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "box-sizing", "gap",
  "row-gap", "column-gap", "flex", "flex-grow", "flex-shrink", "flex-basis", "order",
  "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self", "align-content",
  "grid-template-columns", "grid-column", "border", "border-width", "border-top-width",
  "border-right-width", "border-bottom-width", "border-left-width", "border-style",
  "border-color", "overflow", "overflow-x", "overflow-y",
  "position", "top", "right", "bottom", "left", "inset", "inset-block", "inset-block-start",
  "inset-block-end", "inset-inline", "inset-inline-start", "inset-inline-end", "z-index",
  "float", "clear", "clip", "clip-path",
  "content"
]);

const INHERITED_PROPERTIES = new Set([
  "visibility", "white-space", "color", "font-weight", "font-style", "font-size", "line-height", "text-transform",
  "direction", "text-align", "text-indent", "line-break", "word-break", "overflow-wrap", "hyphens", "tab-size",
  "list-style", "list-style-type"
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
  readonly mediaConditions: readonly string[];
  readonly supportsConditions: readonly string[];
  readonly layer: string | null;
  readonly predeclaredLayers: readonly string[];
}

interface CascadeCandidate {
  readonly declaration: CssDeclaration;
  readonly sourceUrl: string;
  readonly origin: "user-agent" | "author";
  readonly important: boolean;
  readonly inline: boolean;
  readonly specificity: SelectorSpecificity;
  readonly sourceOrder: number;
  readonly layer: string | null;
  readonly layerOrder: number | null;
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
  if (left.layer !== right.layer) {
    if (left.important) {
      if (left.layer === null) return false;
      if (right.layer === null) return true;
      return (left.layerOrder ?? Number.MAX_SAFE_INTEGER) < (right.layerOrder ?? Number.MAX_SAFE_INTEGER);
    }
    if (left.layer === null) return true;
    if (right.layer === null) return false;
    return (left.layerOrder ?? -1) > (right.layerOrder ?? -1);
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
  if (normalized === "prefers-reduced-motion" || /^prefers-reduced-motion\s*:\s*reduce$/u.test(normalized)) {
    return input.environment.reducedMotion;
  }
  if (/^prefers-reduced-motion\s*:\s*no-preference$/u.test(normalized)) return !input.environment.reducedMotion;
  if (/^prefers-color-scheme\s*:\s*dark$/u.test(normalized)) return input.environment.prefersColorScheme === "dark";
  if (/^prefers-color-scheme\s*:\s*light$/u.test(normalized)) return input.environment.prefersColorScheme === "light";
  if (normalized === "hover:hover" || normalized === "hover: hover") return input.environment.hover === "hover";
  if (normalized === "hover:none" || normalized === "hover: none") return input.environment.hover === "none";
  if (normalized === "pointer:fine" || normalized === "pointer: fine") return input.environment.pointer === "fine";
  if (normalized === "pointer:coarse" || normalized === "pointer: coarse") return input.environment.pointer === "coarse";
  if (normalized === "pointer:none" || normalized === "pointer: none") return input.environment.pointer === "none";
  const legacy = /^(min-width|max-width|width)\s*:\s*(.+)$/u.exec(normalized);
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    const boundary = mediaLengthPx(legacy[2]);
    if (boundary === null) return null;
    if (legacy[1] === "min-width") return input.environment.viewportWidthCssPx >= boundary;
    if (legacy[1] === "max-width") return input.environment.viewportWidthCssPx <= boundary;
    return input.environment.viewportWidthCssPx === boundary;
  }
  const range = /^width\s*(<=|>=|<|>)\s*(.+)$/u.exec(normalized);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const boundary = mediaLengthPx(range[2]);
    if (boundary === null) return null;
    if (range[1] === "<=") return input.environment.viewportWidthCssPx <= boundary;
    if (range[1] === ">=") return input.environment.viewportWidthCssPx >= boundary;
    if (range[1] === "<") return input.environment.viewportWidthCssPx < boundary;
    return input.environment.viewportWidthCssPx > boundary;
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
  sources.push({
    sourceUrl: USER_AGENT_STYLESHEET_SOURCE, origin: "user-agent", stylesheet: ua.value,
    media: null, mediaConditions: Object.freeze([]), supportsConditions: Object.freeze([]), layer: null,
    predeclaredLayers: Object.freeze([])
  });
  const resourcesFor = (order: number, owner: DocumentNodeRef): readonly StylesheetResource[] => {
    const metadata = input.resources.filter((resource) => resource.rootOrder === order);
    const matching = metadata.length > 0 ? metadata
      : input.resources.filter((resource) => resource.rootOrder === undefined && resource.owner === owner);
    return [...matching].sort((left, right) =>
      (left.dependencyOrder ?? 0) - (right.dependencyOrder ?? 0)
    );
  };
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
    const dependencies = resourcesFor(reference.order, reference.owner);
    const addResource = (resource: StylesheetResource): boolean => {
      if (authorSources >= limits.maxStylesheetSources) {
        truncate("maxStylesheetSources");
        diagnostics.add("stylesheet-limit", resource.finalUrl, "Author stylesheet source budget exhausted.");
        return false;
      }
      if (authorBytes + resource.bytes.byteLength > limits.maxStylesheetBytes) {
        truncate("maxStylesheetBytes");
        diagnostics.add("stylesheet-limit", resource.finalUrl, "Author stylesheet byte budget exhausted.");
        return false;
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
        return true;
      }
      for (const error of parsed.errors) diagnostics.add("stylesheet-parse", resource.finalUrl, error.message);
      sources.push({
        sourceUrl: resource.finalUrl,
        origin: "author",
        stylesheet: parsed.value,
        media: null,
        mediaConditions: resource.mediaConditions ?? Object.freeze(resource.media === null ? [] : [resource.media]),
        supportsConditions: resource.supportsConditions ?? Object.freeze([]),
        layer: resource.importLayer ?? null,
        predeclaredLayers: resource.predeclaredLayers ?? Object.freeze([])
      });
      authorSources += 1;
      authorBytes += resource.bytes.byteLength;
      return true;
    };
    if (reference.kind === "embedded") {
      for (const resource of dependencies) if (!addResource(resource)) return sources;
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
        media: null,
        mediaConditions: Object.freeze(reference.media === null ? [] : [reference.media]),
        supportsConditions: Object.freeze([]),
        layer: null,
        predeclaredLayers: Object.freeze([])
      });
      authorSources += 1;
      authorBytes += byteLength;
      continue;
    }
    for (const resource of dependencies) if (!addResource(resource)) return sources;
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
  inline: boolean,
  layer: string | null,
  layerOrder: number | null
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
    , layer
    , layerOrder
  };
  const entries = byProperty.get(property) ?? [];
  const sameBucket = entries.findIndex((entry) => entry.origin === next.origin
    && entry.important === next.important && entry.layer === next.layer);
  if (sameBucket < 0) entries.push(next);
  else {
    const current = entries[sameBucket];
    if (current !== undefined && outranks(next, current)) entries[sameBucket] = next;
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

function collectStyleNodes(input: ResolveStylesInput): {
  readonly elements: readonly DocumentNodeRef[];
  readonly totalNodes: number;
} {
  const nodes: DocumentNodeRef[] = [];
  const pending = [input.document.root];
  let totalNodes = 0;
  while (pending.length > 0) {
    input.signal?.throwIfAborted();
    const ref = pending.pop();
    if (ref === undefined) continue;
    totalNodes += 1;
    const node = input.document.node(ref);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
    if (node.kind !== "element") continue;
    nodes.push(ref);
  }
  return { elements: Object.freeze(nodes), totalNodes };
}

function implementationSupportsDeclaration(source: string): boolean {
  const parsed = parseDeclaration(source);
  if (!parsed.ok) return false;
  const property = canonicalProperty(parsed.value.name);
  if (property === null || !SUPPORTED_PROPERTIES.has(property)) return false;
  const validation = validateCssPropertyValue(parsed.value);
  if (validation.status !== "valid") return false;
  const value = cssValue(parsed.value).trim().toLowerCase();
  if (cssWide(value) !== null || value === "revert" || value === "revert-layer") return true;
  const keyword = (...values: readonly string[]): boolean => values.includes(value);
  const length = (allowAuto = false, allowNegative = false, allowNone = false): boolean =>
    parseLength(value, allowAuto, allowNegative, allowNone) !== null;
  const lengths = (allowAuto: boolean, allowNegative: boolean): boolean => {
    const parts = boxParts(value);
    return parts !== null && parts.every((part) => parseLength(part, allowAuto, allowNegative) !== null);
  };
  switch (property) {
    case "display": return parseDisplay(value, initialDisplay(false), null) !== null;
    case "visibility": return keyword("visible", "hidden", "collapse");
    case "white-space": return keyword("normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces");
    case "color":
    case "background-color": return parseColor(value, TRANSPARENT) !== undefined;
    case "background": return parseColor(value, TRANSPARENT) !== undefined;
    case "font-weight": return keyword("normal", "bold", "bolder", "lighter")
      || (/^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 1000);
    case "font-style": return value === "normal" || value === "italic" || value.startsWith("oblique");
    case "font-size": return length() || [
      "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large", "smaller", "larger"
    ].includes(value);
    case "line-height": return value === "normal" || length() || nonNegativeCssNumber(value) !== null;
    case "vertical-align": return length(false, true) || keyword(
      "baseline", "sub", "super", "top", "text-top", "middle", "bottom", "text-bottom"
    );
    case "text-decoration":
    case "text-decoration-line": return splitTopLevel(value, "space")?.every((part) =>
      ["none", "underline", "line-through"].includes(part)) === true;
    case "text-transform": return keyword("none", "uppercase", "lowercase", "capitalize");
    case "direction": return keyword("ltr", "rtl");
    case "unicode-bidi": return keyword("normal", "embed", "isolate", "bidi-override", "isolate-override", "plaintext");
    case "text-align": return keyword("start", "end", "left", "right", "center");
    case "text-indent": return length(false, true);
    case "line-break": return keyword("auto", "normal", "anywhere");
    case "word-break": return keyword("normal", "break-all", "keep-all", "break-word");
    case "overflow-wrap": return keyword("normal", "anywhere", "break-word");
    case "hyphens": return keyword("none", "manual");
    case "tab-size": return nonNegativeCssNumber(value) !== null;
    case "list-style":
    case "list-style-type": return splitTopLevel(value, "space")?.some((part) => [
      "none", "disc", "circle", "square", "decimal", "decimal-leading-zero", "lower-alpha", "upper-alpha"
    ].includes(part)) === true;
    case "margin": return lengths(true, true);
    case "margin-block":
    case "margin-inline": return (splitTopLevel(value, "space") ?? []).every((part) => parseLength(part, true, true) !== null)
      && (splitTopLevel(value, "space")?.length ?? 0) >= 1 && (splitTopLevel(value, "space")?.length ?? 0) <= 2;
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left":
    case "margin-block-start":
    case "margin-block-end":
    case "margin-inline-start":
    case "margin-inline-end": return length(true, true);
    case "padding": return lengths(false, false);
    case "padding-block":
    case "padding-inline": return (splitTopLevel(value, "space") ?? []).every((part) => parseLength(part, false) !== null)
      && (splitTopLevel(value, "space")?.length ?? 0) >= 1 && (splitTopLevel(value, "space")?.length ?? 0) <= 2;
    case "padding-top":
    case "padding-right":
    case "padding-bottom":
    case "padding-left":
    case "padding-block-start":
    case "padding-block-end":
    case "padding-inline-start":
    case "padding-inline-end": return length();
    case "width":
    case "min-width":
    case "height":
    case "min-height": return length(true);
    case "max-width":
    case "max-height": return length(true, false, true);
    case "box-sizing": return keyword("content-box", "border-box");
    case "gap": return (splitTopLevel(value, "space") ?? []).every((part) => parseLength(part, false) !== null)
      && (splitTopLevel(value, "space")?.length ?? 0) >= 1 && (splitTopLevel(value, "space")?.length ?? 0) <= 2;
    case "row-gap":
    case "column-gap": return length();
    case "flex": return parseFlexShorthand(value) !== null;
    case "flex-grow":
    case "flex-shrink": return nonNegativeCssNumber(value) !== null;
    case "flex-basis": return value === "content" || length(true);
    case "order": return /^[-+]?\d+$/u.test(value) && Number.isSafeInteger(Number(value));
    case "flex-direction": return keyword("row", "row-reverse", "column", "column-reverse");
    case "flex-wrap": return keyword("nowrap", "wrap", "wrap-reverse");
    case "justify-content": return keyword(
      "start", "flex-start", "center", "end", "flex-end", "space-between", "space-around", "space-evenly"
    );
    case "align-items": return keyword("start", "flex-start", "center", "end", "flex-end", "stretch", "baseline");
    case "align-self": return keyword("auto", "start", "flex-start", "center", "end", "flex-end", "stretch", "baseline");
    case "align-content": return keyword(
      "start", "flex-start", "center", "end", "flex-end", "stretch", "space-between", "space-around", "space-evenly"
    );
    case "grid-template-columns": return parseGridTracks(value) !== null;
    case "grid-column": return /^\d+$/u.test(value) && Number(value) >= 1;
    case "border": {
      const parts = splitTopLevel(value, "space");
      return parts !== null && parts.length > 0 && parts.every((part) =>
        parseBorderWidth(part) !== null || part === "none" || part === "solid"
        || parseColor(part, TRANSPARENT) !== undefined);
    }
    case "border-width": return (splitTopLevel(value, "space") ?? []).length >= 1
      && (splitTopLevel(value, "space")?.length ?? 0) <= 4
      && (splitTopLevel(value, "space") ?? []).every((part) => parseBorderWidth(part) !== null);
    case "border-top-width":
    case "border-right-width":
    case "border-bottom-width":
    case "border-left-width": return parseBorderWidth(value) !== null;
    case "border-style": return keyword("none", "solid");
    case "border-color": return parseColor(value, TRANSPARENT) !== undefined;
    case "overflow":
    case "overflow-x":
    case "overflow-y": return keyword("visible", "hidden", "clip");
    case "position": return keyword("static", "relative", "absolute", "fixed", "sticky");
    case "top":
    case "right":
    case "bottom":
    case "left":
    case "inset-block-start":
    case "inset-block-end":
    case "inset-inline-start":
    case "inset-inline-end": return length(true, true);
    case "inset": return lengths(true, true);
    case "inset-block":
    case "inset-inline": return (splitTopLevel(value, "space") ?? []).every((part) => parseLength(part, true, true) !== null)
      && (splitTopLevel(value, "space")?.length ?? 0) >= 1 && (splitTopLevel(value, "space")?.length ?? 0) <= 2;
    case "z-index": return value === "auto" || /^[-+]?\d+$/u.test(value);
    case "float": return keyword("none", "left", "right", "inline-start", "inline-end");
    case "clear": return keyword("none", "left", "right", "both", "inline-start", "inline-end");
    case "clip": return parseLegacyClip(value) !== null;
    case "clip-path": return parseClipPath(value) !== null;
    case "content": return value === "none" || value === "normal"
      || parseComponentValues(value).ok;
    default: return false;
  }
}

function supportsCondition(values: readonly ComponentValue[]): boolean {
  const compact = values.filter((value) => value.kind !== "whitespace");
  if (compact[0]?.kind === "ident" && compact[0].value.toLowerCase() === "not") {
    return !supportsCondition(compact.slice(1));
  }
  let operator: "and" | "or" | null = null;
  const groups: ComponentValue[][] = [[]];
  for (const value of compact) {
    if (value.kind === "ident" && (value.value.toLowerCase() === "and" || value.value.toLowerCase() === "or")) {
      const next = value.value.toLowerCase() as "and" | "or";
      if (operator !== null && operator !== next) return false;
      operator = next;
      groups.push([]);
    } else groups.at(-1)?.push(value);
  }
  if (groups.length > 1) {
    const results = groups.map((group) => supportsCondition(group));
    return operator === "and" ? results.every(Boolean) : results.some(Boolean);
  }
  if (compact.length !== 1) return false;
  const condition = compact[0];
  if (condition?.kind === "simple-block" && condition.associatedToken === "open-paren") {
    const declaration = serializeCssComponentValues(condition.value).trim();
    return declaration.includes(":")
      ? implementationSupportsDeclaration(declaration)
      : supportsCondition(condition.value);
  }
  if (condition?.kind === "function-block" && condition.name.toLowerCase() === "selector") {
    return parseSelectorList(serializeCssComponentValues(condition.value)).ok;
  }
  return false;
}

function serializedSupportsConditionApplies(value: string): boolean {
  const parsed = parseComponentValues(`(${value})`);
  return parsed.ok && supportsCondition(parsed.value);
}

function collectCandidates(
  input: ResolveStylesInput,
  sources: readonly StylesheetSource[],
  styleNodes: readonly DocumentNodeRef[],
  totalNodes: number,
  limits: StyleBudgets,
  diagnostics: DiagnosticCollector,
  truncate: (budget: keyof StyleBudgets) => void
): CandidateMap {
  const candidates: CandidateMap = new Map();
  const eligible = new Set(styleNodes);
  const environment = selectorEnvironment(input);
  const root = input.document.node(input.document.root);
  let sourceOrder = 0;
  let stylesheetOrdinal = 0;
  let queryCount = 0;
  let selectorSteps = 0;
  let exhausted = false;
  const layerOrders = new Map<string, number>();
  const registerLayer = (name: string): number => {
    const current = layerOrders.get(name);
    if (current !== undefined) return current;
    const order = layerOrders.size;
    layerOrders.set(name, order);
    return order;
  };
  const selectorExhaustion = new Set<"maxSelectorQueries" | "maxSelectorSteps">();
  for (const source of sources) {
    if (selectorExhaustion.size > 0) break;
    if (!source.mediaConditions.every((condition) => mediaApplies(condition, input, diagnostics, source.sourceUrl))) continue;
    if (!source.supportsConditions.every(serializedSupportsConditionApplies)) continue;
    if (!mediaApplies(source.media, input, diagnostics, source.sourceUrl)) continue;
    for (const layer of source.predeclaredLayers) registerLayer(layer);
    const sourceLayer = source.layer;
    if (sourceLayer !== null) registerLayer(sourceLayer);
    const sourceOrdinal = stylesheetOrdinal++;
    let anonymousLayer = 0;
    const visitRules = (rules: readonly CssRule[], inheritedLayer: string | null): void => {
      for (const rule of rules) {
        if (exhausted) return;
        input.signal?.throwIfAborted();
        if (rule.kind === "at-rule") {
          const name = rule.name.toLowerCase();
          if (name === "namespace" || name === "charset" || name === "import") continue;
          if (name === "media" && rule.block !== null) {
            const media = serializeCssComponentValues(rule.prelude).trim();
            if (mediaApplies(media, input, diagnostics, source.sourceUrl)) {
              visitRules(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"), inheritedLayer);
            }
          } else if (name === "supports" && rule.block !== null) {
            if (supportsCondition(rule.prelude)) {
              visitRules(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"), inheritedLayer);
            }
          } else if (name === "layer") {
            const rawNames = splitCssComponentValues(serializeCssComponentValues(rule.prelude), "comma") ?? [];
            if (rule.block === null) {
              for (const raw of rawNames) registerLayer(inheritedLayer === null ? raw : `${inheritedLayer}.${raw}`);
            } else {
              const local = rawNames[0]
                ?? `__anonymous_${String(sourceOrdinal)}_${String(anonymousLayer++)}`;
              const layer = inheritedLayer === null ? local : `${inheritedLayer}.${local}`;
              registerLayer(layer);
              visitRules(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"), layer);
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
            const authorRule = source.origin === "author";
            if (authorRule && queryCount >= limits.maxSelectorQueries) {
              truncate("maxSelectorQueries");
              selectorExhaustion.add("maxSelectorQueries");
              exhausted = true;
              break;
            }
            if (authorRule && selectorSteps >= limits.maxSelectorSteps) {
              truncate("maxSelectorSteps");
              selectorExhaustion.add("maxSelectorSteps");
              exhausted = true;
              break;
            }
            if (authorRule) queryCount += 1;
            try {
              const baselineSteps = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, totalNodes * 128));
              const result = querySelectorList(selectorListFor(selector, parsed.value), root, environment, {
                limits: {
                  maxNodes: authorRule ? limits.maxSelectorSteps : Math.max(1, totalNodes),
                  maxDepth: authorRule ? 2_048 : Math.max(1, totalNodes),
                  maxSteps: authorRule ? limits.maxSelectorSteps - selectorSteps : baselineSteps
                },
                ...(input.signal === undefined ? {} : { signal: input.signal })
              });
              if (authorRule) selectorSteps += result.usage.steps;
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
              if (authorRule && error !== null && typeof error === "object" && "code" in error
                && error.code === "CSS_RESOURCE_LIMIT_EXCEEDED") {
                truncate("maxSelectorSteps");
                selectorExhaustion.add("maxSelectorSteps");
                exhausted = true;
                break;
              }
              if (!authorRule) throw new Error("The built-in user-agent stylesheet exceeded its fixed evaluation bound.", {
                cause: error
              });
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
              recordCandidate(
                candidates, styleKey(ref, pseudo), declaration, source, specificity, sourceOrder, false,
                inheritedLayer, inheritedLayer === null ? null : registerLayer(inheritedLayer)
              );
            }
          }
        }
      }
    };
    visitRules(source.stylesheet.rules, sourceLayer);
  }

  const inlineSource: StylesheetSource = {
    sourceUrl: "inline-style",
    origin: "author",
    stylesheet: sources[0]?.stylesheet ?? (() => { throw new Error("Missing UA stylesheet"); })(),
    media: null,
    mediaConditions: Object.freeze([]),
    supportsConditions: Object.freeze([]),
    layer: null,
    predeclaredLayers: Object.freeze([])
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
      recordCandidate(
        candidates, styleKey(ref), item, inlineSource, { a: 1, b: 0, c: 0 }, sourceOrder, true,
        null, null
      );
    }
  }
  return candidates;
}

function cssValue(declaration: CssDeclaration): string {
  return serializeCssComponentValues(declaration.value).trim();
}

function cssWide(value: string): "initial" | "inherit" | "unset" | "revert" | "revert-layer" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "initial" || normalized === "inherit" || normalized === "unset") return normalized;
  if (normalized === "revert" || normalized === "revert-layer") return normalized;
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
    const wide = cssWide(cssValue(candidate.declaration));
    if (wide !== "revert" && wide !== "revert-layer") return candidate;
    remaining = wide === "revert"
      ? remaining.filter((entry) => entry.origin !== candidate.origin)
      : remaining.filter((entry) => entry.origin !== candidate.origin || entry.layer !== candidate.layer);
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
    const resolved = resolveCssVariables(value, result);
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
      const candidateValue = resolveCssVariables(cssValue(candidate.declaration), variables);
      if (candidateValue === null) {
        diagnostics.add("property-invalid", candidate.sourceUrl, `Unresolved custom property in ${property}.`);
        break;
      }
      const wide = cssWide(candidateValue);
      if (wide === "revert" || wide === "revert-layer") {
        entries = wide === "revert"
          ? entries.filter((entry) => entry.origin !== candidate.origin)
          : entries.filter((entry) => entry.origin !== candidate.origin || entry.layer !== candidate.layer);
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

function initialStyle(parent: ComputedStyle | null, replaced: boolean, htmlDirection: "ltr" | "rtl" | null): ComputedStyle {
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
      direction: htmlDirection ?? parent?.text.direction ?? "ltr",
      unicodeBidi: "normal",
      textAlign: parent?.text.textAlign ?? "start",
      lineBreak: parent?.text.lineBreak ?? "auto",
      wordBreak: parent?.text.wordBreak ?? "normal",
      overflowWrap: parent?.text.overflowWrap ?? "normal",
      hyphens: parent?.text.hyphens ?? "manual",
      tabSize: parent?.text.tabSize ?? 8,
      textIndent: parent?.text.textIndent ?? ZERO,
      fontSize: parent?.text.fontSize ?? Object.freeze({ kind: "length", value: 16, unit: "px" }),
      lineHeight: parent?.text.lineHeight ?? Object.freeze({ kind: "normal" }),
      verticalAlign: Object.freeze({ kind: "keyword", value: "baseline" })
    },
    box: {
      margin: edges(),
      padding: edges(),
      width: AUTO,
      minWidth: AUTO,
      maxWidth: NONE,
      height: AUTO,
      minHeight: AUTO,
      maxHeight: NONE,
      boxSizing: "content-box",
      rowGap: ZERO,
      columnGap: ZERO,
      borderStyle: "none",
      borderWidths: edges(MEDIUM_BORDER),
      borderColor: null,
      flexDirection: "row",
      flexWrap: "nowrap",
      flexGrow: 0,
      flexShrink: 1,
      flexBasis: AUTO,
      order: 0,
      justifyContent: "start",
      alignItems: "stretch",
      alignSelf: "auto",
      alignContent: "stretch",
      position: "static",
      inset: edges(AUTO),
      zIndex: null,
      float: "none",
      clear: "none",
      legacyClip: { kind: "auto" },
      clipPath: { kind: "none" },
      gridTemplateColumns: [],
      gridColumn: null,
      overflowX: "visible",
      overflowY: "visible"
    },
    generatedContent: null,
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
  return parseCssLength(value, { allowAuto, allowNegative, allowNone });
}

function evaluateComputedMath(
  expression: CssMathExpression,
  basis: number,
  parentPx: number,
  rootPx: number,
  viewportWidth: number,
  viewportHeight: number
): number | null {
  if (expression.kind === "value") {
    if (!Number.isFinite(expression.value)) return null;
    if (expression.unit === "number" || expression.unit === "px") return expression.value;
    if (expression.unit === "%") return basis * expression.value / 100;
    if (expression.unit === "em") return parentPx * expression.value;
    if (expression.unit === "rem") return rootPx * expression.value;
    if (expression.unit === "ch") return parentPx * 0.5 * expression.value;
    if (expression.unit === "vw") return viewportWidth * expression.value / 100;
    return viewportHeight * expression.value / 100;
  }
  if (expression.kind === "negate") {
    const result = evaluateComputedMath(expression.value, basis, parentPx, rootPx, viewportWidth, viewportHeight);
    return result === null ? null : -result;
  }
  if (expression.kind === "sum") {
    const left = evaluateComputedMath(expression.left, basis, parentPx, rootPx, viewportWidth, viewportHeight);
    const right = evaluateComputedMath(expression.right, basis, parentPx, rootPx, viewportWidth, viewportHeight);
    return left === null || right === null ? null : left + right;
  }
  if (expression.kind === "product") {
    const result = evaluateComputedMath(expression.value, basis, parentPx, rootPx, viewportWidth, viewportHeight);
    return result === null ? null : result * expression.factor;
  }
  if (expression.kind === "minimum" || expression.kind === "maximum") {
    let result: number | null = null;
    for (const value of expression.values) {
      const candidate = evaluateComputedMath(value, basis, parentPx, rootPx, viewportWidth, viewportHeight);
      if (candidate === null) return null;
      result = result === null ? candidate
        : expression.kind === "minimum" ? Math.min(result, candidate) : Math.max(result, candidate);
    }
    return result;
  }
  const minimum = evaluateComputedMath(expression.minimum, basis, parentPx, rootPx, viewportWidth, viewportHeight);
  const preferred = evaluateComputedMath(expression.preferred, basis, parentPx, rootPx, viewportWidth, viewportHeight);
  const maximum = evaluateComputedMath(expression.maximum, basis, parentPx, rootPx, viewportWidth, viewportHeight);
  return minimum === null || preferred === null || maximum === null
    ? null : Math.max(minimum, Math.min(preferred, maximum));
}

function absoluteFontSize(
  value: CssLength,
  parentPx: number,
  rootPx: number,
  environment: ResolveStylesInput["environment"]
): CssLength | null {
  if (value.kind === "zero") return value;
  if (value.kind === "auto" || value.kind === "none") return null;
  const pixels = value.kind === "calculation"
    ? evaluateComputedMath(
        value.expression, parentPx, parentPx, rootPx,
        environment.viewportWidthCssPx, environment.viewportHeightCssPx
      )
    : value.unit === "px" ? value.value
      : value.unit === "em" || value.unit === "%" ? parentPx * value.value / (value.unit === "%" ? 100 : 1)
        : value.unit === "rem" ? rootPx * value.value
          : value.unit === "ch" ? parentPx * 0.5 * value.value
            : value.unit === "vw" ? environment.viewportWidthCssPx * value.value / 100
              : environment.viewportHeightCssPx * value.value / 100;
  return pixels === null || !Number.isFinite(pixels) || pixels < 0
    ? null
    : Object.freeze({ kind: "length", value: pixels, unit: "px" });
}

function fontSizePixels(style: ComputedStyle | null): number {
  const size = style?.text.fontSize;
  return size?.kind === "length" && size.unit === "px" ? size.value : 16;
}

function parseBorderWidth(value: string): CssLength | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "thin") return Object.freeze({ kind: "length", value: 1, unit: "px" });
  if (normalized === "medium") return MEDIUM_BORDER;
  if (normalized === "thick") return Object.freeze({ kind: "length", value: 5, unit: "px" });
  return parseLength(normalized, false);
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
      inset: edge(style.box.inset),
      borderWidths: edge(style.box.borderWidths),
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
  return splitCssComponentValues(value, separator);
}

function nonNegativeCssNumber(value: string): number | null {
  const parsed = parseComponentValues(value);
  if (!parsed.ok) return null;
  const components = parsed.value.filter((component) => component.kind !== "whitespace");
  const number = components.length === 1 && components[0]?.kind === "number"
    ? components[0].value : Number.NaN;
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
}

interface FlexShorthandValue {
  readonly grow: number;
  readonly shrink: number;
  readonly basis: CssFlexBasis;
}

function parseFlexShorthand(value: string): FlexShorthandValue | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return { grow: 0, shrink: 0, basis: AUTO };
  if (normalized === "auto") return { grow: 1, shrink: 1, basis: AUTO };
  if (normalized === "initial") return { grow: 0, shrink: 1, basis: AUTO };
  const parts = splitTopLevel(normalized, "space");
  if (parts === null || parts.length < 1 || parts.length > 3) return null;
  const numbers: number[] = [];
  let basis: CssFlexBasis | null = null;
  for (const part of parts) {
    const number = nonNegativeCssNumber(part);
    if (number !== null && numbers.length < 2 && basis === null) {
      numbers.push(number);
      continue;
    }
    if (basis !== null) return null;
    basis = part === "content" ? Object.freeze({ kind: "content" }) : parseLength(part, true, false);
    if (basis === null) return null;
  }
  if (numbers.length === 0 && basis !== null) return { grow: 1, shrink: 1, basis };
  if (numbers.length === 0) return null;
  return {
    grow: numbers[0] ?? 1,
    shrink: numbers[1] ?? 1,
    basis: basis ?? Object.freeze({ kind: "length", value: 0, unit: "%" })
  };
}

function parseGridBreadth(token: string): CssGridBreadth | null {
  const parsed = parseComponentValues(token);
  if (!parsed.ok) return null;
  const values = parsed.value.filter((value) => value.kind !== "whitespace");
  const component = values.length === 1 ? values[0] : undefined;
  if (component?.kind === "ident" && component.value.toLowerCase() === "auto") return { kind: "auto" };
  if (component?.kind === "dimension" && component.unit.toLowerCase() === "fr") {
    return Number.isFinite(component.value) && component.value > 0
      ? { kind: "fraction", value: component.value } : null;
  }
  const length = parseLength(token, false);
  return length === null ? null : { kind: "length", value: length };
}

function parseGridTrack(token: string): CssGridTrack | null {
  const parsed = parseComponentValues(token);
  if (!parsed.ok) return null;
  const values = parsed.value.filter((value) => value.kind !== "whitespace");
  const component = values.length === 1 ? values[0] : undefined;
  if (component?.kind === "function-block" && component.name.toLowerCase() === "minmax") {
    const parts = splitTopLevel(serializeCssComponentValues(component.value), "comma");
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
    const parsed = parseComponentValues(token);
    const values = parsed.ok ? parsed.value.filter((value) => value.kind !== "whitespace") : [];
    const component = values.length === 1 ? values[0] : undefined;
    if (component?.kind === "function-block" && component.name.toLowerCase() === "repeat") {
      const comma = component.value.findIndex((value) => value.kind === "comma");
      const prefix = component.value.slice(0, comma).filter((value) => value.kind !== "whitespace");
      const count = prefix.length === 1 && prefix[0]?.kind === "number" ? prefix[0].value : Number.NaN;
      const repeated = comma < 0 ? null : parseGridTracks(
        serializeCssComponentValues(component.value.slice(comma + 1)),
        nestingDepth + 1
      );
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
  const parsed = parseComponentValues(normalized);
  if (!parsed.ok) return null;
  const components = parsed.value.filter((component) => component.kind !== "whitespace");
  const rectangle = components.length === 1 && components[0]?.kind === "function-block"
    && components[0].name.toLowerCase() === "rect" ? components[0] : null;
  if (rectangle === null) return null;
  const serialized = serializeCssComponentValues(rectangle.value);
  const parts = splitTopLevel(serialized, rectangle.value.some((component) => component.kind === "comma") ? "comma" : "space");
  if (parts === null) return null;
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
  const parsed = parseComponentValues(normalized);
  if (!parsed.ok) return null;
  const components = parsed.value.filter((component) => component.kind !== "whitespace");
  const inset = components.length === 1 && components[0]?.kind === "function-block"
    && components[0].name.toLowerCase() === "inset" ? components[0] : null;
  if (inset === null || inset.value.some((component) =>
    component.kind === "ident" && component.value.toLowerCase() === "round")) return null;
  const sides = fourSides(splitTopLevel(serializeCssComponentValues(inset.value), "space") ?? []);
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
  const parts = splitTopLevel(value.trim(), "space");
  if (parts === null) return null;
  if (parts.length < 1 || parts.length > 4) return null;
  if (parts.length === 1) return [parts[0] ?? "0", parts[0] ?? "0", parts[0] ?? "0", parts[0] ?? "0"];
  if (parts.length === 2) return [parts[0] ?? "0", parts[1] ?? "0", parts[0] ?? "0", parts[1] ?? "0"];
  if (parts.length === 3) return [parts[0] ?? "0", parts[1] ?? "0", parts[2] ?? "0", parts[1] ?? "0"];
  return parts;
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
  return parseCssFunctionalColor(value) ?? NAMED_COLORS[normalized];
}

function colorFromComponentValues(value: string, current: CssColor | null): CssColor | null | undefined {
  const direct = parseColor(value, current);
  if (direct !== undefined) return direct;
  const parsed = parseComponentValues(value);
  if (!parsed.ok) return undefined;
  for (const component of parsed.value) {
    if (component.kind === "whitespace" || component.kind === "comma") continue;
    const candidate = parseColor(serializeCssComponentValues([component]), current);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function generatedContent(value: string, document: IndexedWebDocumentSnapshot, node: DocumentNodeRef): string | null | undefined {
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
  document: IndexedWebDocumentSnapshot,
  state: DocumentState,
  environment: ResolveStylesInput["environment"],
  node: DocumentNodeRef,
  parent: ComputedStyle | null,
  candidates: ReadonlyMap<string, readonly CascadeCandidate[]> | undefined,
  diagnostics: DiagnosticCollector,
  pseudo: PseudoElementIdentity | null = null,
  rootFontSizePx = 16
): ComputedStyle {
  const replaced = document.replaced(node) !== null || document.control(node) !== null;
  const htmlDirectionality = pseudo === null ? document.directionality(node) : null;
  let htmlDirection = htmlDirectionality !== null && htmlDirectionality.source !== "inherited"
    ? htmlDirectionality.direction : null;
  const control = pseudo === null ? document.control(node) : null;
  if (htmlDirectionality?.htmlMode === "auto" && (control?.kind === "text" || control?.kind === "textarea")) {
    const currentValue = state.controls.get(control.node)?.values[0] ?? control.defaultValue;
    htmlDirection = document.directionForRenderedText(node, currentValue);
  }
  let style = initialStyle(parent, replaced, htmlDirection);
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
  const direction = value("direction");
  if (direction !== null) {
    const computed = resolvedWide("direction", direction.value, "ltr", parent?.text.direction ?? null);
    if (computed === "ltr" || computed === "rtl") style = { ...style, text: { ...style.text, direction: computed } };
    else unsupported(direction);
  }
  const unicodeBidi = value("unicode-bidi");
  if (unicodeBidi !== null) {
    const computed = resolvedWide("unicode-bidi", unicodeBidi.value, "normal", parent?.text.unicodeBidi ?? null);
    if (["normal", "embed", "isolate", "bidi-override", "isolate-override", "plaintext"].includes(computed)) {
      style = { ...style, text: { ...style.text, unicodeBidi: computed as ComputedStyle["text"]["unicodeBidi"] } };
    } else unsupported(unicodeBidi);
  }
  const textAlign = value("text-align");
  if (textAlign !== null) {
    const computed = resolvedWide("text-align", textAlign.value, "start", parent?.text.textAlign ?? null);
    if (computed === "start" || computed === "end" || computed === "left" || computed === "center" || computed === "right") {
      style = { ...style, text: { ...style.text, textAlign: computed } };
    } else unsupported(textAlign);
  }
  const keyword = <T extends string>(
    property: "line-break" | "word-break" | "overflow-wrap" | "hyphens",
    initial: T,
    inherited: T,
    supported: readonly T[]
  ): T => {
    const entry = value(property);
    if (entry === null) return inherited;
    const computed = resolvedWide(property, entry.value, initial, inherited);
    if (supported.includes(computed as T)) return computed as T;
    unsupported(entry);
    return inherited;
  };
  style = {
    ...style,
    text: {
      ...style.text,
      lineBreak: keyword("line-break", "auto", style.text.lineBreak, ["auto", "normal", "anywhere"]),
      wordBreak: keyword("word-break", "normal", style.text.wordBreak, ["normal", "break-all", "keep-all", "break-word"]),
      overflowWrap: keyword("overflow-wrap", "normal", style.text.overflowWrap, ["normal", "anywhere", "break-word"]),
      hyphens: keyword("hyphens", "manual", style.text.hyphens, ["none", "manual"])
    }
  };
  const tabSize = value("tab-size");
  if (tabSize !== null) {
    const wide = cssWide(tabSize.value);
    const inherited = parent?.text.tabSize ?? 8;
    const normalized = tabSize.value.trim().toLowerCase();
    const parsed = /^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized) ? Number(normalized) : Number.NaN;
    const computed = wide === "inherit" || wide === "unset" ? inherited
      : wide === "initial" ? 8
        : Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    if (computed === null) unsupported(tabSize);
    else style = { ...style, text: { ...style.text, tabSize: computed } };
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
    const computed = wide === "inherit"
      ? parent?.text.background ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : colorFromComponentValues(background.value, style.text.color);
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
  const fontSize = value("font-size");
  if (fontSize !== null) {
    const parentPx = fontSizePixels(parent);
    const wide = cssWide(fontSize.value);
    const keywords: Readonly<Record<string, number>> = {
      "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18,
      "x-large": 24, "xx-large": 32, "xxx-large": 48,
      smaller: parentPx / 1.2, larger: parentPx * 1.2
    };
    const normalized = fontSize.value.trim().toLowerCase();
    const specified = wide === "inherit" || wide === "unset"
      ? parent?.text.fontSize ?? Object.freeze({ kind: "length", value: 16, unit: "px" } as const)
      : wide === "initial"
        ? Object.freeze({ kind: "length", value: 16, unit: "px" } as const)
        : keywords[normalized] === undefined
          ? parseLength(normalized, false)
          : Object.freeze({ kind: "length", value: keywords[normalized], unit: "px" } as const);
    const computed = specified === null ? null : absoluteFontSize(specified, parentPx, rootFontSizePx, environment);
    if (computed === null) unsupported(fontSize);
    else style = { ...style, text: { ...style.text, fontSize: computed } };
  }
  const lineHeight = value("line-height");
  if (lineHeight !== null) {
    const wide = cssWide(lineHeight.value);
    const normalized = lineHeight.value.trim().toLowerCase();
    const inherited = parent?.text.lineHeight ?? Object.freeze({ kind: "normal" } as const);
    let computed: ComputedStyle["text"]["lineHeight"] | null = null;
    if (wide === "inherit" || wide === "unset") computed = inherited;
    else if (wide === "initial" || normalized === "normal") computed = Object.freeze({ kind: "normal" });
    else if (/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized)) {
      const number = Number(normalized);
      if (Number.isFinite(number)) computed = Object.freeze({ kind: "number", value: number });
    } else {
      const parsed = parseLength(normalized, false);
      if (parsed !== null) {
        const absolute = parsed.kind === "length" && parsed.unit === "%"
          ? Object.freeze({ kind: "length", value: fontSizePixels(style) * parsed.value / 100, unit: "px" } as const)
          : parsed.kind === "length" && parsed.unit === "em"
            ? Object.freeze({ kind: "length", value: fontSizePixels(style) * parsed.value, unit: "px" } as const)
            : parsed;
        computed = Object.freeze({ kind: "length", value: absolute });
      }
    }
    if (computed === null) unsupported(lineHeight);
    else style = { ...style, text: { ...style.text, lineHeight: computed } };
  }
  const verticalAlign = value("vertical-align");
  if (verticalAlign !== null) {
    const wide = cssWide(verticalAlign.value);
    const normalized = verticalAlign.value.trim().toLowerCase();
    const keywords = ["baseline", "sub", "super", "top", "text-top", "middle", "bottom", "text-bottom"] as const;
    const computed = wide === "inherit"
      ? parent?.text.verticalAlign ?? Object.freeze({ kind: "keyword", value: "baseline" } as const)
      : wide === "initial" || wide === "unset"
        ? Object.freeze({ kind: "keyword", value: "baseline" } as const)
        : keywords.includes(normalized as typeof keywords[number])
          ? Object.freeze({ kind: "keyword", value: normalized as typeof keywords[number] } as const)
          : (() => {
              const length = parseLength(normalized, false, true);
              return length === null ? null : Object.freeze({ kind: "length", value: length } as const);
            })();
    if (computed === null) unsupported(verticalAlign);
    else style = { ...style, text: { ...style.text, verticalAlign: computed } };
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

  const directionIsRtl = style.text.direction === "rtl";
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
        const parts = splitTopLevel(entry.value, "space") ?? [];
        const logicalEnd = entry.property.endsWith("-block")
          ? side === "bottom"
          : directionIsRtl ? side === "left" : side === "right";
        return logicalEnd ? parts[1] ?? parts[0] : parts[0];
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
    ["min-height", "minHeight", true, false], ["max-height", "maxHeight", true, true]
  ] as const;
  for (const [property, field, allowAuto, allowNone] of dimensionSpecs) {
    const entry = value(property);
    if (entry === null) continue;
    const wide = cssWide(entry.value);
    const initial = field === "maxWidth" || field === "maxHeight" ? NONE : AUTO;
    const length = wide === "inherit"
      ? parent?.box[field] ?? initial
      : wide === "initial" || wide === "unset"
        ? initial
        : parseLength(entry.value, allowAuto, false, allowNone);
    if (length === null) unsupported(entry);
    else style = { ...style, box: { ...style.box, [field]: length } };
  }
  const boxSizing = value("box-sizing");
  if (boxSizing !== null) {
    const wide = cssWide(boxSizing.value);
    const computed = wide === "inherit"
      ? parent?.box.boxSizing ?? "content-box"
      : wide === "initial" || wide === "unset"
        ? "content-box"
        : boxSizing.value.trim().toLowerCase();
    if (computed === "content-box" || computed === "border-box") {
      style = { ...style, box: { ...style.box, boxSizing: computed } };
    } else unsupported(boxSizing);
  }
  const columnGap = value(["column-gap", "gap"]);
  const rowGap = value(["row-gap", "gap"]);
  if (columnGap !== null) {
    const gapParts = columnGap.property === "gap" ? splitTopLevel(columnGap.value, "space") : null;
    const part = columnGap.property === "gap" ? gapParts?.[1] ?? gapParts?.[0] : columnGap.value;
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
    const part = rowGap.property === "gap"
      ? splitTopLevel(rowGap.value, "space")?.[0] ?? "0"
      : rowGap.value;
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
  const flexNumber = (
    field: "flexGrow" | "flexShrink",
    property: "flex-grow" | "flex-shrink",
    initial: number
  ): void => {
    const entry = value([property, "flex"]);
    if (entry === null) return;
    const wide = cssWide(entry.value);
    let parsed: number | null = null;
    if (wide === "inherit") parsed = parent?.box[field] ?? initial;
    else if (wide === "initial" || wide === "unset") parsed = initial;
    else if (entry.property === "flex") {
      const shorthand = parseFlexShorthand(entry.value);
      parsed = shorthand === null ? null : field === "flexGrow" ? shorthand.grow : shorthand.shrink;
    } else {
      parsed = nonNegativeCssNumber(entry.value);
    }
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
      unsupported({ ...entry, property });
    }
    else style = { ...style, box: { ...style.box, [field]: parsed } };
  };
  flexNumber("flexGrow", "flex-grow", 0);
  flexNumber("flexShrink", "flex-shrink", 1);
  const flexBasis = value(["flex-basis", "flex"]);
  if (flexBasis !== null) {
    const wide = cssWide(flexBasis.value);
    let basis: CssFlexBasis | null;
    if (wide === "inherit") basis = parent?.box.flexBasis ?? AUTO;
    else if (wide === "initial" || wide === "unset") basis = AUTO;
    else if (flexBasis.property === "flex") {
      basis = parseFlexShorthand(flexBasis.value)?.basis ?? null;
    } else basis = flexBasis.value.trim().toLowerCase() === "content"
      ? Object.freeze({ kind: "content" }) : parseLength(flexBasis.value, true, false);
    if (basis === null) unsupported({ ...flexBasis, property: "flex-basis" });
    else style = { ...style, box: { ...style.box, flexBasis: basis } };
  }
  const order = value("order");
  if (order !== null) {
    const wide = cssWide(order.value);
    const parsed = wide === "inherit" ? parent?.box.order ?? 0
      : wide === "initial" || wide === "unset" ? 0
        : /^[-+]?\d+$/u.test(order.value.trim()) ? Number(order.value) : Number.NaN;
    if (!Number.isSafeInteger(parsed)) unsupported(order);
    else style = { ...style, box: { ...style.box, order: parsed } };
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
    if (computed === "start" || computed === "center" || computed === "end" || computed === "space-between"
      || computed === "space-around" || computed === "space-evenly") {
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
    if (computed === "start" || computed === "center" || computed === "end" || computed === "stretch" || computed === "baseline") {
      style = { ...style, box: { ...style.box, alignItems: computed } };
    } else unsupported(alignItems);
  }
  for (const [property, field, initial] of [
    ["align-self", "alignSelf", "auto"],
    ["align-content", "alignContent", "stretch"]
  ] as const) {
    const entry = value(property);
    if (entry === null) continue;
    const wide = cssWide(entry.value);
    const raw = wide === "inherit" ? parent?.box[field] ?? initial
      : wide === "initial" || wide === "unset" ? initial : entry.value.trim().toLowerCase();
    const computed = raw === "flex-start" ? "start" : raw === "flex-end" ? "end" : raw;
    const supported = field === "alignSelf"
      ? ["auto", "start", "center", "end", "stretch", "baseline"]
      : ["start", "center", "end", "stretch", "space-between", "space-around", "space-evenly"];
    if (!supported.includes(computed)) unsupported(entry);
    else style = { ...style, box: { ...style.box, [field]: computed } };
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
    const normalized = borderStyle.value.trim().toLowerCase();
    const computed: ComputedStyle["box"]["borderStyle"] | null = wide === "inherit"
      ? parent?.box.borderStyle ?? "none"
      : wide === "initial" || wide === "unset"
        ? "none"
        : /\bsolid\b/u.test(normalized)
          ? "solid"
          : /\b(?:double|dashed|dotted|groove|ridge|inset|outset)\b/u.test(normalized)
            ? null
            : "none";
    if (computed === null) unsupported(borderStyle);
    else style = { ...style, box: { ...style.box, borderStyle: computed } };
  }
  const borderWidthSides = [
    ["border-top-width", "top", 0], ["border-right-width", "right", 1],
    ["border-bottom-width", "bottom", 2], ["border-left-width", "left", 3]
  ] as const;
  for (const [property, side, index] of borderWidthSides) {
    const entry = value([property, "border-width", "border"]);
    if (entry === null) continue;
    const wide = cssWide(entry.value);
    let width: CssLength | null;
    if (wide === "inherit") width = parent?.box.borderWidths[side] ?? MEDIUM_BORDER;
    else if (wide === "initial" || wide === "unset") width = MEDIUM_BORDER;
    else if (entry.property === "border") {
      const token = splitTopLevel(entry.value, "space")?.find((part) => parseBorderWidth(part) !== null);
      width = token === undefined ? MEDIUM_BORDER : parseBorderWidth(token);
    } else if (entry.property === "border-width") {
      const parts = splitTopLevel(entry.value, "space") ?? [];
      const expanded = fourSides(parts);
      width = expanded === null ? null : parseBorderWidth(expanded[index]);
    } else width = parseBorderWidth(entry.value);
    if (width === null) unsupported({ ...entry, property });
    else style = {
      ...style,
      box: { ...style.box, borderWidths: { ...style.box.borderWidths, [side]: width } }
    };
  }
  const borderColor = value(["border-color", "border"]);
  if (borderColor !== null) {
    const wide = cssWide(borderColor.value);
    const color = wide === "inherit"
      ? parent?.box.borderColor ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : colorFromComponentValues(borderColor.value, style.text.color);
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
  const insetSpecs = [
    ["top", ["top", "inset-block-start", "inset-block", "inset"], "top", 0],
    ["right", ["right", directionIsRtl ? "inset-inline-start" : "inset-inline-end", "inset-inline", "inset"], "right", 1],
    ["bottom", ["bottom", "inset-block-end", "inset-block", "inset"], "bottom", 2],
    ["left", ["left", directionIsRtl ? "inset-inline-end" : "inset-inline-start", "inset-inline", "inset"], "left", 3]
  ] as const;
  for (const [property, names, side, index] of insetSpecs) {
    const entry = value(names);
    if (entry === null) continue;
    const wide = cssWide(entry.value);
    let inset: CssLength | null;
    if (wide === "inherit") inset = parent?.box.inset[side] ?? AUTO;
    else if (wide === "initial" || wide === "unset") inset = AUTO;
    else {
      const shorthand = entry.property === "inset";
      const axis = entry.property === "inset-block" || entry.property === "inset-inline";
      const raw = shorthand ? boxParts(entry.value)?.[index]
        : axis ? (() => {
          const parts = splitTopLevel(entry.value, "space") ?? [];
          const logicalEnd = entry.property === "inset-block"
            ? side === "bottom" : directionIsRtl ? side === "left" : side === "right";
          return logicalEnd ? parts[1] ?? parts[0] : parts[0];
        })() : entry.value;
      inset = raw === undefined ? null : parseLength(raw, true, true);
    }
    if (inset === null) unsupported({ ...entry, property });
    else style = { ...style, box: { ...style.box, inset: { ...style.box.inset, [side]: inset } } };
  }
  const zIndex = value("z-index");
  if (zIndex !== null) {
    const wide = cssWide(zIndex.value);
    const normalized = zIndex.value.trim().toLowerCase();
    const computed = wide === "inherit" ? parent?.box.zIndex ?? null
      : wide === "initial" || wide === "unset" || normalized === "auto" ? null
        : /^[-+]?\d+$/u.test(normalized) ? Number(normalized) : Number.NaN;
    if (computed !== null && !Number.isSafeInteger(computed)) unsupported(zIndex);
    else style = { ...style, box: { ...style.box, zIndex: computed } };
  }
  const float = value("float");
  if (float !== null) {
    const wide = cssWide(float.value);
    const normalized = wide === "inherit" ? parent?.box.float ?? "none"
      : wide === "initial" || wide === "unset" ? "none" : float.value.trim().toLowerCase();
    const computed = normalized === "inline-start" ? (directionIsRtl ? "right" : "left")
      : normalized === "inline-end" ? (directionIsRtl ? "left" : "right") : normalized;
    if (computed === "none" || computed === "left" || computed === "right") {
      style = { ...style, box: { ...style.box, float: computed } };
    } else unsupported(float);
  }
  const clear = value("clear");
  if (clear !== null) {
    const wide = cssWide(clear.value);
    const normalized = wide === "inherit" ? parent?.box.clear ?? "none"
      : wide === "initial" || wide === "unset" ? "none" : clear.value.trim().toLowerCase();
    const computed = normalized === "inline-start" ? (directionIsRtl ? "right" : "left")
      : normalized === "inline-end" ? (directionIsRtl ? "left" : "right") : normalized;
    if (computed === "none" || computed === "left" || computed === "right" || computed === "both") {
      style = { ...style, box: { ...style.box, clear: computed } };
    } else unsupported(clear);
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
      ? parent?.generatedContent ?? null
      : wide === "initial" || wide === "unset"
        ? null
        : generatedContent(content.value, document, node);
    if (computed === undefined) unsupported(content);
    else style = { ...style, generatedContent: computed };
  }
  if (style.display.box === "principal"
    && (style.box.position === "absolute" || style.box.position === "fixed" || style.box.float !== "none")) {
    style = {
      ...style,
      display: Object.freeze({
        ...style.display,
        outer: "block"
      })
    };
  }
  return immutableComputedStyle(style);
}

class ImmutableStyleSnapshot implements StyleSnapshot {
  readonly document: IndexedWebDocumentSnapshot;
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

  public pseudo(node: DocumentNodeRef, identity: PseudoElementIdentity): ComputedStyle | null {
    return this.#pseudos.get(styleKey(node, identity)) ?? null;
  }
}

export function resolveStyles(input: ResolveStylesInput): StyleSnapshot {
  const mediaType: unknown = input.environment.mediaType;
  const colorScheme: unknown = input.environment.prefersColorScheme;
  const reducedMotion: unknown = input.environment.reducedMotion;
  const hover: unknown = input.environment.hover;
  const pointer: unknown = input.environment.pointer;
  if (!Number.isFinite(input.environment.viewportWidthCssPx) || input.environment.viewportWidthCssPx <= 0
    || !Number.isFinite(input.environment.viewportHeightCssPx) || input.environment.viewportHeightCssPx <= 0
    || mediaType !== "screen"
    || (colorScheme !== "light" && colorScheme !== "dark")
    || typeof reducedMotion !== "boolean"
    || (hover !== "none" && hover !== "hover")
    || (pointer !== "none" && pointer !== "coarse" && pointer !== "fine")) {
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
  const styleNodes = collectStyleNodes(input);
  const sources = stylesheetSources(input, limits, diagnostics, truncate);
  const candidates = collectCandidates(
    input,
    sources,
    styleNodes.elements,
    styleNodes.totalNodes,
    limits,
    diagnostics,
    truncate
  );
  const styles = new Map<DocumentNodeRef, ComputedStyle>();
  const pseudos = new Map<string, ComputedStyle>();
  let computedNodes = 0;
  let rootFontSizePx = 16;
  for (const ref of styleNodes.elements) {
    input.signal?.throwIfAborted();
    const parentNode = input.document.parent(ref);
    const parentStyle = parentNode?.kind === "element" ? styles.get(parentNode.ref) ?? null : null;
    const style = computeStyle(
      input.document,
      input.state,
      input.environment,
      ref,
      parentStyle,
      candidates.get(styleKey(ref)),
      diagnostics,
      null,
      ref === input.document.documentElement ? 16 : rootFontSizePx
    );
    styles.set(ref, style);
    if (ref === input.document.documentElement) rootFontSizePx = fontSizePixels(style);
    for (const pseudo of ["before", "after", "marker"] as const) {
      const pseudoCandidates = candidates.get(styleKey(ref, pseudo));
      if (pseudoCandidates === undefined) continue;
      pseudos.set(styleKey(ref, pseudo), computeStyle(
        input.document,
        input.state,
        input.environment,
        ref,
        style,
        pseudoCandidates,
        diagnostics,
        pseudo,
        rootFontSizePx
      ));
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
