import type {
  DocumentNodeRef,
  DocumentSemanticEntry,
  DocumentSourceRange
} from "../../document/index.js";
import type { BidiClass } from "../../unicode/index.js";
import {
  formattingNodeLogicalText,
  documentActionIdentity,
  isAtomicInlineBox,
  isInlineFormattingNode,
  type DocumentActionIdentity,
  type FormattingNode,
  type FormattingNodeId,
  type FormattingTree
} from "../formatting/index.js";
import type { ComputedWhiteSpace, PseudoElementIdentity } from "../style/index.js";
import { processCssText, type LogicalTextUnit, type ProcessedCssText } from "./css-text.js";

export type InlineItemStreamId = string & { readonly __inlineItemStreamId: unique symbol };

interface InlineItemIdentity {
  readonly formattingNode: FormattingNodeId | null;
  readonly documentNode: DocumentNodeRef | null;
  readonly pseudoElement: PseudoElementIdentity | null;
  readonly action: DocumentActionIdentity | null;
  readonly semantic: DocumentSemanticEntry | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
}

export interface InlineTextItem extends InlineItemIdentity {
  readonly kind: "text" | "tab" | "soft-hyphen";
  readonly text: string;
  readonly collapsibleSpace: boolean;
  readonly whiteSpace: ComputedWhiteSpace;
}

export interface InlineAtomicItem extends InlineItemIdentity {
  readonly kind: "atomic-inline";
  readonly text: "\ufffc";
}

export interface InlineForcedBreakItem extends InlineItemIdentity {
  readonly kind: "forced-line-break";
  readonly text: "";
}

export interface InlineBreakOpportunityItem extends InlineItemIdentity {
  readonly kind: "break-opportunity";
  readonly text: "";
}

export interface InlineStructuralBidiControlItem extends InlineItemIdentity {
  readonly kind: "structural-bidi-control";
  readonly text: "";
  readonly bidiClass: BidiClass;
}

export interface InlineBlockBoundaryItem extends InlineItemIdentity {
  readonly kind: "block-boundary";
  readonly text: "";
}

export type InlineItem = InlineTextItem
  | InlineAtomicItem
  | InlineForcedBreakItem
  | InlineBreakOpportunityItem
  | InlineStructuralBidiControlItem
  | InlineBlockBoundaryItem;

export interface InlineItemStream {
  readonly id: InlineItemStreamId;
  readonly containingFormattingBox: FormattingNodeId;
  readonly roots: readonly FormattingNodeId[];
  readonly items: readonly InlineItem[];
  readonly graphemeClusters: number;
  readonly collapsibleSpacePending: boolean;
}

export interface InlineItemStreamSet {
  readonly formatting: FormattingTree;
  readonly streams: readonly InlineItemStream[];
  stream(containingFormattingBox: FormattingNodeId, roots: readonly FormattingNodeId[]): InlineItemStream;
  textForFormattingNode(formattingNode: FormattingNodeId): ProcessedCssText | null;
}

function streamKey(containingFormattingBox: FormattingNodeId, roots: readonly FormattingNodeId[]): string {
  return `${containingFormattingBox}\u0000${roots.join("\u0000")}`;
}

function computed(tree: FormattingTree, node: FormattingNode) {
  if (node.styleNode === null) return null;
  return node.pseudo === null
    ? tree.styles.style(node.styleNode)
    : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
}

function semanticIdentity(tree: FormattingTree, node: FormattingNode): DocumentSemanticEntry | null {
  let current: FormattingNode | null = node;
  while (current !== null) {
    if (current.semantic !== null) return current.semantic;
    current = tree.parent(current.id);
  }
  return null;
}

function unitSourceRange(
  tree: FormattingTree,
  node: FormattingNode,
  unit: LogicalTextUnit
): DocumentSourceRange | null {
  if (node.kind === "text-sequence" && node.source !== null) {
    return tree.document.textSourceRange(node.source, unit.contentStartCodeUnit, unit.contentEndCodeUnit);
  }
  const range = node.sourceRange;
  if (range === null) return null;
  const logicalText = formattingNodeLogicalText(node, tree);
  if (logicalText !== null && range.end - range.start === logicalText.length) {
    return Object.freeze({
      start: range.start + unit.contentStartCodeUnit,
      end: range.start + unit.contentEndCodeUnit,
      provenance: range.provenance
    });
  }
  return range;
}

