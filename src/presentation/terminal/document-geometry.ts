import type { DocumentNodeRef } from "../../document/index.js";
import {
  cssCoordinate,
  cssCoordinateFromFixed,
  cssIntersection,
  cssLengthFromFixed,
  cssPx,
  cssRect,
  cssUnion,
  type CssRect,
  type LayoutFragment,
  type LayoutFragmentId,
  type LayoutFragmentTree,
  type LayoutScrollAttachment,
} from "../layout/index.js";
import { terminalPaintBudgets } from "./display-list.js";
import type {
  DocumentAccessibilityGeometry,
  DocumentDisplayList,
  DocumentFocusGeometry,
  DocumentGeometryEntry,
  DocumentGeometryIndex,
  DocumentScrollAnchorGeometry,
  TerminalTruncation,
} from "./types.js";

interface MutableGeometry {
  readonly fragments: LayoutFragmentId[];
  readonly fragmentSet: Set<LayoutFragmentId>;
  readonly rects: CssRect[];
}

interface GeometryInterval<T> {
  readonly value: T;
  readonly rect: CssRect;
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
}

interface GeometryIntervalNode<T> {
  readonly center: number;
  readonly byStart: readonly GeometryInterval<T>[];
  readonly byEnd: readonly GeometryInterval<T>[];
  readonly left: GeometryIntervalNode<T> | null;
  readonly right: GeometryIntervalNode<T> | null;
}

interface AttachedGeometry<T> {
  readonly value: T;
  readonly rects: readonly CssRect[];
}

function geometryIntervalTree<T>(values: readonly GeometryInterval<T>[]): GeometryIntervalNode<T> | null {
  if (values.length === 0) return null;
  const centers = values.map((value) => value.start + Math.floor((value.end - value.start) / 2))
    .sort((left, right) => left - right);
  const center = centers[Math.floor(centers.length / 2)] ?? 0;
  const left: GeometryInterval<T>[] = [];
  const right: GeometryInterval<T>[] = [];
  const overlaps: GeometryInterval<T>[] = [];
  for (const value of values) {
    if (value.end <= center) left.push(value);
    else if (value.start > center) right.push(value);
    else overlaps.push(value);
  }
  if (overlaps.length === 0) {
    const retained = left.pop() ?? right.shift();
    if (retained !== undefined) overlaps.push(retained);
  }
  return Object.freeze({
    center,
    byStart: Object.freeze([...overlaps].sort((a, b) => a.start - b.start || a.ordinal - b.ordinal)),
    byEnd: Object.freeze([...overlaps].sort((a, b) => b.end - a.end || a.ordinal - b.ordinal)),
    left: geometryIntervalTree(left),
    right: geometryIntervalTree(right),
  });
}

class GeometrySpatialIndex<T> {
  readonly #root: GeometryIntervalNode<T> | null;
  readonly #includeEmpty: boolean;

  public constructor(
    values: readonly { readonly value: T; readonly rects: readonly CssRect[] }[],
    includeEmpty = false,
  ) {
    this.#includeEmpty = includeEmpty;
    const intervals: GeometryInterval<T>[] = [];
    for (const [ordinal, entry] of values.entries()) {
      for (const rect of entry.rects) {
        if (!includeEmpty && (rect.width <= 0 || rect.height <= 0)) continue;
        intervals.push(Object.freeze({
          value: entry.value,
          rect,
          ordinal,
          start: rect.y,
          end: rect.y + Math.max(1, rect.height),
        }));
      }
    }
    this.#root = geometryIntervalTree(intervals);
  }

