import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import type {
  FormattingFormControlNode,
  FormattingNode,
  FormattingNodeId,
  FormattingReplacedNode,
  FormattingTextNode,
  FormattingTree
} from "../formatting/index.js";
import { presentedControlText } from "../search/index.js";
import type { ComputedStyle, CssLength } from "../style/index.js";
import {
  cssAdd,
  cssCoordinate,
  cssCoordinateFromFixed,
  cssIntersection,
  cssLengthFromFixed,
  cssMax,
  cssMin,
  cssMultiply,
  cssPx,
  cssRect,
  cssUnion,
  type CssCoordinate,
  type CssEdges,
  type CssPixelLength,
  type CssRect
} from "./fixed.js";
import type {
  BuildLayoutFragmentTreeInput,
  DocumentActionIdentity,
  LayoutBoxFragment,
  LayoutBudgets,
  LayoutFragment,
  LayoutFragmentId,
  LayoutFragmentTree,
  LayoutOutcome,
  LayoutPaintStyle,
  LayoutSearchSpan,
  LayoutTextFragment,
  LineBox,
  LineBoxId,
  UsedFontMetrics
} from "./types.js";

const DEFAULT_LAYOUT_BUDGETS: LayoutBudgets = Object.freeze({
  maxFragments: 100_000,
  maxLineBoxes: 50_000,
  maxTextFragments: 100_000,
  maxDepth: 512
});

const ZERO = cssPx(0);

class LayoutBudgetExhausted extends Error {}

interface LayoutResult {
  readonly fragment: LayoutFragmentId;
  readonly borderRect: CssRect;
  readonly marginRect: CssRect;
}

interface InlineLineEntry {
  readonly fragment: LayoutFragmentId;
  readonly metrics: UsedFontMetrics;
  readonly lineHeight: CssPixelLength;
  readonly verticalAlign: ComputedStyle["text"]["verticalAlign"];
}

interface InlineFormattingCursor {
  readonly containingFragment: LayoutFragmentId;
  readonly continuationX: CssCoordinate;
  readonly maxX: CssCoordinate;
  readonly textAlign: ComputedStyle["text"]["textAlign"];
  readonly strutMetrics: UsedFontMetrics;
  readonly strutLineHeight: CssPixelLength;
  lineStartX: CssCoordinate;
  x: CssCoordinate;
  y: CssCoordinate;
  collapsedSpace: boolean;
  readonly entries: InlineLineEntry[];
  readonly lineBoxes: LineBox[];
}

interface MappedText {
  readonly value: string;
  readonly units: readonly { readonly start: number; readonly end: number }[];
}

interface UsedDimensions {
  readonly margin: CssEdges;
  readonly padding: CssEdges;
  readonly border: CssEdges;
  readonly contentWidth: CssPixelLength;
  readonly specifiedHeight: CssPixelLength | null;
  readonly minHeight: CssPixelLength;
  readonly maxHeight: CssPixelLength | null;
  readonly marginLeft: CssPixelLength;
  readonly marginRight: CssPixelLength;
}

interface CollapsibleMarginProfile {
  readonly before: CssPixelLength;
  readonly after: CssPixelLength;
  readonly through: boolean;
}

function transformedText(value: string, transform: ComputedStyle["text"]["textTransform"]): MappedText {
  let output = "";
  const units: { readonly start: number; readonly end: number }[] = [];
  let sourceOffset = 0;
  let capitalizeNext = true;
  for (const codePoint of value) {
    let transformed = codePoint;
    if (transform === "uppercase") transformed = codePoint.toUpperCase();
    else if (transform === "lowercase") transformed = codePoint.toLowerCase();
    else if (transform === "capitalize") {
      if (capitalizeNext && /\p{L}/u.test(codePoint)) transformed = codePoint.toUpperCase();
      capitalizeNext = /[\s\p{P}]/u.test(codePoint);
    }
    output += transformed;
    for (let index = 0; index < transformed.length; index += 1) {
      units.push({ start: sourceOffset, end: sourceOffset + codePoint.length });
    }
    sourceOffset += codePoint.length;
  }
  return { value: output, units };
}

function mappedRange(map: MappedText, start: number, end: number): readonly [number, number] {
  const first = map.units[start];
  const last = map.units[end - 1];
  return first === undefined || last === undefined ? [start, end] : [first.start, last.end];
}

function normalizeBudgets(value: Partial<LayoutBudgets> | undefined): LayoutBudgets {
  const integer = (candidate: number | undefined, fallback: number): number =>
    Number.isSafeInteger(candidate) && (candidate ?? 0) > 0 ? candidate ?? fallback : fallback;
  return Object.freeze({
    maxFragments: integer(value?.maxFragments, DEFAULT_LAYOUT_BUDGETS.maxFragments),
    maxLineBoxes: integer(value?.maxLineBoxes, DEFAULT_LAYOUT_BUDGETS.maxLineBoxes),
    maxTextFragments: integer(value?.maxTextFragments, DEFAULT_LAYOUT_BUDGETS.maxTextFragments),
    maxDepth: integer(value?.maxDepth, DEFAULT_LAYOUT_BUDGETS.maxDepth)
  });
}

function fragmentId(value: string): LayoutFragmentId {
  return value as LayoutFragmentId;
}

function lineBoxId(value: string): LineBoxId {
  return value as LineBoxId;
}

function point(value: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return cssCoordinateFromFixed(value + offset);
}

function length(value: number): CssPixelLength {
  return cssLengthFromFixed(value);
}

function nonNegative(value: CssPixelLength): CssPixelLength {
  return cssMax(ZERO, value);
}

function negate(value: CssPixelLength): CssPixelLength {
  return length(0 - value);
}

function sum(...values: readonly CssPixelLength[]): CssPixelLength {
  return length(values.reduce((total, value) => total + value, 0));
}

function collapseMargins(...values: readonly CssPixelLength[]): CssPixelLength {
  const positive = Math.max(0, ...values);
  const negative = Math.min(0, ...values);
  return length(positive + negative);
}

function isInlineFormatting(node: FormattingNode): boolean {
  return node.outer === "inline"
    || node.kind === "text-sequence"
    || node.kind === "generated-text"
    || node.kind === "marker"
    || node.kind === "forced-line-break"
    || node.kind === "form-control"
    || node.kind === "replaced-element"
    || node.kind === "image-fallback";
}

function establishesInlineFormattingContext(node: FormattingNode): boolean {
  return node.outer === "inline"
    && (node.kind === "flex-container" || node.kind === "grid-container" || node.kind === "table-wrapper");
}

class LayoutBuilder {
  readonly #input: BuildLayoutFragmentTreeInput;
  readonly #formatting: FormattingTree;
  readonly #budgets: LayoutBudgets;
  readonly #fragments = new Map<LayoutFragmentId, LayoutFragment>();
  readonly #formattingIndex = new Map<FormattingNodeId, LayoutFragmentId[]>();
  readonly #documentIndex = new Map<DocumentNodeRef, LayoutFragmentId[]>();
  readonly #lineBoxes: LineBox[] = [];
  readonly #lineBoxPositions = new Map<LineBoxId, number>();
  readonly #ordinals = new Map<string, number>();
  readonly #decorationCache = new Map<FormattingNodeId, { readonly underline: boolean; readonly lineThrough: boolean }>();
  readonly #marginProfileCache = new Map<string, CollapsibleMarginProfile>();
  #reserved = 0;
  #textFragments = 0;
  #visualOrder = 0;
  #paintOrder = 0;
  #truncated: keyof LayoutBudgets | null = null;

  public constructor(input: BuildLayoutFragmentTreeInput) {
    this.#input = input;
    this.#formatting = input.formatting;
    this.#budgets = normalizeBudgets(input.context.budgets);
  }

  #newId(formatting: FormattingNodeId, occurrence = "box"): LayoutFragmentId {
    const key = `${formatting}:${occurrence}`;
    const ordinal = (this.#ordinals.get(key) ?? 0) + 1;
    this.#ordinals.set(key, ordinal);
    return fragmentId(`layout-fragment:${key}:${String(ordinal)}`);
  }

