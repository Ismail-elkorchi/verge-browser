import { cssLengthFromFixed, type LayoutFragment } from "../layout/index.js";
import type {
  BuildTerminalDisplayListInput,
  TerminalDisplayList,
  TerminalDisplayListOutcome,
  TerminalPaintBudgets,
  TerminalPaintCommand
} from "./types.js";

const DEFAULT_PAINT_BUDGETS: TerminalPaintBudgets = Object.freeze({
  maxCommands: 200_000,
  maxPaintCells: 2_000_000,
  maxSearchMatches: 10_000
});

export function terminalPaintBudgets(value: Partial<TerminalPaintBudgets> | undefined): TerminalPaintBudgets {
  const integer = (candidate: number | undefined, fallback: number): number =>
    Number.isSafeInteger(candidate) && (candidate ?? 0) > 0 ? candidate ?? fallback : fallback;
  return Object.freeze({
    maxCommands: integer(value?.maxCommands, DEFAULT_PAINT_BUDGETS.maxCommands),
    maxPaintCells: integer(value?.maxPaintCells, DEFAULT_PAINT_BUDGETS.maxPaintCells),
    maxSearchMatches: integer(value?.maxSearchMatches, DEFAULT_PAINT_BUDGETS.maxSearchMatches)
  });
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
    && (ambiguous === 1 || ambiguous === 2);
}

function commandsFor(fragment: LayoutFragment): readonly TerminalPaintCommand[] {
  if (!fragment.style.visible) return [];
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
  const commands: TerminalPaintCommand[] = [];
  if (fragment.kind === "text" && fragment.text.length > 0) {
    commands.push(Object.freeze({
      ...common,
      id: `terminal-paint:text:${fragment.id}`,
      kind: "text",
      rect: fragment.contentRect,
      text: fragment.text,
      paintOrder: fragment.paintOrder * 2 + 1
    }));
  }
  if ((fragment.kind === "control" || fragment.kind === "replaced")) {
    const text = fragment.kind === "control"
      ? fragment.controlText ?? ""
      : fragment.replacedText ?? "";
    if (text.length > 0) {
      commands.push(Object.freeze({
        ...common,
        id: `terminal-paint:atomic:${fragment.id}`,
        kind: "text",
        rect: fragment.contentRect,
        text,
        paintOrder: fragment.paintOrder * 2 + 1
      }));
    }
  }
  if (fragment.kind !== "text" && fragment.style.borderStyle === "solid"
    && (fragment.borderRect.width > fragment.paddingRect.width
      || fragment.borderRect.height > fragment.paddingRect.height)) {
    commands.push(Object.freeze({
      ...common,
      id: `terminal-paint:border:${fragment.id}`,
      kind: "border",
      rect: fragment.borderRect,
      paintOrder: fragment.paintOrder * 2,
      borderRect: fragment.borderRect,
      contentRect: fragment.contentRect,
      borderWidths: Object.freeze({
        top: cssLengthFromFixed(fragment.paddingRect.y - fragment.borderRect.y),
        right: cssLengthFromFixed(fragment.borderRect.x + fragment.borderRect.width - fragment.paddingRect.x - fragment.paddingRect.width),
        bottom: cssLengthFromFixed(fragment.borderRect.y + fragment.borderRect.height - fragment.paddingRect.y - fragment.paddingRect.height),
        left: cssLengthFromFixed(fragment.paddingRect.x - fragment.borderRect.x)
      })
    }));
  }
  return commands;
}

export function buildTerminalDisplayList(input: BuildTerminalDisplayListInput): TerminalDisplayList {
  const context = Object.freeze({ ...input.context });
  if (!validTerminalRenderContext(context)) {
    return Object.freeze({
      layout: input.layout,
      context,
      commands: Object.freeze([]),
      outcome: Object.freeze({ status: "rejected", reason: "invalid-context" })
    });
  }
  const budgets = terminalPaintBudgets(context.budgets);
  const commands: TerminalPaintCommand[] = [];
  const pending = [input.layout.root];
  let truncated = false;
  while (pending.length > 0) {
    context.signal?.throwIfAborted();
    const id = pending.pop();
    if (id === undefined) continue;
    const fragment = input.layout.fragment(id);
    for (let index = fragment.children.length - 1; index >= 0; index -= 1) {
      const child = fragment.children[index];
      if (child !== undefined) pending.push(child);
    }
    for (const command of commandsFor(fragment)) {
      if (commands.length >= budgets.maxCommands) { truncated = true; break; }
      commands.push(command);
    }
    if (truncated) break;
  }
  commands.sort((left, right) => left.paintOrder - right.paintOrder || left.id.localeCompare(right.id));
  const outcome: TerminalDisplayListOutcome = truncated
    ? { status: "truncated", commands: commands.length, budget: "maxCommands", limit: budgets.maxCommands }
    : { status: "complete", commands: commands.length };
  return Object.freeze({
    layout: input.layout,
    context,
    commands: Object.freeze(commands),
    outcome: Object.freeze(outcome)
  });
}
