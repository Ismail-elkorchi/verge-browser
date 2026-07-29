import {
  parseBlockContents,
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
  type ComponentValue,
  type SelectorElementData,
  type SelectorEnvironment,
  type SelectorList,
  type SelectorSpecificity
} from "@ismail-elkorchi/css-parser";
import {
  getAttributeValue,
  hasAttribute,
  HTML_NAMESPACE_URI,
  MATHML_NAMESPACE_URI,
  SVG_NAMESPACE_URI,
  XLINK_NAMESPACE_URI,
  XML_NAMESPACE_URI,
  XMLNS_NAMESPACE_URI,
  type DocumentTree,
  type ElementNode,
  type HtmlNode
} from "@ismail-elkorchi/html-parser";

import type {
  PageBlockStyle,
  PageColor,
  PageStyleIssue,
  PageStylesheetResource,
  PageTextStyle,
  PageWhiteSpace
} from "./types.js";

type StyleTreeNode = DocumentTree | HtmlNode;

export type ComputedDisplay =
  | "none"
  | "contents"
  | "inline"
  | "block"
  | "list-item"
  | "table"
  | "flex"
  | "grid";
export type ComputedVisibility = "visible" | "hidden";
export type ComputedTextTransform = "none" | "uppercase" | "lowercase" | "capitalize";

export interface ComputedBoxLayout {
  readonly flexDirection: "row" | "column";
  readonly flexWrap: boolean;
  readonly justifyContent: "start" | "center" | "end" | "space-between";
  readonly alignItems: "start" | "center" | "end" | "stretch";
  readonly columnGapCells: number;
  readonly rowGapRows: number;
  readonly gridTemplateColumns?: string;
  readonly gridColumn?: number;
  readonly width?: string;
  readonly minWidth?: string;
  readonly maxWidth?: string;
  readonly minHeightRows: number;
  readonly marginInlineAuto: boolean;
  readonly borderColor?: PageColor;
  readonly border: boolean;
  readonly visuallyHidden: boolean;
}

export interface ComputedElementStyle {
  readonly display: ComputedDisplay;
  readonly visibility: ComputedVisibility;
  readonly textTransform: ComputedTextTransform;
  readonly listStyleType: string;
  readonly text: PageTextStyle;
  readonly block: PageBlockStyle;
  readonly box: ComputedBoxLayout;
  readonly customProperties: ReadonlyMap<string, readonly ComponentValue[]>;
}

export interface PageStyleResolution {
  readonly byElement: ReadonlyMap<ElementNode, ComputedElementStyle>;
  readonly issues: readonly PageStyleIssue[];
  readonly stylesheetCount: number;
}

interface StylesheetSource {
  readonly sourceUrl: string;
  readonly stylesheet: CssStylesheet;
  readonly media?: string;
}

interface CascadeCandidate {
  readonly declaration: CssDeclaration;
  readonly sourceUrl: string;
  readonly important: boolean;
  readonly inline: boolean;
  readonly specificity: SelectorSpecificity;
  readonly sourceOrder: number;
}

type CandidateMap = Map<ElementNode, Map<string, CascadeCandidate>>;

const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html",
  "main", "nav", "ol", "p", "pre", "section", "summary", "ul"
]);
const HTML_TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const NON_RENDERED_TAGS = new Set(["head", "link", "meta", "script", "style", "template", "title"]);
const BOLD_TAGS = new Set(["b", "strong", "h1", "h2", "h3", "h4", "h5", "h6", "th"]);
const ITALIC_TAGS = new Set(["address", "cite", "em", "i"]);
const STRIKETHROUGH_TAGS = new Set(["del", "s", "strike"]);
const SUPPORTED_PROPERTIES = new Set([
  "display",
  "visibility",
  "white-space",
  "color",
  "background",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-decoration-line",
  "text-transform",
  "text-align",
  "list-style",
  "list-style-type",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "text-indent",
  "width",
  "min-width",
  "max-width",
  "min-height",
  "gap",
  "row-gap",
  "column-gap",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "grid-column",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "overflow",
  "overflow-x",
  "overflow-y",
  "position",
  "clip",
  "clip-path",
  "height"
]);
const INHERITED_PROPERTIES = new Set([
  "visibility",
  "white-space",
  "color",
  "font-weight",
  "font-style",
  "text-transform",
  "text-align",
  "list-style",
  "list-style-type"
]);
const ASCII_INSENSITIVE_ATTRIBUTES = new Set([
  "align", "charset", "crossorigin", "dir", "draggable", "enctype", "formenctype",
  "frame", "hreflang", "http-equiv", "lang", "media", "method", "rel", "scope",
  "shape", "spellcheck", "target", "type", "wrap"
]);
const MAX_ISSUES = 128;
const MAX_ISSUES_PER_CODE = 32;

