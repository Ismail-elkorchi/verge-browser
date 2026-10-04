import { registerRetainedOwner } from "../../memory/retained-cost.js";
import {
  cssCoordinateFromFixed, cssIntersection, cssLengthFromFixed, cssRect,
  type CssRect, type LayoutFragmentId, type LayoutFragmentTree, type LayoutScrollOwner, type LayoutScrollAttachment,
} from "../layout/index.js";
import type { DocumentNodeRef } from "../../document/index.js";

/** Controlled offsets use document identities, never ephemeral layout fragment identities. */
export interface DocumentScrollOffset {
  readonly node: DocumentNodeRef;
  readonly inline: number;
  readonly block: number;
}

export function translatedRect(rect: CssRect, inline: number, block: number): CssRect {
  return cssRect(cssCoordinateFromFixed(rect.x + inline), cssCoordinateFromFixed(rect.y + block), rect.width, rect.height);
}

/** Sticky constraints include the scroll container's reachable content, not just its port. */
export function stickyContainingRect(layout: LayoutFragmentTree, attachment: Extract<LayoutScrollAttachment, {kind: "sticky"}>): CssRect {
  return attachment.containingFragment === null ? attachment.containingBlock
    : layout.scrollContainer(attachment.containingFragment)?.contentExtent ?? attachment.containingBlock;
}

export function scrollAttachmentEnvelope(
  rect: CssRect,
  attachment: LayoutScrollAttachment,
  documentExtent: CssRect,
  layout: LayoutFragmentTree,
): CssRect {
  if (attachment.kind === "fixed") return documentExtent;
  const normal = attachment.normalBorderRect;
  const containing = stickyContainingRect(layout, attachment);
  const rootInlinePositions = attachment.left === null && attachment.right === null
    ? [normal.x]
    : [normal.x, containing.x, containing.x + containing.width - normal.width];
  const rootBlockPositions = attachment.top === null && attachment.bottom === null
    ? [normal.y]
    : [normal.y, containing.y, containing.y + containing.height - normal.height];
  const minInline = Math.min(...rootInlinePositions);
  const maxInline = Math.max(...rootInlinePositions);
  const minBlock = Math.min(...rootBlockPositions);
  const maxBlock = Math.max(...rootBlockPositions);
  const envelope = cssRect(
    cssCoordinateFromFixed(rect.x + minInline - normal.x),
    cssCoordinateFromFixed(rect.y + minBlock - normal.y),
    cssLengthFromFixed(rect.width + maxInline - minInline),
    cssLengthFromFixed(rect.height + maxBlock - minBlock),
  );
  const boundary = layout.scrollAncestor(attachment.root)?.fragment ?? null;
  let parent = layout.scrollAttachmentParent(attachment.root);
  while (parent !== null && parent.id !== boundary) {
    const outer = layout.scrollAttachment(parent.id);
    if (outer !== null) return scrollAttachmentEnvelope(envelope, outer, documentExtent, layout);
    parent = layout.scrollAttachmentParent(parent.id);
  }
  return envelope;
}

/** One viewport-local projection for painting and every interaction/semantic consumer. */
export class ViewportGeometryProjection {
  readonly #layout: LayoutFragmentTree;
  readonly #viewport: CssRect;
  readonly #offsets: ReadonlyMap<DocumentNodeRef, DocumentScrollOffset>;
  readonly #translations = new Map<LayoutFragmentId, readonly [number, number]>();
  readonly #clips = new Map<LayoutFragmentId, CssRect>();
  readonly #ownerPaintOrder = new Map<LayoutFragmentId | null, number>();
  readonly #candidateWindows = new Map<LayoutFragmentId | null, CssRect>();

