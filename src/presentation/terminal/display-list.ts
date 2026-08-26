import {
  cssCoordinateAdd,
  cssCoordinateDifference,
  cssMax,
  cssPx,
  type LayoutFragment
} from "../layout/index.js";
import type { ComputedStyle } from "../style/index.js";
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
      if (fragment.style.borderStyle !== "solid") continue;
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

function computedStyle(fragment: LayoutFragment, list: BuildTerminalDisplayListInput["layout"]): ComputedStyle | null {
  let formattingNode = list.formatting.node(fragment.formattingNode);
  let computed: ComputedStyle | null = null;
  for (;;) {
    const source = formattingNode.source;
    if (source !== null && list.formatting.document.node(source).kind === "element") {
      computed = formattingNode.pseudo === null
        ? list.formatting.styles.style(source)
        : list.formatting.styles.pseudo(source, formattingNode.pseudo);
    }
    const parent = list.formatting.parent(formattingNode.id);
    if (computed !== null || parent === null) break;
    formattingNode = parent;
  }
  return computed;
}

function positionedZIndex(
  fragment: LayoutFragment,
  layout: BuildTerminalDisplayListInput["layout"]
): number | null {
  const computed = computedStyle(fragment, layout);
  return computed !== null && computed.box.position !== "static" ? computed.box.zIndex ?? 0 : null;
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
      commands: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason: rejection ?? "invalid-budget" })
    });
  }
  const commands: TerminalPaintCommand[] = [];
  const append = (fragment: LayoutFragment): boolean => {
    input.signal?.throwIfAborted();
    const group = commandGroup(fragment);
    if (commands.length + group.length > budgets.maxDisplayListCommands) {
      return false;
    }
    for (const command of group) {
      commands.push(Object.freeze({ ...command, paintOrder: commands.length }) as TerminalPaintCommand);
    }
    return true;
  };
  const paintStackingContext = (root: LayoutFragment): boolean => {
    if (!append(root)) return false;
    const positioned: { readonly fragment: LayoutFragment; readonly zIndex: number; readonly sourceOrder: number }[] = [];
    let sourceOrder = 0;
    const scan = (parent: LayoutFragment): void => {
      for (const childId of parent.children) {
        input.signal?.throwIfAborted();
        const child = input.layout.fragment(childId);
        const zIndex = positionedZIndex(child, input.layout);
        const order = sourceOrder++;
        if (zIndex === null) scan(child);
        else positioned.push({ fragment: child, zIndex, sourceOrder: order });
      }
    };
    scan(root);
    const ordered = (predicate: (zIndex: number) => boolean): readonly typeof positioned[number][] =>
      positioned.filter((entry) => predicate(entry.zIndex)).sort((left, right) =>
        left.zIndex - right.zIndex || left.sourceOrder - right.sourceOrder
      );
    for (const entry of ordered((zIndex) => zIndex < 0)) {
      if (!paintStackingContext(entry.fragment)) return false;
    }
    const paintNormal = (parent: LayoutFragment): boolean => {
      for (const childId of parent.children) {
        input.signal?.throwIfAborted();
        const child = input.layout.fragment(childId);
        if (positionedZIndex(child, input.layout) !== null) continue;
        if (!append(child) || !paintNormal(child)) return false;
      }
      return true;
    };
    if (!paintNormal(root)) return false;
    for (const entry of ordered((zIndex) => zIndex === 0)) {
      if (!paintStackingContext(entry.fragment)) return false;
    }
    for (const entry of ordered((zIndex) => zIndex > 0)) {
      if (!paintStackingContext(entry.fragment)) return false;
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
    commands: Object.freeze(commands),
    outcome: Object.freeze(outcome)
  });
}
