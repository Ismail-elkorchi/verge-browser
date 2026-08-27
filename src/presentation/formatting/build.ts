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
    || node.kind === "forced-line-break"
    || node.kind === "line-break-opportunity";
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

const ANONYMOUS_CONTAINER_KINDS = new Set<FormattingContainerNode["kind"]>([
  "anonymous-block",
  "anonymous-inline",
  "table-wrapper",
  "table",
  "table-column-group",
  "table-body-group",
  "table-row",
  "table-cell",
  "flex-item",
  "grid-item"
]);

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
  readonly #storedIds: FormattingNodeId[] = [];
  #anonymous = 0;
  #textCodeUnits = 0;
  #truncated: keyof FormattingBudgets | null = null;
  #contentStopped = false;

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

  #markTruncated(budget: keyof FormattingBudgets): void {
    this.#truncated ??= budget;
    this.#contentStopped = true;
  }

  #contentIsStopped(): boolean {
    return this.#contentStopped;
  }

  #reserveSlot(node: FormattingNode, anonymous: boolean): void {
    if (this.#nodes.size >= this.#budgets.maxFormattingNodes) {
      this.#markTruncated("maxFormattingNodes");
      throw new FormattingBudgetExhausted();
    }
    if (anonymous && this.#anonymous >= this.#budgets.maxAnonymousWrappers) {
      this.#markTruncated("maxAnonymousWrappers");
      throw new FormattingBudgetExhausted();
    }
    if (anonymous) this.#anonymous += 1;
    this.#nodes.set(node.id, node);
    this.#storedIds.push(node.id);
  }

  #store<T extends FormattingNode>(node: T): T {
    this.#reserveSlot(node, false);
    Object.freeze(node.children);
    const frozen = Object.freeze(node) as T;
    this.#nodes.set(node.id, frozen);
    return frozen;
  }

  #reserveContainer(
    kind: FormattingContainerNode["kind"],
    source: DocumentNodeRef | null,
    styleNode: DocumentNodeRef | null,
    outer: "block" | "inline",
    pseudo: PseudoElementIdentity | null = null,
    appliesBoxStyle = true,
    anonymous = false
  ): FormattingContainerNode {
    const documentNode = source === null ? null : this.#document.node(source);
    const open: FormattingContainerNode = {
      id: this.#id(source, kind, pseudo),
      kind,
      source,
      styleNode,
      pseudo,
      sourceRange: pseudo === null ? documentNode?.sourceRange ?? null : null,
      children: [],
      semantic: source === null || pseudo !== null || !appliesBoxStyle
        ? null
        : this.#document.semantic(source),
      outer,
      appliesBoxStyle
    };
    this.#reserveSlot(open, anonymous);
    return open;
  }

  #finalizeContainer(
    open: FormattingContainerNode,
    children: readonly FormattingNodeId[]
  ): FormattingContainerNode {
    const finalized = Object.freeze({
      ...open,
      children: Object.freeze([...children])
    });
    this.#nodes.set(open.id, finalized);
    return finalized;
  }

  #discardSubtrees(roots: readonly FormattingNodeId[]): void {
    const pending = [...roots];
    const discarded = new Set<FormattingNodeId>();
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || discarded.has(id)) continue;
      discarded.add(id);
      const node = this.#nodes.get(id);
      if (node === undefined) continue;
      pending.push(...node.children);
      if (node.source === null
        && ANONYMOUS_CONTAINER_KINDS.has(node.kind as FormattingContainerNode["kind"])) this.#anonymous -= 1;
      this.#nodes.delete(id);
    }
  }

  #transformConnectedPrefix(
    children: readonly FormattingNode[],
    transform: (retained: readonly FormattingNode[]) => readonly FormattingNodeId[]
  ): readonly FormattingNodeId[] {
    const retained = [...children];
    let remainingAttempts = retained.length + 1;
    while (remainingAttempts > 0) {
      remainingAttempts -= 1;
      const storedCheckpoint = this.#storedIds.length;
      const anonymousCheckpoint = this.#anonymous;
      try {
        return transform(retained);
      } catch (error) {
        if (!(error instanceof FormattingBudgetExhausted)) throw error;
        for (const id of this.#storedIds.splice(storedCheckpoint)) this.#nodes.delete(id);
        this.#anonymous = anonymousCheckpoint;
        const removed = retained.pop();
        if (removed === undefined) return [];
        this.#discardSubtrees([removed.id]);
      }
    }
    return [];
  }

  #anonymousContainer(
    kind: "anonymous-block" | "anonymous-inline" | "table-wrapper" | "table" | "table-column-group" | "table-body-group" | "table-row" | "table-cell" | "flex-item" | "grid-item",
    styleNode: DocumentNodeRef | null,
    children: readonly FormattingNodeId[],
    outer: "block" | "inline"
  ): FormattingContainerNode {
    return this.#finalizeContainer(
      this.#reserveContainer(kind, null, styleNode, outer, null, false, true),
      children
    );
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
      this.#markTruncated("maxTextCodeUnits");
      return null;
    }
    let retainedEnd = Math.min(text.length, remaining);
    if (retainedEnd > 0 && retainedEnd < text.length) {
      const before = text.charCodeAt(retainedEnd - 1);
      const after = text.charCodeAt(retainedEnd);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
        retainedEnd -= 1;
      }
    }
    const retained = text.slice(0, retainedEnd);
    this.#textCodeUnits += retained.length;
    if (retained.length !== text.length) this.#markTruncated("maxTextCodeUnits");
    if (retained.length === 0 && text.length > 0) return null;
    const computed = pseudo === null
      ? this.#styles.style(styleNode)
      : this.#styles.pseudo(styleNode, pseudo) ?? this.#styles.style(styleNode);
    return this.#store({
      id: this.#id(source, kind, pseudo),
      kind,
      source,
      styleNode,
      pseudo,
      sourceRange: kind === "text-sequence" && source !== null
        ? this.#document.textSourceRange(source, 0, retained.length)
        : null,
      children: [],
      semantic: null,
      outer: "inline",
      text: retained,
      whiteSpace: computed.text.whiteSpace,
      appliesBoxStyle: false
    });
  }

  #break(source: DocumentNodeRef, styleNode: DocumentNodeRef, forced: boolean): FormattingNode {
    return this.#store({
      id: this.#id(source, forced ? "forced-line-break" : "line-break-opportunity"),
      kind: forced ? "forced-line-break" : "line-break-opportunity",
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
    const display = pseudoStyle.display;
    const open = principalDisplay(display)
      ? this.#reserveContainer("pseudo-box", source, source, display.outer, identity)
      : null;
    const generated = this.#text("generated-text", source, source, text, identity);
    if (open === null) return generated;
    return this.#finalizeContainer(open, generated === null ? [] : [generated.id]);
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
      try {
        const generated = this.#generated(source, "before", pseudoBefore);
        if (generated !== null) result.push(generated);
      } catch (error) {
        if (!(error instanceof FormattingBudgetExhausted)) throw error;
      }
    }
    if (!this.#contentStopped) {
      for (const child of this.#document.node(source).children) {
        try {
          result.push(...this.#buildDocumentNode(child, source, depth + 1));
        } catch (error) {
          if (!(error instanceof FormattingBudgetExhausted)) throw error;
        }
        if (this.#contentIsStopped()) break;
      }
    }
    const pseudoAfter = this.#styles.pseudo(source, "after")?.generatedContent;
    if (!this.#contentStopped && pseudoAfter !== null && pseudoAfter !== undefined) {
      try {
        const generated = this.#generated(source, "after", pseudoAfter);
        if (generated !== null) result.push(generated);
      } catch (error) {
        if (!(error instanceof FormattingBudgetExhausted)) throw error;
      }
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
    children: readonly FormattingNode[],
    first: FormattingContainerNode
  ): readonly FormattingNode[] {
    const segments: ({ readonly kind: "inline"; readonly children: readonly FormattingNodeId[] }
      | { readonly kind: "block"; readonly node: FormattingNode })[] = [];
    let inlineRun: FormattingNodeId[] = [];
    const flush = (): void => {
      if (inlineRun.length === 0) return;
      segments.push({ kind: "inline", children: inlineRun });
      inlineRun = [];
    };
    for (const child of children) {
      if (inlineLevel(child)) inlineRun.push(child.id);
      else {
        flush();
        segments.push({ kind: "block", node: child });
      }
    }
    flush();
    const continuationCount = segments.filter((segment) => segment.kind === "inline").length;
    if (continuationCount === 0) {
      this.#nodes.delete(first.id);
      return segments.flatMap((segment) => segment.kind === "block" ? [segment.node] : []);
    }
    const continuations = [first];
    for (let index = 1; index < continuationCount; index += 1) {
      continuations.push(this.#reserveContainer("inline-container", source, source, "inline"));
    }
    let continuationIndex = 0;
    const output: FormattingNode[] = [];
    for (const segment of segments) {
      if (segment.kind === "block") output.push(segment.node);
      else {
        const open = continuations[continuationIndex];
        if (open !== undefined) output.push(this.#finalizeContainer(open, segment.children));
        continuationIndex += 1;
      }
    }
    return output;
  }

  #formattingContextItems(
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
      const style = child.styleNode === null ? null
        : child.pseudo === null
          ? this.#styles.style(child.styleNode)
          : this.#styles.pseudo(child.styleNode, child.pseudo) ?? this.#styles.style(child.styleNode);
      if (style?.box.position === "absolute" || style?.box.position === "fixed") {
        // Out-of-flow principal boxes remain children of the flex/grid container,
        // but they do not generate flex-item or grid-item boxes.
        output.push(child.id);
      } else {
        output.push(this.#anonymousContainer(kind, child.styleNode, [child.id], "block").id);
      }
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
    if (semantic?.behavior === "forced-break" || semantic?.behavior === "break-opportunity") {
      return [this.#break(source, source, semantic.behavior === "forced-break")];
    }
    if (semantic?.behavior === "form-control") {
      const control = this.#formControl(source, style);
      return control === null ? [] : [control];
    }
    if (semantic?.behavior === "replaced" || display.replaced) return [this.#replaced(source, style)];
    const internal = internalKind(display);
    if (internal === "table-column") return [this.#column(source, style)];
    const outer = display.outer;
    let kind: FormattingContainerNode["kind"];
    if (internal !== null) kind = internal as FormattingContainerNode["kind"];
    else if (display.listItem) kind = "list-item";
    else if (display.inner === "table") kind = "table";
    else if (display.inner === "flex") kind = "flex-container";
    else if (display.inner === "grid") kind = "grid-container";
    else kind = outer === "block" ? "block-container" : "inline-container";

    const open = this.#reserveContainer(kind, source, source, outer, null, kind !== "table");
    const wrapper = kind === "table"
      ? this.#reserveContainer("table-wrapper", source, source, outer)
      : null;
    let marker: FormattingNode | null = null;
    if (kind === "list-item") {
      const pseudoStyle = this.#styles.pseudo(source, "marker") ?? style;
      try {
        marker = this.#text(
          "marker",
          source,
          source,
          pseudoStyle.generatedContent ?? markerText(pseudoStyle.listStyleType, this.#listOrdinal(source)),
          "marker"
        );
      } catch (error) {
        if (!(error instanceof FormattingBudgetExhausted)) throw error;
      }
    }
    const rawChildren = this.#contentStopped ? [] : this.#rawChildren(source, depth);
    let children = this.#transformConnectedPrefix(rawChildren, (retained) => {
      if (kind === "flex-container" || kind === "grid-container") {
        return this.#formattingContextItems(
          retained,
          kind === "flex-container" ? "flex-item" : "grid-item"
        );
      }
      if (kind === "table" || kind === "table-column-group" || kind === "table-row" || kind === "table-header-group"
        || kind === "table-body-group" || kind === "table-footer-group") {
        return this.#tableFixup(retained, kind, source);
      }
      const fixedChildren = this.#tableFixup(retained, kind, source)
        .map((id) => this.#nodes.get(id))
        .filter((node): node is FormattingNode => node !== undefined);
      if (kind === "inline-container" && display.inner === "flow"
        && fixedChildren.some((child) => !inlineLevel(child))) {
        return this.#inlineContinuations(source, fixedChildren, open).map((node) => node.id);
      }
      return this.#mixedFlow(fixedChildren, source);
    });

    if (!this.#nodes.has(open.id) || children.includes(open.id)) {
      return children
        .map((id) => this.#nodes.get(id))
        .filter((node): node is FormattingNode => node !== undefined);
    }
    if (marker !== null) children = [marker.id, ...children];

    const container = this.#finalizeContainer(open, children);
    if (kind !== "table") return [container];
    if (wrapper === null) throw new Error("Missing reserved table wrapper");
    return [this.#finalizeContainer(wrapper, [container.id])];
  }

  #buildDocumentNode(source: DocumentNodeRef, parentStyleNode: DocumentNodeRef, depth: number): FormattingNode[] {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) {
      this.#markTruncated("maxDepth");
      return [];
    }
    if (this.#contentStopped) return [];
    const node = this.#document.node(source);
    if (node.kind === "text") {
      const text = this.#text("text-sequence", source, parentStyleNode, node.value);
      return text === null ? [] : [text];
    }
    if (node.kind !== "element") return [];
    return this.#buildElement(source, depth);
  }

  public build(): FormattingTree {
    const openRoot = this.#reserveContainer(
      "root",
      null,
      this.#document.documentElement,
      "block",
      null,
      false
    );
    if (this.#styles.document !== this.#document) {
      const rejected = this.#finalizeContainer(openRoot, []);
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
      if (this.#contentStopped) break;
    }
    const root = this.#finalizeContainer(openRoot, rootChildren);
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
