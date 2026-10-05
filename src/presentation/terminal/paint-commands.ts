import type { DocumentImageMetadata } from "../../document/index.js";
import { PackedRows, ValueSequence, checkPackedMetadata } from "../../memory/packed.js";
import { registerRetainedOwner } from "../../memory/retained-cost.js";
import {
  EMPTY_TEXT_CLUSTERS, cssCoordinateAdd, cssCoordinateDifference, cssMax, cssMin, cssNonNegativeLength, cssPx, cssRect,
  type CssEdges, type CssRect, type LayoutFragment, type LayoutFragmentId, type LayoutFragmentTree,
  type LayoutPaintStyle,
} from "../layout/index.js";
import type { DocumentPaintCommands, TerminalPaintCommand } from "./types.js";

// Rows retain only canonical fragment/continuation IDs and paint-specific selections.
// The ordinary box/text geometry and semantic/source identities remain in layout.
const BACKGROUND = 0, TOP = 1, LEFT = 4, COLLAPSED = 5, CONTROL_LINE = 6, TEXT = 7, IMAGE = 8;
const SIDES = ["top", "right", "bottom", "left"] as const;

function box(fragment: LayoutFragment, continuation: number) {
  return fragment.kind === "text" ? fragment : fragment.inlineContinuations?.[continuation] ?? fragment;
}

function borderWidths(fragment: LayoutFragment, continuation: number): CssEdges {
  const geometry = box(fragment, continuation);
  return Object.freeze({
    top: cssNonNegativeLength(cssMax(cssPx(0), cssCoordinateDifference(geometry.paddingRect.y, geometry.borderRect.y))),
    right: cssNonNegativeLength(cssMax(cssPx(0), cssCoordinateDifference(cssCoordinateAdd(geometry.borderRect.x, geometry.borderRect.width),
      cssCoordinateAdd(geometry.paddingRect.x, geometry.paddingRect.width)))),
    bottom: cssNonNegativeLength(cssMax(cssPx(0), cssCoordinateDifference(cssCoordinateAdd(geometry.borderRect.y, geometry.borderRect.height),
      cssCoordinateAdd(geometry.paddingRect.y, geometry.paddingRect.height)))),
    left: cssNonNegativeLength(cssMax(cssPx(0), cssCoordinateDifference(geometry.paddingRect.x, geometry.borderRect.x))),
  });
}

function fragmentText(fragment: LayoutFragment): string {
  return fragment.kind === "text" ? fragment.visualText : fragment.kind === "control" ? fragment.controlText ?? ""
    : fragment.kind === "replaced" ? fragment.replacedText ?? "" : "";
}

function paintsBorderColor(color: LayoutPaintStyle["foreground"]): boolean {
  // Null selects the terminal/default currentColor; only explicit transparency suppresses ink.
  return color === null || color.a > 0;
}

function *operations(fragment: LayoutFragment, style: LayoutPaintStyle, image: boolean): IterableIterator<readonly [number, number]> {
  if (style.visible && fragment.kind !== "text") {
    const count = fragment.inlineContinuations?.length ?? 1;
    for (let continuation = 0; continuation < count; continuation += 1) {
      if (style.background !== null && style.background.a > 0) yield [BACKGROUND, continuation];
      const widths = borderWidths(fragment, continuation);
      for (const [index, side] of SIDES.entries()) {
        if (style.borderStyles[side] === "solid" && widths[side] > 0
          && paintsBorderColor(style.borderColors[side])) yield [TOP + index, continuation];
      }
    }
    if (fragment.kind === "box") {
      for (const [index, segment] of (fragment.tableCollapsedBorderSegments ?? []).entries()) {
        if (paintsBorderColor(segment.style.borderColors[segment.side])) yield [COLLAPSED, index];
      }
    }
  }
  if (fragment.kind === "control") {
    for (const [index, line] of (fragment.controlLines ?? []).entries()) {
      if (line.blockOffset >= fragment.contentRect.height) break;
      if (line.text.length > 0) yield [CONTROL_LINE, index];
    }
  }
  if (style.visible && image) yield [IMAGE, 0];
  else if (style.visible && fragmentText(fragment).length > 0) yield [TEXT, 0];
}