  #reserve(): void {
    if (this.#fragments.size + this.#reserved >= this.#budgets.maxFragments) {
      this.#truncated ??= "maxFragments";
      throw new LayoutBudgetExhausted();
    }
    this.#reserved += 1;
  }

  #store<T extends LayoutFragment>(value: T, reserved = false): T {
    const outstanding = this.#reserved - (reserved ? 1 : 0);
    if (this.#fragments.size + outstanding >= this.#budgets.maxFragments) {
      this.#truncated ??= "maxFragments";
      throw new LayoutBudgetExhausted();
    }
    if (value.kind === "text") {
      if (this.#textFragments >= this.#budgets.maxTextFragments) {
        this.#truncated ??= "maxTextFragments";
        throw new LayoutBudgetExhausted();
      }
      this.#textFragments += 1;
    }
    this.#fragments.set(value.id, value);
    const byFormatting = this.#formattingIndex.get(value.formattingNode) ?? [];
    byFormatting.push(value.id);
    this.#formattingIndex.set(value.formattingNode, byFormatting);
    if (value.documentNode !== null) {
      const byDocument = this.#documentIndex.get(value.documentNode) ?? [];
      byDocument.push(value.id);
      this.#documentIndex.set(value.documentNode, byDocument);
    }
    return value;
  }

  #computed(node: FormattingNode): ComputedStyle | null {
    if (node.styleNode === null) return null;
    return node.pseudo === null
      ? this.#formatting.styles.style(node.styleNode)
      : this.#formatting.styles.pseudo(node.styleNode, node.pseudo) ?? this.#formatting.styles.style(node.styleNode);
  }

  #boxComputed(node: FormattingNode): ComputedStyle | null {
    return node.appliesBoxStyle ? this.#computed(node) : null;
  }

  #fontSize(style: ComputedStyle | null): CssPixelLength {
    const value = style?.text.fontSize;
    return value?.kind === "length" && value.unit === "px"
      ? cssPx(value.value)
      : this.#input.context.rootFontMetrics.fontSize;
  }

  #metrics(style: ComputedStyle | null): UsedFontMetrics {
    return this.#input.context.textMeasurer.fontMetrics(this.#fontSize(style));
  }

  #usedLength(
    value: CssLength,
    percentageBasis: CssPixelLength,
    style: ComputedStyle | null
  ): CssPixelLength | null {
    if (value.kind === "auto" || value.kind === "none") return null;
    if (value.kind === "zero") return ZERO;
    if (!Number.isFinite(value.value)) throw new RangeError("Non-finite computed CSS length.");
    if (value.unit === "px") return cssPx(value.value);
    if (value.unit === "%") return cssMultiply(percentageBasis, value.value / 100);
    if (value.unit === "vw") return cssMultiply(this.#input.context.viewport.width, value.value / 100);
    if (value.unit === "vh") return cssMultiply(this.#input.context.viewport.height, value.value / 100);
    if (value.unit === "rem") return cssMultiply(this.#input.context.rootFontMetrics.fontSize, value.value);
    if (value.unit === "em") return cssMultiply(this.#fontSize(style), value.value);
    return cssMultiply(this.#metrics(style).chAdvance, value.value);
  }

  #edges(style: ComputedStyle | null, containingWidth: CssPixelLength): {
    readonly margin: CssEdges;
    readonly padding: CssEdges;
    readonly border: CssEdges;
  } {
    const used = (value: CssLength): CssPixelLength => this.#usedLength(value, containingWidth, style) ?? ZERO;
    const margin = style === null
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : {
          top: used(style.box.margin.top), right: used(style.box.margin.right),
          bottom: used(style.box.margin.bottom), left: used(style.box.margin.left)
        };
    const padding = style === null
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : {
          top: nonNegative(used(style.box.padding.top)), right: nonNegative(used(style.box.padding.right)),
          bottom: nonNegative(used(style.box.padding.bottom)), left: nonNegative(used(style.box.padding.left))
        };
    const border = style?.box.borderStyle !== "solid"
      ? { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO }
      : {
          top: nonNegative(used(style.box.borderWidths.top)), right: nonNegative(used(style.box.borderWidths.right)),
          bottom: nonNegative(used(style.box.borderWidths.bottom)), left: nonNegative(used(style.box.borderWidths.left))
        };
    return { margin, padding, border };
  }

  #dimensions(
    node: FormattingNode,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null
  ): UsedDimensions {
    const style = this.#boxComputed(node);
    const { margin, padding, border } = this.#edges(style, containingWidth);
    const horizontalChrome = sum(padding.left, padding.right, border.left, border.right);
    const fixedLeft = style?.box.margin.left.kind === "auto" ? ZERO : margin.left;
    const fixedRight = style?.box.margin.right.kind === "auto" ? ZERO : margin.right;
    const availableBorderBox = nonNegative(length(containingWidth - fixedLeft - fixedRight));
    const specified = style === null ? null : this.#usedLength(style.box.width, containingWidth, style);
    const minimum = style === null ? ZERO : this.#usedLength(style.box.minWidth, containingWidth, style) ?? ZERO;
    const maximum = style === null ? null : this.#usedLength(style.box.maxWidth, containingWidth, style);
    const toContent = (candidate: CssPixelLength): CssPixelLength => style?.box.boxSizing === "border-box"
      ? nonNegative(length(candidate - horizontalChrome))
      : nonNegative(candidate);
    const availableContent = nonNegative(length(availableBorderBox - horizontalChrome));
    let contentWidth = specified === null ? availableContent : toContent(specified);
    contentWidth = cssMax(toContent(minimum), contentWidth);
    if (maximum !== null) contentWidth = cssMin(contentWidth, toContent(maximum));
    const borderBoxWidth = sum(contentWidth, horizontalChrome);
    const remaining = length(containingWidth - fixedLeft - fixedRight - borderBoxWidth);
    const autoLeft = style?.box.margin.left.kind === "auto";
    const autoRight = style?.box.margin.right.kind === "auto";
    let marginLeft = fixedLeft;
    let marginRight = fixedRight;
    if (remaining >= 0 && autoLeft && autoRight) {
      marginLeft = length(Math.trunc(remaining / 2));
      marginRight = length(remaining - marginLeft);
    } else if (remaining >= 0 && autoLeft) marginLeft = remaining;
    else if (remaining >= 0 && autoRight) marginRight = remaining;
    else marginRight = length(fixedRight + remaining);
    const heightBasis = containingHeight;
    const resolvedHeight = style === null || (style.box.height.kind === "length" && style.box.height.unit === "%" && heightBasis === null)
      ? null
      : this.#usedLength(style.box.height, heightBasis ?? ZERO, style);
    const minHeight = style === null || (style.box.minHeight.kind === "length" && style.box.minHeight.unit === "%" && heightBasis === null)
      ? ZERO
      : this.#usedLength(style.box.minHeight, heightBasis ?? ZERO, style) ?? ZERO;
    const maxHeight = style === null || (style.box.maxHeight.kind === "length" && style.box.maxHeight.unit === "%" && heightBasis === null)
      ? null
      : this.#usedLength(style.box.maxHeight, heightBasis ?? ZERO, style);
    const verticalChrome = sum(padding.top, padding.bottom, border.top, border.bottom);
    const heightToContent = (candidate: CssPixelLength): CssPixelLength => style?.box.boxSizing === "border-box"
      ? nonNegative(length(candidate - verticalChrome))
      : nonNegative(candidate);
    return {
      margin, padding, border, contentWidth,
      specifiedHeight: resolvedHeight === null ? null : heightToContent(resolvedHeight),
      minHeight: heightToContent(minHeight),
      maxHeight: maxHeight === null ? null : heightToContent(maxHeight),
      marginLeft,
      marginRight
    };
  }

  #normalBlockFlow(node: FormattingNode): boolean {
    if (node.outer !== "block") return false;
    if (node.kind === "table-wrapper" || node.kind.startsWith("table-") || node.kind === "table"
      || node.kind === "flex-container" || node.kind === "grid-container") return false;
    const display = this.#boxComputed(node)?.display;
    return display?.box !== "principal" || display.inner !== "flow-root";
  }

  #createsLineContent(node: FormattingNode): boolean {
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
      return node.whiteSpace === "pre" || node.whiteSpace === "pre-wrap" || node.whiteSpace === "break-spaces"
        ? node.text.length > 0
        : /\S/u.test(node.text);
    }
    if (node.kind === "forced-line-break" || node.kind === "form-control"
      || node.kind === "replaced-element" || node.kind === "image-fallback") return true;
    return node.children.some((child) => this.#createsLineContent(this.#formatting.node(child)));
  }

  #collapsibleMargins(
    id: FormattingNodeId,
    containingWidth: CssPixelLength,
    containingHeight: CssPixelLength | null,
    depth = 0
  ): CollapsibleMarginProfile {
    const key = `${id}:${String(containingWidth)}:${String(containingHeight ?? "auto")}`;
    const cached = this.#marginProfileCache.get(key);
    if (cached !== undefined) return cached;
    const node = this.#formatting.node(id);
    const dimensions = this.#dimensions(node, containingWidth, containingHeight);
    const boundary = !this.#normalBlockFlow(node)
      || (this.#boxComputed(node)?.box.overflowY ?? "visible") !== "visible"
      || depth >= this.#budgets.maxDepth;
    if (boundary) {
      const profile = Object.freeze({
        before: dimensions.margin.top,
        after: dimensions.margin.bottom,
        through: false
      });
      this.#marginProfileCache.set(key, profile);
      return profile;
    }
    const children = node.children.map((child) => this.#formatting.node(child));
    const hasInlineContent = children.some((child) => isInlineFormatting(child) && this.#createsLineContent(child));
    const blockChildren = hasInlineContent ? [] : children.filter((child) => !isInlineFormatting(child));
    const profiles = blockChildren.map((child) => this.#collapsibleMargins(
      child.id,
      dimensions.contentWidth,
      dimensions.specifiedHeight,
      depth + 1
    ));
    const canCollapseBefore = dimensions.border.top === 0 && dimensions.padding.top === 0
      && blockChildren.length > 0;
    const canCollapseAfter = dimensions.border.bottom === 0 && dimensions.padding.bottom === 0
      && dimensions.specifiedHeight === null && dimensions.minHeight === 0 && blockChildren.length > 0;
    let before = dimensions.margin.top;
    let after = dimensions.margin.bottom;
    if (canCollapseBefore) before = collapseMargins(before, profiles[0]?.before ?? ZERO);
    if (canCollapseAfter) after = collapseMargins(after, profiles.at(-1)?.after ?? ZERO);
    const through = !hasInlineContent
      && dimensions.specifiedHeight === null
      && dimensions.minHeight === 0
      && dimensions.border.top === 0 && dimensions.border.bottom === 0
      && dimensions.padding.top === 0 && dimensions.padding.bottom === 0
      && profiles.every((profile) => profile.through);
    if (through) {
      const adjoining = collapseMargins(
        before,
        after,
        ...profiles.flatMap((profile) => [profile.before, profile.after])
      );
      before = adjoining;
      after = adjoining;
    }
    const profile = Object.freeze({ before, after, through });
    this.#marginProfileCache.set(key, profile);
    return profile;
  }

  #paintStyle(node: FormattingNode): LayoutPaintStyle {
    const style = this.#computed(node);
    let underline = false;
    let lineThrough = false;
    const path: FormattingNode[] = [];
    let current: FormattingNode | null = node;
    while (current !== null) {
      const cached = this.#decorationCache.get(current.id);
      if (cached !== undefined) {
        underline ||= cached.underline;
        lineThrough ||= cached.lineThrough;
        break;
      }
      path.push(current);
      current = this.#formatting.parent(current.id);
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index];
      if (entry === undefined) continue;
      const computed = this.#computed(entry);
      underline ||= computed?.text.underline === true;
      lineThrough ||= computed?.text.lineThrough === true;
      this.#decorationCache.set(entry.id, { underline, lineThrough });
    }
    return Object.freeze({
      visible: style?.visibility === "visible",
      foreground: style?.text.color ?? null,
      background: style?.text.background ?? null,
      bold: (style?.text.fontWeight ?? 400) >= 600,
      italic: style?.text.fontStyle !== undefined && style.text.fontStyle !== "normal",
      underline,
      strikethrough: lineThrough,
      borderColor: style?.box.borderColor ?? style?.text.color ?? null,
      borderStyle: style?.box.borderStyle ?? "none"
    });
  }

  #action(node: FormattingNode): DocumentActionIdentity | null {
    if (this.#computed(node)?.visibility !== "visible") return null;
    let source = node.source;
    while (source !== null) {
      const link = this.#formatting.document.link(source);
      if (link !== null) return Object.freeze({ kind: "link", node: link.node, destination: link.destination });
      const control = this.#formatting.document.control(source);
      if (control !== null) return Object.freeze({ kind: "form-control", node: control.node, form: control.form });
      const parent = this.#formatting.document.parent(source);
      const disclosure = parent === null ? null : this.#formatting.document.disclosure(parent.ref);
      if (disclosure?.kind === "details" && disclosure.summary === source) {
        return Object.freeze({
          kind: "disclosure",
          node: disclosure.node,
          open: this.#formatting.state.open.has(disclosure.node)
        });
      }
      source = parent?.ref ?? null;
    }
    return null;
  }

  #clip(node: FormattingNode, paddingRect: CssRect, inherited: CssRect): CssRect {
    const style = this.#boxComputed(node);
    if (style === null) return inherited;
    let result = inherited;
    if (style.box.overflowX !== "visible" || style.box.overflowY !== "visible") {
    const xRect = style.box.overflowX === "visible"
      ? cssRect(inherited.x, paddingRect.y, inherited.width, paddingRect.height)
      : paddingRect;
    const yRect = style.box.overflowY === "visible"
      ? cssRect(paddingRect.x, inherited.y, paddingRect.width, inherited.height)
      : paddingRect;
      result = cssIntersection(result, cssRect(xRect.x, yRect.y, xRect.width, yRect.height));
    }
    if ((style.box.position === "absolute" || style.box.position === "fixed")
      && style.box.legacyClip.kind === "rect") {
      const top = this.#usedLength(style.box.legacyClip.edges.top, paddingRect.height, style) ?? ZERO;
      const right = this.#usedLength(style.box.legacyClip.edges.right, paddingRect.width, style) ?? paddingRect.width;
      const bottom = this.#usedLength(style.box.legacyClip.edges.bottom, paddingRect.height, style) ?? paddingRect.height;
      const left = this.#usedLength(style.box.legacyClip.edges.left, paddingRect.width, style) ?? ZERO;
      result = cssIntersection(result, cssRect(
        point(paddingRect.x, left), point(paddingRect.y, top),
        nonNegative(length(right - left)), nonNegative(length(bottom - top))
      ));
    }
    if (style.box.clipPath.kind === "inset") {
      const top = this.#usedLength(style.box.clipPath.offsets.top, paddingRect.height, style) ?? ZERO;
      const right = this.#usedLength(style.box.clipPath.offsets.right, paddingRect.width, style) ?? ZERO;
      const bottom = this.#usedLength(style.box.clipPath.offsets.bottom, paddingRect.height, style) ?? ZERO;
      const left = this.#usedLength(style.box.clipPath.offsets.left, paddingRect.width, style) ?? ZERO;
      result = cssIntersection(result, cssRect(
        point(paddingRect.x, left), point(paddingRect.y, top),
        nonNegative(length(paddingRect.width - left - right)),
        nonNegative(length(paddingRect.height - top - bottom))
      ));
    }
    return result;
  }

  #visuallyClipped(node: FormattingNode, containingWidth: CssPixelLength): boolean {
    const style = this.#boxComputed(node);
    if (style === null || (style.box.position !== "absolute" && style.box.position !== "fixed")) return false;
    if (style.box.overflowX === "visible" && style.box.overflowY === "visible") return false;
    const width = this.#usedLength(style.box.width, containingWidth, style);
    const height = this.#usedLength(style.box.height, this.#input.context.viewport.height, style);
    if (width === null || height === null || width > cssPx(1) || height > cssPx(1)) return false;
    if (style.box.legacyClip.kind === "rect") {
      const top = this.#usedLength(style.box.legacyClip.edges.top, height, style);
      const right = this.#usedLength(style.box.legacyClip.edges.right, width, style);
      const bottom = this.#usedLength(style.box.legacyClip.edges.bottom, height, style);
      const left = this.#usedLength(style.box.legacyClip.edges.left, width, style);
      if (top !== null && right !== null && bottom !== null && left !== null
        && (bottom <= top || right <= left)) return true;
    }
    if (style.box.clipPath.kind === "inset") {
      const top = this.#usedLength(style.box.clipPath.offsets.top, height, style) ?? ZERO;
      const right = this.#usedLength(style.box.clipPath.offsets.right, width, style) ?? ZERO;
      const bottom = this.#usedLength(style.box.clipPath.offsets.bottom, height, style) ?? ZERO;
      const left = this.#usedLength(style.box.clipPath.offsets.left, width, style) ?? ZERO;
      if (top + bottom >= height || left + right >= width) return true;
    }
    return false;
  }

  #lineHeight(style: ComputedStyle | null, metrics: UsedFontMetrics): CssPixelLength {
    const value = style?.text.lineHeight;
    if (value === undefined || value.kind === "normal") {
      return sum(metrics.ascent, metrics.descent, metrics.lineGap);
    }
    if (value.kind === "number") return cssMultiply(metrics.fontSize, value.value);
    return nonNegative(this.#usedLength(value.value, metrics.fontSize, style) ?? ZERO);
  }

  #parentMetrics(node: FormattingNode): UsedFontMetrics {
    const parent = this.#formatting.parent(node.id);
    return parent === null ? this.#input.context.rootFontMetrics : this.#metrics(this.#computed(parent));
  }

  #verticalShift(
    node: FormattingNode,
    style: ComputedStyle | null,
    metrics: UsedFontMetrics
  ): CssPixelLength {
    const align = style?.text.verticalAlign;
    if (align === undefined || align.kind === "keyword" && align.value === "baseline") return ZERO;
    if (align.kind === "length") return this.#usedLength(align.value, this.#lineHeight(style, metrics), style) ?? ZERO;
    if (align.value === "super") return cssMultiply(metrics.fontSize, 0.33);
    if (align.value === "sub") return cssMultiply(metrics.fontSize, -0.2);
    if (align.value === "middle") {
      return length(
        this.#parentMetrics(node).xHeight / 2
          + this.#lineHeight(style, metrics) / 2
          - metrics.ascent
      );
    }
    return ZERO;
  }

  #inlineExtents(metrics: UsedFontMetrics, lineHeight: CssPixelLength): {
    readonly ascent: CssPixelLength;
    readonly descent: CssPixelLength;
  } {
    const leading = nonNegative(length(lineHeight - metrics.ascent - metrics.descent));
    const before = length(Math.trunc(leading / 2));
    return {
      ascent: cssAdd(metrics.ascent, before),
      descent: cssAdd(metrics.descent, length(leading - before))
    };
  }

  #finalizeLine(cursor: InlineFormattingCursor, force = false): void {
    if (cursor.entries.length === 0 && !force) return;
    if (this.#lineBoxes.length >= this.#budgets.maxLineBoxes) {
      this.#truncated ??= "maxLineBoxes";
      throw new LayoutBudgetExhausted();
    }
    const entries = [...cursor.entries];
    const strut = this.#inlineExtents(cursor.strutMetrics, cursor.strutLineHeight);
    const ascent = entries.reduce((maximum, entry) => {
      const node = this.#formatting.node(this.#fragments.get(entry.fragment)?.formattingNode ?? this.#formatting.root);
      const style = this.#computed(node);
      const extents = this.#inlineExtents(entry.metrics, entry.lineHeight);
      return cssMax(maximum, sum(extents.ascent, this.#verticalShift(node, style, entry.metrics)));
    }, strut.ascent);
    const descent = entries.reduce((maximum, entry) => {
      const node = this.#formatting.node(this.#fragments.get(entry.fragment)?.formattingNode ?? this.#formatting.root);
      const style = this.#computed(node);
      const extents = this.#inlineExtents(entry.metrics, entry.lineHeight);
      return cssMax(maximum, length(extents.descent - this.#verticalShift(node, style, entry.metrics)));
    }, strut.descent);
    const specified = entries.reduce((maximum, entry) => cssMax(maximum, entry.lineHeight), ZERO);
    const height = cssMax(sum(ascent, descent), specified, cursor.strutLineHeight);
    const baseline = sum(length(cursor.y), ascent);
    const contentRight = entries.reduce<number>((maximum, entry) => {
      const fragment = this.#fragments.get(entry.fragment);
      return Math.max(maximum, fragment === undefined
        ? cursor.lineStartX : fragment.borderRect.x + fragment.borderRect.width);
    }, cursor.lineStartX);
    const usedWidth = nonNegative(length(contentRight - cursor.lineStartX));
    const freeInlineSize = nonNegative(length(cursor.maxX - cursor.lineStartX - usedWidth));
    const inlineOffset = cursor.textAlign === "center" ? length(Math.trunc(freeInlineSize / 2))
      : cursor.textAlign === "right" ? freeInlineSize : ZERO;
    const usedIds: LayoutFragmentId[] = [];
    for (const entry of entries) {
      const fragment = this.#fragments.get(entry.fragment);
      if (fragment === undefined) continue;
      const style = this.#computed(this.#formatting.node(fragment.formattingNode));
      const formattingNode = this.#formatting.node(fragment.formattingNode);
      const align = style?.text.verticalAlign;
      const shift = this.#verticalShift(formattingNode, style, entry.metrics);
      const extents = this.#inlineExtents(entry.metrics, entry.lineHeight);
      let y = point(cssCoordinate(baseline), length(0 - extents.ascent - shift));
      if (align?.kind === "keyword" && align.value === "top") y = cursor.y;
      if (align?.kind === "keyword" && align.value === "bottom") {
        y = point(cursor.y, length(height - entry.lineHeight));
      }
      if (align?.kind === "keyword" && align.value === "text-top") {
        y = point(cssCoordinate(baseline), negate(this.#parentMetrics(formattingNode).ascent));
      }
      if (align?.kind === "keyword" && align.value === "text-bottom") {
        y = point(
          cssCoordinate(baseline),
          length(this.#parentMetrics(formattingNode).descent - entry.lineHeight)
        );
      }
      const deltaY = length(y - fragment.contentRect.y);
      const moved = cssRect(point(fragment.contentRect.x, inlineOffset), y, fragment.contentRect.width,
        fragment.kind === "text" ? entry.lineHeight : fragment.contentRect.height);
      const move = (rect: CssRect): CssRect => cssRect(
        point(rect.x, inlineOffset), point(rect.y, deltaY), rect.width, rect.height
      );
      this.#fragments.set(fragment.id, {
        ...fragment,
        contentRect: moved,
        paddingRect: fragment.kind === "text" ? moved : move(fragment.paddingRect),
        borderRect: fragment.kind === "text" ? moved : move(fragment.borderRect),
        marginRect: fragment.kind === "text" ? moved : move(fragment.marginRect),
        overflowRect: fragment.kind === "text" ? moved : move(fragment.overflowRect),
        clipRect: move(fragment.clipRect),
        baseline: length(baseline - y)
      });
      usedIds.push(fragment.id);
    }
    const line = Object.freeze({
      id: lineBoxId(`line-box:${cursor.containingFragment}:${String(this.#lineBoxes.length + 1)}`),
      containingFragment: cursor.containingFragment,
      rect: cssRect(cursor.continuationX, cursor.y, length(cursor.maxX - cursor.continuationX), height),
      baseline,
      ascent,
      descent,
      fragments: Object.freeze(usedIds),
      textFragments: Object.freeze(usedIds.filter((id) => this.#fragments.get(id)?.kind === "text")),
      visualOrder: Object.freeze(usedIds)
    });
    this.#lineBoxPositions.set(line.id, this.#lineBoxes.length);
    this.#lineBoxes.push(line);
    cursor.lineBoxes.push(line);
    cursor.entries.length = 0;
    cursor.y = point(cursor.y, height);
    cursor.x = cursor.continuationX;
    cursor.lineStartX = cursor.continuationX;
    cursor.collapsedSpace = false;
  }

  #textFragment(
    node: FormattingNode,
    cursor: InlineFormattingCursor,
    text: string,
    start: number,
    end: number,
    clip: CssRect
  ): LayoutTextFragment | null {
    const style = this.#computed(node);
    if (style === null) return null;
    const metrics = this.#metrics(style);
    const advance = this.#input.context.textMeasurer.measure(text, metrics.fontSize);
    if (advance <= 0) return null;
    const usedLineHeight = this.#lineHeight(style, metrics);
    const sourceRange = node.source === null || node.sourceRange === null
      ? null
      : this.#formatting.document.textSourceRange(node.source, start, end);
    const box = cssRect(cursor.x, cursor.y, advance, usedLineHeight);
    const visible = style.visibility === "visible";
    const fragment = this.#store<LayoutTextFragment>({
      id: this.#newId(node.id, `text:${String(start)}`),
      kind: "text",
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange,
      contentStartCodeUnit: start,
      contentEndCodeUnit: end,
      text: visible ? text : "",
      contentRect: box,
      paddingRect: box,
      borderRect: box,
      marginRect: box,
      overflowRect: box,
      clipRect: cssIntersection(clip, box),
      children: Object.freeze([]),
      lineBoxes: Object.freeze([]),
      usedFontMetrics: metrics,
      baseline: metrics.baseline,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic: visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null,
      style: this.#paintStyle(node),
      minContentContribution: advance,
      maxContentContribution: advance
    });
    cursor.entries.push({
      fragment: fragment.id,
      metrics,
      lineHeight: usedLineHeight,
      verticalAlign: style.text.verticalAlign
    });
    cursor.x = point(cursor.x, advance);
    return fragment;
  }

  #placeText(node: FormattingTextNode, cursor: InlineFormattingCursor, clip: CssRect): LayoutResult {
    const computed = this.#computed(node);
    const mapped = transformedText(node.text, computed?.text.textTransform ?? "none");
    const wraps = node.whiteSpace !== "nowrap" && node.whiteSpace !== "pre";
    const preservesSpaces = node.whiteSpace === "pre" || node.whiteSpace === "pre-wrap" || node.whiteSpace === "break-spaces";
    const preservesNewlines = node.whiteSpace !== "normal" && node.whiteSpace !== "nowrap";
    const children: LayoutFragmentId[] = [];
    const rectangles: CssRect[] = [];
    let codeUnit = 0;
    const tokens = mapped.value.match(/\r\n|\r|\n|[^\S\r\n]+|[^\s]+/gu) ?? [];
    try {
      for (const [tokenIndex, token] of tokens.entries()) {
        this.#input.context.signal?.throwIfAborted();
      const tokenStart = codeUnit;
      codeUnit += token.length;
      const newline = token === "\n" || token === "\r" || token === "\r\n";
      if (newline) {
        if (preservesNewlines) this.#finalizeLine(cursor, true);
        else if (cursor.x > cursor.lineStartX && !cursor.collapsedSpace) {
          const source = mappedRange(mapped, tokenStart, codeUnit);
          const placed = this.#textFragment(node, cursor, " ", source[0], source[1], clip);
          if (placed !== null) { children.push(placed.id); rectangles.push(placed.borderRect); }
          cursor.collapsedSpace = true;
        }
        continue;
      }
      const whitespace = /^\s+$/u.test(token);
      const rendered = whitespace && !preservesSpaces ? " " : token;
      if (whitespace && !preservesSpaces && (cursor.x === cursor.continuationX || cursor.collapsedSpace)) continue;
      const following = tokens[tokenIndex + 1];
      const followingIsWord = following !== undefined && !/^\s+$/u.test(following);
      if (whitespace && !preservesSpaces && wraps && followingIsWord
        && cursor.x > cursor.continuationX
        && cursor.x
          + this.#input.context.textMeasurer.measure(rendered, this.#fontSize(computed))
          + this.#input.context.textMeasurer.measure(following, this.#fontSize(computed)) > cursor.maxX) {
        this.#finalizeLine(cursor);
        continue;
      }
      const tokenAdvance = this.#input.context.textMeasurer.measure(rendered, this.#fontSize(computed));
      if (wraps && !whitespace && cursor.x > cursor.continuationX && cursor.x + tokenAdvance > cursor.maxX) {
        this.#finalizeLine(cursor);
      }
      const breaksInsideToken = whitespace && preservesSpaces;
      if (!breaksInsideToken) {
        const source = mappedRange(mapped, tokenStart, codeUnit);
        const placed = this.#textFragment(node, cursor, rendered, source[0], source[1], clip);
        if (placed !== null) { children.push(placed.id); rectangles.push(placed.borderRect); }
        cursor.collapsedSpace = whitespace && !preservesSpaces;
        continue;
      }
      let chunk = "";
      let chunkStart = tokenStart;
      let chunkEnd = tokenStart;
      let chunkAdvance = ZERO;
      const flush = (): void => {
        if (chunk.length === 0) return;
        const source = mappedRange(mapped, chunkStart, chunkEnd);
        const placed = this.#textFragment(node, cursor, chunk, source[0], source[1], clip);
        if (placed !== null) { children.push(placed.id); rectangles.push(placed.borderRect); }
        chunk = "";
        chunkAdvance = ZERO;
      };
      for (const grapheme of this.#input.context.textMeasurer.graphemes(rendered, this.#fontSize(computed))) {
        if (wraps && (cursor.x > cursor.continuationX || chunk.length > 0)
          && cursor.x + chunkAdvance + grapheme.advance > cursor.maxX) {
          flush();
          this.#finalizeLine(cursor);
          chunkStart = tokenStart + grapheme.startCodeUnit;
        }
        if (chunk.length === 0) chunkStart = tokenStart + grapheme.startCodeUnit;
        chunk += grapheme.text;
        chunkAdvance = cssAdd(chunkAdvance, grapheme.advance);
        chunkEnd = tokenStart + grapheme.endCodeUnit;
      }
      flush();
      cursor.collapsedSpace = false;
      }
    } catch (error) {
      if (!(error instanceof LayoutBudgetExhausted)) throw error;
    }
    const fallback = cssRect(cursor.x, cursor.y, ZERO, ZERO);
    return this.#container(node, cssUnion(rectangles, fallback), cssUnion(rectangles, fallback), cssUnion(rectangles, fallback), cssUnion(rectangles, fallback), clip, children, []);
  }

  #atomic(
    node: FormattingFormControlNode | FormattingReplacedNode,
    cursor: InlineFormattingCursor,
    clip: CssRect
  ): LayoutResult {
    const control = node.kind === "form-control" ? presentedControlText(node, this.#formatting) : null;
    const text = node.kind === "form-control" ? control?.text ?? "" : node.fallbackText;
    const style = this.#boxComputed(node) ?? this.#computed(node);
    const metrics = this.#metrics(style);
    const lineHeight = this.#lineHeight(style, metrics);
    const containingWidth = nonNegative(length(cursor.maxX - cursor.continuationX));
    const { margin, padding, border } = this.#edges(style, containingWidth);
    const horizontalChrome = sum(padding.left, padding.right, border.left, border.right);
    const verticalChrome = sum(padding.top, padding.bottom, border.top, border.bottom);
    const intrinsicWidth = node.kind !== "form-control" && node.intrinsicWidth !== null
      ? cssPx(node.intrinsicWidth)
      : this.#input.context.textMeasurer.measure(text, metrics.fontSize);
    const specifiedWidth = style === null ? null : this.#usedLength(style.box.width, containingWidth, style);
    const toContentWidth = (value: CssPixelLength): CssPixelLength => style?.box.boxSizing === "border-box"
      ? nonNegative(length(value - horizontalChrome)) : value;
    let contentWidth = cssMax(metrics.chAdvance, specifiedWidth === null ? intrinsicWidth : toContentWidth(specifiedWidth));
    const minimum = style === null ? ZERO : this.#usedLength(style.box.minWidth, containingWidth, style) ?? ZERO;
    const maximum = style === null ? null : this.#usedLength(style.box.maxWidth, containingWidth, style);
    contentWidth = cssMax(contentWidth, toContentWidth(minimum));
    if (maximum !== null) contentWidth = cssMin(contentWidth, toContentWidth(maximum));
    const intrinsicHeight = node.kind !== "form-control" && node.intrinsicHeight !== null
      ? cssPx(node.intrinsicHeight)
      : lineHeight;
    const indefiniteHeight = (value: CssLength): CssPixelLength | null =>
      value.kind === "length" && value.unit === "%" ? null : this.#usedLength(value, ZERO, style);
    const toContentHeight = (value: CssPixelLength): CssPixelLength => style?.box.boxSizing === "border-box"
      ? nonNegative(length(value - verticalChrome)) : nonNegative(value);
    const specifiedHeight = style === null ? null : indefiniteHeight(style.box.height);
    const minimumHeight = style === null ? ZERO : indefiniteHeight(style.box.minHeight) ?? ZERO;
    const maximumHeight = style === null ? null : indefiniteHeight(style.box.maxHeight);
    let contentHeight = specifiedHeight === null ? intrinsicHeight : toContentHeight(specifiedHeight);
    contentHeight = cssMax(contentHeight, toContentHeight(minimumHeight));
    if (maximumHeight !== null) contentHeight = cssMin(contentHeight, toContentHeight(maximumHeight));
    let advance = sum(margin.left, border.left, padding.left, contentWidth, padding.right, border.right, margin.right);
    if (cursor.x > cursor.continuationX && cursor.x + advance > cursor.maxX) this.#finalizeLine(cursor);
    advance = cssMin(advance, containingWidth);
    const marginRect = cssRect(cursor.x, cursor.y, advance, sum(margin.top, verticalChrome, contentHeight, margin.bottom));
    const borderRect = cssRect(
      point(cursor.x, margin.left), point(cursor.y, margin.top),
      nonNegative(length(advance - margin.left - margin.right)), sum(verticalChrome, contentHeight)
    );
    const paddingRect = cssRect(
      point(borderRect.x, border.left), point(borderRect.y, border.top),
      nonNegative(length(borderRect.width - border.left - border.right)),
      nonNegative(length(borderRect.height - border.top - border.bottom))
    );
    const contentRect = cssRect(
      point(paddingRect.x, padding.left), point(paddingRect.y, padding.top),
      nonNegative(length(paddingRect.width - padding.left - padding.right)),
      nonNegative(length(paddingRect.height - padding.top - padding.bottom))
    );
    const visible = style?.visibility === "visible";
    const common = {
      id: this.#newId(node.id),
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange: node.sourceRange,
      contentStartCodeUnit: 0,
      contentEndCodeUnit: text.length,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      overflowRect: borderRect,
      clipRect: cssIntersection(clip, borderRect),
      children: Object.freeze([]),
      lineBoxes: Object.freeze([]),
      usedFontMetrics: metrics,
      baseline: metrics.baseline,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic: visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null,
      style: this.#paintStyle(node),
      minContentContribution: intrinsicWidth,
      maxContentContribution: intrinsicWidth
    } as const;
    const fragment: LayoutBoxFragment = node.kind === "form-control" && control !== null
      ? { ...common, kind: "control", controlLabel: control.label, controlValue: control.value, controlText: control.text }
      : { ...common, kind: "replaced", replacedText: text };
    this.#store(fragment, true);
    const atomicLineHeight = cssMax(lineHeight, borderRect.height);
    cursor.entries.push({ fragment: fragment.id, metrics, lineHeight: atomicLineHeight, verticalAlign: style?.text.verticalAlign ?? { kind: "keyword", value: "baseline" } });
    cursor.x = point(cursor.x, advance);
    cursor.collapsedSpace = false;
    return { fragment: fragment.id, borderRect, marginRect };
  }

  #container(
    node: FormattingNode,
    contentRect: CssRect,
    paddingRect: CssRect,
    borderRect: CssRect,
    marginRect: CssRect,
    clipRect: CssRect,
    children: readonly LayoutFragmentId[],
    lineBoxes: readonly LineBox[],
    reservedId?: LayoutFragmentId
  ): LayoutResult {
    const style = this.#computed(node);
    const visible = style?.visibility === "visible";
    const childOverflow = children.map((id) => this.#fragments.get(id)?.overflowRect).filter((value): value is CssRect => value !== undefined);
    const fragment = this.#store<LayoutBoxFragment>({
      id: reservedId ?? this.#newId(node.id),
      kind: "box",
      formattingNode: node.id,
      documentNode: node.source,
      pseudoElement: node.pseudo,
      sourceRange: node.sourceRange,
      contentStartCodeUnit: null,
      contentEndCodeUnit: null,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      overflowRect: cssUnion([borderRect, ...childOverflow], borderRect),
      clipRect: cssIntersection(clipRect, borderRect.width === 0 || borderRect.height === 0 ? clipRect : cssUnion([borderRect, ...childOverflow], borderRect)),
      children: Object.freeze([...children]),
      lineBoxes: Object.freeze([...lineBoxes]),
      usedFontMetrics: null,
      baseline: null,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic: visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null,
      style: this.#paintStyle(node),
      minContentContribution: children.reduce((maximum, id) => cssMax(maximum, this.#fragments.get(id)?.minContentContribution ?? ZERO), ZERO),
      maxContentContribution: children.reduce((total, id) => cssAdd(total, this.#fragments.get(id)?.maxContentContribution ?? ZERO), ZERO)
    }, true);
    return { fragment: fragment.id, borderRect, marginRect };
  }

  #inline(id: FormattingNodeId, cursor: InlineFormattingCursor, clip: CssRect, depth: number): LayoutResult {
    this.#reserve();
    try { return this.#inlineReserved(id, cursor, clip, depth); }
    finally { this.#reserved -= 1; }
  }

  #inlineReserved(id: FormattingNodeId, cursor: InlineFormattingCursor, clip: CssRect, depth: number): LayoutResult {
    const node = this.#formatting.node(id);
    if (this.#visuallyClipped(node, nonNegative(length(cursor.maxX - cursor.continuationX)))) {
      const empty = cssRect(cursor.x, cursor.y, ZERO, ZERO);
      return this.#container(node, empty, empty, empty, empty, empty, [], []);
    }
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") return this.#placeText(node, cursor, clip);
    if (node.kind === "forced-line-break") {
      const box = cssRect(cursor.x, cursor.y, ZERO, ZERO);
      this.#finalizeLine(cursor, true);
      return this.#container(node, box, box, box, box, clip, [], []);
    }
    if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image-fallback") {
      return this.#atomic(node, cursor, clip);
    }
    if (establishesInlineFormattingContext(node) || !isInlineFormatting(node)) {
      if (cursor.x > cursor.continuationX) this.#finalizeLine(cursor);
      const result = this.#layoutNode(id, cursor.continuationX, cursor.y, length(cursor.maxX - cursor.continuationX), clip, depth + 1);
      cursor.y = cssCoordinateFromFixed(result.marginRect.y + result.marginRect.height);
      cursor.x = cursor.continuationX;
      return result;
    }
    const children: LayoutFragmentId[] = [];
    const rectangles: CssRect[] = [];
    const start = cssRect(cursor.x, cursor.y, ZERO, ZERO);
    for (const child of node.children) {
      const result = this.#tryInline(child, cursor, clip, depth + 1);
      if (result === null) break;
      children.push(result.fragment);
      rectangles.push(result.borderRect);
    }
    const box = cssUnion(rectangles, start);
    return this.#container(node, box, box, box, box, clip, children, []);
  }

  #tryInline(id: FormattingNodeId, cursor: InlineFormattingCursor, clip: CssRect, depth: number): LayoutResult | null {
    try { return this.#inline(id, cursor, clip, depth); }
    catch (error) { if (error instanceof LayoutBudgetExhausted) return null; throw error; }
  }

  #intrinsicWidth(id: FormattingNodeId, maximum: CssPixelLength): CssPixelLength {
    const pending = [id];
    let total = ZERO;
    while (pending.length > 0 && total <= maximum) {
      const current = pending.pop();
      if (current === undefined) continue;
      const node = this.#formatting.node(current);
      const style = this.#computed(node);
      if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
        const text = transformedText(node.text, style?.text.textTransform ?? "none").value.replace(/\s+/gu, " ");
        total = cssAdd(total, this.#input.context.textMeasurer.measure(text, this.#fontSize(style)));
      } else if (node.kind === "form-control") {
        total = cssAdd(total, this.#input.context.textMeasurer.measure(presentedControlText(node, this.#formatting).text, this.#fontSize(style)));
      } else if (node.kind === "replaced-element" || node.kind === "image-fallback") {
        const intrinsic = node.intrinsicWidth === null ? null : cssPx(node.intrinsicWidth);
        total = cssAdd(total, intrinsic ?? this.#input.context.textMeasurer.measure(node.fallbackText, this.#fontSize(style)));
      } else pending.push(...[...node.children].reverse());
    }
    return cssMin(maximum, cssMax(this.#metrics(null).chAdvance, total));
  }

  #translateVertically(result: LayoutResult, offset: CssPixelLength, containingClip: CssRect): LayoutResult {
    if (offset === 0) return result;
    const move = (rect: CssRect): CssRect => cssRect(
      rect.x,
      point(rect.y, offset),
      rect.width,
      rect.height
    );
    const pending = [result.fragment];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const fragment = this.#fragments.get(id);
      if (fragment === undefined) continue;
      pending.push(...fragment.children);
      const lineBoxes = fragment.lineBoxes.map((line) => {
        const moved = Object.freeze({
          ...line,
          rect: move(line.rect),
          baseline: cssAdd(line.baseline, offset)
        });
        const position = this.#lineBoxPositions.get(line.id);
        if (position !== undefined) this.#lineBoxes[position] = moved;
        return moved;
      });
      this.#fragments.set(id, {
        ...fragment,
        contentRect: move(fragment.contentRect),
        paddingRect: move(fragment.paddingRect),
        borderRect: move(fragment.borderRect),
        marginRect: move(fragment.marginRect),
        overflowRect: move(fragment.overflowRect),
        clipRect: cssIntersection(move(fragment.clipRect), containingClip),
        lineBoxes: Object.freeze(lineBoxes)
      });
    }
    const moved = this.#fragments.get(result.fragment);
    return moved === undefined
      ? result
      : { fragment: result.fragment, borderRect: moved.borderRect, marginRect: moved.marginRect };
  }

  #flow(
    node: FormattingNode,
    containingX: CssCoordinate,
    borderY: CssCoordinate,
    containingWidth: CssPixelLength,
    inheritedClip: CssRect,
    depth: number,
    containingHeight: CssPixelLength | null
  ): LayoutResult {
    const containerId = this.#newId(node.id);
    const dimensions = this.#dimensions(node, containingWidth, containingHeight);
    const borderX = point(containingX, dimensions.marginLeft);
    const contentX = point(borderX, sum(dimensions.border.left, dimensions.padding.left));
    const contentY = point(borderY, sum(dimensions.border.top, dimensions.padding.top));
    const provisionalHeight = dimensions.specifiedHeight === null
      ? this.#input.context.viewport.height
      : sum(dimensions.specifiedHeight, dimensions.padding.top, dimensions.padding.bottom, dimensions.border.top, dimensions.border.bottom);
    const provisionalPadding = cssRect(
      point(borderX, dimensions.border.left), point(borderY, dimensions.border.top),
      sum(dimensions.contentWidth, dimensions.padding.left, dimensions.padding.right),
      nonNegative(length(provisionalHeight - dimensions.border.top - dimensions.border.bottom))
    );
    const childClip = this.#clip(node, provisionalPadding, inheritedClip);
    const children: LayoutFragmentId[] = [];
    let currentBottom = contentY as number;
    let pendingBottomMargin = ZERO;
    let inlineRun: FormattingNodeId[] = [];
    let firstInline = true;
    const ownedLineBoxes: LineBox[] = [];
    const flushInline = (): void => {
      if (inlineRun.length === 0) return;
      const style = this.#boxComputed(node) ?? this.#computed(node);
      const indent = firstInline && style !== null
        ? this.#usedLength(style.text.textIndent, dimensions.contentWidth, style) ?? ZERO
        : ZERO;
      const startX = point(contentX, indent);
      const cursor: InlineFormattingCursor = {
        containingFragment: containerId,
        continuationX: contentX,
        maxX: point(contentX, dimensions.contentWidth),
        textAlign: style?.text.textAlign ?? "left",
        strutMetrics: this.#metrics(style),
        strutLineHeight: this.#lineHeight(style, this.#metrics(style)),
        lineStartX: startX,
        x: startX,
        y: cssCoordinateFromFixed(currentBottom),
        collapsedSpace: false,
        entries: [],
        lineBoxes: []
      };
      for (const child of inlineRun) {
        const result = this.#tryInline(child, cursor, childClip, depth + 1);
        if (result === null) break;
        children.push(result.fragment);
      }
      try { this.#finalizeLine(cursor); }
      catch (error) { if (!(error instanceof LayoutBudgetExhausted)) throw error; }
      ownedLineBoxes.push(...cursor.lineBoxes);
      currentBottom = cursor.y;
      pendingBottomMargin = ZERO;
      inlineRun = [];
      firstInline = false;
    };
    const columnFlex = node.kind === "flex-container"
      && (this.#boxComputed(node)?.box.flexDirection === "column"
        || this.#boxComputed(node)?.box.flexDirection === "column-reverse");
    if (columnFlex) {
      const style = this.#boxComputed(node);
      const ordered = style?.box.flexDirection === "column-reverse" ? [...node.children].reverse() : node.children;
      const gap = style === null ? ZERO : this.#usedLength(style.box.rowGap, dimensions.contentWidth, style) ?? ZERO;
      const laidOut: LayoutResult[] = [];
      for (const childId of ordered) {
        const childWidth = style?.box.alignItems === "stretch"
          ? dimensions.contentWidth : this.#intrinsicWidth(childId, dimensions.contentWidth);
        const childDimensions = this.#dimensions(
          this.#formatting.node(childId),
          childWidth,
          dimensions.specifiedHeight
        );
        const dx = style?.box.alignItems === "center" ? length(Math.trunc((dimensions.contentWidth - childWidth) / 2))
          : style?.box.alignItems === "end" ? nonNegative(length(dimensions.contentWidth - childWidth)) : ZERO;
        const result = this.#tryLayoutNode(
          childId, point(contentX, dx), point(cssCoordinateFromFixed(currentBottom), childDimensions.margin.top), childWidth,
          childClip, depth + 1, undefined, dimensions.specifiedHeight
        );
        if (result === null) break;
        children.push(result.fragment);
        laidOut.push(result);
        currentBottom = result.marginRect.y + result.marginRect.height;
        if (laidOut.length < ordered.length) currentBottom += gap;
      }
      const occupied = laidOut.length === 0 ? ZERO : nonNegative(length(
        (laidOut.at(-1)?.marginRect.y ?? contentY)
          + (laidOut.at(-1)?.marginRect.height ?? ZERO)
          - contentY
      ));
      const spare = dimensions.specifiedHeight === null ? ZERO
        : nonNegative(length(dimensions.specifiedHeight - occupied));
      const leading = style?.box.justifyContent === "center" ? length(Math.trunc(spare / 2))
        : style?.box.justifyContent === "end" ? spare : ZERO;
      const extraBetween = style?.box.justifyContent === "space-between" && laidOut.length > 1
        ? length(Math.trunc(spare / (laidOut.length - 1))) : ZERO;
      currentBottom = contentY;
      for (const [index, result] of laidOut.entries()) {
        const moved = this.#translateVertically(
          result,
          cssAdd(leading, cssMultiply(extraBetween, index)),
          childClip
        );
        currentBottom = moved.marginRect.y + moved.marginRect.height;
      }
    } else for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (isInlineFormatting(child)) { inlineRun.push(childId); continue; }
      flushInline();
      const childMargins = this.#collapsibleMargins(
        childId,
        dimensions.contentWidth,
        dimensions.specifiedHeight
      );
      const topMargin = childMargins.before;
      const collapseWithParent = children.length === 0
        && dimensions.border.top === 0 && dimensions.padding.top === 0
        && this.#normalBlockFlow(node)
        && (this.#boxComputed(node)?.box.overflowY ?? "visible") === "visible";
      const collapsed = collapseWithParent ? ZERO : collapseMargins(pendingBottomMargin, topMargin);
      const previousBorderBottom = currentBottom;
      const childY = cssCoordinateFromFixed(currentBottom + collapsed);
      const result = this.#tryLayoutNode(
        childId, contentX, childY, dimensions.contentWidth, childClip, depth + 1,
        undefined, dimensions.specifiedHeight
      );
      if (result === null) break;
      children.push(result.fragment);
      const collapsesThrough = childMargins.through && result.borderRect.height === 0;
      if (collapsesThrough) {
        currentBottom = previousBorderBottom;
        pendingBottomMargin = collapseMargins(pendingBottomMargin, topMargin, childMargins.after);
      } else {
        currentBottom = result.borderRect.y + result.borderRect.height;
        pendingBottomMargin = childMargins.after;
      }
    }
    flushInline();
    const collapseLast = dimensions.border.bottom === 0 && dimensions.padding.bottom === 0
      && dimensions.specifiedHeight === null && dimensions.minHeight === 0
      && this.#normalBlockFlow(node)
      && (this.#boxComputed(node)?.box.overflowY ?? "visible") === "visible";
    if (!collapseLast) currentBottom += pendingBottomMargin;
    let contentHeight = nonNegative(length(currentBottom - contentY));
    contentHeight = cssMax(contentHeight, dimensions.specifiedHeight ?? ZERO, dimensions.minHeight);
    if (dimensions.maxHeight !== null) contentHeight = cssMin(contentHeight, dimensions.maxHeight);
    const contentRect = cssRect(contentX, contentY, dimensions.contentWidth, contentHeight);
    const paddingRect = cssRect(
      point(contentX, negate(dimensions.padding.left)),
      point(contentY, negate(dimensions.padding.top)),
      sum(dimensions.contentWidth, dimensions.padding.left, dimensions.padding.right),
      sum(contentHeight, dimensions.padding.top, dimensions.padding.bottom)
    );
    const borderRect = cssRect(
      point(paddingRect.x, negate(dimensions.border.left)),
      point(paddingRect.y, negate(dimensions.border.top)),
      sum(paddingRect.width, dimensions.border.left, dimensions.border.right),
      sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom)
    );
    const marginRect = cssRect(
      point(borderRect.x, negate(dimensions.marginLeft)),
      point(borderRect.y, negate(dimensions.margin.top)),
      sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight),
      sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom)
    );
    return this.#container(node, contentRect, paddingRect, borderRect, marginRect, this.#clip(node, paddingRect, inheritedClip), children, ownedLineBoxes, containerId);
  }

  #table(
    node: FormattingNode,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    columns = this.#columnCount(node)
  ): LayoutResult {
    if (node.kind === "table-row") {
      const cells = node.children;
      const count = Math.max(columns, cells.length, 1);
      const cellWidth = length(Math.trunc(width / count));
      const children: LayoutFragmentId[] = [];
      let bottom = y as number;
      for (const [index, child] of cells.entries()) {
        const result = this.#tryLayoutNode(child, point(x, cssMultiply(cellWidth, index)), y, cellWidth, clip, depth + 1, columns);
        if (result === null) break;
        children.push(result.fragment);
        bottom = Math.max(bottom, result.marginRect.y + result.marginRect.height);
      }
      const box = cssRect(x, y, width, nonNegative(length(bottom - y)));
      return this.#container(node, box, box, box, box, clip, children, []);
    }
    const children: LayoutFragmentId[] = [];
    let currentY = y;
    for (const child of node.children) {
      const result = this.#tryLayoutNode(child, x, currentY, width, clip, depth + 1, columns);
      if (result === null) break;
      children.push(result.fragment);
      currentY = cssCoordinateFromFixed(result.marginRect.y + result.marginRect.height);
    }
    const box = cssRect(x, y, width, nonNegative(length(currentY - y)));
    return this.#container(node, box, box, box, box, clip, children, []);
  }

  #columnCount(node: FormattingNode): number {
    let maximum = 1;
    const pending = [...node.children];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const child = this.#formatting.node(id);
      if (child.kind === "table-row") maximum = Math.max(maximum, child.children.length);
      else if (child.kind.endsWith("group")) pending.push(...child.children);
    }
    return maximum;
  }

  #layoutFlexOrGrid(
    node: FormattingNode,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    grid: boolean
  ): LayoutResult {
    const style = this.#boxComputed(node);
    if (!grid && (style?.box.flexDirection === "column" || style?.box.flexDirection === "column-reverse")) {
      return this.#flow(node, x, y, width, clip, depth, null);
    }
    const dimensions = this.#dimensions(node, width, null);
    const borderX = point(x, dimensions.marginLeft);
    const contentX = point(borderX, sum(dimensions.border.left, dimensions.padding.left));
    const contentY = point(y, sum(dimensions.border.top, dimensions.padding.top));
    const contentWidth = dimensions.contentWidth;
    const tracks = style?.box.gridTemplateColumns ?? [];
    const count = grid ? Math.max(1, tracks.length) : Math.max(1, node.children.length);
    const gap = style === null ? ZERO : this.#usedLength(style.box.columnGap, contentWidth, style) ?? ZERO;
    const available = nonNegative(length(contentWidth - gap * (count - 1)));
    const widths = grid && tracks.length > 0 ? (() => {
      const fixed = tracks.map((track) => track.kind === "length"
        ? this.#usedLength(track.value, contentWidth, style) ?? ZERO
        : track.kind === "minmax" && track.minimum.kind === "length"
          ? this.#usedLength(track.minimum.value, contentWidth, style) ?? ZERO : ZERO);
      const weights = tracks.map((track) => track.kind === "fraction" ? track.value
        : track.kind === "auto" ? 1
          : track.kind === "minmax" && track.maximum.kind === "fraction" ? track.maximum.value
            : track.kind === "minmax" && track.maximum.kind === "auto" ? 1 : 0);
      let free = nonNegative(length(available - fixed.reduce((total, value) => total + value, 0)));
      let weight = weights.reduce((total, value) => total + value, 0);
      return tracks.map((_track, index) => {
        const share = weight <= 0 ? ZERO : length(Math.trunc(free * (weights[index] ?? 0) / weight));
        free = nonNegative(length(free - share));
        weight -= weights[index] ?? 0;
        return cssMax(this.#metrics(style).chAdvance, cssAdd(fixed[index] ?? ZERO, share));
      });
    })() : Array.from({ length: count }, () => length(Math.trunc(available / count)));
    const offsets: CssPixelLength[] = [];
    let offset = ZERO;
    for (const track of widths) { offsets.push(offset); offset = sum(offset, track, gap); }
    const children: LayoutFragmentId[] = [];
    let currentY = contentY;
    const rowGap = style === null ? ZERO : this.#usedLength(style.box.rowGap, contentWidth, style) ?? ZERO;
    if (grid) {
      for (let start = 0; start < node.children.length; start += count) {
        let rowBottom = currentY as number;
        const entries = node.children.slice(start, start + count).map((child, index) => {
          const requested = this.#computed(this.#formatting.node(child))?.box.gridColumn;
          const column = Math.max(0, Math.min(count - 1, (requested ?? index + 1) - 1));
          const trackWidth = widths[column] ?? ZERO;
          return { child, column, trackWidth };
        });
        const laidOut: { readonly result: LayoutResult; readonly outerHeight: CssPixelLength }[] = [];
        for (const entry of entries) {
          const childDimensions = this.#dimensions(this.#formatting.node(entry.child), entry.trackWidth, null);
          const result = this.#tryLayoutNode(
            entry.child,
            point(contentX, offsets[entry.column] ?? ZERO),
            point(currentY, childDimensions.margin.top),
            entry.trackWidth, clip, depth + 1
          );
          if (result === null) break;
          children.push(result.fragment);
          laidOut.push({ result, outerHeight: result.marginRect.height });
        }
        const rowHeight = laidOut.reduce(
          (maximum, entry) => cssMax(maximum, entry.outerHeight),
          ZERO
        );
        for (const entry of laidOut) {
          const dy = style?.box.alignItems === "center"
            ? length(Math.trunc((rowHeight - entry.outerHeight) / 2))
            : style?.box.alignItems === "end"
              ? nonNegative(length(rowHeight - entry.outerHeight))
              : ZERO;
          const moved = this.#translateVertically(entry.result, dy, clip);
          rowBottom = Math.max(rowBottom, moved.marginRect.y + moved.marginRect.height);
        }
        currentY = cssCoordinateFromFixed(
          rowBottom + (start + count < node.children.length ? rowGap : ZERO)
        );
      }
    } else {
      const ordered = style?.box.flexDirection === "row-reverse" ? [...node.children].reverse() : node.children;
      const lines: { readonly child: FormattingNodeId; readonly basis: CssPixelLength }[][] = [];
      let line: { readonly child: FormattingNodeId; readonly basis: CssPixelLength }[] = [];
      let occupied = ZERO;
      for (const child of ordered) {
        const basis = this.#intrinsicWidth(child, contentWidth);
        if (style?.box.flexWrap !== "nowrap" && line.length > 0 && occupied + gap + basis > contentWidth) {
          lines.push(line); line = []; occupied = ZERO;
        }
        line.push({ child, basis });
        occupied = sum(occupied, line.length === 1 ? ZERO : gap, basis);
      }
      if (line.length > 0) lines.push(line);
      if (style?.box.flexWrap === "wrap-reverse") lines.reverse();
      for (const [lineIndex, entries] of lines.entries()) {
        const required = entries.reduce((total, entry) => cssAdd(total, entry.basis), cssMultiply(gap, Math.max(0, entries.length - 1)));
        const spare = nonNegative(length(contentWidth - required));
        let currentX = point(contentX, style?.box.justifyContent === "center" ? length(Math.trunc(spare / 2))
          : style?.box.justifyContent === "end" ? spare : ZERO);
        const between = style?.box.justifyContent === "space-between" && entries.length > 1
          ? cssAdd(gap, length(Math.trunc(spare / (entries.length - 1)))) : gap;
        let bottom = currentY as number;
        const laidOut: { readonly result: LayoutResult; readonly outerHeight: CssPixelLength }[] = [];
        for (const entry of entries) {
          const childDimensions = this.#dimensions(this.#formatting.node(entry.child), entry.basis, null);
          const result = this.#tryLayoutNode(
            entry.child,
            currentX,
            point(currentY, childDimensions.margin.top),
            entry.basis,
            clip,
            depth + 1
          );
          if (result === null) break;
          children.push(result.fragment);
          laidOut.push({ result, outerHeight: result.marginRect.height });
          currentX = point(currentX, cssAdd(entry.basis, between));
        }
        const lineHeight = laidOut.reduce(
          (maximum, entry) => cssMax(maximum, entry.outerHeight),
          ZERO
        );
        for (const entry of laidOut) {
          const dy = style?.box.alignItems === "center"
            ? length(Math.trunc((lineHeight - entry.outerHeight) / 2))
            : style?.box.alignItems === "end"
              ? nonNegative(length(lineHeight - entry.outerHeight))
              : ZERO;
          const moved = this.#translateVertically(entry.result, dy, clip);
          bottom = Math.max(bottom, moved.marginRect.y + moved.marginRect.height);
        }
        currentY = cssCoordinateFromFixed(
          bottom + (lineIndex < lines.length - 1 ? rowGap : ZERO)
        );
      }
    }
    let contentHeight = nonNegative(length(currentY - contentY));
    contentHeight = cssMax(contentHeight, dimensions.specifiedHeight ?? ZERO, dimensions.minHeight);
    if (dimensions.maxHeight !== null) contentHeight = cssMin(contentHeight, dimensions.maxHeight);
    const contentRect = cssRect(contentX, contentY, contentWidth, contentHeight);
    const paddingRect = cssRect(point(contentX, negate(dimensions.padding.left)), point(contentY, negate(dimensions.padding.top)), sum(contentWidth, dimensions.padding.left, dimensions.padding.right), sum(contentHeight, dimensions.padding.top, dimensions.padding.bottom));
    const borderRect = cssRect(point(paddingRect.x, negate(dimensions.border.left)), point(paddingRect.y, negate(dimensions.border.top)), sum(paddingRect.width, dimensions.border.left, dimensions.border.right), sum(paddingRect.height, dimensions.border.top, dimensions.border.bottom));
    const marginRect = cssRect(point(borderRect.x, negate(dimensions.marginLeft)), point(borderRect.y, negate(dimensions.margin.top)), sum(borderRect.width, dimensions.marginLeft, dimensions.marginRight), sum(borderRect.height, dimensions.margin.top, dimensions.margin.bottom));
    return this.#container(node, contentRect, paddingRect, borderRect, marginRect, this.#clip(node, paddingRect, clip), children, []);
  }

  #layoutNode(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    tableColumns?: number,
    containingHeight: CssPixelLength | null = null
  ): LayoutResult {
    this.#reserve();
    try {
      this.#input.context.signal?.throwIfAborted();
      const node = this.#formatting.node(id);
      if (depth > this.#budgets.maxDepth) {
        this.#truncated ??= "maxDepth";
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(node, empty, empty, empty, empty, clip, [], []);
      }
      if (this.#visuallyClipped(node, width)) {
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(node, empty, empty, empty, empty, empty, [], []);
      }
      if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker"
        || node.kind === "forced-line-break" || node.kind === "form-control"
        || node.kind === "replaced-element" || node.kind === "image-fallback") {
        const cursor: InlineFormattingCursor = {
          containingFragment: this.#newId(node.id, "atomic-context"),
          continuationX: x, maxX: point(x, width), x, y,
          textAlign: this.#computed(node)?.text.textAlign ?? "left",
          strutMetrics: this.#metrics(this.#computed(node)),
          strutLineHeight: this.#lineHeight(this.#computed(node), this.#metrics(this.#computed(node))),
          lineStartX: x,
          collapsedSpace: false, entries: [], lineBoxes: []
        };
        const result = this.#inlineReserved(id, cursor, clip, depth + 1);
        try { this.#finalizeLine(cursor); }
        catch (error) { if (!(error instanceof LayoutBudgetExhausted)) throw error; }
        return result;
      }
      if (node.kind === "table-column" || node.kind === "table-column-group") {
        const children: LayoutFragmentId[] = [];
        for (const child of node.children) {
          const result = this.#tryLayoutNode(child, x, y, ZERO, clip, depth + 1, tableColumns);
          if (result === null) break;
          children.push(result.fragment);
        }
        const empty = cssRect(x, y, ZERO, ZERO);
        return this.#container(node, empty, empty, empty, empty, clip, children, []);
      }
      if (node.kind === "table" || node.kind === "table-header-group" || node.kind === "table-body-group"
        || node.kind === "table-footer-group" || node.kind === "table-row") {
        return this.#table(node, x, y, width, clip, depth, tableColumns);
      }
      if (node.kind === "flex-container") return this.#layoutFlexOrGrid(node, x, y, width, clip, depth, false);
      if (node.kind === "grid-container") return this.#layoutFlexOrGrid(node, x, y, width, clip, depth, true);
      return this.#flow(node, x, y, width, clip, depth, containingHeight);
    } finally {
      this.#reserved -= 1;
    }
  }

  #tryLayoutNode(
    id: FormattingNodeId,
    x: CssCoordinate,
    y: CssCoordinate,
    width: CssPixelLength,
    clip: CssRect,
    depth: number,
    columns?: number,
    containingHeight: CssPixelLength | null = null
  ): LayoutResult | null {
    try { return this.#layoutNode(id, x, y, width, clip, depth, columns, containingHeight); }
    catch (error) { if (error instanceof LayoutBudgetExhausted) return null; throw error; }
  }

  public build(): LayoutFragmentTree {
    const context = this.#input.context;
    const valid = Number.isSafeInteger(context.viewport.width) && context.viewport.width > 0
      && Number.isSafeInteger(context.viewport.height) && context.viewport.height > 0
      && Number.isSafeInteger(context.initialContainingBlock.width) && context.initialContainingBlock.width > 0
      && Number.isSafeInteger(context.initialContainingBlock.height) && context.initialContainingBlock.height > 0;
    if (!valid) return ImmutableLayoutFragmentTree.rejected(this.#input, "invalid-context");
    let root: LayoutResult | null = null;
    try {
      root = this.#layoutNode(
        this.#formatting.root,
        context.initialContainingBlock.x,
        context.initialContainingBlock.y,
        context.initialContainingBlock.width,
        context.initialContainingBlock,
        0,
        undefined,
        context.initialContainingBlock.height
      );
    } catch (error) {
      if (!(error instanceof LayoutBudgetExhausted)) throw error;
    }
    if (root === null) return ImmutableLayoutFragmentTree.rejected(this.#input, "invalid-context");
    const outcome: LayoutOutcome = this.#truncated === null
      ? { status: "complete", fragments: this.#fragments.size, lineBoxes: this.#lineBoxes.length }
      : {
          status: "truncated", fragments: this.#fragments.size, lineBoxes: this.#lineBoxes.length,
          budget: this.#truncated, limit: this.#budgets[this.#truncated]
        };
    return new ImmutableLayoutFragmentTree(
      this.#input, root.fragment, this.#fragments, this.#formattingIndex,
      this.#documentIndex, this.#lineBoxes, outcome
    );
  }
}

class ImmutableLayoutFragmentTree implements LayoutFragmentTree {
  readonly formatting: FormattingTree;
  readonly context: BuildLayoutFragmentTreeInput["context"];
  readonly searchIndex: BuildLayoutFragmentTreeInput["searchIndex"];
  readonly root: LayoutFragmentId;
  readonly lineBoxes: readonly LineBox[];
  readonly outcome: LayoutOutcome;
  readonly #fragments: ReadonlyMap<LayoutFragmentId, LayoutFragment>;
  readonly #parents: ReadonlyMap<LayoutFragmentId, LayoutFragmentId>;
  readonly #formattingIndex: ReadonlyMap<FormattingNodeId, readonly LayoutFragmentId[]>;
  readonly #documentIndex: ReadonlyMap<DocumentNodeRef, readonly LayoutFragmentId[]>;

  public constructor(
    input: BuildLayoutFragmentTreeInput,
    root: LayoutFragmentId,
    fragments: ReadonlyMap<LayoutFragmentId, LayoutFragment>,
    formattingIndex: ReadonlyMap<FormattingNodeId, readonly LayoutFragmentId[]>,
    documentIndex: ReadonlyMap<DocumentNodeRef, readonly LayoutFragmentId[]>,
    lineBoxes: readonly LineBox[],
    outcome: LayoutOutcome
  ) {
    this.formatting = input.formatting;
    this.context = Object.freeze({
      ...input.context,
      viewport: Object.freeze({ ...input.context.viewport }),
      initialContainingBlock: Object.freeze({ ...input.context.initialContainingBlock }),
      rootFontMetrics: Object.freeze({ ...input.context.rootFontMetrics })
    });
    this.searchIndex = input.searchIndex;
    this.root = root;
    this.#fragments = new Map([...fragments].map(([id, fragment]) => [id, Object.freeze({
      ...fragment,
      contentRect: Object.freeze({ ...fragment.contentRect }),
      paddingRect: Object.freeze({ ...fragment.paddingRect }),
      borderRect: Object.freeze({ ...fragment.borderRect }),
      marginRect: Object.freeze({ ...fragment.marginRect }),
      overflowRect: Object.freeze({ ...fragment.overflowRect }),
      clipRect: Object.freeze({ ...fragment.clipRect }),
      children: Object.freeze([...fragment.children]),
      lineBoxes: Object.freeze([...fragment.lineBoxes])
    })]));
    this.#formattingIndex = formattingIndex;
    this.#documentIndex = documentIndex;
    this.lineBoxes = Object.freeze([...lineBoxes]);
    this.outcome = Object.freeze(outcome);
    const parents = new Map<LayoutFragmentId, LayoutFragmentId>();
    for (const fragment of this.#fragments.values()) {
      for (const child of fragment.children) parents.set(child, fragment.id);
    }
    this.#parents = parents;
    Object.freeze(this);
  }

  public static rejected(
    input: BuildLayoutFragmentTreeInput,
    reason: Extract<LayoutOutcome, { readonly status: "rejected" }>["reason"]
  ): LayoutFragmentTree {
    const id = fragmentId("layout-fragment:rejected");
    const empty = cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), ZERO, ZERO);
    const fragment: LayoutBoxFragment = Object.freeze({
      id, kind: "box", formattingNode: input.formatting.root, documentNode: null,
      pseudoElement: null, sourceRange: null, contentStartCodeUnit: null, contentEndCodeUnit: null,
      contentRect: empty, paddingRect: empty, borderRect: empty, marginRect: empty,
      overflowRect: empty, clipRect: empty, children: Object.freeze([]), lineBoxes: Object.freeze([]),
      usedFontMetrics: null, baseline: null, visualOrder: 0, paintOrder: 0, action: null,
      semantic: null, style: Object.freeze({ visible: false, foreground: null, background: null, bold: false,
        italic: false, underline: false, strikethrough: false, borderColor: null, borderStyle: "none" }),
      minContentContribution: ZERO, maxContentContribution: ZERO
    });
    return new ImmutableLayoutFragmentTree(
      input, id, new Map([[id, fragment]]), new Map(), new Map(), [],
      { status: "rejected", reason }
    );
  }

  public fragment(id: LayoutFragmentId): LayoutFragment {
    const fragment = this.#fragments.get(id);
    if (fragment === undefined) throw new RangeError(`Unknown layout fragment: ${id}`);
    return fragment;
  }

  public parent(id: LayoutFragmentId): LayoutFragment | null {
    const parent = this.#parents.get(id);
    return parent === undefined ? null : this.fragment(parent);
  }

  public children(id: LayoutFragmentId): readonly LayoutFragment[] {
    return this.fragment(id).children.map((child) => this.fragment(child));
  }

  public forFormattingNode(node: FormattingNodeId): readonly LayoutFragment[] {
    return (this.#formattingIndex.get(node) ?? []).map((id) => this.fragment(id));
  }

  public forDocumentNode(node: DocumentNodeRef): readonly LayoutFragment[] {
    return (this.#documentIndex.get(node) ?? []).map((id) => this.fragment(id));
  }

  public searchSpans(query: string, limit: number): readonly LayoutSearchSpan[] {
    const spans: LayoutSearchSpan[] = [];
    for (const match of this.searchIndex.search(query, limit).matches) {
      for (const slice of match.slices) {
        for (const fragment of this.forFormattingNode(slice.formatting)) {
          if (fragment.kind !== "text"
            || slice.contentStart >= fragment.contentEndCodeUnit
            || slice.contentEnd <= fragment.contentStartCodeUnit) continue;
          const contentStartCodeUnit = Math.max(slice.contentStart, fragment.contentStartCodeUnit);
          const contentEndCodeUnit = Math.min(slice.contentEnd, fragment.contentEndCodeUnit);
          let sourceRange: DocumentSourceRange | null = slice.sourceRange;
          if (sourceRange !== null && fragment.sourceRange !== null) {
            const start = Math.max(sourceRange.start, fragment.sourceRange.start);
            const end = Math.min(sourceRange.end, fragment.sourceRange.end);
            sourceRange = end > start ? Object.freeze({ start, end, provenance: sourceRange.provenance }) : null;
          }
          spans.push(Object.freeze({
            match: match.id,
            fragment: fragment.id,
            documentNode: fragment.documentNode,
            sourceRange,
            contentStartCodeUnit,
            contentEndCodeUnit
          }));
        }
      }
    }
    return Object.freeze(spans);
  }
}

export function buildLayoutFragmentTree(input: BuildLayoutFragmentTreeInput): LayoutFragmentTree {
  try { return new LayoutBuilder(input).build(); }
  catch (error) {
    if (error instanceof RangeError) {
      return ImmutableLayoutFragmentTree.rejected(input, "invalid-fixed-point-input");
    }
    throw error;
  }
}
