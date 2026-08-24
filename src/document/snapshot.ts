import {
  applyPatchPlan,
  computePatch,
  HTML_NAMESPACE_URI,
  type Attribute,
  type Edit,
  type HtmlNode,
  type NodeId,
  type ParsedDocument,
  type Span
} from "@ismail-elkorchi/html-parser";

import type {
  DocumentAttribute,
  DocumentChoiceControl,
  DocumentDisclosure,
  DocumentEdit,
  DocumentForm,
  DocumentFormControl,
  DocumentHeading,
  DocumentIndexLimits,
  DocumentIndexOutcome,
  DocumentLabel,
  DocumentLandmark,
  DocumentLink,
  DocumentMetadataEntry,
  DocumentNodeRef,
  DocumentOutlineEntry,
  DocumentParserDiagnostic,
  DocumentReplacedContent,
  DocumentSelectOption,
  DocumentSemanticEntry,
  DocumentSemanticRole,
  DocumentSourceMetadata,
  DocumentSourceRange,
  DocumentStylesheetReference,
  WebDocumentNode,
  WebDocumentSnapshotView,
  WebElementNode
} from "./types.js";

const DEFAULT_INDEX_LIMITS: DocumentIndexLimits = Object.freeze({
  maxIndexedNodes: 100_000,
  maxTextCodeUnits: 8 * 1024 * 1024,
  maxLinks: 10_000,
  maxStylesheets: 256,
  maxForms: 256,
  maxControlsPerForm: 2_000,
  maxOptionsPerSelect: 2_000,
  maxHeadings: 10_000
});
const KNOWN_INPUT_TYPES = new Set([
  "hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week",
  "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit",
  "image", "reset", "button"
]);

interface SnapshotContext {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly limits?: Partial<DocumentIndexLimits>;
}

interface MutableIndexState {
  outcome: DocumentIndexOutcome;
}

function nodeRef(sequence: number): DocumentNodeRef {
  return `node:${String(sequence)}` as DocumentNodeRef;
}

function sourceRange(span: Span | undefined, provenance: "input" | "inferred" | undefined): DocumentSourceRange | null {
  return span === undefined
    ? null
    : Object.freeze({ start: span.start, end: span.end, provenance: provenance ?? "inferred" });
}

function attributeRecord(attribute: Attribute): DocumentAttribute {
  return Object.freeze({
    namespace: attribute.namespaceUri,
    prefix: attribute.prefix ?? null,
    name: attribute.localName,
    value: attribute.value,
    sourceRange: sourceRange(attribute.span, attribute.span === undefined ? undefined : "input")
  });
}