function structuralControls(node: FormattingNode, tree: FormattingTree): {
  readonly before: readonly BidiClass[];
  readonly after: readonly BidiClass[];
} {
  const style = computed(tree, node);
  if (style === null || style.text.unicodeBidi === "normal") return { before: [], after: [] };
  const isolate = style.text.direction === "rtl" ? "RLI" as const : "LRI" as const;
  const embedding = style.text.direction === "rtl" ? "RLE" as const : "LRE" as const;
  const override = style.text.direction === "rtl" ? "RLO" as const : "LRO" as const;
  if (style.text.unicodeBidi === "embed") return { before: [embedding], after: ["PDF"] };
  if (style.text.unicodeBidi === "bidi-override") return { before: [override], after: ["PDF"] };
  if (style.text.unicodeBidi === "isolate") return { before: [isolate], after: ["PDI"] };
  if (style.text.unicodeBidi === "isolate-override") return { before: [isolate, override], after: ["PDF", "PDI"] };
  return { before: [], after: [] };
}

function baseIdentity(tree: FormattingTree, node: FormattingNode): Omit<InlineItemIdentity, "sourceRange" | "contentStartCodeUnit" | "contentEndCodeUnit"> {
  return {
    formattingNode: node.id,
    documentNode: node.source,
    pseudoElement: node.pseudo,
    action: node.source === null ? null : documentActionIdentity(tree, node.source),
    semantic: semanticIdentity(tree, node)
  };
}

class ImmutableInlineItemStreamSet implements InlineItemStreamSet {
  readonly formatting: FormattingTree;
  readonly streams: readonly InlineItemStream[];
  readonly #byKey: ReadonlyMap<string, InlineItemStream>;
  readonly #text: ReadonlyMap<FormattingNodeId, ProcessedCssText>;

  public constructor(
    formatting: FormattingTree,
    streams: readonly InlineItemStream[],
    byKey: ReadonlyMap<string, InlineItemStream>,
    text: ReadonlyMap<FormattingNodeId, ProcessedCssText>
  ) {
    this.formatting = formatting;
    this.streams = Object.freeze([...streams]);
    this.#byKey = new Map(byKey);
    this.#text = new Map(text);
    Object.freeze(this);
  }

  public stream(containingFormattingBox: FormattingNodeId, roots: readonly FormattingNodeId[]): InlineItemStream {
    const stream = this.#byKey.get(streamKey(containingFormattingBox, roots));
    if (stream === undefined) {
      throw new RangeError(`No inline item stream for ${containingFormattingBox}.`);
    }
    return stream;
  }

  public textForFormattingNode(formattingNode: FormattingNodeId): ProcessedCssText | null {
    return this.#text.get(formattingNode) ?? null;
  }
}

