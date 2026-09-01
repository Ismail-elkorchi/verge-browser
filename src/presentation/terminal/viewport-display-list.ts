import {
  cssCoordinate,
  cssCoordinateFromFixed,
  cssLengthFromFixed,
  cssRect,
  type CssRect,
  type LayoutFragmentId,
  type LayoutFragmentTree,
  type LayoutScrollAttachment,
} from "../layout/index.js";
import type {
  DisplayListSpatialIndex,
  DocumentDisplayList,
  TerminalPaintCommand,
  TerminalRenderContext,
  ViewportDisplayList,
  ViewportWindow,
} from "./types.js";

export function translatedScrollAttachedRect(rect: CssRect, inline: number, block: number): CssRect {
  return cssRect(
    cssCoordinateFromFixed(rect.x + inline),
    cssCoordinateFromFixed(rect.y + block),
    rect.width,
    rect.height,
  );
}

export function scrollAttachmentTranslation(
  attachment: LayoutScrollAttachment,
  viewport: CssRect,
): readonly [number, number] {
  if (attachment.kind === "fixed") return Object.freeze([viewport.x, viewport.y]);
  const normal = attachment.normalBorderRect;
  let x: number = normal.x;
  let y: number = normal.y;
  if (attachment.left !== null) x = Math.max(x, viewport.x + attachment.left);
  else if (attachment.right !== null) {
    x = Math.min(x, viewport.x + viewport.width - attachment.right - normal.width);
  }
  if (attachment.top !== null) y = Math.max(y, viewport.y + attachment.top);
  else if (attachment.bottom !== null) {
    y = Math.min(y, viewport.y + viewport.height - attachment.bottom - normal.height);
  }
  x = Math.max(
    attachment.containingBlock.x,
    Math.min(attachment.containingBlock.x + attachment.containingBlock.width - normal.width, x),
  );
  y = Math.max(
    attachment.containingBlock.y,
    Math.min(attachment.containingBlock.y + attachment.containingBlock.height - normal.height, y),
  );
  return Object.freeze([x - normal.x, y - normal.y]);
}

export function inheritedScrollAttachment(
  layout: LayoutFragmentTree,
  fragment: LayoutFragmentId,
): LayoutScrollAttachment | null {
  let current: LayoutFragmentId | null = fragment;
  while (current !== null) {
    const attachment = layout.scrollAttachment(current);
    if (attachment !== null) return attachment;
    current = layout.parent(current)?.id ?? null;
  }
  return null;
}

function clipMovesWithStickyRoot(command: TerminalPaintCommand, attachment: LayoutScrollAttachment): boolean {
  if (attachment.kind === "fixed") return true;
  const root = attachment.normalBorderRect;
  const clip = command.clipRect;
  return clip.x >= root.x && clip.y >= root.y
    && clip.x + clip.width <= root.x + root.width
    && clip.y + clip.height <= root.y + root.height;
}

function translatedCommand(
  command: TerminalPaintCommand,
  attachment: LayoutScrollAttachment,
  inline: number,
  block: number,
): TerminalPaintCommand {
  const common = {
    ...command,
    rect: translatedScrollAttachedRect(command.rect, inline, block),
    clipRect: clipMovesWithStickyRoot(command, attachment)
      ? translatedScrollAttachedRect(command.clipRect, inline, block)
      : command.clipRect,
  };
  return command.kind === "border-side"
    ? Object.freeze({ ...common, borderRect: translatedScrollAttachedRect(command.borderRect, inline, block) })
    : Object.freeze(common);
}

function intersects(command: TerminalPaintCommand, rect: CssRect): boolean {
  if (command.kind === "text" && (command.rect.width === 0 || command.rect.height === 0)) {
    return command.clipRect.width > 0 && command.clipRect.height > 0
      && command.rect.x >= command.clipRect.x
      && command.rect.x < command.clipRect.x + command.clipRect.width
      && command.rect.y >= command.clipRect.y
      && command.rect.y < command.clipRect.y + command.clipRect.height
      && command.rect.x >= rect.x && command.rect.x < rect.x + rect.width
      && command.rect.y >= rect.y && command.rect.y < rect.y + rect.height;
  }
  const left = Math.max(command.rect.x, command.clipRect.x);
  const top = Math.max(command.rect.y, command.clipRect.y);
  const right = Math.min(
    command.rect.x + command.rect.width,
    command.clipRect.x + command.clipRect.width,
  );
  const bottom = Math.min(
    command.rect.y + command.rect.height,
    command.clipRect.y + command.clipRect.height,
  );
  return left < rect.x + rect.width && right > rect.x
    && top < rect.y + rect.height && bottom > rect.y;
}