const NAMED_COLORS: Readonly<Record<string, PageColor>> = Object.freeze({
  aliceblue: { r: 240, g: 248, b: 255 },
  aqua: { r: 0, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  brown: { r: 165, g: 42, b: 42 },
  cyan: { r: 0, g: 255, b: 255 },
  darkgray: { r: 169, g: 169, b: 169 },
  darkgreen: { r: 0, g: 100, b: 0 },
  fuchsia: { r: 255, g: 0, b: 255 },
  gold: { r: 255, g: 215, b: 0 },
  gray: { r: 128, g: 128, b: 128 },
  green: { r: 0, g: 128, b: 0 },
  grey: { r: 128, g: 128, b: 128 },
  lightgray: { r: 211, g: 211, b: 211 },
  lime: { r: 0, g: 255, b: 0 },
  magenta: { r: 255, g: 0, b: 255 },
  maroon: { r: 128, g: 0, b: 0 },
  navy: { r: 0, g: 0, b: 128 },
  olive: { r: 128, g: 128, b: 0 },
  orange: { r: 255, g: 165, b: 0 },
  pink: { r: 255, g: 192, b: 203 },
  purple: { r: 128, g: 0, b: 128 },
  red: { r: 255, g: 0, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
  teal: { r: 0, g: 128, b: 128 },
  violet: { r: 238, g: 130, b: 238 },
  white: { r: 255, g: 255, b: 255 },
  yellow: { r: 255, g: 255, b: 0 }
});

class IssueCollector {
  readonly #issues: PageStyleIssue[] = [];
  readonly #indices = new Map<string, number>();
  readonly #countsByCode = new Map<PageStyleIssue["code"], number>();

  add(code: PageStyleIssue["code"], message: string, sourceUrl: string): void {
    const identity = `${code}\u0000${sourceUrl}\u0000${message}`;
    const existingIndex = this.#indices.get(identity);
    if (existingIndex !== undefined) {
      const existing = this.#issues[existingIndex];
      if (existing !== undefined) {
        this.#issues[existingIndex] = {
          ...existing,
          occurrences: existing.occurrences + 1
        };
      }
      return;
    }
    if (this.#issues.length >= MAX_ISSUES) return;
    const codeCount = this.#countsByCode.get(code) ?? 0;
    if (codeCount >= MAX_ISSUES_PER_CODE) return;
    this.#indices.set(identity, this.#issues.length);
    this.#countsByCode.set(code, codeCount + 1);
    this.#issues.push({ code, message, sourceUrl, occurrences: 1 });
  }

  values(): readonly PageStyleIssue[] {
    return this.#issues;
  }
}

function styleChildren(node: StyleTreeNode): readonly StyleTreeNode[] {
  if (node.kind === "document" || node.kind === "templateContent" || node.kind === "element") {
    return node.children;
  }
  return [];
}

function selectorEnvironment(): SelectorEnvironment<StyleTreeNode> {
  return {
    tree: {
      data(node) {
        if (node.kind === "element") {
          return {
            kind: "element",
            namespace: node.namespaceUri,
            localName: node.localName,
            attributes: node.attributes.map((attribute) => ({
              namespace: attribute.namespaceUri,
              localName: attribute.localName,
              value: attribute.value
            }))
          };
        }
        if (node.kind === "text") return { kind: "text", value: node.value };
        return { kind: "other" };
      },
      children: styleChildren
    },
    documentMode: { syntax: "html", quirks: "no-quirks" },
    defaultNamespace: { kind: "any" },
    idValues(_node, element) {
      return attributeValues(element, "id");
    },
    classNames(_node, element) {
      return attributeValues(element, "class").flatMap((value) => value.split(/\s+/u).filter(Boolean));
    },
    resolveNamespacePrefix(prefix) {
      const namespace = {
        html: HTML_NAMESPACE_URI,
        svg: SVG_NAMESPACE_URI,
        math: MATHML_NAMESPACE_URI,
        xlink: XLINK_NAMESPACE_URI,
        xml: XML_NAMESPACE_URI,
        xmlns: XMLNS_NAMESPACE_URI
      }[prefix.toLowerCase()];
      return namespace === undefined
        ? { status: "unknown" }
        : { status: "resolved", namespace };
    },
    attributeValueCaseSensitivity(_element, attribute) {
      return attribute.namespace === null
        && ASCII_INSENSITIVE_ATTRIBUTES.has(attribute.localName.toLowerCase())
        ? "ascii-insensitive"
        : "sensitive";
    },
    matchPseudoClass(node, pseudo) {
      if (pseudo.name === "link" || pseudo.name === "any-link") {
        return node.kind === "element"
          && (node.localName === "a" || node.localName === "area")
          && hasAttribute(node, "href")
          ? "match"
          : "no-match";
      }
      if (pseudo.name === "visited") return "no-match";
      if (
        pseudo.name === "hover"
        || pseudo.name === "active"
        || pseudo.name === "focus"
        || pseudo.name === "focus-visible"
        || pseudo.name === "focus-within"
      ) {
        return "no-match";
      }
      return "unknown";
    }
  };
}

function attributeValues(element: SelectorElementData, name: string): readonly string[] {
  return element.attributes
    .filter((attribute) =>
      attribute.namespace === null && attribute.localName.toLowerCase() === name
    )
    .map((attribute) => attribute.value);
}

function allElements(tree: DocumentTree): readonly ElementNode[] {
  const elements: ElementNode[] = [];
  const pending: StyleTreeNode[] = [...tree.children].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.kind === "element") elements.push(node);
    const children = styleChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
  return elements;
}

function textOfElement(node: ElementNode): string {
  const values: string[] = [];
  const pending: HtmlNode[] = [...node.children].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.kind === "text") values.push(current.value);
    else if (current.kind === "element" || current.kind === "templateContent") {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child) pending.push(child);
      }
    }
  }
  return values.join("");
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

/**
 * Returns whether a stylesheet can target a screen. Width-dependent conditions
 * remain fetchable because they are evaluated again during terminal layout.
 */
export function terminalMediaApplies(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return true;
  return splitMediaQueries(value).some((part) => {
    const normalized = part.trim().toLowerCase();
    if (normalized.startsWith("not ")) return true;
    return !/(?:^|\s)print(?:\s|$)/u.test(normalized)
      || /(?:^|\s)(?:all|screen)(?:\s|$)/u.test(normalized);
  });
}

function mediaLengthPx(value: string): number | null {
  const match = /^([+]?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|ch)$/iu.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "px") return number;
  if (unit === "ch") return number * 8;
  return number * 16;
}

function mediaFeatureApplies(feature: string, viewportWidthPx: number): boolean | null {
  const normalized = feature
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .trim()
    .toLowerCase();
  if (normalized === "prefers-reduced-motion"
    || normalized === "prefers-reduced-motion: reduce") {
    return true;
  }
  if (normalized === "hover:hover" || normalized === "hover: hover") return false;
  if (normalized.startsWith("min-resolution:")) return false;
  const legacy = /^(min-width|max-width|width)\s*:\s*(.+)$/u.exec(normalized);
  if (legacy?.[1] && legacy[2]) {
    const boundary = mediaLengthPx(legacy[2]);
    if (boundary === null) return null;
    if (legacy[1] === "min-width") return viewportWidthPx >= boundary;
    if (legacy[1] === "max-width") return viewportWidthPx <= boundary;
    return viewportWidthPx === boundary;
  }
  const range = /^width\s*(<=|>=|<|>)\s*(.+)$/u.exec(normalized);
  if (range?.[1] && range[2]) {
    const boundary = mediaLengthPx(range[2]);
    if (boundary === null) return null;
    if (range[1] === "<=") return viewportWidthPx <= boundary;
    if (range[1] === ">=") return viewportWidthPx >= boundary;
    if (range[1] === "<") return viewportWidthPx < boundary;
    return viewportWidthPx > boundary;
  }
  return null;
}

function mediaQueryApplies(
  value: string | undefined,
  columns: number,
  issues: IssueCollector,
  sourceUrl: string
): boolean {
  if (value === undefined || value.trim().length === 0) return true;
  const viewportWidthPx = Math.max(1, Math.floor(columns)) * 8;
  return splitMediaQueries(value).some((query) => {
    let normalized = query
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .trim()
      .toLowerCase();
    let negated = false;
    if (normalized.startsWith("not ")) {
      negated = true;
      normalized = normalized.slice(4).trim();
    }
    const mediaType = /^(all|screen|print)\b/u.exec(normalized)?.[1];
    if (mediaType !== undefined) {
      normalized = normalized.slice(mediaType.length).replace(/^\s*and\s*/u, "").trim();
    }
    let applies = mediaType !== "print";
    const features = [...normalized.matchAll(/\(([^()]*)\)/gu)].map((match) => match[1] ?? "");
    if (normalized.length > 0 && features.length === 0) {
      issues.add("stylesheet-media", `Unsupported media query ${query.trim()}.`, sourceUrl);
      applies = false;
    }
    for (const feature of features) {
      const featureResult = mediaFeatureApplies(feature, viewportWidthPx);
      if (featureResult === null) {
        issues.add("stylesheet-media", `Unsupported media feature (${feature.trim()}).`, sourceUrl);
        applies = false;
      } else {
        applies &&= featureResult;
      }
    }
    return negated ? !applies : applies;
  });
}

