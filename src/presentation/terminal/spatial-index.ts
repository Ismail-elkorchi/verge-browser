import type { LayoutFragmentId } from "../layout/index.js";
import type {
  DisplayListAttachmentGroup,
  DisplayListSpatialIndex,
  DisplayListSpatialQuery,
  DocumentDisplayList,
  TerminalPaintCommand,
} from "./types.js";

interface SpatialInterval<TValue> {
  readonly value: TValue;
  readonly start: number;
  readonly end: number;
}

interface IntervalNode<TValue> {
  readonly center: number;
  readonly byStart: readonly SpatialInterval<TValue>[];
  readonly byEnd: readonly SpatialInterval<TValue>[];
  readonly left: IntervalNode<TValue> | null;
  readonly right: IntervalNode<TValue> | null;
}

function commandInterval(command: TerminalPaintCommand): SpatialInterval<TerminalPaintCommand> {
  const start = Math.max(command.rect.y, command.clipRect.y);
  const clippedEnd = Math.min(
    command.rect.y + command.rect.height,
    command.clipRect.y + command.clipRect.height,
  );
  return Object.freeze({ value: command, start, end: Math.max(start + 1, clippedEnd) });
}

function intervalTree<TValue>(values: readonly SpatialInterval<TValue>[]): IntervalNode<TValue> | null {
  if (values.length === 0) return null;
  const centers = values.map((value) => value.start + Math.floor((value.end - value.start) / 2))
    .sort((left, right) => left - right);
  const center = centers[Math.floor(centers.length / 2)] ?? 0;
  const left: SpatialInterval<TValue>[] = [];
  const right: SpatialInterval<TValue>[] = [];
  const overlaps: SpatialInterval<TValue>[] = [];
  for (const value of values) {
    if (value.end <= center) left.push(value);
    else if (value.start > center) right.push(value);
    else overlaps.push(value);
  }
  // A zero-height or saturated fixed-point interval must still make progress.
  if (overlaps.length === 0) {
    const retained = left.pop() ?? right.shift();
    if (retained !== undefined) overlaps.push(retained);
  }
  return Object.freeze({
    center,
    byStart: Object.freeze([...overlaps].sort((a, b) => a.start - b.start)),
    byEnd: Object.freeze([...overlaps].sort((a, b) => b.end - a.end)),
    left: intervalTree(left),
    right: intervalTree(right),
  });
}

function queryIntervals<TValue>(
  root: IntervalNode<TValue> | null,
  top: number,
  bottom: number,
  retain: (value: TValue) => boolean,
  signal?: AbortSignal,
): { readonly values: readonly TValue[]; readonly visitedIntervals: number } {
  const values: TValue[] = [];
  let visitedIntervals = 0;
  const consider = (interval: SpatialInterval<TValue>): void => {
    visitedIntervals += 1;
    if ((visitedIntervals & 255) === 0) signal?.throwIfAborted();
    if (interval.start < bottom && interval.end > top && retain(interval.value)) values.push(interval.value);
  };
  const visit = (node: IntervalNode<TValue> | null): void => {
    if (node === null) return;
    signal?.throwIfAborted();
    if (bottom <= node.center) {
      for (const value of node.byStart) {
        if (value.start >= bottom) break;
        consider(value);
      }
      visit(node.left);
      return;
    }
    if (top > node.center) {
      for (const value of node.byEnd) {
        if (value.end <= top) break;
        consider(value);
      }
      visit(node.right);
      return;
    }
    for (const value of node.byStart) consider(value);
    visit(node.left);
    visit(node.right);
  };
  visit(root);
  return Object.freeze({ values: Object.freeze(values), visitedIntervals });
}

function stickyInterval(group: DisplayListAttachmentGroup): SpatialInterval<DisplayListAttachmentGroup> {
  const attachment = group.attachment;
  if (attachment.kind !== "sticky") throw new TypeError("Expected a sticky display-list attachment.");
  let commandStart: number = attachment.normalBorderRect.y;
  let commandEnd: number = attachment.normalBorderRect.y + attachment.normalBorderRect.height;
  for (const command of group.commands) {
    commandStart = Math.min(commandStart, command.rect.y);
    commandEnd = Math.max(commandEnd, command.rect.y + command.rect.height);
  }
  const before = commandStart - attachment.normalBorderRect.y;
  const after = commandEnd - (attachment.normalBorderRect.y + attachment.normalBorderRect.height);
  const start = attachment.bottom !== null
    ? attachment.containingBlock.y + before
    : commandStart;
  const end = attachment.top !== null
    ? attachment.containingBlock.y + attachment.containingBlock.height + after
    : commandEnd;
  return Object.freeze({ value: group, start, end: Math.max(start + 1, end) });
}