  public query(rect: CssRect, signal?: AbortSignal): readonly T[] {
    const retained = new Map<T, number>();
    let work = 0;
    const consider = (value: GeometryInterval<T>): void => {
      work += 1;
      if ((work & 255) === 0) signal?.throwIfAborted();
      const candidate = value.rect;
      const intersects = candidate.width > 0 && candidate.height > 0
        ? candidate.x < rect.x + rect.width && candidate.x + candidate.width > rect.x
          && candidate.y < rect.y + rect.height && candidate.y + candidate.height > rect.y
        : this.#includeEmpty && candidate.x >= rect.x && candidate.x < rect.x + rect.width
          && candidate.y >= rect.y && candidate.y < rect.y + rect.height;
      if (intersects) {
        retained.set(value.value, value.ordinal);
      }
    };
    const visit = (node: GeometryIntervalNode<T> | null): void => {
      if (node === null) return;
      signal?.throwIfAborted();
      const bottom = rect.y + rect.height;
      if (bottom <= node.center) {
        for (const value of node.byStart) {
          if (value.start >= bottom) break;
          consider(value);
        }
        visit(node.left);
      } else if (rect.y > node.center) {
        for (const value of node.byEnd) {
          if (value.end <= rect.y) break;
          consider(value);
        }
        visit(node.right);
      } else {
        for (const value of node.byStart) consider(value);
        visit(node.left);
        visit(node.right);
      }
    };
    visit(this.#root);
    return Object.freeze([...retained].sort((left, right) => left[1] - right[1]).map(([value]) => value));
  }
}

function visibleRect(fragment: LayoutFragment): CssRect | null {
  if (!fragment.style.visible) return null;
  const rect = cssIntersection(fragment.borderRect, fragment.clipRect);
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

class ImmutableDocumentGeometryIndex implements DocumentGeometryIndex {
  readonly documentExtent: CssRect;
  readonly focusOrder: readonly DocumentFocusGeometry[];
  readonly accessibility: readonly DocumentAccessibilityGeometry[];
  readonly scrollAnchors: readonly DocumentScrollAnchorGeometry[];
  readonly retainedRectangles: number;
  readonly truncations: readonly TerminalTruncation[];
  readonly #geometry: ReadonlyMap<DocumentNodeRef, DocumentGeometryEntry>;
  readonly #anchors: ReadonlyMap<DocumentNodeRef, DocumentScrollAnchorGeometry>;
  readonly #focus: ReadonlyMap<DocumentNodeRef, DocumentFocusGeometry>;
  readonly #accessibility: ReadonlyMap<DocumentNodeRef, DocumentAccessibilityGeometry>;
  readonly #focusSpatial: GeometrySpatialIndex<DocumentFocusGeometry>;
  readonly #attachedFocusSpatial: GeometrySpatialIndex<DocumentFocusGeometry>;
  readonly #accessibilitySpatial: GeometrySpatialIndex<DocumentAccessibilityGeometry>;
  readonly #attachedAccessibilitySpatial: GeometrySpatialIndex<DocumentAccessibilityGeometry>;
  readonly #focusOrdinal: ReadonlyMap<DocumentNodeRef, number>;
  readonly #accessibilityOrdinal: ReadonlyMap<DocumentNodeRef, number>;

  public constructor(
    documentExtent: CssRect,
    geometry: ReadonlyMap<DocumentNodeRef, DocumentGeometryEntry>,
    focusOrder: readonly DocumentFocusGeometry[],
    attachedFocus: readonly AttachedGeometry<DocumentFocusGeometry>[],
    accessibility: readonly DocumentAccessibilityGeometry[],
    attachedAccessibility: readonly AttachedGeometry<DocumentAccessibilityGeometry>[],
    scrollAnchors: readonly DocumentScrollAnchorGeometry[],
    retainedRectangles: number,
    truncations: readonly TerminalTruncation[],
  ) {
    this.documentExtent = documentExtent;
    this.#geometry = geometry;
    this.focusOrder = Object.freeze([...focusOrder]);
    this.accessibility = Object.freeze([...accessibility]);
    this.scrollAnchors = Object.freeze(scrollAnchors
      .map((anchor, sourceOrder) => ({ anchor, sourceOrder }))
      .sort((left, right) => left.anchor.blockOffsetCssPx - right.anchor.blockOffsetCssPx
        || left.sourceOrder - right.sourceOrder)
      .map(({ anchor }) => anchor));
    this.#anchors = new Map(scrollAnchors.map((anchor) => [anchor.documentNode, anchor]));
    this.#focus = new Map(focusOrder.map((entry) => [entry.node, entry]));
    this.#accessibility = new Map(accessibility.map((entry) => [entry.documentNode, entry]));
    this.#focusOrdinal = new Map(focusOrder.map((entry, ordinal) => [entry.node, ordinal]));
    this.#accessibilityOrdinal = new Map(accessibility.map((entry, ordinal) => [entry.documentNode, ordinal]));
    this.#focusSpatial = new GeometrySpatialIndex(focusOrder.map((entry) => ({
      value: entry,
      rects: entry.rects,
    })));
    this.#attachedFocusSpatial = new GeometrySpatialIndex(attachedFocus);
    this.#accessibilitySpatial = new GeometrySpatialIndex(accessibility.map((entry) => ({
      value: entry,
      rects: Object.freeze([entry.rect]),
    })), true);
    this.#attachedAccessibilitySpatial = new GeometrySpatialIndex(attachedAccessibility, true);
    this.retainedRectangles = retainedRectangles;
    this.truncations = Object.freeze([...truncations]);
    Object.freeze(this);
  }

  public forDocumentNode(node: DocumentNodeRef): DocumentGeometryEntry | null {
    return this.#geometry.get(node) ?? null;
  }

  public anchorForNode(node: DocumentNodeRef): DocumentScrollAnchorGeometry | null {
    return this.#anchors.get(node) ?? null;
  }

  public focusForNode(node: DocumentNodeRef): DocumentFocusGeometry | null {
    return this.#focus.get(node) ?? null;
  }

  public accessibilityForNode(node: DocumentNodeRef): DocumentAccessibilityGeometry | null {
    return this.#accessibility.get(node) ?? null;
  }

  public focusIntersecting(rect: CssRect, signal?: AbortSignal): readonly DocumentFocusGeometry[] {
    const values = new Map<DocumentNodeRef, DocumentFocusGeometry>();
    for (const entry of this.#focusSpatial.query(rect, signal)) values.set(entry.node, entry);
    for (const entry of this.#attachedFocusSpatial.query(rect, signal)) values.set(entry.node, entry);
    return Object.freeze([...values.values()].sort((left, right) =>
      (this.#focusOrdinal.get(left.node) ?? 0) - (this.#focusOrdinal.get(right.node) ?? 0)));
  }

  public accessibilityIntersecting(
    rect: CssRect,
    signal?: AbortSignal,
  ): readonly DocumentAccessibilityGeometry[] {
    const values = new Map<DocumentNodeRef, DocumentAccessibilityGeometry>();
    for (const entry of this.#accessibilitySpatial.query(rect, signal)) values.set(entry.documentNode, entry);
    for (const entry of this.#attachedAccessibilitySpatial.query(rect, signal)) {
      values.set(entry.documentNode, entry);
    }
    return Object.freeze([...values.values()].sort((left, right) =>
      (this.#accessibilityOrdinal.get(left.documentNode) ?? 0)
        - (this.#accessibilityOrdinal.get(right.documentNode) ?? 0)));
  }
}

function inheritedAttachment(
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

function attachmentEnvelope(
  rect: CssRect,
  attachment: LayoutScrollAttachment,
  documentExtent: CssRect,
): CssRect {
  if (attachment.kind === "fixed") return documentExtent;
  const normal = attachment.normalBorderRect;
  const containing = attachment.containingBlock;
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
  return cssRect(
    cssCoordinateFromFixed(rect.x + minInline - normal.x),
    cssCoordinateFromFixed(rect.y + minBlock - normal.y),
    cssLengthFromFixed(rect.width + maxInline - minInline),
    cssLengthFromFixed(rect.height + maxBlock - minBlock),
  );
}

function attachedGeometry<T>(
  values: readonly T[],
  fragments: (value: T) => readonly LayoutFragmentId[],
  rects: (value: T) => readonly CssRect[],
  layout: LayoutFragmentTree,
  documentExtent: CssRect,
): readonly AttachedGeometry<T>[] {
  const attached: AttachedGeometry<T>[] = [];
  for (const value of values) {
    const valueFragments = fragments(value);
    const envelopes: CssRect[] = [];
    for (const [index, rect] of rects(value).entries()) {
      const fragment = valueFragments[index] ?? valueFragments[0];
      if (fragment === undefined) continue;
      const attachment = inheritedAttachment(layout, fragment);
      if (attachment !== null) envelopes.push(attachmentEnvelope(rect, attachment, documentExtent));
    }
    if (envelopes.length > 0) attached.push(Object.freeze({ value, rects: Object.freeze(envelopes) }));
  }
  return Object.freeze(attached);
}

/** Builds document-space semantic and interaction geometry once per document layout. */
export function buildDocumentGeometryIndex(
  list: DocumentDisplayList,
  signal?: AbortSignal,
): DocumentGeometryIndex {
  const budgets = terminalPaintBudgets(list.context.budgets);
  if (budgets === null) {
    const empty = cssRect(
      list.layout.context.initialContainingBlock.x,
      list.layout.context.initialContainingBlock.y,
      cssPx(0),
      cssPx(0),
    );
    return new ImmutableDocumentGeometryIndex(empty, new Map(), [], [], [], [], [], 0, []);
  }
  const document = list.layout.formatting.document;
  const geometry = new Map<DocumentNodeRef, MutableGeometry>();
  const focus = new Map<DocumentNodeRef, {
    action: NonNullable<LayoutFragment["action"]>;
    fragments: LayoutFragmentId[];
    fragmentSet: Set<LayoutFragmentId>;
    rects: CssRect[];
  }>();
  const ensure = (node: DocumentNodeRef): MutableGeometry => {
    const value = geometry.get(node) ?? { fragments: [], fragmentSet: new Set(), rects: [] };
    geometry.set(node, value);
    return value;
  };
  const retainFragment = (value: MutableGeometry, fragment: LayoutFragmentId): void => {
    if (value.fragmentSet.has(fragment)) return;
    value.fragmentSet.add(fragment);
    value.fragments.push(fragment);
  };
  let retainedRectangles = 0;
  let retainedFocusRectangles = 0;
  const truncations = new Map<TerminalTruncation["budget"], number>();
  const truncated = (budget: TerminalTruncation["budget"], limit: number): void => {
    truncations.set(budget, limit);
  };
  const layoutFragments: LayoutFragmentId[] = [];
  const pendingFragments = [list.layout.root];
  while (pendingFragments.length > 0) {
    const id = pendingFragments.pop();
    if (id === undefined) continue;
    layoutFragments.push(id);
    const children = list.layout.fragment(id).children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pendingFragments.push(child);
    }
  }
  for (const [index, id] of layoutFragments.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const fragment = list.layout.fragment(id);
    const actionRect = visibleRect(fragment);
    const geometryRect = fragment.style.visible ? fragment.borderRect : null;
    if (fragment.documentNode !== null) {
      const value = ensure(fragment.documentNode);
      retainFragment(value, fragment.id);
      if (geometryRect !== null && retainedRectangles < budgets.maxRetainedDocumentRectangles) {
        value.rects.push(geometryRect);
        retainedRectangles += 1;
      } else if (geometryRect !== null) truncated("maxRetainedDocumentRectangles", budgets.maxRetainedDocumentRectangles);
    }
    if (fragment.action === null) continue;
    const control = document.control(fragment.action.node);
    if (control?.disabled === true) continue;
    const value = focus.get(fragment.action.node) ?? {
      action: fragment.action,
      fragments: [],
      fragmentSet: new Set(),
      rects: [],
    };
    if (!value.fragmentSet.has(fragment.id)) {
      value.fragmentSet.add(fragment.id);
      value.fragments.push(fragment.id);
    }
    if (actionRect !== null && retainedFocusRectangles < budgets.maxRetainedFocusRectangles) {
      value.rects.push(actionRect);
      retainedFocusRectangles += 1;
    } else if (actionRect !== null) {
      truncated("maxRetainedFocusRectangles", budgets.maxRetainedFocusRectangles);
    }
    focus.set(fragment.action.node, value);
  }
  const order: DocumentNodeRef[] = [];
  const pending = [document.root];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const node = pending.pop();
    if (node === undefined) continue;
    order.push(node);
    const children = document.node(node).children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  const subtreeBounds = new Map<DocumentNodeRef, CssRect>();
  const representativeFragments = new Map<DocumentNodeRef, LayoutFragmentId>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    if (node === undefined) continue;
    const own = geometry.get(node);
    let bounds: CssRect | null = null;
    let representative = own?.fragments[0];
    for (const rect of own?.rects ?? []) {
      bounds = bounds === null ? rect : cssUnion([bounds, rect], bounds);
    }
    for (const child of document.node(node).children) {
      const childBounds = subtreeBounds.get(child);
      if (childBounds !== undefined) {
        bounds = bounds === null ? childBounds : cssUnion([bounds, childBounds], bounds);
      }
      representative ??= representativeFragments.get(child);
    }
    if (bounds !== null) subtreeBounds.set(node, bounds);
    if (representative !== undefined) representativeFragments.set(node, representative);
    if (own === undefined && bounds !== null && representative !== undefined) {
      if (retainedRectangles < budgets.maxRetainedDocumentRectangles) {
        geometry.set(node, {
          fragments: [representative],
          fragmentSet: new Set([representative]),
          rects: [bounds],
        });
        retainedRectangles += 1;
      } else truncated("maxRetainedDocumentRectangles", budgets.maxRetainedDocumentRectangles);
    }
  }
  const immutable = new Map<DocumentNodeRef, DocumentGeometryEntry>();
  const focusOrder: DocumentFocusGeometry[] = [];
  const accessibility: DocumentAccessibilityGeometry[] = [];
  const anchors: DocumentScrollAnchorGeometry[] = [];
  for (const node of order) {
    signal?.throwIfAborted();
    const value = geometry.get(node);
    if (value !== undefined) {
      immutable.set(node, Object.freeze({
        documentNode: node,
        layoutFragments: Object.freeze(value.fragments),
        rects: Object.freeze(value.rects),
      }));
      const first = value.fragments[0];
      if (first !== undefined && anchors.length < budgets.maxRetainedScrollAnchors) {
        anchors.push(Object.freeze({
          id: `document-scroll-anchor:${node}`,
          documentNode: node,
          layoutFragment: first,
          blockOffsetCssPx: list.layout.fragment(first).borderRect.y,
        }));
      } else if (first !== undefined) truncated("maxRetainedScrollAnchors", budgets.maxRetainedScrollAnchors);
    }
    const focusValue = focus.get(node);
    if (focusValue !== undefined) {
      focusOrder.push(Object.freeze({
        node,
        action: focusValue.action,
        layoutFragments: Object.freeze(focusValue.fragments),
        rects: Object.freeze(focusValue.rects),
        label: document.semantic(node)?.accessibleName || "Action",
      }));
    }
    const semantic = document.semantic(node);
    if (semantic === null || semantic.accessibilityHidden || value === undefined) continue;
    if (accessibility.length >= budgets.maxRetainedAccessibilityRectangles) {
      truncated("maxRetainedAccessibilityRectangles", budgets.maxRetainedAccessibilityRectangles);
      continue;
    }
    let rect: CssRect | null = subtreeBounds.get(node) ?? null;
    const semanticRects: CssRect[] = [];
    const semanticRectFragments: LayoutFragmentId[] = [];
    for (const fragmentId of value.fragments) {
      const fragment = list.layout.fragment(fragmentId);
      if (!fragment.style.visible) continue;
      const candidate = cssIntersection(fragment.borderRect, fragment.clipRect);
      semanticRects.push(candidate);
      semanticRectFragments.push(fragmentId);
    }
    if (rect === null) {
      const fragment = value.fragments[0] === undefined ? null : list.layout.fragment(value.fragments[0]);
      rect = fragment?.borderRect ?? cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(0), cssPx(0));
    }
    const semanticFragments = [...value.fragments];
    const semanticFragmentSet = new Set(semanticFragments);
    for (const fragment of focusValue?.fragments ?? []) {
      if (!semanticFragmentSet.has(fragment)) {
        semanticFragmentSet.add(fragment);
        semanticFragments.push(fragment);
      }
    }
    accessibility.push(Object.freeze({
      documentNode: node,
      layoutFragments: Object.freeze(semanticFragments),
      role: semantic.role,
      name: semantic.accessibleName,
      description: semantic.accessibleDescription,
      rect,
      rects: Object.freeze(semanticRects),
      rectFragments: Object.freeze(semanticRectFragments),
    }));
  }
  const root = list.layout.fragment(list.layout.root);
  const extent = cssUnion(
    [list.layout.context.initialContainingBlock, root.overflowRect],
    list.layout.context.initialContainingBlock,
  );
  return new ImmutableDocumentGeometryIndex(
    extent,
    immutable,
    focusOrder,
    attachedGeometry(
      focusOrder,
      (entry) => entry.layoutFragments,
      (entry) => entry.rects,
      list.layout,
      extent,
    ),
    accessibility,
    attachedGeometry(
      accessibility,
      (entry) => entry.rectFragments,
      (entry) => entry.rects,
      list.layout,
      extent,
    ),
    anchors,
    retainedRectangles,
    [...truncations].map(([budget, limit]) => Object.freeze({ budget, limit })),
  );
}