function stylesheetSources(
  tree: DocumentTree,
  resources: readonly PageStylesheetResource[],
  issues: IssueCollector,
  signal?: AbortSignal
): readonly StylesheetSource[] {
  const resourceByOwner = new Map(resources.map((resource) => [resource.ownerNodeId, resource]));
  const sources: StylesheetSource[] = [];
  for (const element of allElements(tree)) {
    signal?.throwIfAborted();
    const tag = element.localName.toLowerCase();
    if (tag === "style") {
      const media = getAttributeValue(element, "media");
      if (!terminalMediaApplies(media)) {
        issues.add("stylesheet-media", "Skipped a stylesheet whose media query does not target terminal rendering.", "inline");
        continue;
      }
      let parsed: ReturnType<typeof parseStylesheet>;
      try {
        parsed = parseStylesheet(textOfElement(element), {
          ...(signal === undefined ? {} : { signal })
        });
      } catch (error) {
        signal?.throwIfAborted();
        issues.add(
          "stylesheet-parse",
          error instanceof Error ? error.message : String(error),
          "inline"
        );
        continue;
      }
      if (!parsed.ok) {
        issues.add("stylesheet-parse", "Unable to parse an embedded stylesheet.", "inline");
        continue;
      }
      for (const error of parsed.errors) issues.add("stylesheet-parse", error.message, "inline");
      sources.push({
        sourceUrl: "inline",
        stylesheet: parsed.value,
        ...(media === undefined ? {} : { media })
      });
      continue;
    }
    if (tag !== "link") continue;
    const resource = resourceByOwner.get(element.id);
    if (!resource) continue;
    let parsed: ReturnType<typeof parseStylesheetBytes>;
    try {
      parsed = parseStylesheetBytes(resource.bytes, {
        ...(resource.transportEncodingLabel === undefined
          ? {}
          : { transportEncodingLabel: resource.transportEncodingLabel }),
        limits: {
          maxInputBytes: resource.bytes.byteLength,
          maxTokens: 200_000,
          maxNodes: 100_000,
          maxDepth: 128,
          maxSteps: 2_000_000
        },
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      signal?.throwIfAborted();
      issues.add(
        "stylesheet-parse",
        error instanceof Error ? error.message : String(error),
        resource.finalUrl
      );
      continue;
    }
    if (!parsed.ok) {
      issues.add("stylesheet-parse", "Unable to parse an external stylesheet.", resource.finalUrl);
      continue;
    }
    for (const error of parsed.errors) issues.add("stylesheet-parse", error.message, resource.finalUrl);
    sources.push({
      sourceUrl: resource.finalUrl,
      stylesheet: parsed.value,
      ...(resource.media === undefined ? {} : { media: resource.media })
    });
  }
  return sources;
}

function selectorListFor(selector: ComplexSelector, parsed: SelectorList): SelectorList {
  return {
    ...parsed,
    selectors: [selector]
  };
}

function compareSpecificity(left: SelectorSpecificity, right: SelectorSpecificity): number {
  return left.a - right.a || left.b - right.b || left.c - right.c;
}

function outranks(left: CascadeCandidate, right: CascadeCandidate): boolean {
  if (left.important !== right.important) return left.important;
  if (left.inline !== right.inline) return left.inline;
  const specificity = compareSpecificity(left.specificity, right.specificity);
  return specificity !== 0 ? specificity > 0 : left.sourceOrder >= right.sourceOrder;
}

function canonicalProperty(name: string): string | null {
  const semantics = resolveCssProperty(name.toLowerCase());
  if (semantics === null) return null;
  return semantics.kind === "custom" ? semantics.name : semantics.name;
}

function recordCandidate(
  candidates: CandidateMap,
  element: ElementNode,
  declaration: CssDeclaration,
  sourceUrl: string,
  specificity: SelectorSpecificity,
  sourceOrder: number,
  inline: boolean
): void {
  const property = canonicalProperty(declaration.name) ?? declaration.name.toLowerCase();
  const byProperty = candidates.get(element) ?? new Map<string, CascadeCandidate>();
  const next: CascadeCandidate = {
    declaration,
    sourceUrl,
    important: declaration.important,
    inline,
    specificity,
    sourceOrder
  };
  const current = byProperty.get(property);
  if (current === undefined || outranks(next, current)) byProperty.set(property, next);
  candidates.set(element, byProperty);
}

function declarationsOf(rule: CssQualifiedRule): readonly CssDeclaration[] {
  return rule.block.items.filter((item): item is CssDeclaration => item.kind === "declaration");
}

function collectRuleCandidates(
  tree: DocumentTree,
  sources: readonly StylesheetSource[],
  candidates: CandidateMap,
  issues: IssueCollector,
  columns: number,
  signal?: AbortSignal
): number {
  const environment = selectorEnvironment();
  let sourceOrder = 0;
  for (const source of sources) {
    if (!mediaQueryApplies(source.media, columns, issues, source.sourceUrl)) continue;
    const visitRules = (rules: CssStylesheet["rules"]): void => {
      for (const rule of rules) {
      signal?.throwIfAborted();
      if (rule.kind === "at-rule") {
        if (rule.name.toLowerCase() === "media" && rule.block !== null) {
          const media = serializeCssComponentValues(rule.prelude).trim();
          if (mediaQueryApplies(media, columns, issues, source.sourceUrl)) {
            visitRules(rule.block.items.filter((item): item is CssRule => item.kind !== "declaration"));
          }
          continue;
        }
        issues.add(
          "unsupported-at-rule",
          `Unsupported @${rule.name} rule was ignored.`,
          source.sourceUrl
        );
        continue;
      }
      const selectorText = serializeCssComponentValues(rule.prelude).trim();
      const parsed = parseSelectorList(selectorText, {
        ...(signal === undefined ? {} : { signal })
      });
      if (!parsed.ok) {
        issues.add("selector-parse", `Invalid selector: ${selectorText}`, source.sourceUrl);
        continue;
      }
      for (const error of parsed.errors) issues.add("selector-parse", error.message, source.sourceUrl);
      const specificities = specificitiesOfSelectorList(parsed.value);
      const matchingSpecificity = new Map<ElementNode, SelectorSpecificity>();
      for (const [index, selector] of parsed.value.selectors.entries()) {
        let result: ReturnType<typeof querySelectorList<StyleTreeNode>>;
        try {
          result = querySelectorList(
            selectorListFor(selector, parsed.value),
            tree,
            environment,
            {
              limits: { maxNodes: 250_000, maxDepth: 2_048, maxSteps: 1_000_000 },
              ...(signal === undefined ? {} : { signal })
            }
          );
        } catch (error) {
          signal?.throwIfAborted();
          issues.add(
            "selector-unknown",
            error instanceof Error ? error.message : String(error),
            source.sourceUrl
          );
          continue;
        }
        const specificity = specificities[index] ?? { a: 0, b: 0, c: 0 };
        for (const match of result.matches) {
          if (match.kind !== "element") continue;
          const previous = matchingSpecificity.get(match);
          if (previous === undefined || compareSpecificity(specificity, previous) > 0) {
            matchingSpecificity.set(match, specificity);
          }
        }
        for (const unknown of result.unknown) {
          for (const reason of unknown.reasons) {
            issues.add(
              "selector-unknown",
              `Selector ${selectorText} depends on unsupported ${reason.code} ${reason.name}.`,
              source.sourceUrl
            );
          }
        }
      }
      if (matchingSpecificity.size === 0) continue;
      for (const declaration of declarationsOf(rule)) {
        const property = canonicalProperty(declaration.name);
        if (property === null) {
          issues.add(
            "property-invalid",
            `Unknown property ${declaration.name.toLowerCase()}.`,
            source.sourceUrl
          );
          continue;
        }
        if (!property.startsWith("--") && !SUPPORTED_PROPERTIES.has(property)) {
          issues.add(
            "property-unsupported",
            `Property ${property} is outside Verge's terminal CSS profile.`,
            source.sourceUrl
          );
          continue;
        }
        sourceOrder += 1;
        for (const [element, specificity] of matchingSpecificity) {
          recordCandidate(
            candidates,
            element,
            declaration,
            source.sourceUrl,
            specificity,
            sourceOrder,
            false
          );
        }
      }
    }
    };
    visitRules(source.stylesheet.rules);
  }
  return sourceOrder;
}

function collectInlineCandidates(
  elements: readonly ElementNode[],
  candidates: CandidateMap,
  issues: IssueCollector,
  initialSourceOrder: number,
  signal?: AbortSignal
): void {
  let sourceOrder = initialSourceOrder;
  for (const element of elements) {
    signal?.throwIfAborted();
    const value = getAttributeValue(element, "style");
    if (value === undefined) continue;
    const parsed = parseBlockContents(value, {
      ...(signal === undefined ? {} : { signal })
    });
    if (!parsed.ok) {
      issues.add("stylesheet-parse", "Unable to parse an inline style attribute.", "inline");
      continue;
    }
    for (const error of parsed.errors) issues.add("stylesheet-parse", error.message, "inline");
    for (const item of parsed.value) {
      if (item.kind !== "declaration") continue;
      const property = canonicalProperty(item.name);
      if (property === null) {
        issues.add("property-invalid", `Unknown property ${item.name.toLowerCase()}.`, "inline");
        continue;
      }
      if (!property.startsWith("--") && !SUPPORTED_PROPERTIES.has(property)) {
        issues.add(
          "property-unsupported",
          `Property ${property} is outside Verge's terminal CSS profile.`,
          "inline"
        );
        continue;
      }
      sourceOrder += 1;
      recordCandidate(
        candidates,
        element,
        item,
        "inline",
        { a: 1, b: 0, c: 0 },
        sourceOrder,
        true
      );
    }
  }
}

function cssValue(declaration: CssDeclaration): string {
  return serializeCssComponentValues(declaration.value).trim();
}

function customPropertyValues(
  parent: ReadonlyMap<string, readonly ComponentValue[]> | undefined,
  candidates: ReadonlyMap<string, CascadeCandidate> | undefined
): ReadonlyMap<string, readonly ComponentValue[]> {
  let hasLocalCustomProperty = false;
  for (const name of candidates?.keys() ?? []) {
    if (!name.startsWith("--")) continue;
    hasLocalCustomProperty = true;
    break;
  }
  if (!hasLocalCustomProperty) return parent ?? new Map();
  const inherited = new Map(parent ?? []);
  const local = new Map<string, readonly ComponentValue[]>();
  for (const [name, candidate] of candidates ?? []) {
    if (!name.startsWith("--")) continue;
    const wide = cssWide(cssValue(candidate.declaration));
    if (wide === "initial") {
      inherited.delete(name);
      continue;
    }
    if (wide === "inherit" || wide === "unset" || wide === "revert") continue;
    local.set(name, candidate.declaration.value);
  }

  const resolvedLocal = new Map<string, readonly ComponentValue[] | null>();
  const resolveLocal = (name: string, stack: ReadonlySet<string>): readonly ComponentValue[] | null => {
    const known = resolvedLocal.get(name);
    if (known !== undefined) return known;
    if (stack.has(name)) {
      resolvedLocal.set(name, null);
      return null;
    }
    const raw = local.get(name);
    if (raw === undefined) return inherited.get(name) ?? null;
    const nextStack = new Set(stack);
    nextStack.add(name);
    const resolved = substituteComponents(raw, (reference) =>
      local.has(reference)
        ? resolveLocal(reference, nextStack)
        : inherited.get(reference) ?? null
    );
    resolvedLocal.set(name, resolved);
    return resolved;
  };

  for (const name of local.keys()) {
    const value = resolveLocal(name, new Set());
    if (value === null) inherited.delete(name);
    else inherited.set(name, value);
  }
  return inherited;
}

function substituteComponents(
  values: readonly ComponentValue[],
  lookup: (name: string) => readonly ComponentValue[] | null
): readonly ComponentValue[] | null {
  const output: ComponentValue[] = [];
  for (const value of values) {
    if (value.kind === "function-block" && value.name.toLowerCase() === "var") {
      const commaIndex = value.value.findIndex((component) => component.kind === "comma");
      const nameValues = commaIndex < 0 ? value.value : value.value.slice(0, commaIndex);
      const name = serializeCssComponentValues(nameValues).trim();
      if (!name.startsWith("--")) return null;
      const replacement = lookup(name)
        ?? (commaIndex < 0
          ? null
          : substituteComponents(value.value.slice(commaIndex + 1), lookup));
      if (replacement === null) return null;
      output.push(...replacement);
      continue;
    }
    if (value.kind === "function-block") {
      const nested = substituteComponents(value.value, lookup);
      if (nested === null) return null;
      output.push({ ...value, value: nested });
      continue;
    }
    if (value.kind === "simple-block") {
      const nested = substituteComponents(value.value, lookup);
      if (nested === null) return null;
      output.push({ ...value, value: nested });
      continue;
    }
    output.push(value);
  }
  return output;
}

function resolvedDeclaration(
  candidate: CascadeCandidate,
  customProperties: ReadonlyMap<string, readonly ComponentValue[]>
): CssDeclaration | null {
  const value = substituteComponents(
    candidate.declaration.value,
    (name) => customProperties.get(name) ?? null
  );
  if (value === null) return null;
  const property = canonicalProperty(candidate.declaration.name);
  if (property === null) return null;
  return {
    ...candidate.declaration,
    name: property,
    value
  };
}

function validatedCandidate(
  candidate: CascadeCandidate | undefined,
  customProperties: ReadonlyMap<string, readonly ComponentValue[]>,
  issues: IssueCollector
): { readonly candidate: CascadeCandidate; readonly declaration: CssDeclaration } | undefined {
  if (candidate === undefined) return undefined;
  const property = canonicalProperty(candidate.declaration.name);
  if (property === null || property.startsWith("--") || !SUPPORTED_PROPERTIES.has(property)) {
    issues.add(
      "property-unsupported",
      `Property ${candidate.declaration.name.toLowerCase()} is outside Verge's terminal CSS profile.`,
      candidate.sourceUrl
    );
    return undefined;
  }
  const declaration = resolvedDeclaration(candidate, customProperties);
  if (declaration === null) {
    issues.add(
      "property-invalid",
      `Value for ${property} contains an unresolved custom property.`,
      candidate.sourceUrl
    );
    return undefined;
  }
  const validation = validateCssPropertyValue(declaration);
  if (validation.status === "invalid") {
    issues.add("property-invalid", `Invalid value for ${property}.`, candidate.sourceUrl);
    return undefined;
  }
  if (validation.status === "unsupported") {
    issues.add(
      "property-unsupported",
      `Value for ${property} requires CSS computation that Verge does not support.`,
      candidate.sourceUrl
    );
    return undefined;
  }
  return { candidate, declaration };
}

function candidateValue(
  candidates: ReadonlyMap<string, CascadeCandidate> | undefined,
  properties: string | readonly string[],
  customProperties: ReadonlyMap<string, readonly ComponentValue[]>,
  issues: IssueCollector
): {
  readonly property: string;
  readonly value: string;
  readonly sourceUrl: string;
} | undefined {
  const names = typeof properties === "string" ? [properties] : properties;
  let property: string | undefined;
  let candidate: CascadeCandidate | undefined;
  for (const name of names) {
    const current = candidates?.get(name);
    if (current !== undefined && (candidate === undefined || outranks(current, candidate))) {
      property = name;
      candidate = current;
    }
  }
  const validated = validatedCandidate(candidate, customProperties, issues);
  return validated === undefined
    ? undefined
    : {
      property: property ?? validated.declaration.name.toLowerCase(),
      value: cssValue(validated.declaration),
      sourceUrl: validated.candidate.sourceUrl
    };
}

function initialDisplay(element: ElementNode): ComputedDisplay {
  const tag = element.localName.toLowerCase();
  if (NON_RENDERED_TAGS.has(tag)) return "none";
  if (tag === "li") return "list-item";
  if (tag === "table") return "table";
  if (HTML_TABLE_TAGS.has(tag) || HTML_BLOCK_TAGS.has(tag)) return "block";
  return "inline";
}

function initialTextStyle(element: ElementNode): PageTextStyle {
  const tag = element.localName.toLowerCase();
  return {
    ...(BOLD_TAGS.has(tag) ? { bold: true } : {}),
    ...(ITALIC_TAGS.has(tag) ? { italic: true } : {}),
    ...(tag === "u" ? { underline: true } : {}),
    ...(STRIKETHROUGH_TAGS.has(tag) ? { strikethrough: true } : {})
  };
}

function initialBlockStyle(element: ElementNode): PageBlockStyle {
  return {
    whiteSpace: element.localName.toLowerCase() === "pre" ? "pre" : "normal",
    textAlign: "left",
    marginTopRows: 0,
    marginRightCells: 0,
    marginBottomRows: 0,
    marginLeftCells: 0,
    paddingTopRows: 0,
    paddingRightCells: 0,
    paddingBottomRows: 0,
    paddingLeftCells: 0,
    textIndentCells: 0
  };
}

function inheritedBase(parent: ComputedElementStyle | undefined, element: ElementNode): ComputedElementStyle {
  const initialText = initialTextStyle(element);
  const usesBrowserLinkColor = (
    element.localName.toLowerCase() === "a"
    || element.localName.toLowerCase() === "area"
  ) && hasAttribute(element, "href");
  return {
    display: initialDisplay(element),
    visibility: parent?.visibility ?? "visible",
    textTransform: parent?.textTransform ?? "none",
    listStyleType: parent?.listStyleType ?? (element.localName.toLowerCase() === "ol" ? "decimal" : "disc"),
    text: {
      ...(usesBrowserLinkColor || parent?.text.foreground === undefined
        ? {}
        : { foreground: parent.text.foreground }),
      ...(parent?.text.bold === true ? { bold: true } : {}),
      ...(parent?.text.italic === true ? { italic: true } : {}),
      ...(parent?.text.underline === true ? { underline: true } : {}),
      ...(parent?.text.strikethrough === true ? { strikethrough: true } : {}),
      ...initialText
    },
    block: {
      ...initialBlockStyle(element),
      whiteSpace: parent?.block.whiteSpace ?? initialBlockStyle(element).whiteSpace,
      textAlign: parent?.block.textAlign ?? "left"
    },
    box: {
      flexDirection: "row",
      flexWrap: false,
      justifyContent: "start",
      alignItems: "stretch",
      columnGapCells: 0,
      rowGapRows: 0,
      minHeightRows: 0,
      marginInlineAuto: false,
      border: false,
      visuallyHidden: false
    },
    customProperties: parent?.customProperties ?? new Map()
  };
}

function cssWide(value: string): "initial" | "inherit" | "unset" | "revert" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "initial" || normalized === "inherit" || normalized === "unset") return normalized;
  if (normalized === "revert" || normalized === "revert-layer" || normalized === "revert-rule") return "revert";
  return null;
}