function intersectsInline(command: TerminalPaintCommand, left: number, right: number): boolean {
  const start = Math.max(command.rect.x, command.clipRect.x);
  const clippedEnd = Math.min(
    command.rect.x + command.rect.width,
    command.clipRect.x + command.clipRect.width,
  );
  const end = Math.max(start + 1, clippedEnd);
  return start < right && end > left;
}

class ImmutableDisplayListSpatialIndex implements DisplayListSpatialIndex {
  readonly commandCount: number;
  readonly attachmentCommandCount: number;
  readonly fixedAttachmentGroups: readonly DisplayListAttachmentGroup[];
  readonly #root: IntervalNode<TerminalPaintCommand> | null;
  readonly #stickyRoot: IntervalNode<DisplayListAttachmentGroup> | null;

  public constructor(list: DocumentDisplayList) {
    const attachmentByFragment = new Map<LayoutFragmentId, ReturnType<typeof list.layout.scrollAttachment>>();
    const attachmentFor = (fragment: LayoutFragmentId) => {
      const known = attachmentByFragment.get(fragment);
      if (known !== undefined) return known;
      const path: LayoutFragmentId[] = [];
      let current: LayoutFragmentId | null = fragment;
      let attachment = null;
      while (current !== null) {
        const cached = attachmentByFragment.get(current);
        if (cached !== undefined) {
          attachment = cached;
          break;
        }
        path.push(current);
        attachment = list.layout.scrollAttachment(current);
        if (attachment !== null) break;
        current = list.layout.parent(current)?.id ?? null;
      }
      for (const id of path) attachmentByFragment.set(id, attachment);
      return attachment;
    };
    const normal: SpatialInterval<TerminalPaintCommand>[] = [];
    const attached = new Map<LayoutFragmentId, {
      readonly attachment: NonNullable<ReturnType<typeof attachmentFor>>;
      readonly commands: TerminalPaintCommand[];
    }>();
    for (const command of list.commands) {
      const attachment = attachmentFor(command.layoutFragment);
      if (attachment === null) {
        normal.push(commandInterval(command));
        continue;
      }
      const group = attached.get(attachment.root) ?? { attachment, commands: [] };
      group.commands.push(command);
      attached.set(attachment.root, group);
    }
    this.commandCount = list.commands.length;
    const groups = Object.freeze([...attached.values()].map((group) => Object.freeze({
      attachment: group.attachment,
      commands: Object.freeze(group.commands),
    })));
    this.attachmentCommandCount = groups.reduce((count, group) => count + group.commands.length, 0);
    this.fixedAttachmentGroups = Object.freeze(groups.filter((group) => group.attachment.kind === "fixed"));
    this.#root = intervalTree(normal);
    this.#stickyRoot = intervalTree(groups
      .filter((group) => group.attachment.kind === "sticky")
      .map(stickyInterval));
    Object.freeze(this);
  }

  public query(rect: Parameters<DisplayListSpatialIndex["query"]>[0], signal?: AbortSignal): DisplayListSpatialQuery {
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const left = rect.x;
    const right = rect.x + rect.width;
    const queried = queryIntervals(this.#root, top, bottom, (command) => intersectsInline(command, left, right), signal);
    const commands = [...queried.values];
    commands.sort((a, b) => a.paintOrder - b.paintOrder);
    return Object.freeze({
      commands: Object.freeze(commands),
      metrics: Object.freeze({ visitedIntervals: queried.visitedIntervals, returnedCommands: commands.length }),
    });
  }

  public queryStickyAttachments(
    rect: Parameters<DisplayListSpatialIndex["queryStickyAttachments"]>[0],
    signal?: AbortSignal,
  ) {
    const queried = queryIntervals(
      this.#stickyRoot,
      rect.y,
      rect.y + rect.height,
      () => true,
      signal,
    );
    return Object.freeze({
      groups: queried.values,
      metrics: Object.freeze({
        visitedIntervals: queried.visitedIntervals,
        returnedCommands: queried.values.reduce((count, group) => count + group.commands.length, 0),
      }),
    });
  }
}

/** Builds one bounded document-space interval tree; paint commands are retained by reference. */
export function buildDisplayListSpatialIndex(list: DocumentDisplayList): DisplayListSpatialIndex {
  return new ImmutableDisplayListSpatialIndex(list);
}