  public constructor(layout: LayoutFragmentTree, viewport: CssRect, offsets: readonly DocumentScrollOffset[] = []) {
    this.#layout = layout;
    this.#viewport = viewport;
    const adopted = new Map<DocumentNodeRef, DocumentScrollOffset>();
    for (const offset of offsets) {
      if (!Number.isSafeInteger(offset.inline) || !Number.isSafeInteger(offset.block)) {
        throw new RangeError("Scroll offsets must be finite fixed-point integers.");
      }
      if (adopted.has(offset.node)) throw new TypeError("A scroll owner may have only one offset.");
      adopted.set(offset.node, Object.freeze({ ...offset }));
    }
    this.#offsets = adopted;
    registerRetainedOwner(this,()=>[this.#layout,this.#viewport,this.#offsets,this.#translations,this.#clips,this.#candidateWindows,this.#ownerPaintOrder]);
  }

  public recordContentWindow(owner: LayoutFragmentId | null, rect: CssRect, paintOrder: number): void {
    this.#candidateWindows.set(owner, rect);
    this.#ownerPaintOrder.set(owner, paintOrder);
  }

  public *visibleScrollOwners(): Iterable<LayoutScrollOwner> {
    for (const id of [...this.#candidateWindows.keys()].sort((a,b)=>(this.#ownerPaintOrder.get(a)??0)-(this.#ownerPaintOrder.get(b)??0))) {
      const owner = id === null ? null : this.#layout.scrollContainer(id);
      if (owner !== null) yield owner;
    }
  }

  public candidateWindows(): Iterable<readonly [LayoutFragmentId | null, CssRect]> {
    return this.#candidateWindows.entries();
  }

  public offset(owner: LayoutScrollOwner): readonly [number, number] {
    const requested = this.#offsets.get(owner.documentNode);
    return [
      Math.max(owner.minInline, Math.min(owner.maxInline, requested?.inline ?? 0)),
      Math.max(owner.minBlock, Math.min(owner.maxBlock, requested?.block ?? 0)),
    ];
  }

  public translation(fragment: LayoutFragmentId): readonly [number, number] {
    const known = this.#translations.get(fragment);
    if (known !== undefined) return known;
    const pending: LayoutFragmentId[] = [];
    let current: LayoutFragmentId | null = fragment;
    while (current !== null && !this.#translations.has(current)) {
      pending.push(current);
      current = this.#layout.scrollAttachmentParent(current)?.id ?? null;
    }
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;
      const parent = this.#layout.scrollAttachmentParent(id)?.id ?? null;
      const inherited = parent === null ? [0, 0] : this.#translations.get(parent) ?? [0, 0];
      const owner = parent === null ? null : this.#layout.scrollContainer(parent);
      const offset = owner === null ? [0, 0] : this.offset(owner);
      let inline = inherited[0] - offset[0];
      let block = inherited[1] - offset[1];
      const attachment = this.#layout.scrollAttachment(id);
      if (attachment?.kind === "fixed") {
        inline = this.#viewport.x;
        block = this.#viewport.y;
      } else if (attachment?.kind === "sticky") {
        const scrollOwner = this.#layout.scrollAncestor(id);
        const viewport = scrollOwner === null ? this.#viewport : this.rect(scrollOwner.fragment, scrollOwner.scrollport);
        const normal = translatedRect(attachment.normalBorderRect, inline, block);
        const containing = translatedRect(stickyContainingRect(this.#layout, attachment), inline, block);
        let x: number = normal.x;
        let y: number = normal.y;
        if (attachment.left !== null) x = Math.max(x, viewport.x + attachment.left);
        else if (attachment.right !== null) x = Math.min(x, viewport.x + viewport.width - attachment.right - normal.width);
        if (attachment.top !== null) y = Math.max(y, viewport.y + attachment.top);
        else if (attachment.bottom !== null) y = Math.min(y, viewport.y + viewport.height - attachment.bottom - normal.height);
        x = Math.max(containing.x, Math.min(containing.x + containing.width - normal.width, x));
        y = Math.max(containing.y, Math.min(containing.y + containing.height - normal.height, y));
        inline += x - normal.x;
        block += y - normal.y;
      }
      this.#translations.set(id, Object.freeze([inline, block]));
    }
    return this.#translations.get(fragment) ?? [0, 0];
  }

  public rect(fragment: LayoutFragmentId, rect: CssRect): CssRect {
    const [inline, block] = this.translation(fragment);
    return inline === 0 && block === 0 ? rect : translatedRect(rect, inline, block);
  }

  public clip(fragment: LayoutFragmentId, boxChrome = false): CssRect {
    const known = boxChrome ? undefined : this.#clips.get(fragment);
    if (known !== undefined) return known;
    let chain = this.#layout.clipChain(fragment);
    let result: CssRect | null = null;
    while (chain !== null) {
      if (boxChrome && chain.owner === fragment && (chain.kind === "overflow" || chain.kind === "contain")) {
        chain = chain.parent;
        continue;
      }
      const rect = chain.kind === "canvas"
        ? cssRect(this.#viewport.x,chain.rect.y,this.#viewport.width,chain.rect.height)
        : chain.owner === null ? chain.rect : this.rect(chain.owner, chain.rect);
      result = result === null ? rect : cssIntersection(result, rect);
      chain = chain.parent;
    }
    const resolved = result ?? this.#layout.fragment(fragment).clipRect;
    if (!boxChrome) this.#clips.set(fragment, resolved);
    return resolved;
  }

  public visible(fragment: LayoutFragmentId, rect: CssRect): CssRect {
    return cssIntersection(this.rect(fragment, rect), this.clip(fragment));
  }
}

export function reconcileScrollOffsets(layout: LayoutFragmentTree, offsets: readonly DocumentScrollOffset[]): readonly DocumentScrollOffset[] {
  const retained: DocumentScrollOffset[] = [];
  const seen = new Set<DocumentNodeRef>();
  for (const offset of offsets) {
    if (seen.has(offset.node)) throw new TypeError("A scroll owner may have only one offset.");
    seen.add(offset.node);
    if (!Number.isSafeInteger(offset.inline) || !Number.isSafeInteger(offset.block)) throw new RangeError("Invalid scroll offset.");
    const owner = layout.forDocumentNode(offset.node).map((fragment) => layout.scrollContainer(fragment.id)).find((entry) => entry !== null);
    if (owner === undefined) continue;
    const inline = Math.max(owner.minInline, Math.min(owner.maxInline, offset.inline));
    const block = Math.max(owner.minBlock, Math.min(owner.maxBlock, offset.block));
    if (inline !== 0 || block !== 0) retained.push(Object.freeze({ node: offset.node, inline, block }));
  }
  return Object.freeze(retained);
}

export function logicalRangeRect(layout: LayoutFragmentTree, fragment: LayoutFragmentId, start: number, end: number): CssRect | null {
  const value = layout.fragment(fragment);
  const lines = value.kind === "control" && value.controlLines !== undefined ? value.controlLines
    : [{clusters:value.visualClusters??[],blockOffset:0,height:value.contentRect.height}];
  for (const line of lines) {
    let advance = 0;
    let left: number | null = null;
    let right = 0;
    for (const cluster of line.clusters) {
      if (cluster.contentStartCodeUnit < end && cluster.contentEndCodeUnit > start) {
        left ??= advance;
        right = advance + cluster.advance;
      }
      advance += cluster.advance;
    }
    if (left !== null) return cssRect(cssCoordinateFromFixed(value.contentRect.x+left),
      cssCoordinateFromFixed(value.contentRect.y+line.blockOffset),cssLengthFromFixed(Math.max(1,right-left)),line.height);
  }
  return null;
}

export function revealDocumentNode(
  layout: LayoutFragmentTree,
  viewport: CssRect,
  offsets: readonly DocumentScrollOffset[],
  target: DocumentNodeRef,
  align: "start" | "nearest",
): { readonly offsets: readonly DocumentScrollOffset[]; readonly rect: CssRect | null } {
  const fragments = layout.forDocumentNode(target);
  const fragment = fragments.find((entry) => entry.kind !== "text" && entry.style.visible)
    ?? fragments.find((entry) => entry.style.visible);
  if (fragment === undefined) return { offsets, rect: null };
  const targetRect = fragment.borderRect;
  return revealLayoutRect(layout, viewport, offsets, fragment.id, targetRect, align);
}

export function viewportInlineRange(layout:LayoutFragmentTree, viewportWidth:number): {readonly minInline:number;readonly maxInline:number} {
  return layout.viewportDirection === "rtl"
    ? {minInline:Math.min(0,layout.scrollExtent.x),maxInline:0}
    : {minInline:0,maxInline:Math.max(0,layout.scrollExtent.x+layout.scrollExtent.width-viewportWidth)};
}

/** CSSOM nearest alignment leaves an oversized target spanning both edges stationary. */
export function scrollRevealDelta(start:number,size:number,portStart:number,portSize:number,align:"start"|"nearest"):number {
  if (align === "start") return start-portStart;
  const before = start < portStart;
  const after = start+size > portStart+portSize;
  if (before && after) return 0;
  if (before) return size > portSize ? start+size-portStart-portSize : start-portStart;
  if (after) return size > portSize ? start-portStart : start+size-portStart-portSize;
  return 0;
}

export function revealLayoutRect(
  layout: LayoutFragmentTree,
  viewport: CssRect,
  offsets: readonly DocumentScrollOffset[],
  fragment: LayoutFragmentId,
  targetRect: CssRect,
  align: "start" | "nearest",
): {readonly offsets: readonly DocumentScrollOffset[]; readonly rect: CssRect} {
  const retained = new Map(offsets.map((entry) => [entry.node, entry]));
  let owner = layout.scrollAncestor(fragment);
  while (owner !== null) {
    const projection = new ViewportGeometryProjection(layout, viewport, [...retained.values()]);
    const rect = projection.rect(fragment, targetRect);
    const port = projection.rect(owner.fragment, owner.scrollport);
    const [inline, block] = projection.offset(owner);
    retained.set(owner.documentNode, Object.freeze({ node: owner.documentNode,
      inline: Math.max(owner.minInline, Math.min(owner.maxInline, inline + scrollRevealDelta(rect.x, rect.width, port.x, port.width, align))),
      block: Math.max(owner.minBlock, Math.min(owner.maxBlock, block + scrollRevealDelta(rect.y, rect.height, port.y, port.height, align))),
    }));
    owner = owner.parent === null ? null : layout.scrollContainer(owner.parent);
  }
  const result = reconcileScrollOffsets(layout, [...retained.values()]);
  const projection = new ViewportGeometryProjection(layout, viewport, result);
  return { offsets: result, rect: projection.rect(fragment, targetRect) };
}