function freezeNode<T extends WebDocumentNode>(node: T): T {
  Object.freeze(node.children);
  if (node.kind === "element") {
    Object.freeze(node.attributes);
  }
  return Object.freeze(node);
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function normalizedLimits(overrides: Partial<DocumentIndexLimits> | undefined): DocumentIndexLimits {
  const values = { ...DEFAULT_INDEX_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return values;
}

function markTruncated(
  state: MutableIndexState,
  exhausted: keyof DocumentIndexLimits,
  limit: number,
  indexedNodes: number
): void {
  if (state.outcome.status === "complete") {
    state.outcome = { status: "truncated", indexedNodes, exhausted, limit };
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMethod(value: string | null): "get" | "post" | "dialog" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "post" || normalized === "dialog" ? normalized : "get";
}

function normalizeEncoding(value: string | null): "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "multipart/form-data" || normalized === "text/plain"
    ? normalized
    : "application/x-www-form-urlencoded";
}

function explicitRole(value: string | null): DocumentSemanticRole | null {
  if (value === null) return null;
  const role = value.trim().toLowerCase().split(/\s+/u)[0];
  const supported = new Set<DocumentSemanticRole>([
    "document", "article", "heading", "paragraph", "list", "listitem", "definition",
    "term", "blockquote", "code", "link", "button", "textbox", "checkbox", "radio",
    "combobox", "table", "rowgroup", "row", "cell", "columnheader", "rowheader",
    "img", "figure", "separator", "group", "dialog", "generic"
  ]);
  return role !== undefined && supported.has(role as DocumentSemanticRole)
    ? role as DocumentSemanticRole
    : null;
}

function htmlRole(node: WebElementNode, attribute: (name: string) => string | null): DocumentSemanticRole {
  const explicit = explicitRole(attribute("role"));
  if (explicit !== null) return explicit;
  if (node.namespace !== HTML_NAMESPACE_URI) {
    if (node.namespace === "http://www.w3.org/2000/svg") return "img";
    return "generic";
  }
  const roles: Readonly<Record<string, DocumentSemanticRole>> = {
    a: attribute("href") === null ? "generic" : "link",
    article: "article",
    blockquote: "blockquote",
    button: "button",
    code: "code",
    dd: "definition",
    dialog: "dialog",
    dl: "list",
    dt: "term",
    figure: "figure",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    hr: "separator",
    img: "img",
    li: "listitem",
    ol: "list",
    p: "paragraph",
    table: "table",
    tbody: "rowgroup",
    tfoot: "rowgroup",
    thead: "rowgroup",
    tr: "row",
    td: "cell",
    th: attribute("scope") === "row" ? "rowheader" : "columnheader",
    ul: "list"
  };
  if (node.name === "input") {
    const type = (attribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "reset" || type === "button") return "button";
    return "textbox";
  }
  if (node.name === "textarea") return "textbox";
  if (node.name === "select") return "combobox";
  return roles[node.name] ?? "generic";
}

function landmarkFor(
  node: WebElementNode,
  attribute: (name: string) => string | null,
  accessibleName: string,
  hasSectioningAncestor: boolean
): DocumentLandmark | null {
  const role = attribute("role")?.trim().toLowerCase().split(/\s+/u)[0];
  if (role === "banner" || role === "navigation" || role === "main" || role === "complementary"
    || role === "contentinfo" || role === "search" || role === "form" || role === "region") {
    return role;
  }
  if (node.name === "header") return hasSectioningAncestor ? null : "banner";
  if (node.name === "footer") return hasSectioningAncestor ? null : "contentinfo";
  if (node.name === "form") return accessibleName.length === 0 ? null : "form";
  if (node.name === "section") return accessibleName.length === 0 ? null : "region";
  const implicit: Readonly<Record<string, DocumentLandmark>> = {
    aside: "complementary",
    main: "main",
    nav: "navigation",
    search: "search"
  };
  return implicit[node.name] ?? null;
}

export class WebDocumentSnapshot implements WebDocumentSnapshotView {
  readonly root: DocumentNodeRef;
  readonly documentElement: DocumentNodeRef | null;
  readonly head: DocumentNodeRef | null;
  readonly body: DocumentNodeRef | null;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly baseUrl: string;
  readonly title: string;
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly links: readonly DocumentLink[];
  readonly stylesheets: readonly DocumentStylesheetReference[];
  readonly forms: readonly DocumentForm[];
  readonly controls: readonly DocumentFormControl[];
  readonly labels: readonly DocumentLabel[];
  readonly headings: readonly DocumentHeading[];
  readonly outline: readonly DocumentOutlineEntry[];
  readonly landmarks: readonly DocumentSemanticEntry[];
  readonly replacedContent: readonly DocumentReplacedContent[];
  readonly disclosures: readonly DocumentDisclosure[];
  readonly diagnostics: readonly DocumentParserDiagnostic[];
  readonly sourceMetadata: DocumentSourceMetadata;
  readonly indexOutcome: DocumentIndexOutcome;
  readonly sourceText: string | null;

  readonly #nodes: ReadonlyMap<DocumentNodeRef, WebDocumentNode>;
  readonly #semantics: ReadonlyMap<DocumentNodeRef, DocumentSemanticEntry>;
  readonly #elementsById: ReadonlyMap<string, DocumentNodeRef>;
  readonly #forms: ReadonlyMap<DocumentNodeRef, DocumentForm>;
  readonly #formOwners: ReadonlyMap<DocumentNodeRef, DocumentNodeRef>;
  readonly #controls: ReadonlyMap<DocumentNodeRef, DocumentFormControl>;
  readonly #radioGroups: ReadonlyMap<DocumentNodeRef, readonly DocumentChoiceControl[]>;
  readonly #options: ReadonlyMap<DocumentNodeRef, DocumentSelectOption>;
  readonly #labelsByNode: ReadonlyMap<DocumentNodeRef, DocumentLabel>;
  readonly #links: ReadonlyMap<DocumentNodeRef, DocumentLink>;
  readonly #headings: ReadonlyMap<DocumentNodeRef, DocumentHeading>;
  readonly #replaced: ReadonlyMap<DocumentNodeRef, DocumentReplacedContent>;
  readonly #disclosures: ReadonlyMap<DocumentNodeRef, DocumentDisclosure>;
  readonly #textRanges: ReadonlyMap<DocumentNodeRef, readonly [number, number]>;
  readonly #documentText: string;
  readonly #parsed: ParsedDocument;
  readonly #parserIds: ReadonlyMap<DocumentNodeRef, NodeId>;

  public constructor(parsed: ParsedDocument, context: SnapshotContext) {
    this.#parsed = parsed;
    this.sourceText = parsed.sourceText;
    this.requestUrl = context.requestUrl;
    this.finalUrl = context.finalUrl;
    const limits = normalizedLimits(context.limits);
    const mutableOutcome: MutableIndexState = {
      outcome: { status: "complete", indexedNodes: 0 }
    };
    const nodes = new Map<DocumentNodeRef, WebDocumentNode>();
    const parserIds = new Map<DocumentNodeRef, NodeId>();
    let sequence = 0;

    this.root = nodeRef(++sequence);
    parserIds.set(this.root, parsed.tree.id);
    const pendingClones: {
      readonly source: HtmlNode;
      readonly ref: DocumentNodeRef;
    }[] = [];
    const cloneNode = (node: HtmlNode, parent: DocumentNodeRef): DocumentNodeRef => {
      const ref = nodeRef(++sequence);
      parserIds.set(ref, node.id);
      const children: DocumentNodeRef[] = [];
      const range = node.kind === "templateContent"
        ? null
        : sourceRange(node.span, node.spanProvenance);
      let cloned: WebDocumentNode;
      if (node.kind === "element") {
        cloned = {
          ref,
          parent,
          children,
          sourceRange: range,
          kind: "element",
          namespace: node.namespaceUri,
          prefix: node.prefix ?? null,
          name: node.namespaceUri === HTML_NAMESPACE_URI
            ? node.localName.toLowerCase()
            : node.localName,
          attributes: node.attributes.map(attributeRecord),
          templateContent: null
        };
      } else if (node.kind === "templateContent") {
        cloned = { ref, parent, children, sourceRange: range, kind: "template-content" };
      } else if (node.kind === "text") {
        cloned = { ref, parent, children, sourceRange: range, kind: "text", value: node.value };
      } else if (node.kind === "comment") {
        cloned = { ref, parent, children, sourceRange: range, kind: "comment", value: node.value };
      } else if (node.kind === "processingInstruction") {
        cloned = {
          ref, parent, children, sourceRange: range, kind: "processing-instruction",
          target: node.target, data: node.data
        };
      } else {
        cloned = { ref, parent, children, sourceRange: range, kind: "doctype", name: node.name };
      }
      nodes.set(ref, cloned);
      if (node.kind === "element" || node.kind === "templateContent") {
        pendingClones.push({ source: node, ref });
      }
      return ref;
    };

    const rootChildren = parsed.tree.children.map((child) => cloneNode(child, this.root));
    while (pendingClones.length > 0) {
      const pending = pendingClones.pop();
      if (pending === undefined) continue;
      const { source, ref } = pending;
      if (source.kind !== "element" && source.kind !== "templateContent") continue;
      const children = source.children.map((child) => cloneNode(child, ref));
      const cloned = nodes.get(ref);
      if (cloned === undefined) continue;
      if (source.kind === "element") {
        nodes.set(ref, {
          ...cloned,
          children,
          templateContent: source.templateContent === undefined
            ? null
            : cloneNode(source.templateContent, ref)
        } as WebDocumentNode);
      } else {
        nodes.set(ref, { ...cloned, children });
      }
    }
    nodes.set(this.root, freezeNode({
      ref: this.root,
      parent: null,
      children: rootChildren,
      sourceRange: null,
      kind: "document"
    }));
    for (const [ref, node] of nodes) {
      if (ref !== this.root && !Object.isFrozen(node)) nodes.set(ref, freezeNode(node));
    }
    this.#nodes = nodes;
    this.#parserIds = parserIds;

    let totalNodes = 0;
    const elements: WebElementNode[] = [];
    const sectioningAncestors = new Set<DocumentNodeRef>();
    let indexedNodes = 0;
    const pending: { readonly ref: DocumentNodeRef; readonly sectioning: boolean }[] = [
      { ref: this.root, sectioning: false }
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const { ref } = current;
      totalNodes += 1;
      const node = nodes.get(ref);
      if (indexedNodes < limits.maxIndexedNodes) {
        indexedNodes += 1;
        if (node?.kind === "element") {
          elements.push(node);
          if (current.sectioning) sectioningAncestors.add(node.ref);
        }
      }
      if (node !== undefined) {
        const childSectioning = current.sectioning || (node.kind === "element"
          && node.namespace === HTML_NAMESPACE_URI
          && ["article", "aside", "main", "nav", "section"].includes(node.name));
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) pending.push({ ref: child, sectioning: childSectioning });
        }
      }
    }
    mutableOutcome.outcome = { status: "complete", indexedNodes };
    if (totalNodes > limits.maxIndexedNodes) {
      markTruncated(mutableOutcome, "maxIndexedNodes", limits.maxIndexedNodes, indexedNodes);
    }

    const attribute = (ref: DocumentNodeRef, name: string, namespace: string | null = null): string | null => {
      const node = nodes.get(ref);
      if (node?.kind !== "element") return null;
      const found = node.attributes.find((entry) =>
        entry.namespace === namespace
        && (node.namespace === HTML_NAMESPACE_URI
          ? entry.name.toLowerCase() === name.toLowerCase()
          : entry.name === name)
      );
      return found?.value ?? null;
    };

    const textRanges = new Map<DocumentNodeRef, readonly [number, number]>();
    const textParts: string[] = [];
    let textLength = 0;
    let textNodesVisited = 0;
    const pendingText: ({
      readonly phase: "enter";
      readonly ref: DocumentNodeRef;
    } | {
      readonly phase: "exit";
      readonly ref: DocumentNodeRef;
      readonly start: number;
    })[] = [{ phase: "enter", ref: this.root }];
    while (pendingText.length > 0) {
      const pending = pendingText.pop();
      if (pending === undefined) continue;
      if (pending.phase === "exit") {
        textRanges.set(pending.ref, [pending.start, textLength]);
        continue;
      }
      if (textNodesVisited >= limits.maxIndexedNodes) continue;
      textNodesVisited += 1;
      const node = nodes.get(pending.ref);
      if (node === undefined) continue;
      const start = textLength;
      if (node.kind === "text") {
        const remaining = Math.max(0, limits.maxTextCodeUnits - textLength);
        const retained = node.value.slice(0, remaining);
        textParts.push(retained);
        textLength += retained.length;
        if (retained.length !== node.value.length) {
          markTruncated(mutableOutcome, "maxTextCodeUnits", limits.maxTextCodeUnits, indexedNodes);
        }
        textRanges.set(node.ref, [start, textLength]);
      } else {
        pendingText.push({ phase: "exit", ref: node.ref, start });
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) pendingText.push({ phase: "enter", ref: child });
        }
      }
    }
    this.#documentText = textParts.join("");
    this.#textRanges = textRanges;
    const text = (ref: DocumentNodeRef, maxCodeUnits = 32_768): string => {
      const range = textRanges.get(ref);
      return range === undefined ? "" : this.#documentText.slice(range[0], Math.min(range[1], range[0] + maxCodeUnits));
    };

    const accessibilityHidden = new Map<DocumentNodeRef, boolean>();
    const hiddenPending: { readonly ref: DocumentNodeRef; readonly inherited: boolean }[] = [
      { ref: this.root, inherited: false }
    ];
    while (hiddenPending.length > 0) {
      const current = hiddenPending.pop();
      if (current === undefined) continue;
      const node = nodes.get(current.ref);
      if (node === undefined) continue;
      const own = node.kind === "element"
        && (attribute(node.ref, "hidden") !== null || attribute(node.ref, "aria-hidden")?.toLowerCase() === "true");
      const hidden = current.inherited || own;
      accessibilityHidden.set(node.ref, hidden);
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) hiddenPending.push({ ref: child, inherited: hidden });
      }
    }

    const html = elements.find((element) => element.namespace === HTML_NAMESPACE_URI && element.name === "html") ?? null;
    this.documentElement = html?.ref ?? null;
    this.head = elements.find((element) => element.namespace === HTML_NAMESPACE_URI && element.name === "head")?.ref ?? null;
    this.body = elements.find((element) => element.namespace === HTML_NAMESPACE_URI && element.name === "body")?.ref ?? null;

    const elementByHtmlId = new Map<string, DocumentNodeRef>();
    for (const element of elements) {
      const id = attribute(element.ref, "id");
      if (id !== null && !elementByHtmlId.has(id)) elementByHtmlId.set(id, element.ref);
    }
    this.#elementsById = elementByHtmlId;

    const titleElement = elements.find((element) => element.namespace === HTML_NAMESPACE_URI && element.name === "title");
    this.title = cleanText(titleElement === undefined ? "" : text(titleElement.ref)) || this.finalUrl;
    const baseElement = elements.find((element) =>
      element.namespace === HTML_NAMESPACE_URI && element.name === "base" && attribute(element.ref, "href") !== null
    );
    this.baseUrl = baseElement === undefined
      ? this.finalUrl
      : resolveUrl(attribute(baseElement.ref, "href") ?? "", this.finalUrl);

    const labels: DocumentLabel[] = [];
    const labelTextByTarget = new Map<DocumentNodeRef, string>();
    for (const element of elements) {
      if (element.namespace !== HTML_NAMESPACE_URI || element.name !== "label") continue;
      const labelText = cleanText(text(element.ref));
      if (labelText.length === 0) continue;
      const explicitTarget = attribute(element.ref, "for");
      let target = explicitTarget === null ? null : elementByHtmlId.get(explicitTarget) ?? null;
      if (target === null) {
        const descendants = [...element.children].reverse();
        while (descendants.length > 0 && target === null) {
          const descendant = descendants.pop();
          const child = descendant === undefined ? undefined : nodes.get(descendant);
          if (child?.kind === "element" && ["input", "textarea", "select", "button"].includes(child.name)) {
            target = child.ref;
          } else if (child !== undefined) {
            for (let index = child.children.length - 1; index >= 0; index -= 1) {
              const nested = child.children[index];
              if (nested !== undefined) descendants.push(nested);
            }
          }
        }
      }
      if (target !== null) {
        const entry = Object.freeze({ node: element.ref, target, text: labelText });
        labels.push(entry);
        labelTextByTarget.set(target, [labelTextByTarget.get(target), labelText].filter(Boolean).join(" "));
      }
    }
    this.labels = Object.freeze(labels);
    this.#labelsByNode = new Map(labels.map((label) => [label.node, label]));

    const accessibleNames = new Map<string, string>();
    const accessibleName = (element: WebElementNode, includeContents = true): string => {
      const cacheKey = `${element.ref}:${includeContents ? "contents" : "explicit"}`;
      const cached = accessibleNames.get(cacheKey);
      if (cached !== undefined) return cached;
      const labelledBy = attribute(element.ref, "aria-labelledby");
      if (labelledBy !== null) {
        const value = labelledBy.split(/\s+/u)
          .map((id) => elementByHtmlId.get(id))
          .filter((ref): ref is DocumentNodeRef => ref !== undefined)
          .map((ref) => cleanText(text(ref)))
          .filter(Boolean)
          .join(" ");
        if (value.length > 0) {
          accessibleNames.set(cacheKey, value);
          return value;
        }
      }
      const value = cleanText(
        attribute(element.ref, "aria-label")
        ?? labelTextByTarget.get(element.ref)
        ?? attribute(element.ref, "alt")
        ?? attribute(element.ref, "title")
        ?? attribute(element.ref, "placeholder")
        ?? (includeContents ? text(element.ref) : "")
      );
      accessibleNames.set(cacheKey, value);
      return value;
    };
    const accessibleDescription = (element: WebElementNode): string => {
      const describedBy = attribute(element.ref, "aria-describedby");
      if (describedBy === null) return "";
      return describedBy.split(/\s+/u)
        .map((id) => elementByHtmlId.get(id))
        .filter((ref): ref is DocumentNodeRef => ref !== undefined)
        .map((ref) => cleanText(text(ref)))
        .filter(Boolean)
        .join(" ");
    };

    const semantics = new Map<DocumentNodeRef, DocumentSemanticEntry>();
    const landmarks: DocumentSemanticEntry[] = [];
    const nameFromContents = new Set<DocumentSemanticRole>([
      "heading", "link", "button", "listitem", "term", "definition", "cell",
      "columnheader", "rowheader", "figure", "paragraph", "blockquote", "code", "article"
    ]);
    for (const element of elements.slice(0, limits.maxIndexedNodes)) {
      const get = (name: string): string | null => attribute(element.ref, name);
      const isControl = element.namespace === HTML_NAMESPACE_URI
        && ["input", "textarea", "select", "button"].includes(element.name);
      const isReplaced = element.namespace !== HTML_NAMESPACE_URI
        || ["img", "audio", "video", "iframe", "embed", "object"].includes(element.name);
      const role = htmlRole(element, get);
      const name = accessibleName(element, nameFromContents.has(role));
      const semantic = Object.freeze({
        node: element.ref,
        role,
        landmark: landmarkFor(element, get, name, sectioningAncestors.has(element.ref)),
        accessibleName: name,
        accessibleDescription: accessibleDescription(element),
        accessibilityHidden: accessibilityHidden.get(element.ref) === true,
        behavior: element.namespace === HTML_NAMESPACE_URI && element.name === "br"
          ? "forced-break"
          : isControl
            ? "form-control"
            : isReplaced
              ? "replaced"
              : "normal"
      });
      semantics.set(element.ref, semantic);
      if (semantic.landmark !== null) landmarks.push(semantic);
    }
    this.#semantics = semantics;
    this.landmarks = Object.freeze(landmarks);

    const metadata: DocumentMetadataEntry[] = [];
    const stylesheets: DocumentStylesheetReference[] = [];
    const links: DocumentLink[] = [];
    let stylesheetOrder = 0;
    for (const element of elements.slice(0, limits.maxIndexedNodes)) {
      if (element.namespace !== HTML_NAMESPACE_URI) continue;
      if (element.name === "meta") {
        const name = attribute(element.ref, "name") ?? attribute(element.ref, "property") ?? attribute(element.ref, "http-equiv");
        const content = attribute(element.ref, "content");
        if (name !== null && content !== null) metadata.push(Object.freeze({ node: element.ref, name, content }));
      }
      if (element.name === "a" || element.name === "area") {
        const href = attribute(element.ref, "href");
        if (href !== null) {
          if (links.length < limits.maxLinks) {
            links.push(Object.freeze({
              node: element.ref,
              index: links.length + 1,
              href,
              destination: resolveUrl(href, this.baseUrl),
              label: accessibleName(element) || href
            }));
          } else markTruncated(mutableOutcome, "maxLinks", limits.maxLinks, totalNodes);
        }
      }
      if (element.name === "style") {
        if (stylesheets.length < limits.maxStylesheets) {
          stylesheets.push(Object.freeze({
            kind: "embedded",
            owner: element.ref,
            order: stylesheetOrder++,
            cssText: text(element.ref, limits.maxTextCodeUnits),
            media: attribute(element.ref, "media")
          }));
        } else markTruncated(mutableOutcome, "maxStylesheets", limits.maxStylesheets, totalNodes);
      }
      if (element.name === "link") {
        const rel = (attribute(element.ref, "rel") ?? "").toLowerCase().split(/\s+/u);
        const href = attribute(element.ref, "href");
        const type = attribute(element.ref, "type")?.trim().toLowerCase();
        if (rel.includes("stylesheet") && !rel.includes("alternate")
          && attribute(element.ref, "disabled") === null
          && (type === undefined || type === "text/css")
          && href !== null && href.trim().length > 0) {
          if (stylesheets.length < limits.maxStylesheets) {
            stylesheets.push(Object.freeze({
              kind: "external",
              owner: element.ref,
              order: stylesheetOrder++,
              href,
              destination: resolveUrl(href, this.baseUrl),
              media: attribute(element.ref, "media")
            }));
          } else markTruncated(mutableOutcome, "maxStylesheets", limits.maxStylesheets, totalNodes);
        }
      }
    }
    this.metadata = Object.freeze(metadata);
    this.stylesheets = Object.freeze(stylesheets);
    this.links = Object.freeze(links);
    this.#links = new Map(links.map((link) => [link.node, link]));

    const disabledByFieldset = new Map<DocumentNodeRef, boolean>();
    const disabledPending: {
      readonly ref: DocumentNodeRef;
      readonly inherited: boolean;
    }[] = [{ ref: this.root, inherited: false }];
    let disabledNodes = 0;
    while (disabledPending.length > 0 && disabledNodes < limits.maxIndexedNodes) {
      const pending = disabledPending.pop();
      if (pending === undefined) continue;
      disabledNodes += 1;
      const node = nodes.get(pending.ref);
      if (node === undefined) continue;
      disabledByFieldset.set(pending.ref, pending.inherited);
      if (node.kind !== "element") {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) disabledPending.push({ ref: child, inherited: pending.inherited });
        }
        continue;
      }
      const ownDisabledFieldset = node.namespace === HTML_NAMESPACE_URI
        && node.name === "fieldset"
        && attribute(node.ref, "disabled") !== null;
      const firstLegend = ownDisabledFieldset
        ? node.children.find((child) => {
          const childNode = nodes.get(child);
          return childNode?.kind === "element" && childNode.namespace === HTML_NAMESPACE_URI && childNode.name === "legend";
        })
        : undefined;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) {
          disabledPending.push({
            ref: child,
            inherited: pending.inherited || (ownDisabledFieldset && child !== firstLegend)
          });
        }
      }
    }

    const allFormElements = elements.filter((element) => element.namespace === HTML_NAMESPACE_URI && element.name === "form");
    const formElements = allFormElements.slice(0, limits.maxForms);
    if (allFormElements.length > limits.maxForms) {
      markTruncated(mutableOutcome, "maxForms", limits.maxForms, totalNodes);
    }
    const indexedForms = new Set(formElements.map((form) => form.ref));
    const allForms = new Set(allFormElements.map((form) => form.ref));
    const formOwners = new Map<DocumentNodeRef, DocumentNodeRef>();
    const treeFormOwners = new Map<DocumentNodeRef, DocumentNodeRef>();
    const ownerPending: { readonly ref: DocumentNodeRef; readonly owner: DocumentNodeRef | null }[] = [
      { ref: this.root, owner: null }
    ];
    let ownerNodes = 0;
    while (ownerPending.length > 0 && ownerNodes < limits.maxIndexedNodes) {
      const current = ownerPending.pop();
      if (current === undefined) continue;
      ownerNodes += 1;
      const node = nodes.get(current.ref);
      if (node === undefined) continue;
      const owner = allForms.has(node.ref) ? node.ref : current.owner;
      if (owner !== null) {
        treeFormOwners.set(node.ref, owner);
        if (indexedForms.has(owner)) formOwners.set(node.ref, owner);
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) ownerPending.push({ ref: child, owner });
      }
    }
    const formByHtmlId = new Map<string, DocumentNodeRef>();
    for (const form of allFormElements) {
      const id = attribute(form.ref, "id");
      if (id !== null && !formByHtmlId.has(id)) formByHtmlId.set(id, form.ref);
    }
    const controlElements = elements.filter((element) =>
      element.namespace === HTML_NAMESPACE_URI && ["input", "textarea", "select", "button"].includes(element.name)
    );
    const controlOwner = new Map<DocumentNodeRef, DocumentNodeRef>();
    const controlsWithUnindexedOwner = new Set<DocumentNodeRef>();
    for (const control of controlElements) {
      const explicitForm = attribute(control.ref, "form");
      const owner = explicitForm === null
        ? treeFormOwners.get(control.ref) ?? null
        : formByHtmlId.get(explicitForm) ?? null;
      if (owner !== null) {
        if (indexedForms.has(owner)) {
          controlOwner.set(control.ref, owner);
          formOwners.set(control.ref, owner);
        } else controlsWithUnindexedOwner.add(control.ref);
      }
    }
    const controlsByForm = new Map<DocumentNodeRef, DocumentFormControl[]>();
    const controlIndex = new Map<DocumentNodeRef, DocumentFormControl>();
    const optionIndex = new Map<DocumentNodeRef, DocumentSelectOption>();
    const formControlCount = new Map<DocumentNodeRef, number>();
    for (const element of controlElements) {
      if (controlsWithUnindexedOwner.has(element.ref)) continue;
      const owner = controlOwner.get(element.ref) ?? null;
      const budgetOwner = owner ?? this.root;
      const count = formControlCount.get(budgetOwner) ?? 0;
      if (count >= limits.maxControlsPerForm) {
        markTruncated(mutableOutcome, "maxControlsPerForm", limits.maxControlsPerForm, totalNodes);
        continue;
      }
      const common = {
        node: element.ref,
        form: owner,
        name: attribute(element.ref, "name") ?? "",
        label: accessibleName(element) || "Unnamed control",
        disabled: disabledByFieldset.get(element.ref) === true || attribute(element.ref, "disabled") !== null,
        required: attribute(element.ref, "required") !== null
      };
      const submitterMetadata = () => {
        const rawAction = attribute(element.ref, "formaction");
        const rawMethod = attribute(element.ref, "formmethod");
        const rawEncoding = attribute(element.ref, "formenctype");
        return {
          formAction: rawAction === null
            ? null
            : rawAction.trim().length === 0 ? this.finalUrl : resolveUrl(rawAction, this.baseUrl),
          formMethod: rawMethod === null ? null : normalizeMethod(rawMethod),
          formEncoding: rawEncoding === null ? null : normalizeEncoding(rawEncoding),
          formNoValidate: attribute(element.ref, "formnovalidate") !== null,
          formTarget: attribute(element.ref, "formtarget")
        } as const;
      };
      let control: DocumentFormControl;
      if (element.name === "textarea") {
        control = Object.freeze({
          ...common,
          kind: "textarea",
          defaultValue: text(element.ref, limits.maxTextCodeUnits),
          placeholder: attribute(element.ref, "placeholder"),
          readOnly: attribute(element.ref, "readonly") !== null
        });
      } else if (element.name === "select") {
        const options: {
          readonly element: WebElementNode;
          readonly disabledByGroup: boolean;
        }[] = [];
        const optionPending = element.children.map((ref) => ({ ref, disabledByGroup: false })).reverse();
        while (optionPending.length > 0 && options.length < limits.maxOptionsPerSelect) {
          const current = optionPending.pop();
          const node = current === undefined ? undefined : nodes.get(current.ref);
          if (node?.kind !== "element") continue;
          if (node.namespace === HTML_NAMESPACE_URI && node.name === "option") {
            options.push({ element: node, disabledByGroup: current?.disabledByGroup ?? false });
            continue;
          }
          const groupDisabled = (current?.disabledByGroup ?? false)
            || (node.namespace === HTML_NAMESPACE_URI && node.name === "optgroup" && attribute(node.ref, "disabled") !== null);
          for (let index = node.children.length - 1; index >= 0; index -= 1) {
            const child = node.children[index];
            if (child !== undefined) optionPending.push({ ref: child, disabledByGroup: groupDisabled });
          }
        }
        if (optionPending.length > 0) {
          markTruncated(mutableOutcome, "maxOptionsPerSelect", limits.maxOptionsPerSelect, totalNodes);
        }
        const multiple = attribute(element.ref, "multiple") !== null;
        const hasSelected = options.some(({ element: option }) => attribute(option.ref, "selected") !== null);
        const mappedOptions = options.map(({ element: option, disabledByGroup }, index) => Object.freeze({
          node: option.ref,
          select: element.ref,
          value: attribute(option.ref, "value") ?? text(option.ref, limits.maxTextCodeUnits),
          label: cleanText(text(option.ref, limits.maxTextCodeUnits)),
          defaultSelected: attribute(option.ref, "selected") !== null || (!multiple && !hasSelected && index === 0),
          disabled: disabledByGroup || attribute(option.ref, "disabled") !== null
        }));
        for (const option of mappedOptions) optionIndex.set(option.node, option);
        control = Object.freeze({ ...common, kind: "select", multiple, options: Object.freeze(mappedOptions) });
      } else if (element.name === "button") {
        const rawType = (attribute(element.ref, "type") ?? "submit").trim().toLowerCase();
        const type = rawType === "reset" || rawType === "button" ? rawType : "submit";
        if (type === "submit" || type === "reset") {
          control = Object.freeze({
            ...common,
            kind: type,
            label: cleanText(text(element.ref)) || common.label,
            value: attribute(element.ref, "value") ?? "",
            ...submitterMetadata()
          });
        } else {
          control = Object.freeze({ ...common, kind: "unsupported", inputType: type, reason: "unsupported-button" });
        }
      } else {
        const rawInputType = (attribute(element.ref, "type") ?? "text").trim().toLowerCase();
        const inputType = KNOWN_INPUT_TYPES.has(rawInputType) ? rawInputType : "text";
        const defaultValue = attribute(element.ref, "value") ?? (inputType === "checkbox" || inputType === "radio" ? "on" : "");
        if (inputType === "hidden") {
          control = Object.freeze({
            node: element.ref, form: owner, kind: "hidden", name: common.name,
            defaultValue, disabled: common.disabled
          });
        } else if (inputType === "checkbox" || inputType === "radio") {
          control = Object.freeze({
            ...common, kind: inputType, value: defaultValue,
            defaultChecked: attribute(element.ref, "checked") !== null
          });
        } else if (inputType === "submit" || inputType === "reset") {
          control = Object.freeze({
            ...common, kind: inputType,
            value: defaultValue || (inputType === "submit" ? "Submit" : "Reset"),
            ...submitterMetadata()
          });
        } else if (["text", "search", "email", "url", "tel", "password", "number"].includes(inputType)) {
          const rawMin = inputType === "number" ? finiteNumber(attribute(element.ref, "min")) : null;
          const rawMax = inputType === "number" ? finiteNumber(attribute(element.ref, "max")) : null;
          const rangeValid = rawMin === null || rawMax === null || rawMin <= rawMax;
          const rawStep = inputType === "number" ? finiteNumber(attribute(element.ref, "step")) : null;
          control = Object.freeze({
            ...common,
            kind: "text",
            inputType: inputType as "text" | "search" | "email" | "url" | "tel" | "password" | "number",
            defaultValue,
            placeholder: attribute(element.ref, "placeholder"),
            readOnly: attribute(element.ref, "readonly") !== null,
            min: rangeValid ? rawMin : null,
            max: rangeValid ? rawMax : null,
            step: rawStep !== null && rawStep > 0 ? rawStep : null
          });
        } else {
          control = Object.freeze({
            ...common,
            kind: "unsupported",
            inputType,
            reason: inputType === "file" ? "file-upload" : "unsupported-input"
          });
        }
      }
      if (owner !== null) {
        const list = controlsByForm.get(owner) ?? [];
        list.push(control);
        controlsByForm.set(owner, list);
      }
      controlIndex.set(element.ref, control);
      formControlCount.set(budgetOwner, count + 1);
    }

    const forms: DocumentForm[] = [];
    for (const element of formElements) {
      if (forms.length >= limits.maxForms) {
        markTruncated(mutableOutcome, "maxForms", limits.maxForms, totalNodes);
        break;
      }
      const controls = controlsByForm.get(element.ref) ?? [];
      const search = controls.find((control) => control.kind === "text" && control.inputType === "search");
      const legendRef = element.children.find((child) => {
        const node = nodes.get(child);
        return node?.kind === "element" && node.namespace === HTML_NAMESPACE_URI && node.name === "legend";
      });
      const label = cleanText(
        attribute(element.ref, "aria-label")
        ?? attribute(element.ref, "title")
        ?? (legendRef === undefined ? "" : text(legendRef))
      ) || (search?.kind === "text" ? search.label : `Form ${String(forms.length + 1)}`);
      const rawAction = attribute(element.ref, "action");
      const form = Object.freeze({
        node: element.ref,
        index: forms.length + 1,
        label,
        method: normalizeMethod(attribute(element.ref, "method")),
        encoding: normalizeEncoding(attribute(element.ref, "enctype")),
        action: rawAction === null || rawAction.trim().length === 0
          ? this.finalUrl
          : resolveUrl(rawAction, this.baseUrl),
        noValidate: attribute(element.ref, "novalidate") !== null,
        target: attribute(element.ref, "target"),
        controls: Object.freeze(controls),
        submitters: Object.freeze(controls.filter((control) => control.kind === "submit").map((control) => control.node))
      });
      forms.push(form);
    }
    this.forms = Object.freeze(forms);
    this.#forms = new Map(forms.map((form) => [form.node, form]));
    this.#formOwners = formOwners;
    this.#controls = controlIndex;
    this.controls = Object.freeze([...controlIndex.values()]);
    this.#options = optionIndex;
    const radioGroups = new Map<string, DocumentChoiceControl[]>();
    for (const control of this.controls) {
      if (control.kind !== "radio") continue;
      const key = control.name.length === 0
        ? control.node
        : `${control.form ?? "document"}\u0000${control.name}`;
      const group = radioGroups.get(key) ?? [];
      group.push(control);
      radioGroups.set(key, group);
    }
    const radioGroupIndex = new Map<DocumentNodeRef, readonly DocumentChoiceControl[]>();
    for (const group of radioGroups.values()) {
      const frozen = Object.freeze([...group]);
      for (const control of group) radioGroupIndex.set(control.node, frozen);
    }
    this.#radioGroups = radioGroupIndex;

    const headings: DocumentHeading[] = [];
    for (const element of elements) {
      const match = element.namespace === HTML_NAMESPACE_URI ? /^h([1-6])$/u.exec(element.name) : null;
      if (match?.[1] === undefined) continue;
      if (headings.length >= limits.maxHeadings) {
        markTruncated(mutableOutcome, "maxHeadings", limits.maxHeadings, totalNodes);
        break;
      }
      headings.push(Object.freeze({ node: element.ref, level: Number(match[1]), text: accessibleName(element) }));
    }
    this.headings = Object.freeze(headings);
    this.#headings = new Map(headings.map((heading) => [heading.node, heading]));
    const headingStack: DocumentHeading[] = [];
    const outline: DocumentOutlineEntry[] = [];
    for (const heading of headings) {
      while ((headingStack.at(-1)?.level ?? 0) >= heading.level) headingStack.pop();
      outline.push(Object.freeze({ ...heading, parentHeading: headingStack.at(-1)?.node ?? null }));
      headingStack.push(heading);
    }
    this.outline = Object.freeze(outline);

    const replaced: DocumentReplacedContent[] = [];
    const disclosures: DocumentDisclosure[] = [];
    for (const element of elements) {
      if (element.namespace === "http://www.w3.org/2000/svg") {
        if (element.parent === null || nodes.get(element.parent)?.kind !== "element"
          || (nodes.get(element.parent) as WebElementNode).namespace !== element.namespace) {
          replaced.push(Object.freeze({
            node: element.ref, kind: "svg", source: null,
            fallbackText: accessibleName(element) || "SVG image", width: null, height: null
          }));
        }
        continue;
      }
      if (element.namespace === "http://www.w3.org/1998/Math/MathML") {
        if (element.parent === null || nodes.get(element.parent)?.kind !== "element"
          || (nodes.get(element.parent) as WebElementNode).namespace !== element.namespace) {
          replaced.push(Object.freeze({
            node: element.ref, kind: "mathml", source: null,
            fallbackText: cleanText(text(element.ref)) || "Mathematical expression", width: null, height: null
          }));
        }
        continue;
      }
      if (element.namespace !== HTML_NAMESPACE_URI) continue;
      if (element.name === "img") {
        const src = attribute(element.ref, "src");
        replaced.push(Object.freeze({
          node: element.ref, kind: "image",
          source: src === null ? null : resolveUrl(src, this.baseUrl),
          fallbackText: accessibleName(element) || "Image",
          width: finiteNumber(attribute(element.ref, "width")),
          height: finiteNumber(attribute(element.ref, "height"))
        }));
      } else if (element.name === "audio" || element.name === "video") {
        const src = attribute(element.ref, "src");
        replaced.push(Object.freeze({
          node: element.ref, kind: "media",
          source: src === null ? null : resolveUrl(src, this.baseUrl),
          fallbackText: accessibleName(element) || `${element.name} content`, width: null, height: null
        }));
      } else if (element.name === "iframe" || element.name === "embed" || element.name === "object") {
        const source = attribute(element.ref, element.name === "object" ? "data" : "src");
        replaced.push(Object.freeze({
          node: element.ref, kind: "embedded",
          source: source === null ? null : resolveUrl(source, this.baseUrl),
          fallbackText: accessibleName(element) || "Embedded content", width: null, height: null
        }));
      }
      if (element.name === "details" || element.name === "dialog") {
        const summary = element.name === "details"
          ? element.children.find((child) => {
            const node = nodes.get(child);
            return node?.kind === "element" && node.namespace === HTML_NAMESPACE_URI && node.name === "summary";
          }) ?? null
          : null;
        disclosures.push(Object.freeze({
          node: element.ref,
          kind: element.name,
          initiallyOpen: attribute(element.ref, "open") !== null,
          summary
        }));
      }
    }
    this.replacedContent = Object.freeze(replaced);
    this.disclosures = Object.freeze(disclosures);
    this.#replaced = new Map(replaced.map((entry) => [entry.node, entry]));
    this.#disclosures = new Map(disclosures.map((entry) => [entry.node, entry]));

    this.diagnostics = Object.freeze(parsed.tree.errors.map((error): DocumentParserDiagnostic => Object.freeze({
      id: error.parseErrorId,
      message: error.message,
      sourceRange: sourceRange(error.span, error.span === undefined ? undefined : "input")
    })));
    this.sourceMetadata = Object.freeze({
      inputKind: parsed.metadata.inputKind,
      transportBytes: parsed.metadata.transportByteLength,
      decodedUtf8Bytes: parsed.metadata.resourceUsage.decodedUtf8Bytes,
      decodedCodeUnits: parsed.metadata.resourceUsage.decodedCodeUnits,
      encoding: parsed.metadata.encoding.name,
      encodingSource: parsed.metadata.encoding.source,
      parserNodeCount: parsed.metadata.resourceUsage.nodes,
      parserMaxDepth: parsed.metadata.resourceUsage.maxDepth
    });
    this.indexOutcome = Object.freeze(mutableOutcome.outcome);
    Object.freeze(this);
  }

  public node(ref: DocumentNodeRef): WebDocumentNode {
    const node = this.#nodes.get(ref);
    if (node === undefined) throw new RangeError(`Unknown document node reference: ${ref}`);
    return node;
  }

  public parent(ref: DocumentNodeRef): WebDocumentNode | null {
    const parent = this.node(ref).parent;
    return parent === null ? null : this.node(parent);
  }

  public children(ref: DocumentNodeRef): readonly WebDocumentNode[] {
    return this.node(ref).children.map((child) => this.node(child));
  }

  public attribute(ref: DocumentNodeRef, name: string, namespace: string | null = null): string | null {
    const node = this.node(ref);
    if (node.kind !== "element") return null;
    return node.attributes.find((entry) =>
      entry.namespace === namespace
      && (node.namespace === HTML_NAMESPACE_URI
        ? entry.name.toLowerCase() === name.toLowerCase()
        : entry.name === name)
    )?.value ?? null;
  }

  public text(ref: DocumentNodeRef, maxCodeUnits = 32_768): string {
    if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
      throw new RangeError("maxCodeUnits must be a non-negative safe integer");
    }
    const range = this.#textRanges.get(ref);
    return range === undefined ? "" : this.#documentText.slice(range[0], Math.min(range[1], range[0] + maxCodeUnits));
  }

  public textSourceRange(
    ref: DocumentNodeRef,
    startCodeUnit: number,
    endCodeUnit: number
  ): DocumentSourceRange | null {
    const node = this.node(ref);
    if (node.kind !== "text" || node.sourceRange === null || this.sourceText === null) return null;
    if (!Number.isSafeInteger(startCodeUnit) || !Number.isSafeInteger(endCodeUnit)
      || startCodeUnit < 0 || endCodeUnit < startCodeUnit || endCodeUnit > node.value.length) {
      throw new RangeError("Text source offsets must be a valid half-open range");
    }
    const retained = this.sourceText.slice(node.sourceRange.start, node.sourceRange.end);
    if (retained === node.value) {
      return Object.freeze({
        start: node.sourceRange.start + startCodeUnit,
        end: node.sourceRange.start + endCodeUnit,
        provenance: node.sourceRange.provenance
      });
    }
    if (startCodeUnit === 0 && endCodeUnit === node.value.length) return node.sourceRange;
    return null;
  }

  public semantic(ref: DocumentNodeRef): DocumentSemanticEntry | null {
    return this.#semantics.get(ref) ?? null;
  }

  public elementById(id: string): DocumentNodeRef | null {
    return this.#elementsById.get(id) ?? null;
  }

  public form(ref: DocumentNodeRef): DocumentForm | null {
    return this.#forms.get(ref) ?? null;
  }

  public formOwner(ref: DocumentNodeRef): DocumentNodeRef | null {
    this.node(ref);
    return this.#formOwners.get(ref) ?? null;
  }

  public control(ref: DocumentNodeRef): DocumentFormControl | null {
    return this.#controls.get(ref) ?? null;
  }

  public radioGroup(ref: DocumentNodeRef): readonly DocumentChoiceControl[] {
    const control = this.control(ref);
    return control?.kind === "radio"
      ? this.#radioGroups.get(ref) ?? Object.freeze([control])
      : [];
  }

  public option(ref: DocumentNodeRef): DocumentSelectOption | null {
    return this.#options.get(ref) ?? null;
  }

  public label(ref: DocumentNodeRef): DocumentLabel | null {
    return this.#labelsByNode.get(ref) ?? null;
  }

  public link(ref: DocumentNodeRef): DocumentLink | null {
    return this.#links.get(ref) ?? null;
  }

  public heading(ref: DocumentNodeRef): DocumentHeading | null {
    return this.#headings.get(ref) ?? null;
  }

  public replaced(ref: DocumentNodeRef): DocumentReplacedContent | null {
    return this.#replaced.get(ref) ?? null;
  }

  public disclosure(ref: DocumentNodeRef): DocumentDisclosure | null {
    return this.#disclosures.get(ref) ?? null;
  }

  public applySourceEdits(edits: readonly DocumentEdit[]): string {
    const parserEdits: Edit[] = edits.map((edit): Edit => {
      const target = this.#parserIds.get(edit.target);
      if (target === undefined) throw new RangeError(`Unknown document edit target: ${edit.target}`);
      if (edit.kind === "remove-node") return { kind: "removeNode", target };
      if (edit.kind === "replace-text") return { kind: "replaceText", target, value: edit.value };
      if (edit.kind === "set-attribute") return { kind: "setAttr", target, name: edit.name, value: edit.value };
      if (edit.kind === "remove-attribute") return { kind: "removeAttr", target, name: edit.name };
      if (edit.kind === "insert-html-before") return { kind: "insertHtmlBefore", target, html: edit.html };
      return { kind: "insertHtmlAfter", target, html: edit.html };
    });
    return applyPatchPlan(this.#parsed, computePatch(this.#parsed, parserEdits));
  }
}

export function createWebDocumentSnapshot(parsed: ParsedDocument, context: SnapshotContext): WebDocumentSnapshot {
  return new WebDocumentSnapshot(parsed, context);
}