function resolvedValue(
  property: string,
  value: string,
  initial: string,
  inherited: string | undefined
): string {
  const wide = cssWide(value);
  if (wide === null) return value;
  if (wide === "inherit") return inherited ?? initial;
  if (wide === "unset") return INHERITED_PROPERTIES.has(property) ? inherited ?? initial : initial;
  return initial;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function alphaIsOpaque(value: string | undefined): boolean {
  if (value === undefined) return true;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 1;
}

function parseRgbComponent(value: string): number | null {
  const normalized = value.trim();
  if (normalized.endsWith("%")) {
    const percentage = Number.parseFloat(normalized.slice(0, -1));
    return Number.isFinite(percentage) ? clampByte(percentage * 2.55) : null;
  }
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? clampByte(number) : null;
}

function parseHexColor(value: string): PageColor | null {
  const raw = value.slice(1);
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(raw)) return null;
  const expanded = raw.length <= 4
    ? raw.replace(/[0-9a-f]/giu, (character) => `${character}${character}`)
    : raw;
  if (expanded.length === 8 && expanded.slice(6) !== "ff") return null;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16)
  };
}

function parseRgbColor(value: string): PageColor | null {
  const match = /^(?:rgb|rgba)\((.+)\)$/iu.exec(value);
  if (!match?.[1]) return null;
  const [componentsText, alphaText] = match[1].split("/").map((part) => part.trim());
  const components = componentsText?.includes(",")
    ? componentsText.split(",").map((part) => part.trim())
    : componentsText?.split(/\s+/u);
  if (!components || components.length < 3 || !alphaIsOpaque(alphaText ?? components[3])) return null;
  const rgb = components.slice(0, 3).map(parseRgbComponent);
  if (rgb.some((part) => part === null)) return null;
  return { r: rgb[0] ?? 0, g: rgb[1] ?? 0, b: rgb[2] ?? 0 };
}