/** Construction-only interning is discarded when ownership transfers to the immutable sequence. */
export class PaintCommandBuilder {
  readonly #rows = new PackedRows(4);
  readonly #styles: LayoutPaintStyle[] = [];
  readonly #styleIds = new Map<LayoutPaintStyle, number>();
  readonly #foregroundStyles = new Map<LayoutPaintStyle, LayoutPaintStyle>();
  public constructor() {
    // Immutable sequence wrapper/private slots and its style-reference owner.
    checkPackedMetadata(64 + 6 * 8 + 64);
  }
  public get length(): number { return this.#rows.length; }
  public append(fragment: LayoutFragment, fragmentIndex: number, style: LayoutPaintStyle, limit: number, signal?: AbortSignal, image = false): boolean {
    let count = 0;
    const pending = operations(fragment, style, image);
    while (!pending.next().done) {
      if ((count++ & 255) === 0) signal?.throwIfAborted();
      if (this.length + count > limit) return false;
    }
    const styleId = (value: LayoutPaintStyle): number => {
      const previous = this.#styleIds.get(value);
      if (previous !== undefined) return previous;
      checkPackedMetadata(8);
      const index = this.#styles.length;
      this.#styles.push(value); this.#styleIds.set(value, index);
      return index;
    };
    let foreground: LayoutPaintStyle | undefined;
    for (const [kind, detail] of operations(fragment, style, image)) {
      signal?.throwIfAborted();
      let selected = style;
      if (kind === COLLAPSED) {
        if (fragment.kind !== "box") throw new Error("Collapsed border requires a box fragment.");
        selected = fragment.tableCollapsedBorderSegments?.[detail]?.style ?? style;
      } else if (kind !== BACKGROUND && style.background !== null) {
        foreground ??= this.#foregroundStyles.get(style);
        if (foreground === undefined) {
          checkPackedMetadata(64 + Object.keys(style).length * 16);
          foreground = Object.freeze({ ...style, background: null });
          this.#foregroundStyles.set(style, foreground);
        }
        selected = foreground;
      }
      this.#rows.push(fragmentIndex, kind, detail, styleId(selected));
    }
    return true;
  }
  public finish(layout: LayoutFragmentTree, fragments: readonly LayoutFragmentId[], reserved: number, images?: readonly DocumentImageMetadata[]): DocumentPaintCommands {
    return new PackedPaintCommands(layout, fragments, this.#rows.seal(), Object.freeze(this.#styles), reserved, images);
  }
}

class PackedPaintCommands extends ValueSequence<TerminalPaintCommand> implements DocumentPaintCommands {
  readonly #layout: LayoutFragmentTree;
  readonly #fragments: readonly LayoutFragmentId[];
  readonly #rows: PackedRows;
  readonly #styles: readonly LayoutPaintStyle[];
  readonly #reserved: number;
  readonly #images: readonly DocumentImageMetadata[] | undefined;
  public constructor(layout: LayoutFragmentTree, fragments: readonly LayoutFragmentId[], rows: PackedRows,
    styles: readonly LayoutPaintStyle[], reserved: number, images?: readonly DocumentImageMetadata[]) {
    super(); this.#layout = layout; this.#fragments = fragments; this.#rows = rows; this.#styles = styles; this.#reserved = reserved; this.#images = images;
    registerRetainedOwner(this, [layout, fragments, rows, styles, images], () => 6 * 8); Object.freeze(this);
  }
  public get length(): number { return this.#rows.length; }
  public layoutFragment(index: number): LayoutFragmentId {
    const id = this.#fragments[this.#rows.get(index, 0)];
    if (id === undefined) throw new RangeError("Missing canonical paint fragment.");
    return id;
  }
  public isText(index: number): boolean { return this.#rows.get(index, 1) >= CONTROL_LINE; }
  public rect(index: number): CssRect {
    const fragment = this.#layout.fragment(this.layoutFragment(index));
    const kind = this.#rows.get(index, 1), detail = this.#rows.get(index, 2);
    if (kind <= LEFT) return box(fragment, detail).borderRect;
    if (kind === COLLAPSED && fragment.kind === "box") {
      const segment = fragment.tableCollapsedBorderSegments?.[detail];
      if (segment !== undefined) return segment.borderRect;
    }
    if (kind === CONTROL_LINE && fragment.kind === "control") {
      const line = fragment.controlLines?.[detail];
      if (line !== undefined) return cssRect(fragment.contentRect.x, cssCoordinateAdd(fragment.contentRect.y, line.blockOffset),
        fragment.contentRect.width, cssMin(line.height, cssCoordinateDifference(
          cssCoordinateAdd(fragment.contentRect.y, fragment.contentRect.height), cssCoordinateAdd(fragment.contentRect.y, line.blockOffset))));
    }
    if (kind === TEXT || kind === IMAGE) return fragment.contentRect;
    throw new RangeError("Missing canonical paint geometry.");
  }
  public at(index: number): TerminalPaintCommand | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const fragment = this.#layout.fragment(this.layoutFragment(index));
    const kind = this.#rows.get(index, 1), detail = this.#rows.get(index, 2);
    const style = this.#styles[this.#rows.get(index, 3)];
    if (style === undefined) throw new RangeError("Missing retained paint style.");
    const paintOrder = this.#reserved + index;
    if (kind === COLLAPSED && fragment.kind === "box") {
      const segment = fragment.tableCollapsedBorderSegments?.[detail];
      if (segment === undefined) throw new RangeError("Missing collapsed border segment.");
      return Object.freeze({ id: segment.id, kind: "border-side", layoutFragment: fragment.id,
        formattingNode: segment.formattingNode, documentNode: segment.documentNode, sourceRange: segment.sourceRange,
        contentStartCodeUnit: null, contentEndCodeUnit: null, rect: segment.borderRect, borderRect: segment.borderRect,
        borderWidths: segment.borderWidths, clipRect: segment.clipRect, side: segment.side, action: null, semantic: null, style, paintOrder });
    }
    const common = { layoutFragment: fragment.id, formattingNode: fragment.formattingNode, documentNode: fragment.documentNode,
      sourceRange: fragment.sourceRange, contentStartCodeUnit: fragment.contentStartCodeUnit, contentEndCodeUnit: fragment.contentEndCodeUnit,
      clipRect: fragment.clipRect, action: fragment.action, semantic: fragment.semantic, style, paintOrder, rect: this.rect(index) };
    if (kind === BACKGROUND) return Object.freeze({ ...common, id: `terminal-paint:background:${fragment.id}:${String(detail)}`, kind: "background" });
    if (kind >= TOP && kind <= LEFT) {
      const side = SIDES[kind - TOP];
      if (side === undefined) throw new RangeError("Invalid border side.");
      return Object.freeze({ ...common, id: `terminal-paint:border-${side}:${fragment.id}:${String(detail)}`, kind: "border-side",
        side, borderRect: common.rect, borderWidths: borderWidths(fragment, detail) });
    }
    if (kind === CONTROL_LINE && fragment.kind === "control") {
      const line = fragment.controlLines?.[detail];
      if (line === undefined) throw new RangeError("Missing control paint line.");
      return Object.freeze({ ...common, id: `terminal-paint:control-line:${fragment.id}:${String(detail)}`, kind: "text", text: line.text, clusters: line.clusters });
    }
    if (kind === IMAGE) {
      const node = this.#layout.formatting.node(fragment.formattingNode);
      if (node.kind !== "image" || node.imageResourceId === null) throw new RangeError("Missing canonical image resource.");
      const metadata = this.#images?.find((image) => image.id === node.imageResourceId);
      return Object.freeze({ ...common, id: `terminal-paint:image:${fragment.id}`, kind: "image", resourceId: node.imageResourceId, paintGroup: this.#rows.get(index, 0),
        naturalWidth: metadata === undefined ? node.naturalWidth : metadata.width,
        naturalHeight: metadata === undefined ? node.naturalHeight : metadata.height,
        text: fragmentText(fragment), clusters: fragment.visualClusters ?? EMPTY_TEXT_CLUSTERS });
    }
    return Object.freeze({ ...common, id: `terminal-paint:text:${fragment.id}`, kind: "text", text: fragmentText(fragment),
      clusters: fragment.visualClusters ?? EMPTY_TEXT_CLUSTERS });
  }
}
