import { checkPackedMetadata } from "../../memory/packed.js";
import { PaintCommandBuilder } from "./paint-commands.js";
import { createLayoutPaintResolver } from "../layout/paint-style.js";
import { createPaintSuppressionResolver } from "./paint-suppression.js";
import { createLayoutArtworkResolver, type LayoutArtworkFallbackReason } from "../layout/paint-artwork.js";
import type { LayoutFragment } from "../layout/index.js";
import type {
  BuildDocumentDisplayListInput,
  DocumentDisplayList,
  DocumentDisplayListOutcome,
  TerminalPaintBudgets
} from "./types.js";

const DEFAULT_PAINT_BUDGETS: TerminalPaintBudgets = Object.freeze({
  maxDisplayListCommands: 200_000,
  maxRetainedImagePlacements: 4_096,
  maxGeneratedPaintUnits: 2_000_000,
  maxRetainedPaintCells: 2_000_000,
  maxRetainedCellBufferRows: 10_000,
  maxRetainedCellBufferColumns: 10_000,
  maxRetainedHitTestRegions: 200_000,
  maxRetainedFocusRectangles: 200_000,
  maxRetainedAccessibilityRectangles: 200_000,
  maxRetainedDocumentRectangles: 200_000,
  maxRetainedScrollAnchors: 200_000,
  maxRetainedSearchCellSpans: 200_000,
  maxLogicalSearchMatches: 10_000
});

/** Zero is a valid no-work terminal budget. Invalid supplied budgets are rejected. */
export function terminalPaintBudgets(value: Partial<TerminalPaintBudgets> | undefined): TerminalPaintBudgets | null {
  const read = (key: keyof TerminalPaintBudgets): number | null => {
    const candidate = value?.[key];
    if (candidate === undefined) return DEFAULT_PAINT_BUDGETS[key];
    return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  };
  const result = {
    maxDisplayListCommands: read("maxDisplayListCommands"),
    maxRetainedImagePlacements: read("maxRetainedImagePlacements"),
    maxGeneratedPaintUnits: read("maxGeneratedPaintUnits"),
    maxRetainedPaintCells: read("maxRetainedPaintCells"),
    maxRetainedCellBufferRows: read("maxRetainedCellBufferRows"),
    maxRetainedCellBufferColumns: read("maxRetainedCellBufferColumns"),
    maxRetainedHitTestRegions: read("maxRetainedHitTestRegions"),
    maxRetainedFocusRectangles: read("maxRetainedFocusRectangles"),
    maxRetainedAccessibilityRectangles: read("maxRetainedAccessibilityRectangles"),
    maxRetainedDocumentRectangles: read("maxRetainedDocumentRectangles"),
    maxRetainedScrollAnchors: read("maxRetainedScrollAnchors"),
    maxRetainedSearchCellSpans: read("maxRetainedSearchCellSpans"),
    maxLogicalSearchMatches: read("maxLogicalSearchMatches")
  };
  for (const candidate of Object.values(result)) if (candidate === null) return null;
  return Object.freeze(result as TerminalPaintBudgets);
}

export function validTerminalRenderContext(input: BuildDocumentDisplayListInput["context"]): boolean {
  const depth: unknown = input.colorDepth;
  const ambiguous: unknown = input.ambiguousWidth;
  return Number.isSafeInteger(input.columns) && input.columns > 0
    && Number.isSafeInteger(input.rows) && input.rows > 0
    && Number.isSafeInteger(input.cellWidthCssPx) && input.cellWidthCssPx > 0
    && Number.isSafeInteger(input.rowHeightCssPx) && input.rowHeightCssPx > 0
    && (depth === 0 || depth === 4 || depth === 8 || depth === 24)
    && typeof input.unicode === "boolean"
    && (ambiguous === 1 || ambiguous === 2)
    && typeof input.cellMeasurer.width === "function";
}

