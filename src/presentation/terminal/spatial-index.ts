import { registerRetainedOwner } from "../../memory/retained-cost.js";
import { cssIntersection, cssUnion, type CssRect, type LayoutFragmentId, type LayoutScrollAttachment, type LayoutScrollOwner } from "../layout/index.js";
import { ViewportGeometryProjection, translatedRect, scrollAttachmentEnvelope } from "./viewport-geometry.js";
import type {
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

function intervalTree<TValue>(values: readonly SpatialInterval<TValue>[], signal?: AbortSignal): IntervalNode<TValue> | null {
  signal?.throwIfAborted();
  if (values.length === 0) return null;
  const centers = values.map((value) => value.start + Math.floor((value.end - value.start) / 2))
    .sort((left, right) => left - right);
  const center = centers[Math.floor(centers.length / 2)] ?? 0;
  const left: SpatialInterval<TValue>[] = [];
  const right: SpatialInterval<TValue>[] = [];
  const overlaps: SpatialInterval<TValue>[] = [];
  let visited = 0;
  for (const value of values) {
    if ((visited++ & 255) === 0) signal?.throwIfAborted();
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
    left: intervalTree(left, signal),
    right: intervalTree(right, signal),
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

interface AttachedCommands {
  readonly attachment: LayoutScrollAttachment;
  readonly root: IntervalNode<number> | null;
}

interface OwnerIndex {
  readonly paintOrder: number;
  readonly owner: LayoutScrollOwner | null;
  readonly commands: IntervalNode<number> | null;
  readonly children: IntervalNode<LayoutScrollOwner> | null;
  readonly sticky: IntervalNode<AttachedCommands> | null;
  readonly fixed: readonly AttachedCommands[];
}

function inlineIntersects(rect: CssRect, query: CssRect): boolean {
  return rect.x < query.x + query.width && rect.x + Math.max(1, rect.width) > query.x;
}

class ImmutableDisplayListSpatialIndex implements DisplayListSpatialIndex {
  readonly commandCount: number;
  readonly #owners: ReadonlyMap<LayoutFragmentId | null, OwnerIndex>;
  readonly #list: DocumentDisplayList;

  public constructor(list: DocumentDisplayList, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.#list = list;
    const layout = list.layout;
    const ownerPaintOrder = new Map<LayoutFragmentId, number>();
    for (const [index, id] of list.fragmentPaintOrder.entries()) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      if (layout.scrollContainer(id) !== null) ownerPaintOrder.set(id, index);
    }
    const attachments = new Map<LayoutFragmentId, LayoutScrollAttachment | null>();
    const attachmentFor = (id: LayoutFragmentId): LayoutScrollAttachment | null => {
      const path: LayoutFragmentId[] = [];
      let current: LayoutFragmentId | null = id;
      let attachment: LayoutScrollAttachment | null = null;
      while (current !== null) {
        if ((path.length & 255) === 0) signal?.throwIfAborted();
        if (attachments.has(current)) { attachment = attachments.get(current) ?? null; break; }
        path.push(current);
        attachment = layout.scrollAttachment(current);
        if (attachment !== null) break;
        current = layout.scrollAttachmentParent(current)?.id ?? null;
      }
      for (const fragment of path) attachments.set(fragment, attachment);
      return attachment;
    };
    const buckets = new Map<LayoutFragmentId | null, {
      owner: LayoutScrollOwner | null;
      commands: SpatialInterval<number>[];
      children: SpatialInterval<LayoutScrollOwner>[];
      attached: Map<LayoutFragmentId, { attachment: LayoutScrollAttachment; commands: SpatialInterval<number>[] }>;
    }>();
    const bucket = (id: LayoutFragmentId | null) => {
      let value = buckets.get(id);
      if (value === undefined) {
        value = { owner: id === null ? null : layout.scrollContainer(id), commands: [], children: [], attached: new Map() };
        buckets.set(id, value);
      }
      return value;
    };
    bucket(null);
    for (const owner of layout.scrollOwners) {
      signal?.throwIfAborted();
      bucket(owner.fragment);
      const attachment = attachmentFor(owner.fragment);
      const rect = attachment?.kind === "sticky" ? scrollAttachmentEnvelope(owner.scrollport, attachment, layout.scrollExtent, layout) : owner.scrollport;
      bucket(owner.parent).children.push({ value: owner,
        start: attachment?.kind === "fixed" ? Number.MIN_SAFE_INTEGER : rect.y,
        end: attachment?.kind === "fixed" ? Number.MAX_SAFE_INTEGER : rect.y + Math.max(1, rect.height),
      });
    }
    for (let index = 0; index < list.commands.length; index += 1) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      const fragment = list.commands.layoutFragment(index);
      const rect = list.commands.rect(index);
      const interval = Object.freeze({ value: index, start: rect.y, end: rect.y + Math.max(1, rect.height) });
      const owner = layout.scrollAncestor(fragment);
      const target = bucket(owner?.fragment ?? null);
      const attachment = attachmentFor(fragment);
      // An attachment outside this owner is already represented by the owner's projection.
      if (attachment === null || (owner !== null && layout.scrollAncestor(attachment.root)?.fragment !== owner.fragment
        && attachment.root !== fragment)) {
        target.commands.push(interval);
      } else {
        let group = target.attached.get(attachment.root);
        if (group === undefined) { group = { attachment, commands: [] }; target.attached.set(attachment.root, group); }
        group.commands.push(interval);
      }
    }
    this.commandCount = list.commands.length;
    this.#owners = new Map([...buckets].map(([id, value]) => {
      signal?.throwIfAborted();
      const sticky: SpatialInterval<AttachedCommands>[] = [];
      const fixed: AttachedCommands[] = [];
      for (const group of value.attached.values()) {
        const retained = Object.freeze({ attachment: group.attachment, root: intervalTree(group.commands, signal) });
        if (group.attachment.kind === "fixed") fixed.push(retained);
        else {
          const attachment = group.attachment;
          const bounds = cssUnion(group.commands.map(entry=>list.commands.rect(entry.value)), attachment.normalBorderRect);
          const envelope = scrollAttachmentEnvelope(bounds, attachment, layout.scrollExtent, layout);
          sticky.push({ value: retained, start:envelope.y, end:envelope.y+Math.max(1,envelope.height) });
        }
      }
      return [id, Object.freeze({ paintOrder:id===null?-1:ownerPaintOrder.get(id)??0, owner: value.owner, commands: intervalTree(value.commands, signal),
        children: intervalTree(value.children, signal), sticky: intervalTree(sticky, signal), fixed: Object.freeze(fixed) })];
    }));
    Object.freeze(this);
    registerRetainedOwner(this, () => [this.#list, this.#owners]);
  }

  public query(rect: CssRect, signal?: AbortSignal, suppliedProjection?: ViewportGeometryProjection): DisplayListSpatialQuery {
    const projection = suppliedProjection ?? new ViewportGeometryProjection(this.#list.layout, rect);
    const commands: TerminalPaintCommand[] = [];
    let visitedIntervals = 0;
    const retained = this.#list.commands;
    const retain = (index: number): void => {
      signal?.throwIfAborted();
      const fragment = retained.layoutFragment(index);
      const originalRect = retained.rect(index);
      const resolvedRect = projection.rect(fragment, originalRect);
      const clipRect = projection.clip(fragment, !retained.isText(index));
      const visible = cssIntersection(resolvedRect, clipRect);
      if ((originalRect.width > 0 && originalRect.height > 0 && (visible.width <= 0 || visible.height <= 0))
        || visible.x >= rect.x + rect.width || visible.x + Math.max(1, visible.width) <= rect.x
        || visible.y >= rect.y + rect.height || visible.y + Math.max(1, visible.height) <= rect.y
        || clipRect.width <= 0 || clipRect.height <= 0) return;
      const command = retained.at(index);
      if (command === undefined) throw new RangeError("Missing indexed paint command.");
      const resolved = { ...command, rect: resolvedRect, clipRect };
      commands.push(Object.freeze(command.kind === "border-side"
        ? { ...resolved, borderRect: projection.rect(fragment, command.borderRect) } : resolved));
    };
    const queryCommands = (root: IntervalNode<number> | null, query: CssRect): void => {
      const result = queryIntervals(root, query.y, query.y + query.height, (index) => inlineIntersects(retained.rect(index), query), signal);
      visitedIntervals += result.visitedIntervals;
      for (const index of result.values) retain(index);
    };
    const pending: (LayoutFragmentId | null)[] = [null];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const id = pending.pop();
      const entry = this.#owners.get(id ?? null);
      if (entry === undefined) continue;
      let query = rect;
      if (entry.owner !== null) {
        const port = projection.visible(entry.owner.fragment, entry.owner.scrollport);
        const visible = cssIntersection(port, rect);
        if (visible.width <= 0 || visible.height <= 0) continue;
        const [inline, block] = projection.translation(entry.owner.fragment);
        const [offsetInline, offsetBlock] = projection.offset(entry.owner);
        query = translatedRect(visible, offsetInline - inline, offsetBlock - block);
      }
      projection.recordContentWindow(entry.owner?.fragment ?? null, query, entry.paintOrder);
      queryCommands(entry.commands, query);
      const children = queryIntervals(entry.children, query.y, query.y + query.height, () => true, signal);
      visitedIntervals += children.visitedIntervals;
      for (const owner of children.values) pending.push(owner.fragment);
      const sticky = queryIntervals(entry.sticky, query.y, query.y + query.height, () => true, signal);
      visitedIntervals += sticky.visitedIntervals;
      for (const group of [...entry.fixed, ...sticky.values]) {
        const [inline, block] = projection.translation(group.attachment.root);
        queryCommands(group.root, translatedRect(rect, -inline, -block));
      }
    }
    commands.sort((a, b) => a.paintOrder - b.paintOrder);
    return Object.freeze({ commands: Object.freeze(commands), metrics: Object.freeze({ visitedIntervals, returnedCommands: commands.length }) });
  }
}

/** Per-owner interval indexes retain packed command IDs and decode only visible query results. */
export function buildDisplayListSpatialIndex(list: DocumentDisplayList, signal?: AbortSignal): DisplayListSpatialIndex {
  return new ImmutableDisplayListSpatialIndex(list, signal);
}
