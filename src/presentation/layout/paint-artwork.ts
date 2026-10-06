import type { DocumentImageMetadata } from "../../document/index.js";
import { checkPackedMetadata } from "../../memory/packed.js";
import { registerRetainedOwner } from "../../memory/retained-cost.js";
import { cssCoordinateAdd, cssLengthFromFixed, cssMax, cssMultiply, cssPx, cssRect,
  type CssPixelLength, type CssRect, type LayoutFragment, type LayoutFragmentTree } from "./index.js";
import type { ComputedStyle, CssColor, CssLength, CssMaskImage, StyleSnapshot } from "../style/types.js";
import { formattingComputedStyle } from "./paint-style.js";
import { evaluateUsedCssMath } from "./length-math.js";

export interface LayoutMaskArtwork {
  readonly rect: CssRect;
  readonly clipRect: CssRect;
  readonly resourceId: string;
  readonly naturalWidth: number | null;
  readonly naturalHeight: number | null;
  readonly tint: CssColor;
}

export type LayoutArtworkFallbackReason = "unsupported-mask" | "native-content-mask" | "mask-intrinsics-pending"
  | "repeating-mask" | "missing-mask-tint" | "unsupported-mask-paint";

class ResolvedMaskArtwork implements LayoutMaskArtwork {
  readonly #rect: CssRect;
  readonly #clipRect: CssRect;
  readonly #resource: DocumentImageMetadata | Extract<CssMaskImage, { readonly kind: "url" }>;
  readonly #naturalWidth: number | null;
  readonly #naturalHeight: number | null;
  readonly #tint: CssColor;
  public constructor(area: CssRect, inline: CssPixelLength, block: CssPixelLength,
    width: CssPixelLength, height: CssPixelLength, resource: DocumentImageMetadata | Extract<CssMaskImage, { readonly kind: "url" }>,
    naturalWidth: number | null, naturalHeight: number | null, tint: CssColor) {
    // One immutable descriptor/private slots and its newly resolved rectangle.
    // Clip, tint and resource identity remain shared canonical dependencies.
    const pending = naturalWidth === null || naturalHeight === null;
    checkPackedMetadata(64 + 6 * 8 + (pending ? 0 : 64 + 4 * 16));
    // Pending resources retain the author's box as a spatial discovery owner;
    // they cannot expose graphics until natural dimensions are accepted.
    this.#rect = pending ? area : cssRect(cssCoordinateAdd(area.x, inline), cssCoordinateAdd(area.y, block), width, height);
    this.#clipRect = area; this.#resource = resource;
    this.#naturalWidth = naturalWidth; this.#naturalHeight = naturalHeight; this.#tint = tint;
    registerRetainedOwner(this, [this.#rect, area, resource, tint], () => 6 * 8);
    Object.freeze(this);
  }
  public get rect(): CssRect { return this.#rect; }
  public get clipRect(): CssRect { return this.#clipRect; }
  public get resourceId(): string { return "id" in this.#resource ? this.#resource.id : this.#resource.resourceId; }
  public get naturalWidth(): number | null { return this.#naturalWidth; }
  public get naturalHeight(): number | null { return this.#naturalHeight; }
  public get tint(): CssColor { return this.#tint; }
}

function usedMaskLength(value: CssLength, basis: CssPixelLength, fragment: LayoutFragment,
  style: ComputedStyle, layout: LayoutFragmentTree): CssPixelLength | null {
  if (value.kind === "zero") return cssPx(0);
  if (value.kind === "calculation") return evaluateUsedCssMath(value.calculation.expression,
    (magnitude, unit) => usedMaskLength({ kind: "length", value: magnitude, unit }, basis, fragment, style, layout) ?? cssPx(0));
  if (value.kind !== "length") return null;
  const font = style.text.fontSize;
  const fontSize = font.kind === "zero" ? cssPx(0) : font.kind === "length" && font.unit === "px"
    ? cssPx(font.value) : layout.rootFontMetrics.fontSize;
  switch (value.unit) {
    case "px": return cssPx(value.value);
    case "%": return cssMultiply(basis, value.value / 100);
    case "em": return cssMultiply(fontSize, value.value);
    case "rem": return cssMultiply(layout.rootFontMetrics.fontSize, value.value);
    case "ex": return cssMultiply((fragment.usedFontMetrics ?? layout.context.textMeasurer.fontMetrics(fontSize)).xHeight, value.value);
    case "ch": return cssMultiply((fragment.usedFontMetrics ?? layout.context.textMeasurer.fontMetrics(fontSize)).chAdvance, value.value);
    case "vw": return cssMultiply(layout.context.viewport.width, value.value / 100);
    case "vh": return cssMultiply(layout.context.viewport.height, value.value / 100);
  }
}

function paintsBorder(fragment: LayoutFragment, style: ComputedStyle): boolean {
  const border = fragment.borderRect, padding = fragment.paddingRect;
  const widths = { top: padding.y - border.y, right: border.x + border.width - padding.x - padding.width,
    bottom: border.y + border.height - padding.y - padding.height, left: padding.x - border.x };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const color = style.box.borderColors[side];
    if (widths[side] > 0 && style.box.borderStyles[side] === "solid" && (color === null || color.a > 0)) return true;
  }
  return fragment.kind === "box" && (fragment.tableCollapsedBorderSegments ?? []).some((segment) => {
    const color = segment.style.borderColors[segment.side];
    return color === null || color.a > 0;
  });
}

/** One image-backed alpha silhouette. Layout stays canonical; only its artwork
 * size/position is resolved here. Native text/control descendants never rasterize.
 */
function resolveMaskArtwork(fragment: LayoutFragment, style: ComputedStyle, layout: LayoutFragmentTree,
  metadata: DocumentImageMetadata | undefined, nativeContent: boolean, descendantPaint: boolean): LayoutMaskArtwork | LayoutArtworkFallbackReason {
  if (style.mask.image.kind !== "url") return "unsupported-mask";
  if (nativeContent || fragment.kind !== "box") return "native-content-mask";
  if (descendantPaint || paintsBorder(fragment, style)) return "unsupported-mask-paint";
  // A mask clips existing paint; color alone does not fill an empty element.
  // background:currentColor is already resolved by the canonical style stage.
  // This bounded artwork path models one uniform background, not border ink.
  const tint = style.text.background;
  if (tint === null || tint.a <= 0) return "missing-mask-tint";
  const area = fragment.borderRect;
  if (metadata?.width === null || metadata?.height === null || metadata === undefined || metadata.width <= 0 || metadata.height <= 0) {
    return new ResolvedMaskArtwork(area, cssPx(0), cssPx(0), area.width, area.height,
      metadata ?? style.mask.image, null, null, tint);
  }
  const naturalWidth = cssPx(metadata.width), naturalHeight = cssPx(metadata.height);
  let width: CssPixelLength = naturalWidth, height: CssPixelLength = naturalHeight;
  const size = style.mask.size;
  if (size.kind === "contain" || size.kind === "cover") {
    const scale = size.kind === "contain" ? Math.min(area.width / naturalWidth, area.height / naturalHeight)
      : Math.max(area.width / naturalWidth, area.height / naturalHeight);
    width = cssMultiply(naturalWidth, scale); height = cssMultiply(naturalHeight, scale);
  } else if (size.kind === "explicit") {
    const requestedWidth = usedMaskLength(size.width, area.width, fragment, style, layout);
    const requestedHeight = usedMaskLength(size.height, area.height, fragment, style, layout);
    width = requestedWidth ?? (requestedHeight === null ? naturalWidth : cssMultiply(naturalWidth, requestedHeight / naturalHeight));
    height = requestedHeight ?? (requestedWidth === null ? naturalHeight : cssMultiply(naturalHeight, requestedWidth / naturalWidth));
  }
  // Negative calculation results are valid specified lengths but mask sizes
  // have a non-negative used range, just like the canonical box-size solver.
  width = cssMax(cssPx(0), width); height = cssMax(cssPx(0), height);
  const inline = style.mask.position === "center" ? cssLengthFromFixed((area.width - width) / 2) : cssPx(0);
  const block = style.mask.position === "center" ? cssLengthFromFixed((area.height - height) / 2) : cssPx(0);
  if (style.mask.repeat === "repeat" && (inline > 0 || block > 0 || inline + width < area.width || block + height < area.height)) {
    return "repeating-mask";
  }
  return new ResolvedMaskArtwork(area, inline, block, width, height, metadata, metadata.width, metadata.height, tint);
}

/** Resolve CSS artwork geometry at the layout/paint bridge. Display-list
 * admission consumes only this canonical descriptor, never CSS sizing values.
 */
export function createLayoutArtworkResolver(layout: LayoutFragmentTree, styles: StyleSnapshot,
  images: readonly DocumentImageMetadata[] | undefined, signal?: AbortSignal): (fragment: LayoutFragment) =>
  { readonly masked: boolean; readonly artwork: LayoutMaskArtwork | null; readonly fallback: LayoutArtworkFallbackReason | null } {
  // This one construction-only traversal owns both mask ancestry and subtree
  // eligibility. Stacking order may visit a descendant independently later;
  // it must not turn that descendant's chrome into unmasked source paint.
  const scopes = new Map<LayoutFragment["id"], {
    readonly fragment: LayoutFragment;
    readonly style: ComputedStyle | null;
    readonly ownsMask: boolean;
    readonly maskedAncestor: boolean;
    nativeContent: boolean;
    decorativeContent: boolean;
    descendantPaint: boolean;
  }>();
  const pending = [{ id: layout.root, maskedAncestor: false }];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const entry = pending.pop();
    if (entry === undefined) continue;
    const { id, maskedAncestor } = entry;
    const fragment = layout.fragment(id);
    const node = layout.formatting.node(fragment.formattingNode);
    const style = formattingComputedStyle(node, styles);
    const ownsMask = node.appliesBoxStyle && fragment.kind !== "text"
      && style !== null && style.mask.image.kind !== "none";
    scopes.set(id, { fragment, style, ownsMask, maskedAncestor, descendantPaint: false,
      nativeContent: fragment.kind === "control" || fragment.kind === "replaced"
        || fragment.kind === "text" && fragment.visualText.trim().length > 0,
      decorativeContent: node.appliesBoxStyle && fragment.kind !== "text" && style !== null && style.visibility === "visible"
        && (ownsMask || style.text.background !== null && style.text.background.a > 0 || paintsBorder(fragment, style)),
    });
    for (const child of fragment.children) pending.push({ id: child, maskedAncestor: maskedAncestor || ownsMask });
  }
  const order = [...scopes.values()];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    signal?.throwIfAborted();
    const scope = order[index];
    if (scope === undefined) continue;
    for (const child of scope.fragment.children) {
      const descendant = scopes.get(child);
      if (descendant === undefined) continue;
      scope.nativeContent ||= descendant.nativeContent;
      scope.descendantPaint ||= descendant.decorativeContent;
    }
    scope.decorativeContent ||= scope.descendantPaint;
  }
  const metadata = new Map(images?.map((image) => [image.id, image]));
  const unmasked = Object.freeze({ masked: false, artwork: null, fallback: null });
  const maskedDescendant = Object.freeze({ masked: true, artwork: null, fallback: null });
  return (fragment) => {
    signal?.throwIfAborted();
    const scope = scopes.get(fragment.id);
    if (scope === undefined) return unmasked;
    const { style } = scope;
    if (scope.maskedAncestor) return scope.ownsMask && !scope.nativeContent
      ? { masked: true, artwork: null, fallback: "unsupported-mask-paint" } : maskedDescendant;
    if (!scope.ownsMask || style === null) return unmasked;
    const resolved = resolveMaskArtwork(fragment, style, layout,
      style.mask.image.kind === "url" ? metadata.get(style.mask.image.resourceId) : undefined, scope.nativeContent, scope.descendantPaint);
    return typeof resolved === "string" ? { masked: true, artwork: null, fallback: resolved }
      : { masked: true, artwork: resolved,
        fallback: resolved.naturalWidth === null || resolved.naturalHeight === null ? "mask-intrinsics-pending" : null };
  };
}