function hueToRgb(p: number, q: number, rawT: number): number {
  const t = rawT < 0 ? rawT + 1 : rawT > 1 ? rawT - 1 : rawT;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function parseHslColor(value: string): PageColor | null {
  const match = /^(?:hsl|hsla)\((.+)\)$/iu.exec(value);
  if (!match?.[1]) return null;
  const [componentsText, alphaText] = match[1].split("/").map((part) => part.trim());
  const components = componentsText?.includes(",")
    ? componentsText.split(",").map((part) => part.trim())
    : componentsText?.split(/\s+/u);
  if (!components || components.length < 3 || !alphaIsOpaque(alphaText ?? components[3])) return null;
  const hue = Number.parseFloat(components[0] ?? "");
  const saturation = Number.parseFloat((components[1] ?? "").replace("%", "")) / 100;
  const lightness = Number.parseFloat((components[2] ?? "").replace("%", "")) / 100;
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  const h = ((hue % 360) + 360) % 360 / 360;
  if (saturation === 0) {
    const gray = clampByte(lightness * 255);
    return { r: gray, g: gray, b: gray };
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: clampByte(hueToRgb(p, q, h + 1 / 3) * 255),
    g: clampByte(hueToRgb(p, q, h) * 255),
    b: clampByte(hueToRgb(p, q, h - 1 / 3) * 255)
  };
}

function parseColor(value: string, currentColor: PageColor | undefined): PageColor | undefined | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "transparent") return undefined;
  if (normalized === "currentcolor") return currentColor;
  if (normalized.startsWith("#")) return parseHexColor(normalized);
  return NAMED_COLORS[normalized] ?? parseRgbColor(normalized) ?? parseHslColor(normalized);
}

