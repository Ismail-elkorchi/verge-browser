import {
  snapshotDocumentState,
  type DocumentNodeRef,
  type DocumentState,
  type IndexedWebDocumentSnapshot
} from "../../document/index.js";
import type {
  ComputedDisplay,
  ComputedStyle,
  PseudoElementIdentity,
  StyleSnapshot
} from "../style/index.js";
import type {
  BuildFormattingTreeInput,
  FormattingBudgets,
  FormattingColumnNode,
  FormattingContainerNode,
  FormattingFormControlNode,
  FormattingNode,
  FormattingNodeId,
  FormattingOutcome,
  FormattingReplacedNode,
  FormattingTextNode,
  FormattingTree,
  SuppressedFormattingSubtree
} from "./types.js";

const DEFAULT_FORMATTING_BUDGETS: FormattingBudgets = Object.freeze({
  maxFormattingNodes: 150_000,
  maxDepth: 1_024,
  maxTextCodeUnits: 8 * 1024 * 1024,
  maxAnonymousWrappers: 50_000
});

function normalizedBudgets(overrides: Partial<FormattingBudgets> | undefined): FormattingBudgets {
  const result = { ...DEFAULT_FORMATTING_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function formatId(value: string): FormattingNodeId {
  return value as FormattingNodeId;
}

function markerText(type: ComputedStyle["listStyleType"], ordinal: number): string {
  if (type === "none") return "";
  if (type === "disc") return "•";
  if (type === "circle") return "◦";
  if (type === "square") return "▪";
  if (type === "decimal") return `${String(ordinal)}.`;
  if (type === "decimal-leading-zero") return `${String(ordinal).padStart(2, "0")}.`;
  const alpha = (value: number): string => {
    let current = Math.max(1, value);
    let output = "";
    while (current > 0) {
      current -= 1;
      output = String.fromCharCode(97 + current % 26) + output;
      current = Math.floor(current / 26);
    }
    return output;
  };
  const value = alpha(ordinal);
  return `${type === "upper-alpha" ? value.toUpperCase() : value}.`;
}

function internalKind(display: ComputedDisplay): FormattingNode["kind"] | null {
  if (display.box !== "principal" || display.internal === null) return null;
  const kinds: Readonly<Record<NonNullable<typeof display.internal>, FormattingNode["kind"]>> = {
    "table-row-group": "table-body-group",
    "table-header-group": "table-header-group",
    "table-footer-group": "table-footer-group",
    "table-row": "table-row",
    "table-cell": "table-cell",
    "table-column-group": "table-column-group",
    "table-column": "table-column",
    "table-caption": "table-caption"
  };
  return kinds[display.internal];
}

function inlineLevel(node: FormattingNode): boolean {
  return node.outer === "inline"
    || node.kind === "text-sequence"
    || node.kind === "marker"
    || node.kind === "forced-line-break";
}

function collapsesEntireTextRun(node: FormattingNode): boolean {
  return node.kind === "text-sequence"
    && (node.whiteSpace === "normal" || node.whiteSpace === "nowrap")
    && /^\s*$/u.test(node.text);
}

function principalDisplay(
  display: ComputedStyle["display"]
): display is Extract<ComputedStyle["display"], { readonly box: "principal" }> {
  return display.box === "principal";
}

class FormattingBudgetExhausted extends Error {}

class FormattingBuilder {
  readonly #input: BuildFormattingTreeInput;
  readonly #document: IndexedWebDocumentSnapshot;
  readonly #state: DocumentState;
  readonly #styles: StyleSnapshot;
  readonly #budgets: FormattingBudgets;
  readonly #nodes = new Map<FormattingNodeId, FormattingNode>();
  readonly #suppressed: SuppressedFormattingSubtree[] = [];
  readonly #sourceIndex = new Map<DocumentNodeRef, FormattingNodeId[]>();
  readonly #ordinalBySource = new Map<string, number>();
  readonly #listOrdinals = new Map<DocumentNodeRef, number>();
  readonly #indexedListParents = new Set<DocumentNodeRef>();
  #anonymous = 0;
  #textCodeUnits = 0;
  #truncated: keyof FormattingBudgets | null = null;

  public constructor(input: BuildFormattingTreeInput) {
    this.#input = input;
    this.#document = input.document;
    this.#state = snapshotDocumentState(input.state);
    this.#styles = input.styles;
    this.#budgets = normalizedBudgets(input.budgets);
  }

  #id(source: DocumentNodeRef | null, kind: FormattingNode["kind"], pseudo: PseudoElementIdentity | null = null): FormattingNodeId {
    const identity = `${source ?? "anonymous"}:${pseudo ?? kind}`;
    const ordinal = (this.#ordinalBySource.get(identity) ?? 0) + 1;
    this.#ordinalBySource.set(identity, ordinal);
    return formatId(`format:${identity}:${String(ordinal)}`);
  }

  #store<T extends FormattingNode>(node: T, root = false): T {
    if (!root && this.#nodes.size >= this.#budgets.maxFormattingNodes - 1) {
      this.#truncated ??= "maxFormattingNodes";
      throw new FormattingBudgetExhausted();
    }
    Object.freeze(node.children);
    const frozen = Object.freeze(node) as T;
    this.#nodes.set(node.id, frozen);
    if (node.source !== null) {
      const entries = this.#sourceIndex.get(node.source) ?? [];
      entries.push(node.id);
      this.#sourceIndex.set(node.source, entries);
    }
    return frozen;
  }

  #container(
    kind: FormattingContainerNode["kind"],
    source: DocumentNodeRef | null,
    styleNode: DocumentNodeRef | null,
    children: readonly FormattingNodeId[],
    outer: "block" | "inline",
    pseudo: PseudoElementIdentity | null = null,
    root = false,
    appliesBoxStyle = !root,
    semanticOwner = appliesBoxStyle
  ): FormattingContainerNode {
    const documentNode = source === null ? null : this.#document.node(source);
    return this.#store({
      id: this.#id(source, kind, pseudo),
      kind,
      source,
      styleNode,
      pseudo,
      sourceRange: pseudo === null ? documentNode?.sourceRange ?? null : null,
      children: [...children],
      semantic: source === null || pseudo !== null || !semanticOwner
        ? null
        : this.#document.semantic(source),
      outer,
      appliesBoxStyle
    }, root);
  }

  #anonymousContainer(
    kind: "anonymous-block" | "anonymous-inline" | "table-wrapper" | "table" | "table-column-group" | "table-body-group" | "table-row" | "table-cell" | "flex-item" | "grid-item",
    styleNode: DocumentNodeRef | null,
    children: readonly FormattingNodeId[],
    outer: "block" | "inline"
  ): FormattingContainerNode {
    this.#anonymous += 1;
    if (this.#anonymous > this.#budgets.maxAnonymousWrappers) {
      this.#truncated ??= "maxAnonymousWrappers";
      throw new FormattingBudgetExhausted();
    }
    return this.#container(kind, null, styleNode, children, outer, null, false, false);
  }

  #text(
    kind: FormattingTextNode["kind"],
    source: DocumentNodeRef | null,
    styleNode: DocumentNodeRef,
    text: string,
    pseudo: PseudoElementIdentity | null = null
  ): FormattingTextNode | null {
    const remaining = this.#budgets.maxTextCodeUnits - this.#textCodeUnits;
    if (remaining <= 0) {
      this.#truncated ??= "maxTextCodeUnits";
      return null;
    }
    const retained = text.slice(0, remaining);
    this.#textCodeUnits += retained.length;
    if (retained.length !== text.length) this.#truncated ??= "maxTextCodeUnits";
    const documentNode = source === null ? null : this.#document.node(source);
    const computed = pseudo === null
      ? this.#styles.style(styleNode)
      : this.#styles.pseudo(styleNode, pseudo) ?? this.#styles.style(styleNode);
    return this.#store({
      id: this.#id(source, kind, pseudo),
      kind,
      source,
      styleNode,
      pseudo,
      sourceRange: kind === "text-sequence" ? documentNode?.sourceRange ?? null : null,
      children: [],
      semantic: null,
      outer: "inline",
      text: retained,
      whiteSpace: computed.text.whiteSpace,
      appliesBoxStyle: false
    });
  }

  #break(source: DocumentNodeRef, styleNode: DocumentNodeRef): FormattingNode {
    return this.#store({
      id: this.#id(source, "forced-line-break"),
      kind: "forced-line-break",
      source,
      styleNode,
      pseudo: null,
      sourceRange: this.#document.node(source).sourceRange,
      children: [],
      semantic: null,
      outer: "inline",
      appliesBoxStyle: false
    });
  }

  #replaced(source: DocumentNodeRef, style: ComputedStyle): FormattingReplacedNode {
    const metadata = this.#document.replaced(source);
    return this.#store({
      id: this.#id(source, metadata?.kind === "image" ? "image-fallback" : "replaced-element"),
      kind: metadata?.kind === "image" ? "image-fallback" : "replaced-element",
      source,
      styleNode: source,
      pseudo: null,
      sourceRange: this.#document.node(source).sourceRange,
      children: [],
      semantic: this.#document.semantic(source),
      outer: style.display.box === "principal" ? style.display.outer : "inline",
      fallbackText: metadata?.fallbackText ?? this.#document.semantic(source)?.accessibleName ?? "Embedded content",
      intrinsicWidth: metadata?.width ?? null,
      intrinsicHeight: metadata?.height ?? null,
      appliesBoxStyle: true
    });
  }

  #formControl(source: DocumentNodeRef, style: ComputedStyle): FormattingFormControlNode | null {
    const control = this.#document.control(source);
    if (control === null || control.kind === "hidden") return null;
    return this.#store({
      id: this.#id(source, "form-control"),
      kind: "form-control",
      source,
      styleNode: source,
      pseudo: null,
      sourceRange: this.#document.node(source).sourceRange,
      children: [],
      semantic: this.#document.semantic(source),
      outer: style.display.box === "principal" ? style.display.outer : "inline",
      control,
      appliesBoxStyle: true
    });
  }

  #column(source: DocumentNodeRef, style: ComputedStyle): FormattingColumnNode {
    const rawSpan = Number(this.#document.attribute(source, "span") ?? "1");
    return this.#store({
      id: this.#id(source, "table-column"),
      kind: "table-column",
      source,
      styleNode: source,
      pseudo: null,
      sourceRange: this.#document.node(source).sourceRange,
      children: [],
      semantic: this.#document.semantic(source),
      outer: style.display.box === "principal" ? style.display.outer : "block",
      span: Number.isSafeInteger(rawSpan) && rawSpan > 0 ? Math.min(1_000, rawSpan) : 1,
      appliesBoxStyle: true
    });
  }

  #generated(source: DocumentNodeRef, identity: "before" | "after", text: string): FormattingNode | null {
    const pseudoStyle = this.#styles.pseudo(source, identity);
    if (pseudoStyle === null || pseudoStyle.display.box === "none") return null;
    const generated = this.#text("generated-text", source, source, text, identity);
    const display = pseudoStyle.display;
    if (generated === null || !principalDisplay(display)) return generated;
    return this.#container(
      "pseudo-box",
      source,
      source,
      [generated.id],
      display.outer,
      identity
    );
  }

  #listOrdinal(source: DocumentNodeRef): number {
    const parent = this.#document.parent(source)?.ref;
    if (parent === undefined) return 1;
    if (!this.#indexedListParents.has(parent)) {
      this.#indexedListParents.add(parent);
      let ordinal = 0;
      for (const sibling of this.#document.node(parent).children) {
        const node = this.#document.node(sibling);
        if (node.kind !== "element") continue;
        const display = this.#styles.style(sibling).display;
        if (display.box !== "principal" || !display.listItem) continue;
        ordinal += 1;
        this.#listOrdinals.set(sibling, ordinal);
      }
    }
    return this.#listOrdinals.get(source) ?? 1;
  }

  #rawChildren(source: DocumentNodeRef, depth: number): FormattingNode[] {
    const result: FormattingNode[] = [];
    const pseudoBefore = this.#styles.pseudo(source, "before")?.generatedContent;
    if (pseudoBefore !== null && pseudoBefore !== undefined) {
      const generated = this.#generated(source, "before", pseudoBefore);
      if (generated !== null) result.push(generated);
    }
    for (const child of this.#document.node(source).children) {
      result.push(...this.#buildDocumentNode(child, source, depth + 1));
    }
    const pseudoAfter = this.#styles.pseudo(source, "after")?.generatedContent;
    if (pseudoAfter !== null && pseudoAfter !== undefined) {
      const generated = this.#generated(source, "after", pseudoAfter);
      if (generated !== null) result.push(generated);
    }
    return result;
  }

  #mixedFlow(children: readonly FormattingNode[], styleNode: DocumentNodeRef): readonly FormattingNodeId[] {
    const hasBlock = children.some((child) => !inlineLevel(child));
    if (!hasBlock) return children.map((child) => child.id);
    const output: FormattingNodeId[] = [];
    let inlineRun: FormattingNodeId[] = [];
    const flush = (): void => {
      if (inlineRun.length === 0) return;
      const inline = this.#anonymousContainer("anonymous-inline", styleNode, inlineRun, "inline");
      const block = this.#anonymousContainer("anonymous-block", styleNode, [inline.id], "block");
      output.push(block.id);
      inlineRun = [];
    };
    for (const child of children) {
      if (inlineLevel(child)) inlineRun.push(child.id);
      else {
        flush();
        output.push(child.id);
      }
    }
    flush();
    return output;
  }

  #inlineContinuations(
    source: DocumentNodeRef,
    children: readonly FormattingNode[]
  ): readonly FormattingNode[] {
    const output: FormattingNode[] = [];
    let inlineRun: FormattingNodeId[] = [];
    let semanticOwner = true;
    const continuation = (): void => {
      output.push(this.#container(
        "inline-container",
        source,
        source,
        inlineRun,
        "inline",
        null,
        false,
        true,
        semanticOwner
      ));
      semanticOwner = false;
      inlineRun = [];
    };
    for (const child of children) {
      if (inlineLevel(child)) inlineRun.push(child.id);
      else {
        continuation();
        output.push(child);
      }
    }
    continuation();
    return output;
  }

  #independentFormattingItems(
    children: readonly FormattingNode[],
    kind: "flex-item" | "grid-item"
  ): readonly FormattingNodeId[] {
    const output: FormattingNodeId[] = [];
    let textRun: FormattingNode[] = [];
    const flushText = (): void => {
      if (textRun.length === 0) return;
      if (!textRun.every(collapsesEntireTextRun)) {
        output.push(this.#anonymousContainer(
          kind,
          textRun.find((node) => node.styleNode !== null)?.styleNode ?? null,
          textRun.map((node) => node.id),
          "block"
        ).id);
      }
      textRun = [];
    };
    for (const child of children) {
      if (child.kind === "text-sequence") {
        textRun.push(child);
        continue;
      }
      flushText();
      output.push(this.#anonymousContainer(kind, child.styleNode, [child.id], "block").id);
    }
    flushText();
    return output;
  }

  #tableFixup(children: readonly FormattingNode[], parent: FormattingNode["kind"], styleNode: DocumentNodeRef): readonly FormattingNodeId[] {
    const cells = new Set(["table-cell"]);
    const rows = new Set(["table-row"]);
    const groups = new Set(["table-header-group", "table-body-group", "table-footer-group"]);
    const hasTableInternal = children.some((child) => cells.has(child.kind) || rows.has(child.kind)
      || groups.has(child.kind) || child.kind === "table-caption" || child.kind === "table-column-group"
      || child.kind === "table-column");
    const normalizedChildren = hasTableInternal
      ? children.filter((child) => !collapsesEntireTextRun(child))
      : children;
    const expected = (kind: FormattingNode["kind"]): boolean => {
      if (parent === "table-row") return cells.has(kind);
      if (parent === "table-column-group") return kind === "table-column";
      if (groups.has(parent)) return rows.has(kind);
      if (parent === "table") return groups.has(kind) || kind === "table-caption" || kind === "table-column-group";
      return !cells.has(kind) && !rows.has(kind) && !groups.has(kind) && kind !== "table-caption" && kind !== "table-column-group" && kind !== "table-column";
    };
    if (normalizedChildren.every((child) => expected(child.kind))) return normalizedChildren.map((child) => child.id);
    if (parent === "table-column-group") {
      return normalizedChildren.filter((child) => child.kind === "table-column").map((child) => child.id);
    }
    if (parent === "table-row") {
      return normalizedChildren.map((child) => cells.has(child.kind)
        ? child.id
        : this.#anonymousContainer("table-cell", styleNode, [child.id], "block").id);
    }
    if (groups.has(parent)) {
      const output: FormattingNodeId[] = [];
      let cellsRun: FormattingNodeId[] = [];
      const flush = (): void => {
        if (cellsRun.length === 0) return;
        output.push(this.#anonymousContainer("table-row", styleNode, cellsRun, "block").id);
        cellsRun = [];
      };
      for (const child of normalizedChildren) {
        if (child.kind === "table-row") {
          flush();
          output.push(child.id);
        } else if (child.kind === "table-cell") cellsRun.push(child.id);
        else cellsRun.push(this.#anonymousContainer("table-cell", styleNode, [child.id], "block").id);
      }
      flush();
      return output;
    }
    if (parent === "table") {
      const output: FormattingNodeId[] = [];
      let rowsRun: FormattingNodeId[] = [];
      let cellsRun: FormattingNodeId[] = [];
      let columnsRun: FormattingNodeId[] = [];
      const flushCells = (): void => {
        if (cellsRun.length === 0) return;
        rowsRun.push(this.#anonymousContainer("table-row", styleNode, cellsRun, "block").id);
        cellsRun = [];
      };
      const flushRows = (): void => {
        flushCells();
        if (rowsRun.length === 0) return;
        output.push(this.#anonymousContainer("table-body-group", styleNode, rowsRun, "block").id);
        rowsRun = [];
      };
      const flushColumns = (): void => {
        if (columnsRun.length === 0) return;
        output.push(this.#anonymousContainer("table-column-group", styleNode, columnsRun, "block").id);
        columnsRun = [];
      };
      const flushAll = (): void => {
        flushRows();
        flushColumns();
      };
      for (const child of normalizedChildren) {
        if (child.kind === "table-caption") {
          flushAll();
          output.push(child.id);
        } else if (child.kind === "table-column") {
          flushRows();
          columnsRun.push(child.id);
        } else if (child.kind === "table-column-group") {
          flushAll();
          output.push(child.id);
        } else if (groups.has(child.kind)) {
          flushAll();
          output.push(child.id);
        } else if (child.kind === "table-row") {
          flushColumns();
          flushCells();
          rowsRun.push(child.id);
        } else if (child.kind === "table-cell") {
          flushColumns();
          cellsRun.push(child.id);
        } else {
          flushColumns();
          cellsRun.push(this.#anonymousContainer("table-cell", styleNode, [child.id], "block").id);
        }
      }
      flushAll();
      return output;
    }
    const output: FormattingNodeId[] = [];
    let internalRun: FormattingNode[] = [];
    const flush = (): void => {
      if (internalRun.length === 0) return;
      const tableChildren = this.#tableFixup(internalRun, "table", styleNode);
      const table = this.#anonymousContainer("table", styleNode, tableChildren, "block");
      output.push(this.#anonymousContainer("table-wrapper", styleNode, [table.id], "block").id);
      internalRun = [];
    };
    for (const child of normalizedChildren) {
      if (expected(child.kind)) {
        flush();
        output.push(child.id);
        continue;
      }
      internalRun.push(child);
    }
    flush();
    return output;
  }

  #buildElement(source: DocumentNodeRef, depth: number): FormattingNode[] {
    const style = this.#styles.style(source);
    const display = style.display;
    const semantic = this.#document.semantic(source);
    if (!principalDisplay(display)) {
      if (display.box === "none") this.#suppressed.push({ source, reason: "display-none" });
      else return this.#rawChildren(source, depth);
      return [];
    }
    if (semantic?.behavior === "forced-break") return [this.#break(source, source)];
    if (semantic?.behavior === "form-control") {
      const control = this.#formControl(source, style);
      return control === null ? [] : [control];
    }
    if (semantic?.behavior === "replaced" || display.replaced) return [this.#replaced(source, style)];
    const internal = internalKind(display);
    if (internal === "table-column") return [this.#column(source, style)];
    const rawChildren = this.#rawChildren(source, depth);
    const outer = display.outer;
    let kind: FormattingContainerNode["kind"];
    if (internal !== null) kind = internal as FormattingContainerNode["kind"];
    else if (display.listItem) kind = "list-item";
    else if (display.inner === "table") kind = "table";
    else if (display.inner === "flex") kind = "flex-container";
    else if (display.inner === "grid") kind = "grid-container";
    else kind = outer === "block" ? "block-container" : "inline-container";

    let children: readonly FormattingNodeId[];
    if (kind === "flex-container" || kind === "grid-container") {
      children = this.#independentFormattingItems(
        rawChildren,
        kind === "flex-container" ? "flex-item" : "grid-item"
      );
    } else if (kind === "table" || kind === "table-column-group" || kind === "table-row" || kind === "table-header-group"
      || kind === "table-body-group" || kind === "table-footer-group") {
      children = this.#tableFixup(rawChildren, kind, source);
    } else {
      const fixedChildren = this.#tableFixup(rawChildren, kind, source)
        .map((id) => this.#nodes.get(id))
        .filter((node): node is FormattingNode => node !== undefined);
      if (kind === "inline-container" && display.inner === "flow"
        && fixedChildren.some((child) => !inlineLevel(child))) {
        return [...this.#inlineContinuations(source, fixedChildren)];
      }
      children = this.#mixedFlow(fixedChildren, source);
    }

    if (kind === "list-item") {
      const pseudoStyle = this.#styles.pseudo(source, "marker") ?? style;
      const marker = this.#text(
        "marker",
        source,
        source,
        pseudoStyle.generatedContent ?? markerText(pseudoStyle.listStyleType, this.#listOrdinal(source)),
        "marker"
      );
      if (marker !== null) children = [marker.id, ...children];
    }

    const container = this.#container(kind, source, source, children, outer, null, false, kind !== "table");
    if (kind !== "table") return [container];
    return [this.#container("table-wrapper", source, source, [container.id], outer)];
  }

  #buildDocumentNode(source: DocumentNodeRef, parentStyleNode: DocumentNodeRef, depth: number): FormattingNode[] {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) {
      this.#truncated ??= "maxDepth";
      return [];
    }
    if (this.#nodes.size >= this.#budgets.maxFormattingNodes - 1) {
      this.#truncated ??= "maxFormattingNodes";
      return [];
    }
    const node = this.#document.node(source);
    if (node.kind === "text") {
      const text = this.#text("text-sequence", source, parentStyleNode, node.value);
      return text === null ? [] : [text];
    }
    if (node.kind !== "element") return [];
    return this.#buildElement(source, depth);
  }

  public build(): FormattingTree {
    if (this.#styles.document !== this.#document) {
      const rejected = this.#container("root", null, null, [], "block", null, true);
      return new ImmutableFormattingTree(
        this.#document,
        this.#state,
        this.#styles,
        rejected.id,
        this.#nodes,
        this.#sourceIndex,
        this.#suppressed,
        { status: "rejected", reason: "document-style-mismatch" }
      );
    }
    const rootChildren: FormattingNodeId[] = [];
    for (const child of this.#document.node(this.#document.root).children) {
      try {
        rootChildren.push(...this.#buildDocumentNode(
          child,
          this.#document.documentElement ?? this.#document.root,
          1
        ).map((node) => node.id));
      } catch (error) {
        if (!(error instanceof FormattingBudgetExhausted)) throw error;
        break;
      }
      if (this.#truncated === "maxFormattingNodes") break;
    }
    const root = this.#container("root", null, this.#document.documentElement, rootChildren, "block", null, true);
    const reachable = new Set<FormattingNodeId>();
    const pending = [root.id];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || reachable.has(id)) continue;
      reachable.add(id);
      const node = this.#nodes.get(id);
      if (node !== undefined) pending.push(...node.children);
    }
    for (const id of this.#nodes.keys()) {
      if (!reachable.has(id)) this.#nodes.delete(id);
    }
    this.#sourceIndex.clear();
    for (const node of this.#nodes.values()) {
      if (node.source === null) continue;
      const entries = this.#sourceIndex.get(node.source) ?? [];
      entries.push(node.id);
      this.#sourceIndex.set(node.source, entries);
    }
    const outcome: FormattingOutcome = this.#truncated === null
      ? { status: "complete", nodes: this.#nodes.size }
      : {
          status: "truncated",
          nodes: this.#nodes.size,
          budget: this.#truncated,
          limit: this.#budgets[this.#truncated]
        };
    return new ImmutableFormattingTree(
      this.#document,
      this.#state,
      this.#styles,
      root.id,
      this.#nodes,
      this.#sourceIndex,
      this.#suppressed,
      outcome
    );
  }
}

class ImmutableFormattingTree implements FormattingTree {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly styles: StyleSnapshot;
  readonly root: FormattingNodeId;
  readonly suppressed: readonly SuppressedFormattingSubtree[];
  readonly outcome: FormattingOutcome;
  readonly #nodes: ReadonlyMap<FormattingNodeId, FormattingNode>;
  readonly #parents: ReadonlyMap<FormattingNodeId, FormattingNodeId>;
  readonly #sourceIndex: ReadonlyMap<DocumentNodeRef, readonly FormattingNodeId[]>;

  public constructor(
    document: IndexedWebDocumentSnapshot,
    state: DocumentState,
    styles: StyleSnapshot,
    root: FormattingNodeId,
    nodes: ReadonlyMap<FormattingNodeId, FormattingNode>,
    sourceIndex: ReadonlyMap<DocumentNodeRef, readonly FormattingNodeId[]>,
    suppressed: readonly SuppressedFormattingSubtree[],
    outcome: FormattingOutcome
  ) {
    this.document = document;
    this.state = state;
    this.styles = styles;
    this.root = root;
    this.#nodes = nodes;
    this.#sourceIndex = sourceIndex;
    this.suppressed = Object.freeze(suppressed.map((entry) => Object.freeze(entry)));
    this.outcome = Object.freeze(outcome);
    const parents = new Map<FormattingNodeId, FormattingNodeId>();
    for (const node of nodes.values()) {
      for (const child of node.children) parents.set(child, node.id);
    }
    this.#parents = parents;
    Object.freeze(this);
  }

  public node(id: FormattingNodeId): FormattingNode {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new RangeError(`Unknown formatting node: ${id}`);
    return node;
  }

  public parent(id: FormattingNodeId): FormattingNode | null {
    const parent = this.#parents.get(id);
    return parent === undefined ? null : this.node(parent);
  }

  public children(id: FormattingNodeId): readonly FormattingNode[] {
    return this.node(id).children.map((child) => this.node(child));
  }

  public forSource(source: DocumentNodeRef): readonly FormattingNode[] {
    return (this.#sourceIndex.get(source) ?? []).map((id) => this.node(id));
  }
}

export function buildFormattingTree(input: BuildFormattingTreeInput): FormattingTree {
  return new FormattingBuilder(input).build();
}
