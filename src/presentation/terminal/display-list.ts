import {
  cssCoordinateAdd,
  cssCoordinateDifference,
  cssMax,
  cssPx,
  type LayoutFragment
} from "../layout/index.js";
import type {
  BuildTerminalDisplayListInput,
  TerminalDisplayList,
  TerminalDisplayListOutcome,
  TerminalPaintBudgets,
  TerminalPaintCommand
} from "./types.js";

const DEFAULT_PAINT_BUDGETS: TerminalPaintBudgets = Object.freeze({
  maxDisplayListCommands: 200_000,
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

export function validTerminalRenderContext(input: BuildTerminalDisplayListInput["context"]): boolean {
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

function commandGroup(fragment: LayoutFragment): readonly Omit<TerminalPaintCommand, "paintOrder">[] {
  const common = {
    layoutFragment: fragment.id,
    formattingNode: fragment.formattingNode,
    documentNode: fragment.documentNode,
    sourceRange: fragment.sourceRange,
    contentStartCodeUnit: fragment.contentStartCodeUnit,
    contentEndCodeUnit: fragment.contentEndCodeUnit,
    clipRect: fragment.clipRect,
    action: fragment.action,
    semantic: fragment.semantic,
    style: fragment.style
  } as const;
  const commands: Omit<TerminalPaintCommand, "paintOrder">[] = [];
  if (fragment.style.visible && fragment.kind !== "text") {
    const boxes = fragment.inlineContinuations ?? [{
      contentRect: fragment.contentRect,
      paddingRect: fragment.paddingRect,
      borderRect: fragment.borderRect,
      marginRect: fragment.marginRect
    }];
    for (const [continuation, box] of boxes.entries()) {
      if (fragment.style.background !== null && fragment.style.background.a > 0) {
        commands.push(Object.freeze({
          ...common,
          id: `terminal-paint:background:${fragment.id}:${String(continuation)}`,
          kind: "background",
          rect: box.borderRect
        }));
      }
      const borderEdge = cssCoordinateAdd(box.borderRect.x, box.borderRect.width);
      const borderBottom = cssCoordinateAdd(box.borderRect.y, box.borderRect.height);
      const paddingEdge = cssCoordinateAdd(box.paddingRect.x, box.paddingRect.width);
      const paddingBottom = cssCoordinateAdd(box.paddingRect.y, box.paddingRect.height);
      const borderWidths = Object.freeze({
        top: cssMax(cssPx(0), cssCoordinateDifference(box.paddingRect.y, box.borderRect.y)),
        right: cssMax(cssPx(0), cssCoordinateDifference(borderEdge, paddingEdge)),
        bottom: cssMax(cssPx(0), cssCoordinateDifference(borderBottom, paddingBottom)),
        left: cssMax(cssPx(0), cssCoordinateDifference(box.paddingRect.x, box.borderRect.x))
      });
      for (const side of ["top", "right", "bottom", "left"] as const) {
        if (fragment.style.borderStyles[side] !== "solid") continue;
        if (borderWidths[side] <= 0) continue;
        commands.push(Object.freeze({
          ...common,
          id: `terminal-paint:border-${side}:${fragment.id}:${String(continuation)}`,
          kind: "border-side",
          side,
          rect: box.borderRect,
          borderRect: box.borderRect,
          borderWidths
        }));
      }
    }
    if (
      fragment.kind === "box" &&
      fragment.tableCollapsedBorderSegments !== undefined
    ) {
      for (const segment of fragment.tableCollapsedBorderSegments) {
        commands.push(
          Object.freeze({
            id: segment.id,
            kind: "border-side",
            layoutFragment: fragment.id,
            formattingNode: segment.formattingNode,
            documentNode: segment.documentNode,
            sourceRange: segment.sourceRange,
            contentStartCodeUnit: null,
            contentEndCodeUnit: null,
            rect: segment.borderRect,
            borderRect: segment.borderRect,
            borderWidths: segment.borderWidths,
            clipRect: segment.clipRect,
            side: segment.side,
            action: null,
            semantic: null,
            style: segment.style,
          }),
        );
      }
    }
  }
  const text = fragment.kind === "text" ? fragment.visualText
    : fragment.kind === "control" ? fragment.controlText ?? ""
      : fragment.kind === "replaced" ? fragment.replacedText ?? "" : "";
  if (fragment.style.visible && text.length > 0) {
    commands.push(Object.freeze({
      ...common,
      id: `terminal-paint:text:${fragment.id}`,
      kind: "text",
      rect: fragment.contentRect,
      text,
      clusters: fragment.visualClusters ?? Object.freeze([])
    }));
  }
  return commands;
}

export function buildTerminalDisplayList(input: BuildTerminalDisplayListInput): TerminalDisplayList {
  const context = Object.freeze({ ...input.context });
  const budgets = terminalPaintBudgets(context.budgets);
  const rejection = !validTerminalRenderContext(context) ? "invalid-context" as const
    : budgets === null ? "invalid-budget" as const : null;
  if (rejection !== null || budgets === null) {
    return Object.freeze({
      layout: input.layout,
      context,
      fragmentPaintOrder: Object.freeze([]),
      commands: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason: rejection ?? "invalid-budget" })
    });
  }
  const commands: TerminalPaintCommand[] = [];
  const fragmentPaintOrder = [] as LayoutFragment["id"][];
  const append = (fragment: LayoutFragment): boolean => {
    input.signal?.throwIfAborted();
    const group = commandGroup(fragment);
    if (commands.length + group.length > budgets.maxDisplayListCommands) {
      return false;
    }
    for (const command of group) {
      commands.push(Object.freeze({ ...command, paintOrder: commands.length }) as TerminalPaintCommand);
    }
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
  const complete = paintStackingContext(input.layout.fragment(input.layout.root));
  const outcome: TerminalDisplayListOutcome = !complete
    ? {
        status: "truncated",
        commands: commands.length,
        budget: "maxDisplayListCommands",
        limit: budgets.maxDisplayListCommands
      }
    : { status: "complete", commands: commands.length };
  return Object.freeze({
    layout: input.layout,
    context,
    fragmentPaintOrder: Object.freeze(fragmentPaintOrder),
    commands: Object.freeze(commands),
    outcome: Object.freeze(outcome)
  });
}