function displayValue(value: string, initial: ComputedDisplay): ComputedDisplay | null {
  switch (value.trim().toLowerCase()) {
    case "none": return "none";
    case "contents": return "contents";
    case "inline":
    case "inline-block":
      return "inline";
    case "list-item":
      return "list-item";
    case "table":
    case "inline-table":
      return "table";
    case "block":
    case "flow-root":
      return "block";
    case "flex":
    case "inline-flex":
      return "flex";
    case "grid":
    case "inline-grid":
      return "grid";
    default:
      return cssWide(value) === null ? null : initial;
  }
}

function parseLength(value: string, axis: "horizontal" | "vertical", maximum: number): number | null {
  const match = /^([+]?(?:\d+(?:\.\d+)?|\.\d+))(ch|em|rem|px)?$/iu.exec(value.trim());
  if (!match?.[1]) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] ?? (number === 0 ? "px" : "")).toLowerCase();
  if (unit.length === 0) return null;
  let cells = number;
  if (unit === "em" || unit === "rem") cells *= axis === "horizontal" ? 2 : 1;
  else if (unit === "px") cells /= axis === "horizontal" ? 8 : 16;
  else if (unit === "ch" && axis === "vertical") cells /= 2;
  return Math.min(maximum, Math.max(0, Math.round(cells)));
}

function boxValues(value: string): readonly string[] | null {
  const values = value.trim().split(/\s+/u).filter(Boolean);
  if (values.length < 1 || values.length > 4) return null;
  if (values.length === 1) return [values[0] ?? "0", values[0] ?? "0", values[0] ?? "0", values[0] ?? "0"];
  if (values.length === 2) return [values[0] ?? "0", values[1] ?? "0", values[0] ?? "0", values[1] ?? "0"];
  if (values.length === 3) return [values[0] ?? "0", values[1] ?? "0", values[2] ?? "0", values[1] ?? "0"];
  return values;
}

function supportedValueIssue(
  issues: IssueCollector,
  sourceUrl: string,
  property: string,
  value: string
): void {
  issues.add(
    "value-unsupported",
    `Value ${value} for ${property} cannot be represented by Verge's terminal CSS profile.`,
    sourceUrl
  );
}