/** CSS canvas propagation never alters the selected element's used box. */
function canvasBackground(input: BuildDocumentDisplayListInput): DocumentDisplayList["canvasBackground"] {
  const document = input.styles.document;
  const root = document.documentElement;
  if (root === null) return null;
  const rootStyle = input.styles.style(root);
  if (rootStyle.display.box === "none") return null;
  let source = root;
  let selected = rootStyle;
  const rootNode = document.node(root);
  if ((rootStyle.text.background === null || rootStyle.text.background.a === 0)
    && rootNode.kind === "element" && rootNode.name === "html"
    && rootNode.namespace === "http://www.w3.org/1999/xhtml"
    && rootStyle.box.contain === "none" && document.body !== null) {
    const body = document.node(document.body);
    const bodyStyle = input.styles.style(document.body);
    if (body.kind === "element" && body.name === "body" && body.parent === root
      && bodyStyle.display.box !== "none" && bodyStyle.box.contain === "none") {
      source = document.body;
      selected = bodyStyle;
    }
  }
  if (selected.text.background === null || selected.text.background.a <= 0 || selected.mask.image.kind !== "none") return null;
  const base = input.layout.fragment(input.layout.root).style;
  return Object.freeze({ source, style: Object.freeze({ ...base, visible: true,
    foreground: null, background: selected.text.background }) });
}