/** Builds CSS-transformed logical inline items before search or layout consumes them. */
export function buildInlineItemStreamSet(tree: FormattingTree, signal?: AbortSignal): InlineItemStreamSet {
  const streams: InlineItemStream[] = [];
  const byKey = new Map<string, InlineItemStream>();
  const textByFormatting = new Map<FormattingNodeId, ProcessedCssText>();

  const buildStream = (containing: FormattingNodeId, roots: readonly FormattingNodeId[]): void => {
    if (roots.length === 0) return;
    const key = streamKey(containing, roots);
    if (byKey.has(key)) return;
    const items: InlineItem[] = [];
    let graphemeClusters = 0;
    let collapsibleSpacePending = false;
    const appendControl = (node: FormattingNode, bidiClass: BidiClass): void => {
      items.push(Object.freeze({
        ...baseIdentity(tree, node),
        kind: "structural-bidi-control",
        text: "",
        bidiClass,
        sourceRange: node.sourceRange,
        contentStartCodeUnit: 0,
        contentEndCodeUnit: 0
      }));
    };
    const visit = (id: FormattingNodeId): void => {
      signal?.throwIfAborted();
      const node = tree.node(id);
      const identity = baseIdentity(tree, node);
      if (isAtomicInlineBox(tree, node)) {
        items.push(Object.freeze({
          ...identity,
          kind: "atomic-inline",
          text: "\ufffc",
          sourceRange: node.sourceRange,
          contentStartCodeUnit: 0,
          contentEndCodeUnit: 0
        }));
        return;
      }
      if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
        const style = computed(tree, node);
        if (style === null) return;
        const processed = processCssText(
          node.text,
          style.text.textTransform,
          node.whiteSpace,
          collapsibleSpacePending,
          {},
          signal
        );
        if (processed.outcome.status !== "complete") {
          throw new RangeError("Inline item stream exceeded its grapheme-cluster budget.");
        }
        graphemeClusters += processed.outcome.graphemeClusters;
        textByFormatting.set(node.id, processed);
        collapsibleSpacePending = processed.collapsibleSpacePending;
        for (const unit of processed.units) {
          if (unit.kind === "forced-break") {
            items.push(Object.freeze({
              ...identity,
              kind: "forced-line-break",
              text: "",
              sourceRange: unitSourceRange(tree, node, unit),
              contentStartCodeUnit: unit.contentStartCodeUnit,
              contentEndCodeUnit: unit.contentEndCodeUnit
            }));
            collapsibleSpacePending = false;
            continue;
          }
          items.push(Object.freeze({
            ...identity,
            kind: unit.kind === "tab" ? "tab" : unit.kind === "soft-hyphen" ? "soft-hyphen" : "text",
            text: unit.text,
            collapsibleSpace: unit.collapsibleSpace,
            whiteSpace: node.whiteSpace,
            sourceRange: unitSourceRange(tree, node, unit),
            contentStartCodeUnit: unit.contentStartCodeUnit,
            contentEndCodeUnit: unit.contentEndCodeUnit
          }));
        }
        return;
      }
      if (node.kind === "forced-line-break") {
        items.push(Object.freeze({
          ...identity,
          kind: "forced-line-break",
          text: "",
          sourceRange: node.sourceRange,
          contentStartCodeUnit: 0,
          contentEndCodeUnit: 0
        }));
        collapsibleSpacePending = false;
        return;
      }
      if (node.kind === "line-break-opportunity") {
        items.push(Object.freeze({
          ...identity,
          kind: "break-opportunity",
          text: "",
          sourceRange: node.sourceRange,
          contentStartCodeUnit: 0,
          contentEndCodeUnit: 0
        }));
        return;
      }
      if (!isInlineFormattingNode(node)) {
        items.push(Object.freeze({
          ...identity,
          kind: "block-boundary",
          text: "",
          sourceRange: node.sourceRange,
          contentStartCodeUnit: 0,
          contentEndCodeUnit: 0
        }));
        collapsibleSpacePending = false;
        return;
      }
      const controls = structuralControls(node, tree);
      for (const control of controls.before) appendControl(node, control);
      for (const child of node.children) visit(child);
      for (const control of controls.after) appendControl(node, control);
    };
    for (const root of roots) visit(root);
    const stream = Object.freeze({
      id: `inline-item-stream:${key}` as InlineItemStreamId,
      containingFormattingBox: containing,
      roots: Object.freeze([...roots]),
      items: Object.freeze(items),
      graphemeClusters,
      collapsibleSpacePending
    });
    streams.push(stream);
    byKey.set(key, stream);
  };

  const pending = [tree.root];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const id = pending.pop();
    if (id === undefined) continue;
    const node = tree.node(id);
    const ownsInlineFormattingContext = node.kind === "root" || node.outer === "block" || isAtomicInlineBox(tree, node);
    if (ownsInlineFormattingContext) {
      let run: FormattingNodeId[] = [];
      const flush = (): void => {
        buildStream(node.id, run);
        run = [];
      };
      for (const child of node.children) {
        if (isInlineFormattingNode(tree.node(child))) run.push(child);
        else flush();
      }
      flush();
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }

  const allNodes = [tree.root];
  while (allNodes.length > 0) {
    const id = allNodes.pop();
    if (id === undefined) continue;
    const node = tree.node(id);
    const logicalText = formattingNodeLogicalText(node, tree);
    if (logicalText !== null && !textByFormatting.has(node.id)) {
      const style = computed(tree, node);
      if (style !== null) {
        const whiteSpace = node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker"
          ? node.whiteSpace : style.text.whiteSpace;
        const processed = processCssText(logicalText, style.text.textTransform, whiteSpace, false, {}, signal);
        if (processed.outcome.status !== "complete") {
          throw new RangeError("Inline item text exceeded its grapheme-cluster budget.");
        }
        textByFormatting.set(node.id, processed);
      }
    }
    for (const child of node.children) allNodes.push(child);
  }
  return new ImmutableInlineItemStreamSet(tree, streams, byKey, textByFormatting);
}