function normalizedWindow(window: ViewportWindow): ViewportWindow {
  const integer = (value: number, minimum: number): number => {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError("Viewport window values must be bounded integers.");
    return value;
  };
  return Object.freeze({
    scrollRow: integer(window.scrollRow, 0),
    viewportRows: integer(window.viewportRows, 1),
    overscanBefore: integer(window.overscanBefore, 0),
    overscanAfter: integer(window.overscanAfter, 0),
  });
}

export interface BuildViewportDisplayListInput {
  readonly documentDisplayList: DocumentDisplayList;
  readonly spatialIndex: DisplayListSpatialIndex;
  readonly context: TerminalRenderContext;
  readonly window: ViewportWindow;
  readonly signal?: AbortSignal;
  readonly instrumentation?: {
    record(stage: "spatial-query" | "fixed-sticky-resolution", elapsedMilliseconds: number): void;
  };
}

/** Selects and resolves only commands intersecting one viewport and bounded overscan window. */
export function buildViewportDisplayList(input: BuildViewportDisplayListInput): ViewportDisplayList {
  const window = normalizedWindow(input.window);
  const startRow = Math.max(0, window.scrollRow - window.overscanBefore);
  const retainedRows = window.viewportRows + Math.min(window.scrollRow, window.overscanBefore) + window.overscanAfter;
  const viewport = cssRect(
    cssCoordinate(cssLengthFromFixed(0)),
    cssCoordinateFromFixed(window.scrollRow * input.context.rowHeightCssPx),
    cssLengthFromFixed(input.context.columns * input.context.cellWidthCssPx),
    cssLengthFromFixed(window.viewportRows * input.context.rowHeightCssPx),
  );
  const windowRect = cssRect(
    viewport.x,
    cssCoordinateFromFixed(startRow * input.context.rowHeightCssPx),
    viewport.width,
    cssLengthFromFixed(retainedRows * input.context.rowHeightCssPx),
  );
  const queryStarted = input.instrumentation === undefined ? 0 : performance.now();
  const queried = input.spatialIndex.query(windowRect, input.signal);
  input.instrumentation?.record("spatial-query", performance.now() - queryStarted);
  const commands = [...queried.commands];
  const sticky = input.spatialIndex.queryStickyAttachments(windowRect, input.signal);
  let visitedAttachments = 0;
  const attachmentStarted = input.instrumentation === undefined ? 0 : performance.now();
  for (const group of [...input.spatialIndex.fixedAttachmentGroups, ...sticky.groups]) {
    input.signal?.throwIfAborted();
    const [inline, block] = scrollAttachmentTranslation(group.attachment, viewport);
    for (const command of group.commands) {
      visitedAttachments += 1;
      if ((visitedAttachments & 255) === 0) input.signal?.throwIfAborted();
      const resolved = translatedCommand(command, group.attachment, inline, block);
      if (intersects(resolved, windowRect)) commands.push(resolved);
    }
  }
  input.instrumentation?.record("fixed-sticky-resolution", performance.now() - attachmentStarted);
  commands.sort((left, right) => left.paintOrder - right.paintOrder);
  return Object.freeze({
    documentDisplayList: input.documentDisplayList,
    context: Object.freeze({ ...input.context, rows: window.viewportRows }),
    window,
    viewportRect: viewport,
    windowRect,
    commands: Object.freeze(commands),
    spatialQuery: Object.freeze({
      visitedIntervals: queried.metrics.visitedIntervals
        + sticky.metrics.visitedIntervals
        + visitedAttachments,
      returnedCommands: commands.length,
    }),
    outcome: input.documentDisplayList.outcome,
  });
}