export function buildDocumentDisplayList(input: BuildDocumentDisplayListInput): DocumentDisplayList {
  const context = Object.freeze({ ...input.context });
  const budgets = terminalPaintBudgets(context.budgets);
  const rejection = !validTerminalRenderContext(context) ? "invalid-context" as const
    : budgets === null ? "invalid-budget" as const : null;
  const commands = new PaintCommandBuilder();
  checkPackedMetadata(64);
  const fragmentPaintOrder: LayoutFragment["id"][] = [];
  const paintSuppressed = new Set<LayoutFragment["id"]>();
  const artworkFallbacks = new Map<LayoutArtworkFallbackReason, { reason: LayoutArtworkFallbackReason; count: number; layoutFragment: LayoutFragment["id"] }>();
  let artworkFallbacksOmitted = 0;
  if (rejection !== null || budgets === null) {
    return Object.freeze({
      layout: input.layout,
      styles: input.styles,
      context,
      fragmentPaintOrder: Object.freeze(fragmentPaintOrder),
      paintSuppressed,
      artworkFallbacks: Object.freeze([]), artworkFallbacksOmitted,
      canvasBackground: null,
      commands: commands.finish(input.layout, fragmentPaintOrder, 0, input.images),
      outcome: Object.freeze({ status: "rejected", reason: rejection ?? "invalid-budget" })
    });
  }
  const suppression = createPaintSuppressionResolver(input.layout, input.styles, input.signal);
  // Geometry/control indexes may include owners after a truncated paint prefix.
  // Resolve their eligibility too, so a paint budget cannot reveal hidden ink.
  const pending = [input.layout.root];
  while (pending.length > 0) {
    input.signal?.throwIfAborted();
    const id = pending.pop();
    if (id === undefined) continue;
    const fragment = input.layout.fragment(id);
    if (suppression.formattingSuppressed(fragment.formattingNode)) {
      checkPackedMetadata(8);
      paintSuppressed.add(id);
    }
    for (const child of fragment.children) pending.push(child);
  }
  const resolveArtwork = createLayoutArtworkResolver(input.layout, input.styles, input.images, input.signal);
  const candidateCanvas = canvasBackground(input);
  const canvasMasked = candidateCanvas !== null && input.layout.forDocumentNode(candidateCanvas.source)
    .some((fragment) => fragment.pseudoElement === null && resolveArtwork(fragment).masked);
  const selectedCanvas = candidateCanvas !== null && (canvasMasked || suppression.sourceSuppressed(candidateCanvas.source)) ? null : candidateCanvas;
  const canvas = budgets.maxDisplayListCommands > 0 ? selectedCanvas : null;
  const reservedCommands = canvas === null ? 0 : 1;
  const paintStyle = createLayoutPaintResolver(input.layout, input.styles);
  const append = (fragment: LayoutFragment): boolean => {
    input.signal?.throwIfAborted();
    if (paintSuppressed.has(fragment.id)) {
      checkPackedMetadata(8);
      fragmentPaintOrder.push(fragment.id);
      return true;
    }
    const current = paintStyle(fragment);
    const style = fragment.documentNode === canvas?.source && fragment.pseudoElement === null
      ? Object.freeze({ ...current, background: null }) : current;
    const node = input.layout.formatting.node(fragment.formattingNode);
    const artwork = resolveArtwork(fragment);
    if (artwork.fallback !== null) {
      const previous = artworkFallbacks.get(artwork.fallback);
      if (previous !== undefined) previous.count += 1;
      else if (artworkFallbacks.size < Math.min(8, budgets.maxRetainedImagePlacements)) {
        checkPackedMetadata(64);
        artworkFallbacks.set(artwork.fallback, { reason: artwork.fallback, count: 1, layoutFragment: fragment.id });
      } else artworkFallbacksOmitted += 1;
    }
    const maskLabel = artwork.fallback !== null && artwork.fallback !== "native-content-mask" && fragment.action !== null
      && (fragment.semantic?.accessibleName || input.layout.formatting.semantic(fragment.action.node)?.accessibleName || "").length > 0;
    if (!commands.append(fragment, fragmentPaintOrder.length, style, budgets.maxDisplayListCommands - reservedCommands, input.signal,
      node.kind === "image" && node.imageResourceId !== null && !artwork.masked, artwork.masked, artwork.artwork, maskLabel)) return false;
    checkPackedMetadata(8);
    fragmentPaintOrder.push(fragment.id);
    return true;
  };
  const paintStackingContext = (root: LayoutFragment): boolean => {
    if (!append(root)) return false;
    const contexts: LayoutFragment[] = [];
    const participants: {
      readonly fragment: LayoutFragment;
      readonly phase: "in-flow-block" | "float" | "inline" | "positioned-auto-zero";
    }[] = [];
    const scan = (
      parent: LayoutFragment,
      inheritedPhase: "float" | "positioned-auto-zero" | null = null
    ): void => {
      for (const childId of parent.children) {
        input.signal?.throwIfAborted();
        const child = input.layout.fragment(childId);
        const metadata = input.layout.stacking(child.id);
        if (metadata.establishesStackingContext) contexts.push(child);
        else {
          const phase = inheritedPhase ?? (metadata.paintPhase === "float"
            || metadata.paintPhase === "inline" || metadata.paintPhase === "positioned-auto-zero"
            ? metadata.paintPhase : "in-flow-block");
          participants.push({ fragment: child, phase });
          scan(child, phase === "float" || phase === "positioned-auto-zero" ? phase : null);
        }
      }
    };
    scan(root);
    const orderedContexts = (predicate: (level: number) => boolean): readonly LayoutFragment[] =>
      contexts.filter((fragment) => predicate(input.layout.stacking(fragment.id).stackLevel ?? 0))
        .sort((left, right) =>
          (input.layout.stacking(left.id).stackLevel ?? 0) - (input.layout.stacking(right.id).stackLevel ?? 0)
          || input.layout.stacking(left.id).sourceOrder - input.layout.stacking(right.id).sourceOrder
      );
    for (const context of orderedContexts((level) => level < 0)) {
      if (!paintStackingContext(context)) return false;
    }
    const phaseOrder = ["in-flow-block", "float", "inline", "positioned-auto-zero"] as const;
    for (const phase of phaseOrder) {
      const phaseParticipants = participants
        .filter((entry) => entry.phase === phase)
        .sort((left, right) => input.layout.stacking(left.fragment.id).sourceOrder
          - input.layout.stacking(right.fragment.id).sourceOrder);
      for (const entry of phaseParticipants) {
        if (!append(entry.fragment)) return false;
      }
    }
    for (const context of orderedContexts((level) => level === 0)) {
      if (!paintStackingContext(context)) return false;
    }
    for (const context of orderedContexts((level) => level > 0)) {
      if (!paintStackingContext(context)) return false;
    }
    return true;
  };
  const complete = (selectedCanvas === null || canvas !== null)
    && paintStackingContext(input.layout.fragment(input.layout.root));
  const outcome: DocumentDisplayListOutcome = !complete
    ? {
        status: "truncated",
        commands: reservedCommands + commands.length,
        budget: "maxDisplayListCommands",
        limit: budgets.maxDisplayListCommands
      }
    : { status: "complete", commands: reservedCommands + commands.length };
  return Object.freeze({
    layout: input.layout,
    styles: input.styles,
    context,
    fragmentPaintOrder: Object.freeze(fragmentPaintOrder),
    paintSuppressed,
    artworkFallbacks: Object.freeze([...artworkFallbacks.values()].map((entry) => Object.freeze(entry))), artworkFallbacksOmitted,
    canvasBackground: canvas,
    commands: commands.finish(input.layout, fragmentPaintOrder, reservedCommands, input.images),
    outcome: Object.freeze(outcome)
  });
}