function computeElementStyle(
  element: ElementNode,
  parent: ComputedElementStyle | undefined,
  candidates: ReadonlyMap<string, CascadeCandidate> | undefined,
  issues: IssueCollector
): ComputedElementStyle {
  let computed = inheritedBase(parent, element);
  const customProperties = customPropertyValues(parent?.customProperties, candidates);
  computed = { ...computed, customProperties };
  const valueFor = (property: string): { readonly value: string; readonly sourceUrl: string } | undefined =>
    candidateValue(candidates, property, customProperties, issues);

  const display = valueFor("display");
  if (display) {
    const value = displayValue(display.value, initialDisplay(element));
    if (value === null) supportedValueIssue(issues, display.sourceUrl, "display", display.value);
    else computed = { ...computed, display: value };
  }
  const visibility = valueFor("visibility");
  if (visibility) {
    const value = resolvedValue("visibility", visibility.value, "visible", parent?.visibility);
    if (value === "visible" || value === "hidden" || value === "collapse") {
      computed = { ...computed, visibility: value === "visible" ? "visible" : "hidden" };
    } else supportedValueIssue(issues, visibility.sourceUrl, "visibility", visibility.value);
  }
  const whiteSpace = valueFor("white-space");
  if (whiteSpace) {
    const value = resolvedValue("white-space", whiteSpace.value, "normal", parent?.block.whiteSpace);
    if (["normal", "nowrap", "pre", "pre-wrap", "pre-line"].includes(value)) {
      computed = { ...computed, block: { ...computed.block, whiteSpace: value as PageWhiteSpace } };
    } else supportedValueIssue(issues, whiteSpace.sourceUrl, "white-space", whiteSpace.value);
  }
  const textAlign = valueFor("text-align");
  if (textAlign) {
    const value = resolvedValue("text-align", textAlign.value, "left", parent?.block.textAlign);
    const aligned = value === "start" ? "left" : value === "end" ? "right" : value;
    if (aligned === "left" || aligned === "center" || aligned === "right") {
      computed = { ...computed, block: { ...computed.block, textAlign: aligned } };
    } else supportedValueIssue(issues, textAlign.sourceUrl, "text-align", textAlign.value);
  }
  const transform = valueFor("text-transform");
  if (transform) {
    const value = resolvedValue("text-transform", transform.value, "none", parent?.textTransform);
    if (value === "none" || value === "uppercase" || value === "lowercase" || value === "capitalize") {
      computed = { ...computed, textTransform: value };
    } else supportedValueIssue(issues, transform.sourceUrl, "text-transform", transform.value);
  }
  const listStyle = candidateValue(
    candidates,
    ["list-style-type", "list-style"],
    customProperties,
    issues
  );
  if (listStyle) {
    const value = resolvedValue("list-style-type", listStyle.value, "disc", parent?.listStyleType);
    const supportedMarkers = [
      "none",
      "disc",
      "circle",
      "square",
      "decimal",
      "decimal-leading-zero",
      "lower-alpha",
      "upper-alpha"
    ];
    const marker = value.split(/\s+/u).find((part) => supportedMarkers.includes(part));
    if (marker !== undefined) {
      computed = { ...computed, listStyleType: marker };
    } else supportedValueIssue(issues, listStyle.sourceUrl, "list-style-type", listStyle.value);
  }
  const foreground = valueFor("color");
  if (foreground) {
    const inherited = parent?.text.foreground;
    const raw = resolvedValue("color", foreground.value, "currentcolor", inherited === undefined ? undefined : "currentcolor");
    const color = raw === "currentcolor" && inherited !== undefined ? inherited : parseColor(raw, inherited);
    if (color === null) supportedValueIssue(issues, foreground.sourceUrl, "color", foreground.value);
    else computed = { ...computed, text: { ...computed.text, ...(color === undefined ? {} : { foreground: color }) } };
  }
  const background = candidateValue(
    candidates,
    ["background-color", "background"],
    customProperties,
    issues
  );
  if (background) {
    const raw = cssWide(background.value) === null ? background.value : "transparent";
    const color = parseColor(raw, computed.text.foreground);
    if (color === null) supportedValueIssue(issues, background.sourceUrl, "background-color", background.value);
    else {
      computed = {
        ...computed,
        text: { ...computed.text, ...(color === undefined ? {} : { background: color }) },
        block: { ...computed.block, ...(color === undefined ? {} : { background: color }) }
      };
    }
  }
  const weight = valueFor("font-weight");
  if (weight) {
    const inherited = parent?.text.bold === true ? "700" : "400";
    const value = resolvedValue("font-weight", weight.value, "400", inherited).toLowerCase();
    const numeric = Number.parseInt(value, 10);
    const bold = value === "bold" || value === "bolder" || Number.isFinite(numeric) && numeric >= 600;
    const normal = value === "normal" || value === "lighter" || Number.isFinite(numeric) && numeric < 600;
    if (!bold && !normal) supportedValueIssue(issues, weight.sourceUrl, "font-weight", weight.value);
    else computed = { ...computed, text: { ...computed.text, bold } };
  }
  const fontStyle = valueFor("font-style");
  if (fontStyle) {
    const value = resolvedValue(
      "font-style",
      fontStyle.value,
      "normal",
      parent?.text.italic === true ? "italic" : "normal"
    ).toLowerCase();
    if (value === "normal" || value === "italic" || value.startsWith("oblique")) {
      computed = { ...computed, text: { ...computed.text, italic: value !== "normal" } };
    } else supportedValueIssue(issues, fontStyle.sourceUrl, "font-style", fontStyle.value);
  }
  const decoration = candidateValue(
    candidates,
    ["text-decoration-line", "text-decoration"],
    customProperties,
    issues
  );
  if (decoration) {
    const value = decoration.value.toLowerCase();
    computed = {
      ...computed,
      text: {
        ...computed.text,
        underline: value.includes("underline"),
        strikethrough: value.includes("line-through")
      }
    };
  }

  const rightIsInlineStart = getAttributeValue(element, "dir")?.trim().toLowerCase() === "rtl";
  const sideProperties = [
    ["margin-top", ["margin-top", "margin", "margin-block-start", "margin-block"], "marginTopRows", 0, "vertical", 8],
    ["margin-right", [
      "margin-right",
      "margin",
      rightIsInlineStart ? "margin-inline-start" : "margin-inline-end",
      "margin-inline"
    ], "marginRightCells", 1, "horizontal", 16],
    ["margin-bottom", ["margin-bottom", "margin", "margin-block-end", "margin-block"], "marginBottomRows", 2, "vertical", 8],
    ["margin-left", [
      "margin-left",
      "margin",
      rightIsInlineStart ? "margin-inline-end" : "margin-inline-start",
      "margin-inline"
    ], "marginLeftCells", 3, "horizontal", 16],
    ["padding-top", ["padding-top", "padding", "padding-block-start", "padding-block"], "paddingTopRows", 0, "vertical", 8],
    ["padding-right", [
      "padding-right",
      "padding",
      rightIsInlineStart ? "padding-inline-start" : "padding-inline-end",
      "padding-inline"
    ], "paddingRightCells", 1, "horizontal", 16],
    ["padding-bottom", ["padding-bottom", "padding", "padding-block-end", "padding-block"], "paddingBottomRows", 2, "vertical", 8],
    ["padding-left", [
      "padding-left",
      "padding",
      rightIsInlineStart ? "padding-inline-end" : "padding-inline-start",
      "padding-inline"
    ], "paddingLeftCells", 3, "horizontal", 16]
  ] as const;
  for (const [property, propertyNames, field, sideIndex, axis, maximum] of sideProperties) {
    const entry = candidateValue(candidates, propertyNames, customProperties, issues);
    if (!entry) continue;
    const isFourSideShorthand = entry.property === "margin" || entry.property === "padding";
    const isAxisShorthand = entry.property === "margin-block"
      || entry.property === "margin-inline"
      || entry.property === "padding-block"
      || entry.property === "padding-inline";
    const rawValue = isFourSideShorthand
      ? boxValues(entry.value)?.[sideIndex]
      : isAxisShorthand
        ? (() => {
          const values = entry.value.trim().split(/\s+/u);
          if (values.length < 1 || values.length > 2) return undefined;
          const isEnd = property.endsWith("right") || property.endsWith("bottom");
          return isEnd ? values[1] ?? values[0] : values[0];
        })()
        : entry.value;
    if (axis === "horizontal" && rawValue?.trim().toLowerCase() === "auto") {
      computed = {
        ...computed,
        box: { ...computed.box, marginInlineAuto: true },
        block: { ...computed.block, [field]: 0 }
      };
      continue;
    }
    const length = rawValue === undefined ? null : parseLength(rawValue, axis, maximum);
    if (length === null) supportedValueIssue(issues, entry.sourceUrl, property, entry.value);
    else computed = { ...computed, block: { ...computed.block, [field]: length } };
  }
  const textIndent = valueFor("text-indent");
  if (textIndent) {
    const length = parseLength(textIndent.value, "horizontal", 16);
    if (length === null) {
      supportedValueIssue(issues, textIndent.sourceUrl, "text-indent", textIndent.value);
    } else {
      computed = {
        ...computed,
        block: { ...computed.block, textIndentCells: length }
      };
    }
  }
  const flexDirection = valueFor("flex-direction");
  if (flexDirection) {
    const value = flexDirection.value.trim().toLowerCase();
    if (value === "row" || value === "row-reverse") {
      computed = { ...computed, box: { ...computed.box, flexDirection: "row" } };
    } else if (value === "column" || value === "column-reverse") {
      computed = { ...computed, box: { ...computed.box, flexDirection: "column" } };
    } else supportedValueIssue(issues, flexDirection.sourceUrl, "flex-direction", flexDirection.value);
  }
  const flexWrap = valueFor("flex-wrap");
  if (flexWrap) {
    const value = flexWrap.value.trim().toLowerCase();
    if (value === "wrap" || value === "wrap-reverse" || value === "nowrap") {
      computed = { ...computed, box: { ...computed.box, flexWrap: value !== "nowrap" } };
    } else supportedValueIssue(issues, flexWrap.sourceUrl, "flex-wrap", flexWrap.value);
  }
  const justify = valueFor("justify-content");
  if (justify) {
    const value = justify.value.trim().toLowerCase();
    const normalized = value === "flex-start" ? "start" : value === "flex-end" ? "end" : value;
    if (normalized === "start" || normalized === "center" || normalized === "end" || normalized === "space-between") {
      computed = {
        ...computed,
        box: {
          ...computed.box,
          justifyContent: normalized
        }
      };
    } else supportedValueIssue(issues, justify.sourceUrl, "justify-content", justify.value);
  }
  const align = valueFor("align-items");
  if (align) {
    const value = align.value.trim().toLowerCase();
    const normalized = value === "flex-start" ? "start" : value === "flex-end" ? "end" : value;
    if (normalized === "start" || normalized === "center" || normalized === "end" || normalized === "stretch") {
      computed = {
        ...computed,
        box: {
          ...computed.box,
          alignItems: normalized
        }
      };
    } else supportedValueIssue(issues, align.sourceUrl, "align-items", align.value);
  }
  const gap = candidateValue(
    candidates,
    ["gap", "column-gap", "row-gap"],
    customProperties,
    issues
  );
  const columnGap = candidateValue(candidates, ["column-gap", "gap"], customProperties, issues);
  const rowGap = candidateValue(candidates, ["row-gap", "gap"], customProperties, issues);
  const gapPart = (entry: typeof gap, index: number): string | undefined => {
    if (!entry) return undefined;
    const parts = entry.value.trim().split(/\s+/u);
    return entry.property === "gap" ? parts[index] ?? parts[0] : parts[0];
  };
  const columnGapCells = parseLength(
    gapPart(columnGap, 1) ?? gapPart(gap, 1) ?? "0",
    "horizontal",
    16
  );
  const rowGapRows = parseLength(
    gapPart(rowGap, 0) ?? gapPart(gap, 0) ?? "0",
    "vertical",
    8
  );
  computed = {
    ...computed,
    box: {
      ...computed.box,
      columnGapCells: columnGapCells ?? 0,
      rowGapRows: rowGapRows ?? 0
    }
  };
  const gridTemplate = valueFor("grid-template-columns");
  if (gridTemplate) {
    computed = {
      ...computed,
      box: { ...computed.box, gridTemplateColumns: gridTemplate.value }
    };
  }
  const gridColumn = valueFor("grid-column");
  if (gridColumn) {
    const value = Number.parseInt(gridColumn.value, 10);
    if (Number.isSafeInteger(value) && value > 0) {
      computed = { ...computed, box: { ...computed.box, gridColumn: value } };
    }
  }
  const dimensions = [
    ["width", "width"],
    ["min-width", "minWidth"],
    ["max-width", "maxWidth"]
  ] as const;
  for (const [property, field] of dimensions) {
    const entry = valueFor(property);
    if (entry) computed = { ...computed, box: { ...computed.box, [field]: entry.value } };
  }
  const minHeight = valueFor("min-height");
  if (minHeight) {
    const rows = parseLength(minHeight.value, "vertical", 12);
    if (rows !== null) computed = { ...computed, box: { ...computed.box, minHeightRows: rows } };
  }
  const border = candidateValue(
    candidates,
    ["border", "border-style", "border-width"],
    customProperties,
    issues
  );
  const borderColor = candidateValue(
    candidates,
    ["border-color", "border"],
    customProperties,
    issues
  );
  const borderValue = border?.value.toLowerCase() ?? "";
  const hasBorder = border !== undefined
    && !/\b(?:none|hidden|0(?:px|rem|em|ch)?)\b/u.test(borderValue);
  const parsedBorderColor = borderColor === undefined
    ? undefined
    : borderColor.value
      .split(/\s+/u)
      .map((part) => parseColor(part, computed.text.foreground))
      .find((color): color is PageColor => color !== null && color !== undefined);
  computed = {
    ...computed,
    box: {
      ...computed.box,
      border: hasBorder,
      ...(parsedBorderColor === undefined ? {} : { borderColor: parsedBorderColor })
    }
  };
  const position = valueFor("position")?.value.trim().toLowerCase();
  const overflow = candidateValue(
    candidates,
    ["overflow", "overflow-x", "overflow-y"],
    customProperties,
    issues
  )?.value.trim().toLowerCase();
  const clip = candidateValue(
    candidates,
    ["clip-path", "clip"],
    customProperties,
    issues
  )?.value.trim().toLowerCase();
  const width = valueFor("width")?.value.trim().toLowerCase();
  const height = valueFor("height")?.value.trim().toLowerCase();
  const tinyWidth = width === "1px" || width === "0" || width === "0px";
  const tinyHeight = height === "1px" || height === "0" || height === "0px";
  if (
    (position === "absolute" || position === "fixed")
    && overflow === "hidden"
    && tinyWidth
    && tinyHeight
    && clip !== undefined
  ) {
    computed = { ...computed, box: { ...computed.box, visuallyHidden: true } };
  }
  return computed;
}

function parentIndex(tree: DocumentTree): ReadonlyMap<ElementNode, ElementNode | undefined> {
  const parents = new Map<ElementNode, ElementNode | undefined>();
  const visit = (node: HtmlNode, parent: ElementNode | undefined): void => {
    if (node.kind !== "element") return;
    parents.set(node, parent);
    for (const child of node.children) visit(child, node);
  };
  for (const child of tree.children) visit(child, undefined);
  return parents;
}

export function resolvePageStyles(
  tree: DocumentTree,
  resources: readonly PageStylesheetResource[] = [],
  initialIssues: readonly PageStyleIssue[] = [],
  options: {
    readonly authorStyles?: "apply" | "ignore";
    readonly columns?: number;
    readonly signal?: AbortSignal;
  } = {}
): PageStyleResolution {
  const issues = new IssueCollector();
  for (const issue of initialIssues) {
    for (let occurrence = 0; occurrence < issue.occurrences; occurrence += 1) {
      issues.add(issue.code, issue.message, issue.sourceUrl);
    }
  }
  const elements = allElements(tree);
  const candidates: CandidateMap = new Map();
  let stylesheetCount = 0;
  if (options.authorStyles !== "ignore") {
    const sources = stylesheetSources(tree, resources, issues, options.signal);
    stylesheetCount = sources.length;
    const lastSourceOrder = collectRuleCandidates(
      tree,
      sources,
      candidates,
      issues,
      options.columns ?? 80,
      options.signal
    );
    collectInlineCandidates(elements, candidates, issues, lastSourceOrder, options.signal);
  }
  const parents = parentIndex(tree);
  const byElement = new Map<ElementNode, ComputedElementStyle>();
  for (const element of elements) {
    const parent = parents.get(element);
    const parentStyle = parent === undefined ? undefined : byElement.get(parent);
    byElement.set(element, computeElementStyle(element, parentStyle, candidates.get(element), issues));
  }
  return {
    byElement,
    issues: issues.values(),
    stylesheetCount
  };
}

export function transformStyledText(value: string, transform: ComputedTextTransform): string {
  if (transform === "uppercase") return value.toLocaleUpperCase();
  if (transform === "lowercase") return value.toLocaleLowerCase();
  if (transform === "capitalize") {
    return value.replace(/(^|[\s\p{P}])(\p{L})/gu, (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toLocaleUpperCase()}`
    );
  }
  return value;
}
