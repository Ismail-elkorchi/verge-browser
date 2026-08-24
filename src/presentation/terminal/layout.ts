import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import type {
  FormattingFormControlNode,
  FormattingNode,
  FormattingNodeId,
  FormattingReplacedNode,
  FormattingTextNode,
  FormattingTree
} from "../formatting/index.js";
import type { ComputedStyle, CssLength } from "../style/index.js";
import type {
  BuildFragmentTreeInput,
  ContainerFragment,
  ControlFragment,
  FragmentBudgets,
  FragmentId,
  FragmentOutcome,
  FragmentTree,
  ReplacedFragment,
  TerminalAccessibilityNode,
  TerminalAction,
  TerminalFocusTarget,
  TerminalFragment,
  TerminalHitRegion,
  TerminalRect,
  TerminalRow,
  TerminalRowFragment,
  TerminalRowStyleRun,
  TerminalScrollAnchor,
  TerminalSearchRange,
  TerminalSearchResult,
  TerminalStyleRun,
  TextFragment
} from "./types.js";

const DEFAULT_FRAGMENT_BUDGETS: FragmentBudgets = Object.freeze({
  maxFragments: 250_000,
  maxRows: 100_000,
  maxPaintCells: 8_000_000,
  maxDepth: 1_024,
  maxSearchMatches: 10_000
});

interface Placement {
  readonly fragment: FragmentId;
  readonly formatting: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly width: number;
  readonly clip: TerminalRect;
  readonly style: TerminalStyleRun;
  readonly paintOrder: number;
}

interface PaintUnit {
  readonly placement: Placement;
  readonly column: number;
  readonly width: number;
  readonly text: string;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
}

interface LayoutResult {
  readonly fragment: FragmentId;
  readonly rect: TerminalRect;
}

interface InlineCursor {
  startColumn: number;
  readonly continuationColumn: number;
  readonly maxColumn: number;
  row: number;
  column: number;
  maxRow: number;
  collapsedSpace: boolean;
}

interface SourceUnit {
  readonly start: number;
  readonly end: number;
}

interface SemanticGeometry {
  readonly fragment: FragmentId;
  readonly rect: TerminalRect;
}

interface MappedText {
  readonly value: string;
  readonly sourceUnits: readonly SourceUnit[];
}

class FragmentBudgetExhausted extends Error {}

function transformTextWithSourceMap(
  value: string,
  transform: ComputedStyle["text"]["textTransform"]
): MappedText {
  let transformed = "";
  const sourceUnits: SourceUnit[] = [];
  let sourceOffset = 0;
  let capitalizeNext = true;
  for (const codePoint of value) {
    let output = codePoint;
    if (transform === "uppercase") output = codePoint.toUpperCase();
    else if (transform === "lowercase") output = codePoint.toLowerCase();
    else if (transform === "capitalize") {
      if (capitalizeNext && /\p{L}/u.test(codePoint)) output = codePoint.toUpperCase();
      capitalizeNext = /[\s\p{P}]/u.test(codePoint);
    }
    transformed += output;
    for (let index = 0; index < output.length; index += 1) {
      sourceUnits.push({ start: sourceOffset, end: sourceOffset + codePoint.length });
    }
    sourceOffset += codePoint.length;
  }
  return { value: transformed, sourceUnits };
}

function mappedSourceRange(map: MappedText, start: number, end: number): readonly [number, number] {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    const unit = map.sourceUnits[index];
    if (unit === undefined) continue;
    minimum = Math.min(minimum, unit.start);
    maximum = Math.max(maximum, unit.end);
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? [minimum, maximum] : [start, end];
}

function fragmentId(value: string): FragmentId {
  return value as FragmentId;
}

function normalizeBudgets(overrides: Partial<FragmentBudgets> | undefined): FragmentBudgets {
  const result = { ...DEFAULT_FRAGMENT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function rect(row: number, column: number, width: number, height: number): TerminalRect {
  return Object.freeze({
    row: Math.max(0, Math.floor(row)),
    column: Math.max(0, Math.floor(column)),
    width: Math.max(0, Math.floor(width)),
    height: Math.max(0, Math.floor(height))
  });
}

function intersection(left: TerminalRect, right: TerminalRect): TerminalRect {
  const row = Math.max(left.row, right.row);
  const column = Math.max(left.column, right.column);
  const bottom = Math.min(left.row + left.height, right.row + right.height);
  const edge = Math.min(left.column + left.width, right.column + right.width);
  return rect(row, column, Math.max(0, edge - column), Math.max(0, bottom - row));
}

function union(rects: readonly TerminalRect[], fallback: TerminalRect): TerminalRect {
  if (rects.length === 0) return fallback;
  let row = fallback.row;
  let column = fallback.column;
  let bottom = fallback.row + fallback.height;
  let edge = fallback.column + fallback.width;
  for (const value of rects) {
    row = Math.min(row, value.row);
    column = Math.min(column, value.column);
    bottom = Math.max(bottom, value.row + value.height);
    edge = Math.max(edge, value.column + value.width);
  }
  return rect(row, column, edge - column, bottom - row);
}

function styleRun(style: ComputedStyle): TerminalStyleRun {
  return Object.freeze({
    foreground: style.text.color,
    background: style.text.background,
    bold: style.text.fontWeight >= 600,
    italic: style.text.fontStyle !== "normal",
    underline: style.text.underline,
    strikethrough: style.text.lineThrough
  });
}

function isInlineFormatting(node: FormattingNode): boolean {
  return node.outer === "inline"
    || node.kind === "text-sequence"
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

class FragmentBuilder {
  readonly #input: BuildFragmentTreeInput;
  readonly #formatting: FormattingTree;
  readonly #budgets: FragmentBudgets;
  readonly #viewportClip: TerminalRect;
  readonly #fragments = new Map<FragmentId, TerminalFragment>();
  readonly #placements: Placement[] = [];
  readonly #sourceIndex = new Map<DocumentNodeRef, FragmentId[]>();
  readonly #hitRegions: TerminalHitRegion[] = [];
  readonly #anchors: TerminalScrollAnchor[] = [];
  readonly #accessibility: TerminalAccessibilityNode[] = [];
  readonly #fragmentOrdinals = new Map<string, number>();
  readonly #decorationCache = new Map<FormattingNodeId, {
    readonly underline: boolean;
    readonly lineThrough: boolean;
  }>();
  #visualOrder = 0;
  #paintOrder = 0;
  #paintCells = 0;
  #truncated: keyof FragmentBudgets | null = null;

  public constructor(input: BuildFragmentTreeInput) {
    this.#input = input;
    this.#formatting = input.formatting;
    this.#budgets = normalizeBudgets(input.budgets);
    this.#viewportClip = rect(0, 0, input.viewport.columns, this.#budgets.maxRows);
  }

  #newId(formatting: FormattingNodeId, suffix = "box"): FragmentId {
    const key = `${formatting}:${suffix}`;
    const ordinal = (this.#fragmentOrdinals.get(key) ?? 0) + 1;
    this.#fragmentOrdinals.set(key, ordinal);
    return fragmentId(`fragment:${key}:${String(ordinal)}`);
  }

  #store<T extends TerminalFragment>(fragment: T, root = false): T {
    if (!root && this.#fragments.size >= this.#budgets.maxFragments - 1) {
      this.#truncated ??= "maxFragments";
      throw new FragmentBudgetExhausted();
    }
    const frozen = Object.freeze({
      ...fragment,
      rect: Object.freeze({ ...fragment.rect }),
      clip: Object.freeze({ ...fragment.clip }),
      children: Object.freeze([...fragment.children]),
      action: fragment.action === null ? null : Object.freeze({ ...fragment.action })
    }) as unknown as T;
    this.#fragments.set(frozen.id, frozen);
    if (frozen.source !== null) {
      const entries = this.#sourceIndex.get(frozen.source) ?? [];
      entries.push(frozen.id);
      this.#sourceIndex.set(frozen.source, entries);
    }
    const visibleRect = intersection(frozen.rect, frozen.clip);
    const descendantProvidesAction = frozen.kind === "container"
      && frozen.action !== null
      && this.#hitRegions.some((entry) => entry.action.node === frozen.action?.node);
    if (frozen.action !== null && !descendantProvidesAction && visibleRect.width > 0 && visibleRect.height > 0) {
      this.#hitRegions.push(Object.freeze({ action: frozen.action, fragment: frozen.id, rect: visibleRect }));
    }
    if (frozen.semantic !== null && frozen.source !== null && visibleRect.width > 0 && visibleRect.height > 0) {
      this.#accessibility.push(Object.freeze({
        source: frozen.source,
        fragment: frozen.id,
        role: frozen.semantic.role,
        name: frozen.semantic.accessibleName,
        description: frozen.semantic.accessibleDescription,
        rect: visibleRect
      }));
    }
    return frozen;
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

  #textStyle(node: FormattingNode, computed: ComputedStyle): TerminalStyleRun {
    const path: FormattingNode[] = [];
    let current: FormattingNode | null = node;
    let inherited = { underline: false, lineThrough: false };
    while (current !== null) {
      const cached = this.#decorationCache.get(current.id);
      if (cached !== undefined) {
        inherited = cached;
        break;
      }
      path.push(current);
      current = this.#formatting.parent(current.id);
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index];
      if (entry === undefined) continue;
      const style = this.#computed(entry);
      inherited = {
        underline: inherited.underline || style?.text.underline === true,
        lineThrough: inherited.lineThrough || style?.text.lineThrough === true
      };
      this.#decorationCache.set(entry.id, inherited);
    }
    return {
      ...styleRun(computed),
      underline: inherited.underline,
      strikethrough: inherited.lineThrough
    };
  }

  #length(value: CssLength, axis: "horizontal" | "vertical", containing: number): number {
    if (value.kind === "zero" || value.kind === "auto" || value.kind === "none") return 0;
    const profile = this.#input.profile;
    const pixelsPerUnit = axis === "horizontal" ? profile.cellWidthPx : profile.rowHeightPx;
    if (value.unit === "px") return Math.round(value.value / pixelsPerUnit);
    if (value.unit === "ch") return Math.round(value.value * (axis === "horizontal" ? 1 : profile.cellWidthPx / profile.rowHeightPx));
    if (value.unit === "em" || value.unit === "rem") return Math.round(value.value * (axis === "horizontal" ? 2 : 1));
    if (value.unit === "%") return Math.round(containing * value.value / 100);
    if (value.unit === "vw") {
      return Math.round(this.#input.viewport.columns * profile.cellWidthPx * value.value / 100 / pixelsPerUnit);
    }
    return Math.round(this.#input.viewport.rows * profile.rowHeightPx * value.value / 100 / pixelsPerUnit);
  }

  #action(node: FormattingNode): TerminalAction | null {
    if (this.#computed(node)?.visibility !== "visible") return null;
    let source = node.source;
    while (source !== null) {
      const link = this.#formatting.document.link(source);
      if (link !== null) return { kind: "link", node: link.node, destination: link.destination };
      const control = this.#formatting.document.control(source);
      if (control !== null) return { kind: "form-control", node: control.node, form: control.form };
      const parent = this.#formatting.document.parent(source);
      const disclosure = parent === null ? null : this.#formatting.document.disclosure(parent.ref);
      if (disclosure?.kind === "details" && disclosure.summary === source) {
        return {
          kind: "disclosure",
          node: disclosure.node,
          open: this.#formatting.state.open.has(disclosure.node)
        };
      }
      source = parent?.ref ?? null;
    }
    return null;
  }

  #clipFor(node: FormattingNode, box: TerminalRect, inherited: TerminalRect): TerminalRect {
    const style = this.#boxComputed(node);
    if (style === null) return inherited;
    const row = style.box.overflowY === "visible" ? inherited.row : Math.max(inherited.row, box.row);
    const bottom = style.box.overflowY === "visible"
      ? inherited.row + inherited.height
      : Math.min(inherited.row + inherited.height, box.row + box.height);
    const column = style.box.overflowX === "visible" ? inherited.column : Math.max(inherited.column, box.column);
    const edge = style.box.overflowX === "visible"
      ? inherited.column + inherited.width
      : Math.min(inherited.column + inherited.width, box.column + box.width);
    return rect(row, column, Math.max(0, edge - column), Math.max(0, bottom - row));
  }

  #visuallyClipped(node: FormattingNode, width: number): boolean {
    const style = this.#boxComputed(node);
    if (style === null || (style.box.position !== "absolute" && style.box.position !== "fixed")) return false;
    if (style.box.overflowX === "visible" && style.box.overflowY === "visible") return false;
    const tiny = (value: CssLength): boolean => value.kind === "zero"
      || (value.kind === "length" && value.unit === "px" && value.value <= 1);
    if (!tiny(style.box.width) || !tiny(style.box.height)) return false;
    if (style.box.legacyClip.kind === "rect") {
      const { top, right, bottom, left } = style.box.legacyClip.edges;
      if (top.kind !== "auto" && right.kind !== "auto" && bottom.kind !== "auto" && left.kind !== "auto") {
        const vertical = this.#length(bottom, "vertical", this.#input.viewport.rows)
          <= this.#length(top, "vertical", this.#input.viewport.rows);
        const horizontal = this.#length(right, "horizontal", width) <= this.#length(left, "horizontal", width);
        if (vertical || horizontal) return true;
      }
    }
    if (style.box.clipPath.kind === "inset") {
      const { top, right, bottom, left } = style.box.clipPath.offsets;
      const vertical = this.#length(top, "vertical", 1) + this.#length(bottom, "vertical", 1) >= 1;
      const horizontal = this.#length(left, "horizontal", 1) + this.#length(right, "horizontal", 1) >= 1;
      if (vertical || horizontal) return true;
    }
    return false;
  }

  #clippedFragment(node: FormattingNode, x: number, y: number, clip: TerminalRect): LayoutResult {
    const box = rect(y, x, 0, 0);
    const fragment = this.#containerFragment(node, box, intersection(clip, box), []);
    if (node.source !== null && node.semantic !== null && !node.semantic.accessibilityHidden
      && this.#computed(node)?.visibility === "visible") {
      this.#accessibility.push(Object.freeze({
        source: node.source,
        fragment: fragment.id,
        role: node.semantic.role,
        name: node.semantic.accessibleName,
        description: node.semantic.accessibleDescription,
        rect: box
      }));
    }
    return { fragment: fragment.id, rect: box };
  }

  #projectUnboxedAccessibility(): void {
    const existing = new Set(this.#accessibility.map((entry) => entry.source));
    const relevant = new Set<DocumentNodeRef>();
    const direct = new Map<DocumentNodeRef, SemanticGeometry>();
    for (const fragment of this.#fragments.values()) {
      if (fragment.source === null) continue;
      const visible = intersection(fragment.rect, fragment.clip);
      if (visible.width <= 0 || visible.height <= 0) continue;
      const current = direct.get(fragment.source);
      direct.set(fragment.source, current === undefined
        ? { fragment: fragment.id, rect: visible }
        : { fragment: current.fragment, rect: union([current.rect, visible], current.rect) });
      let source: DocumentNodeRef | null = fragment.source;
      while (source !== null && !relevant.has(source)) {
        relevant.add(source);
        source = this.#formatting.document.parent(source)?.ref ?? null;
      }
    }
    const childCounts = new Map<DocumentNodeRef, number>();
    for (const source of relevant) {
      childCounts.set(source, this.#formatting.document.node(source).children
        .filter((child) => relevant.has(child)).length);
    }
    const pending = [...relevant].filter((source) => childCounts.get(source) === 0);
    const geometry = new Map(direct);
    while (pending.length > 0) {
      const source = pending.pop();
      if (source === undefined) continue;
      const current = geometry.get(source);
      if (current !== undefined && !existing.has(source) && this.#formatting.styles.has(source)) {
        const style = this.#formatting.styles.style(source);
        const semantic = this.#formatting.document.semantic(source);
        if (style.display.box === "contents" && style.visibility === "visible"
          && semantic !== null && !semantic.accessibilityHidden) {
          this.#accessibility.push(Object.freeze({
            source,
            fragment: current.fragment,
            role: semantic.role,
            name: semantic.accessibleName,
            description: semantic.accessibleDescription,
            rect: current.rect
          }));
          existing.add(source);
        }
      }
      const parent = this.#formatting.document.parent(source)?.ref ?? null;
      if (parent === null || !relevant.has(parent)) continue;
      if (current !== undefined) {
        const parentGeometry = geometry.get(parent);
        geometry.set(parent, parentGeometry === undefined
          ? current
          : {
              fragment: parentGeometry.fragment,
              rect: union([parentGeometry.rect, current.rect], parentGeometry.rect)
            });
      }
      const remaining = (childCounts.get(parent) ?? 1) - 1;
      childCounts.set(parent, remaining);
      if (remaining === 0) pending.push(parent);
    }
  }

  #containerFragment(node: FormattingNode, box: TerminalRect, clip: TerminalRect, children: readonly FragmentId[]): ContainerFragment {
    const visible = this.#computed(node)?.visibility === "visible";
    const semantic = visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null;
    const fragment = this.#store({
      id: this.#newId(node.id),
      kind: "container",
      formatting: node.id,
      source: node.source,
      sourceRange: node.sourceRange,
      rect: box,
      clip,
      children: [...children],
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic
    }, node.id === this.#formatting.root);
    if (node.source !== null && semantic !== null && box.height > 0) {
      this.#anchors.push(Object.freeze({
        id: `anchor:${node.source}`,
        source: node.source,
        fragment: fragment.id,
        row: box.row
      }));
    }
    if (visible) this.#paintBorder(node, fragment);
    return fragment;
  }

  #paintBorder(node: FormattingNode, fragment: ContainerFragment): void {
    const computed = this.#boxComputed(node);
    if (computed === null || computed.box.borderStyle !== "solid"
      || computed.box.borderWidth.kind === "zero" || fragment.rect.width < 1 || fragment.rect.height < 1) return;
    const horizontal = this.#input.profile.unicode ? "─" : "-";
    const vertical = this.#input.profile.unicode ? "│" : "|";
    const top = fragment.rect.width === 1
      ? vertical
      : `${this.#input.profile.unicode ? "┌" : "+"}${horizontal.repeat(Math.max(0, fragment.rect.width - 2))}${this.#input.profile.unicode ? "┐" : "+"}`;
    const bottom = fragment.rect.width === 1
      ? vertical
      : `${this.#input.profile.unicode ? "└" : "+"}${horizontal.repeat(Math.max(0, fragment.rect.width - 2))}${this.#input.profile.unicode ? "┘" : "+"}`;
    const decorations: { readonly row: number; readonly column: number; readonly text: string; readonly width: number }[] = [
      { row: fragment.rect.row, column: fragment.rect.column, text: top, width: fragment.rect.width }
    ];
    for (let row = fragment.rect.row + 1; row < fragment.rect.row + fragment.rect.height - 1; row += 1) {
      decorations.push({ row, column: fragment.rect.column, text: vertical, width: 1 });
      if (fragment.rect.width > 1) {
        decorations.push({ row, column: fragment.rect.column + fragment.rect.width - 1, text: vertical, width: 1 });
      }
    }
    if (fragment.rect.height > 1) {
      decorations.push({
        row: fragment.rect.row + fragment.rect.height - 1,
        column: fragment.rect.column,
        text: bottom,
        width: fragment.rect.width
      });
    }
    const visibleCells = decorations.reduce((total, decoration) => {
      const visible = intersection(
        rect(decoration.row, decoration.column, decoration.width, 1),
        fragment.clip
      );
      return total + visible.width * visible.height;
    }, 0);
    if (this.#paintCells + visibleCells > this.#budgets.maxPaintCells) {
      this.#truncated ??= "maxPaintCells";
      return;
    }
    const decorationStyle = {
      ...styleRun(computed),
      foreground: computed.box.borderColor ?? computed.text.color,
      background: null
    };
    for (const decoration of decorations) {
      this.#placements.push({
        fragment: fragment.id,
        formatting: node.id,
        source: node.source,
        sourceRange: null,
        row: decoration.row,
        column: decoration.column,
        text: decoration.text,
        width: decoration.width,
        clip: fragment.clip,
        style: decorationStyle,
        paintOrder: fragment.paintOrder
      });
    }
    this.#paintCells += visibleCells;
  }

  #textPlacement(
    node: FormattingNode,
    cursor: InlineCursor,
    text: string,
    localStart: number,
    localEnd: number,
    clip: TerminalRect
  ): TextFragment | null {
    const width = this.#input.measurer.width(text);
    if (width <= 0) return null;
    if (cursor.row >= this.#budgets.maxRows) {
      this.#truncated ??= "maxRows";
      return null;
    }
    const style = this.#computed(node);
    if (style === null) return null;
    const visible = style.visibility === "visible";
    if (visible && this.#paintCells + width > this.#budgets.maxPaintCells) {
      this.#truncated ??= "maxPaintCells";
      return null;
    }
    const sourceRange = node.source === null || node.sourceRange === null
      ? null
      : this.#formatting.document.textSourceRange(node.source, localStart, localEnd);
    const box = rect(cursor.row, cursor.column, width, 1);
    const fragment = this.#store({
      id: this.#newId(node.id, `text:${String(localStart)}`),
      kind: "text",
      formatting: node.id,
      source: node.source,
      sourceRange,
      rect: box,
      clip: intersection(clip, box),
      children: [],
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic: visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null,
      text: visible ? text : "",
      style: this.#textStyle(node, style)
    });
    if (visible) {
      this.#placements.push({
        fragment: fragment.id,
        formatting: node.id,
        source: node.source,
        sourceRange,
        row: cursor.row,
        column: cursor.column,
        text,
        width,
        clip: fragment.clip,
        style: fragment.style,
        paintOrder: fragment.paintOrder
      });
      this.#paintCells += width;
    }
    cursor.column += width;
    cursor.maxRow = Math.max(cursor.maxRow, cursor.row);
    return fragment;
  }

  #newline(cursor: InlineCursor): void {
    cursor.row += 1;
    cursor.startColumn = cursor.continuationColumn;
    cursor.column = cursor.continuationColumn;
    cursor.maxRow = Math.max(cursor.maxRow, cursor.row);
    cursor.collapsedSpace = false;
  }

  #placeText(node: FormattingTextNode, cursor: InlineCursor, clip: TerminalRect): LayoutResult {
    const computed = this.#computed(node);
    const transformed = transformTextWithSourceMap(node.text, computed?.text.textTransform ?? "none");
    const whiteSpace = node.whiteSpace;
    const wraps = whiteSpace !== "nowrap" && whiteSpace !== "pre";
    const preservesSpaces = whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
    const preservesNewlines = whiteSpace !== "normal" && whiteSpace !== "nowrap";
    const children: FragmentId[] = [];
    const startRow = cursor.row;
    const startColumn = cursor.column;
    let codeUnit = 0;
    const tokens = transformed.value.match(/\r\n|\r|\n|[^\S\r\n]+|[^\s]+/gu) ?? [];
    for (const token of tokens) {
      this.#input.signal?.throwIfAborted();
      const tokenStart = codeUnit;
      codeUnit += token.length;
      const newline = token === "\n" || token === "\r" || token === "\r\n";
      if (newline) {
        if (preservesNewlines) this.#newline(cursor);
        else if (cursor.column > cursor.startColumn && !cursor.collapsedSpace) {
          const source = mappedSourceRange(transformed, tokenStart, codeUnit);
          const fragment = this.#textPlacement(node, cursor, " ", source[0], source[1], clip);
          if (fragment !== null) children.push(fragment.id);
          cursor.collapsedSpace = true;
        }
        continue;
      }
      const whitespace = /^\s+$/u.test(token);
      const rendered = whitespace && !preservesSpaces ? " " : token;
      if (whitespace && !preservesSpaces
        && (cursor.column === cursor.startColumn || cursor.collapsedSpace)) continue;
      if (whitespace && !preservesSpaces && cursor.column >= cursor.maxColumn) {
        cursor.collapsedSpace = true;
        continue;
      }
      const tokenWidth = this.#input.measurer.width(rendered);
      if (wraps && !whitespace && cursor.column > cursor.startColumn && cursor.column + tokenWidth > cursor.maxColumn) {
        this.#newline(cursor);
      }
      let chunkText = "";
      let chunkStart = tokenStart;
      let chunkEnd = tokenStart;
      const flush = (): void => {
        if (chunkText.length === 0) return;
        const source = mappedSourceRange(transformed, chunkStart, chunkEnd);
        const fragment = this.#textPlacement(node, cursor, chunkText, source[0], source[1], clip);
        if (fragment !== null) children.push(fragment.id);
        chunkText = "";
      };
      for (const grapheme of this.#input.measurer.graphemes(rendered)) {
        if (wraps && (cursor.column > cursor.startColumn || chunkText.length > 0)
          && cursor.column + this.#input.measurer.width(chunkText) + grapheme.cells > cursor.maxColumn) {
          flush();
          this.#newline(cursor);
          chunkStart = tokenStart + grapheme.startCodeUnit;
        }
        if (chunkText.length === 0) chunkStart = tokenStart + grapheme.startCodeUnit;
        chunkText += grapheme.text;
        chunkEnd = tokenStart + grapheme.endCodeUnit;
      }
      flush();
      cursor.collapsedSpace = whitespace && !preservesSpaces;
    }
    const box = rect(
      startRow,
      Math.min(startColumn, cursor.column),
      Math.max(0, Math.min(cursor.maxColumn, Math.max(startColumn, cursor.column)) - Math.min(startColumn, cursor.column)),
      Math.max(1, cursor.maxRow - startRow + 1)
    );
    const fragment = this.#containerFragment(node, box, intersection(clip, box), children);
    return { fragment: fragment.id, rect: box };
  }

  #controlText(node: FormattingFormControlNode): { readonly label: string; readonly value: string; readonly text: string } {
    const control = node.control;
    const state = this.#formatting.state.controls.get(control.node);
    if (control.kind === "text" || control.kind === "textarea") {
      const value = state?.values[0] ?? control.defaultValue;
      return { label: control.label, value, text: `${control.label}: ${value || control.placeholder || ""}` };
    }
    if (control.kind === "checkbox" || control.kind === "radio") {
      const checked = state?.checked ?? control.defaultChecked;
      return { label: control.label, value: checked ? control.value : "", text: `${checked ? "[x]" : "[ ]"} ${control.label}` };
    }
    if (control.kind === "select") {
      const values = state?.values ?? control.options.filter((option) => option.defaultSelected).map((option) => option.value);
      return { label: control.label, value: values.join(", "), text: `${control.label}: ${values.join(", ")}` };
    }
    if (control.kind === "submit" || control.kind === "reset") {
      return { label: control.label, value: control.value, text: `[${control.label || control.value}]` };
    }
    if (control.kind === "hidden") {
      return { label: "", value: control.defaultValue, text: "" };
    }
    return { label: control.label, value: "", text: `${control.label}: unsupported control` };
  }

  #placeAtomic(
    node: FormattingFormControlNode | FormattingReplacedNode,
    cursor: InlineCursor,
    clip: TerminalRect
  ): LayoutResult {
    const control = node.kind === "form-control" ? this.#controlText(node) : null;
    const text = node.kind === "form-control" ? control?.text ?? "" : node.fallbackText;
    const maxWidth = Math.max(1, cursor.maxColumn - cursor.startColumn);
    const clipped = this.#input.measurer.width(text) > maxWidth
      ? this.#input.measurer.graphemes(text).reduce((current, grapheme) =>
        current.width + grapheme.cells <= Math.max(1, maxWidth - 1)
          ? { text: current.text + grapheme.text, width: current.width + grapheme.cells }
          : current,
      { text: "", width: 0 }).text + "…"
      : text;
    const width = Math.max(1, this.#input.measurer.width(clipped));
    if (cursor.column > cursor.startColumn && cursor.column + width > cursor.maxColumn) this.#newline(cursor);
    const style = this.#boxComputed(node);
    const visible = style?.visibility === "visible";
    const usedWidth = Math.min(width, maxWidth);
    const paintAllowed = cursor.row < this.#budgets.maxRows
      && (!visible || this.#paintCells + usedWidth <= this.#budgets.maxPaintCells);
    if (!paintAllowed) {
      this.#truncated ??= cursor.row >= this.#budgets.maxRows ? "maxRows" : "maxPaintCells";
    }
    const box = paintAllowed
      ? rect(cursor.row, cursor.column, usedWidth, 1)
      : rect(cursor.row, cursor.column, 0, 0);
    const common = {
      id: this.#newId(node.id),
      formatting: node.id,
      source: node.source,
      sourceRange: node.sourceRange,
      rect: box,
      clip: intersection(clip, box),
      children: [] as const,
      visualOrder: ++this.#visualOrder,
      paintOrder: ++this.#paintOrder,
      action: visible ? this.#action(node) : null,
      semantic: visible && node.semantic?.accessibilityHidden !== true ? node.semantic : null
    };
    let fragment: ControlFragment | ReplacedFragment;
    if (node.kind === "form-control" && control !== null) {
      fragment = this.#store({ ...common, kind: "control", label: control.label, value: control.value });
    } else {
      fragment = this.#store({ ...common, kind: "replaced", fallbackText: text });
    }
    if (style !== null && visible && paintAllowed) {
      this.#placements.push({
        fragment: fragment.id,
        formatting: node.id,
        source: node.source,
        sourceRange: node.sourceRange,
        row: box.row,
        column: box.column,
        text: clipped,
        width: box.width,
        clip: fragment.clip,
        style: styleRun(style),
        paintOrder: fragment.paintOrder
      });
      this.#paintCells += box.width;
    }
    if (paintAllowed) {
      cursor.column += box.width;
      cursor.maxRow = Math.max(cursor.maxRow, cursor.row);
      cursor.collapsedSpace = false;
    }
    return { fragment: fragment.id, rect: box };
  }

  #layoutInline(id: FormattingNodeId, cursor: InlineCursor, clip: TerminalRect, depth: number): LayoutResult {
    const node = this.#formatting.node(id);
    if (this.#visuallyClipped(node, Math.max(1, cursor.maxColumn - cursor.column))) {
      return this.#clippedFragment(node, cursor.column, cursor.row, clip);
    }
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
      return this.#placeText(node, cursor, clip);
    }
    if (node.kind === "forced-line-break") {
      const before = rect(cursor.row, cursor.column, 0, 1);
      this.#newline(cursor);
      const fragment = this.#containerFragment(node, before, intersection(clip, before), []);
      return { fragment: fragment.id, rect: before };
    }
    if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image-fallback") {
      return this.#placeAtomic(node, cursor, clip);
    }
    if (establishesInlineFormattingContext(node)) {
      const available = Math.max(1, cursor.maxColumn - cursor.column);
      const result = this.#layoutNode(id, cursor.column, cursor.row, available, clip, depth + 1);
      cursor.column += result.rect.width;
      cursor.maxRow = Math.max(cursor.maxRow, result.rect.row + result.rect.height - 1);
      cursor.collapsedSpace = false;
      return result;
    }
    if (!isInlineFormatting(node)) {
      if (cursor.column !== cursor.startColumn) this.#newline(cursor);
      const result = this.#layoutNode(id, cursor.startColumn, cursor.row, cursor.maxColumn - cursor.startColumn, clip, depth + 1);
      cursor.row = result.rect.row + result.rect.height;
      cursor.column = cursor.startColumn;
      cursor.maxRow = Math.max(cursor.maxRow, cursor.row);
      cursor.collapsedSpace = false;
      return result;
    }
    const startRow = cursor.row;
    const startColumn = cursor.column;
    const children: FragmentId[] = [];
    const childRects: TerminalRect[] = [];
    for (const child of node.children) {
      const result = this.#layoutInline(child, cursor, clip, depth + 1);
      children.push(result.fragment);
      childRects.push(result.rect);
    }
    const box = union(childRects, rect(startRow, startColumn, 0, 1));
    const fragment = this.#containerFragment(node, box, intersection(clip, box), children);
    return { fragment: fragment.id, rect: box };
  }

  #inlineIntrinsicWidth(ids: readonly FormattingNodeId[], maximum: number): number {
    let width = 0;
    const pending = [...ids].reverse();
    while (pending.length > 0 && width <= maximum) {
      this.#input.signal?.throwIfAborted();
      const id = pending.pop();
      if (id === undefined) continue;
      const node = this.#formatting.node(id);
      if (node.kind === "forced-line-break") return maximum + 1;
      if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
        const computed = this.#computed(node);
        const transformed = transformTextWithSourceMap(
          node.text,
          computed?.text.textTransform ?? "none"
        ).value;
        let measured: number;
        if (node.whiteSpace === "pre" || node.whiteSpace === "pre-wrap") {
          measured = 0;
          let lineStart = 0;
          for (let index = 0; index <= transformed.length; index += 1) {
            const character = transformed[index];
            if (index !== transformed.length && character !== "\n" && character !== "\r") continue;
            measured = Math.max(measured, this.#input.measurer.width(transformed.slice(lineStart, index)));
            if (character === "\r" && transformed[index + 1] === "\n") index += 1;
            lineStart = index + 1;
          }
        } else {
          measured = this.#input.measurer.width(transformed.replace(/\s+/gu, " "));
        }
        width += measured;
        continue;
      }
      if (node.kind === "form-control") width += this.#input.measurer.width(this.#controlText(node).text);
      else if (node.kind === "replaced-element" || node.kind === "image-fallback") {
        width += this.#input.measurer.width(node.fallbackText);
      } else {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) pending.push(child);
        }
      }
    }
    return width;
  }

  #estimatedHeight(id: FormattingNodeId, width: number, depth = 0): number {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) return 1;
    const node = this.#formatting.node(id);
    if (node.kind === "forced-line-break" || node.kind === "form-control"
      || node.kind === "replaced-element" || node.kind === "image-fallback") return 1;
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
      const transformed = transformTextWithSourceMap(
        node.text,
        this.#computed(node)?.text.textTransform ?? "none"
      ).value;
      if (node.whiteSpace === "pre" || node.whiteSpace === "pre-wrap" || node.whiteSpace === "pre-line") {
        let rows = 0;
        let lineStart = 0;
        for (let index = 0; index <= transformed.length; index += 1) {
          const character = transformed[index];
          if (index !== transformed.length && character !== "\n" && character !== "\r") continue;
          const lineWidth = this.#input.measurer.width(transformed.slice(lineStart, index));
          rows += node.whiteSpace === "pre" ? 1 : Math.max(1, Math.ceil(lineWidth / Math.max(1, width)));
          if (character === "\r" && transformed[index + 1] === "\n") index += 1;
          lineStart = index + 1;
        }
        return Math.max(1, rows);
      }
      const measured = this.#input.measurer.width(transformed.replace(/\s+/gu, " "));
      return node.whiteSpace === "nowrap" ? 1 : Math.max(1, Math.ceil(measured / Math.max(1, width)));
    }
    const style = this.#boxComputed(node);
    const marginTop = style === null ? 0 : this.#length(style.box.margin.top, "vertical", this.#input.viewport.rows);
    const marginBottom = style === null ? 0 : this.#length(style.box.margin.bottom, "vertical", this.#input.viewport.rows);
    const paddingTop = style === null ? 0 : this.#length(style.box.padding.top, "vertical", this.#input.viewport.rows);
    const paddingBottom = style === null ? 0 : this.#length(style.box.padding.bottom, "vertical", this.#input.viewport.rows);
    const border = style?.box.borderStyle === "solid" && style.box.borderWidth.kind !== "zero" ? 1 : 0;
    const specified = style === null || style.box.height.kind === "auto"
      ? 0 : this.#length(style.box.height, "vertical", this.#input.viewport.rows);
    const minimum = style === null || style.box.minHeight.kind === "auto"
      ? 0 : this.#length(style.box.minHeight, "vertical", this.#input.viewport.rows);
    let content = 0;
    let inline: FormattingNodeId[] = [];
    const flushInline = (): void => {
      if (inline.length === 0) return;
      const intrinsic = this.#inlineIntrinsicWidth(inline, Math.max(1, width));
      content += Math.max(1, Math.ceil(intrinsic / Math.max(1, width)));
      inline = [];
    };
    for (const childId of node.children) {
      const child = this.#formatting.node(childId);
      if (isInlineFormatting(child)) inline.push(childId);
      else {
        flushInline();
        content += this.#estimatedHeight(childId, width, depth + 1);
      }
    }
    flushInline();
    return Math.max(1, marginTop + paddingTop + border + Math.max(specified, minimum, content) + paddingBottom + border + marginBottom);
  }

  #flexBasis(id: FormattingNodeId, maximum: number): number {
    const pending = [id];
    while (pending.length > 0) {
      this.#input.signal?.throwIfAborted();
      const current = pending.pop();
      if (current === undefined) continue;
      const node = this.#formatting.node(current);
      const style = this.#boxComputed(node);
      if (style !== null && style.box.width.kind !== "auto") {
        const width = this.#length(style.box.width, "horizontal", maximum);
        const padding = this.#length(style.box.padding.left, "horizontal", maximum)
          + this.#length(style.box.padding.right, "horizontal", maximum);
        const border = style.box.borderStyle === "solid" && style.box.borderWidth.kind !== "zero" ? 2 : 0;
        return Math.max(1, Math.min(maximum, width + padding + border));
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return Math.max(1, Math.min(maximum, this.#inlineIntrinsicWidth([id], maximum)));
  }

  #flow(
    node: FormattingNode,
    x: number,
    y: number,
    width: number,
    clip: TerminalRect,
    depth: number
  ): LayoutResult {
    const style = this.#boxComputed(node);
    const marginTop = style === null ? 0 : this.#length(style.box.margin.top, "vertical", this.#input.viewport.rows);
    const marginBottom = style === null ? 0 : this.#length(style.box.margin.bottom, "vertical", this.#input.viewport.rows);
    const fixedMarginLeft = style === null ? 0 : this.#length(style.box.margin.left, "horizontal", width);
    const fixedMarginRight = style === null ? 0 : this.#length(style.box.margin.right, "horizontal", width);
    const paddingTop = style === null ? 0 : this.#length(style.box.padding.top, "vertical", this.#input.viewport.rows);
    const paddingBottom = style === null ? 0 : this.#length(style.box.padding.bottom, "vertical", this.#input.viewport.rows);
    const paddingLeft = style === null ? 0 : this.#length(style.box.padding.left, "horizontal", width);
    const paddingRight = style === null ? 0 : this.#length(style.box.padding.right, "horizontal", width);
    const border = style?.box.borderStyle === "solid" && style.box.borderWidth.kind !== "zero" ? 1 : 0;
    const specifiedWidth = style === null || style.box.width.kind === "auto" ? null : this.#length(style.box.width, "horizontal", width);
    const availableWidth = Math.max(1, width - fixedMarginLeft - fixedMarginRight);
    const minimumWidth = style === null || style.box.minWidth.kind === "auto"
      ? 0 : this.#length(style.box.minWidth, "horizontal", width);
    const maximumWidth = style === null || style.box.maxWidth.kind === "auto" || style.box.maxWidth.kind === "none"
      ? availableWidth : this.#length(style.box.maxWidth, "horizontal", width);
    const chromeWidth = paddingLeft + paddingRight + border * 2;
    const autoContentWidth = Math.max(1, availableWidth - chromeWidth);
    const contentBoxWidth = Math.max(minimumWidth, Math.min(maximumWidth, specifiedWidth ?? autoContentWidth));
    const outerWidth = Math.max(1, Math.min(availableWidth, contentBoxWidth + chromeWidth));
    const autoLeft = style?.box.margin.left.kind === "auto";
    const autoRight = style?.box.margin.right.kind === "auto";
    const freeMargin = Math.max(0, width - fixedMarginLeft - fixedMarginRight - outerWidth);
    const marginLeft = autoLeft
      ? autoRight ? Math.floor(freeMargin / 2) : freeMargin
      : fixedMarginLeft;
    const specifiedHeight = style === null || style.box.height.kind === "auto"
      ? 0 : this.#length(style.box.height, "vertical", this.#input.viewport.rows);
    const provisionalHeight = specifiedHeight > 0
      ? paddingTop + border + specifiedHeight + paddingBottom + border
      : this.#budgets.maxRows;
    const childClip = this.#clipFor(
      node,
      rect(y + marginTop, x + marginLeft, outerWidth, provisionalHeight),
      clip
    );
    const contentX = x + marginLeft + paddingLeft + border;
    const contentWidth = Math.max(1, outerWidth - paddingLeft - paddingRight - border * 2);
    let currentY = y + marginTop + paddingTop + border;
    const children: FragmentId[] = [];
    const childRects: TerminalRect[] = [];
    let inlineRun: FormattingNodeId[] = [];
    let firstInlineRun = true;
    const flushInline = (): void => {
      if (inlineRun.length === 0) return;
      const indent = firstInlineRun && style !== null
        ? this.#length(style.text.textIndent, "horizontal", contentWidth)
        : 0;
      const lineWidth = Math.max(1, contentWidth - Math.max(0, indent));
      const intrinsic = Math.min(lineWidth, this.#inlineIntrinsicWidth(inlineRun, lineWidth));
      const alignment = style?.text.textAlign === "center"
        ? Math.max(0, Math.floor((lineWidth - intrinsic) / 2))
        : style?.text.textAlign === "right"
          ? Math.max(0, lineWidth - intrinsic)
          : 0;
      const startColumn = contentX + indent + alignment;
      const cursor: InlineCursor = {
        startColumn,
        continuationColumn: contentX,
        maxColumn: contentX + contentWidth,
        row: currentY,
        column: startColumn,
        maxRow: currentY,
        collapsedSpace: false
      };
      for (const child of inlineRun) {
        const result = this.#layoutInline(child, cursor, childClip, depth + 1);
        children.push(result.fragment);
        childRects.push(result.rect);
      }
      currentY = Math.max(currentY + 1, cursor.maxRow + 1);
      inlineRun = [];
      firstInlineRun = false;
    };
    const columnFlex = node.kind === "flex-container"
      && (style?.box.flexDirection === "column" || style?.box.flexDirection === "column-reverse");
    const orderedChildren = columnFlex && style.box.flexDirection === "column-reverse"
      ? [...node.children].reverse()
      : node.children;
    const flexRowGap = columnFlex
      ? this.#length(style.box.rowGap, "vertical", this.#input.viewport.rows)
      : 0;
    if (columnFlex) {
      const estimates = orderedChildren.map((child) => this.#estimatedHeight(child, contentWidth));
      const occupied = estimates.reduce((total, height) => total + height, 0)
        + flexRowGap * Math.max(0, orderedChildren.length - 1);
      const spare = Math.max(0, specifiedHeight - occupied);
      currentY += style.box.justifyContent === "center"
        ? Math.floor(spare / 2)
        : style.box.justifyContent === "end" ? spare : 0;
      const between = style.box.justifyContent === "space-between" && orderedChildren.length > 1
        ? flexRowGap + Math.floor(spare / (orderedChildren.length - 1))
        : flexRowGap;
      for (const [childIndex, childId] of orderedChildren.entries()) {
        const basis = style.box.alignItems === "stretch" ? contentWidth : this.#flexBasis(childId, contentWidth);
        const childX = contentX + (style.box.alignItems === "center"
          ? Math.floor((contentWidth - basis) / 2)
          : style.box.alignItems === "end" ? contentWidth - basis : 0);
        const result = this.#layoutNode(childId, childX, currentY, basis, childClip, depth + 1);
        children.push(result.fragment);
        childRects.push(result.rect);
        currentY = Math.max(currentY, result.rect.row + result.rect.height);
        if (childIndex < orderedChildren.length - 1) currentY += between;
      }
    } else {
      for (const childId of orderedChildren) {
        const child = this.#formatting.node(childId);
        if (isInlineFormatting(child)) {
          inlineRun.push(childId);
          continue;
        }
        flushInline();
        const result = this.#layoutNode(childId, contentX, currentY, contentWidth, childClip, depth + 1);
        children.push(result.fragment);
        childRects.push(result.rect);
        currentY = Math.max(currentY, result.rect.row + result.rect.height);
      }
      flushInline();
    }
    const minHeight = style === null ? 0 : this.#length(style.box.minHeight, "vertical", this.#input.viewport.rows);
    const contentHeight = Math.max(minHeight, specifiedHeight, Math.max(0, currentY - (y + marginTop + paddingTop + border)));
    const box = rect(y + marginTop, x + marginLeft, outerWidth, Math.max(1, paddingTop + border + contentHeight + paddingBottom + border));
    const fragmentClip = this.#clipFor(node, box, clip);
    const fragment = this.#containerFragment(node, box, fragmentClip, children);
    return {
      fragment: fragment.id,
      rect: rect(box.row, box.column, box.width, box.height + marginBottom)
    };
  }

  #columnCount(node: FormattingNode): number {
    let maximum = 1;
    const pending = [...node.children];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      const child = this.#formatting.node(id);
      if (child.kind === "table-row") {
        maximum = Math.max(maximum, child.children.filter((entry) => this.#formatting.node(entry).kind === "table-cell").length);
      } else if (child.kind === "table-header-group" || child.kind === "table-body-group" || child.kind === "table-footer-group") {
        pending.push(...child.children);
      }
    }
    return maximum;
  }

  #table(
    node: FormattingNode,
    x: number,
    y: number,
    width: number,
    clip: TerminalRect,
    depth: number,
    columns = this.#columnCount(node)
  ): LayoutResult {
    if (node.kind === "table-row") {
      const cells = node.children;
      const cellWidth = Math.max(1, Math.floor(width / Math.max(columns, cells.length)));
      const children: FragmentId[] = [];
      const childRects: TerminalRect[] = [];
      let maxHeight = 1;
      for (const [index, child] of cells.entries()) {
        const result = this.#layoutNode(child, x + index * cellWidth, y, cellWidth, clip, depth + 1, columns);
        children.push(result.fragment);
        childRects.push(result.rect);
        maxHeight = Math.max(maxHeight, result.rect.height);
      }
      const box = rect(y, x, width, maxHeight);
      const fragment = this.#containerFragment(node, box, intersection(clip, box), children);
      return { fragment: fragment.id, rect: box };
    }
    const children: FragmentId[] = [];
    let currentY = y;
    for (const child of node.children) {
      const result = this.#layoutNode(child, x, currentY, width, clip, depth + 1, columns);
      children.push(result.fragment);
      currentY += result.rect.height;
    }
    const box = rect(y, x, width, Math.max(1, currentY - y));
    const fragment = this.#containerFragment(node, box, intersection(clip, box), children);
    return { fragment: fragment.id, rect: box };
  }

  #columns(
    node: FormattingNode,
    x: number,
    y: number,
    width: number,
    clip: TerminalRect,
    depth: number,
    grid: boolean
  ): LayoutResult {
    const style = this.#boxComputed(node);
    const direction = style?.box.flexDirection ?? "row";
    if (!grid && (direction === "column" || direction === "column-reverse")) return this.#flow(node, x, y, width, clip, depth);
    const marginTop = style === null ? 0 : this.#length(style.box.margin.top, "vertical", this.#input.viewport.rows);
    const marginBottom = style === null ? 0 : this.#length(style.box.margin.bottom, "vertical", this.#input.viewport.rows);
    const marginLeft = style === null ? 0 : this.#length(style.box.margin.left, "horizontal", width);
    const marginRight = style === null ? 0 : this.#length(style.box.margin.right, "horizontal", width);
    const paddingTop = style === null ? 0 : this.#length(style.box.padding.top, "vertical", this.#input.viewport.rows);
    const paddingBottom = style === null ? 0 : this.#length(style.box.padding.bottom, "vertical", this.#input.viewport.rows);
    const paddingLeft = style === null ? 0 : this.#length(style.box.padding.left, "horizontal", width);
    const paddingRight = style === null ? 0 : this.#length(style.box.padding.right, "horizontal", width);
    const border = style?.box.borderStyle === "solid" && style.box.borderWidth.kind !== "zero" ? 1 : 0;
    const availableOuterWidth = Math.max(1, width - marginLeft - marginRight);
    const specifiedWidth = style === null || style.box.width.kind === "auto" ? null : this.#length(style.box.width, "horizontal", width);
    const minimumWidth = style?.box.minWidth.kind === "auto" || style === null ? 0 : this.#length(style.box.minWidth, "horizontal", width);
    const maximumWidth = style === null || style.box.maxWidth.kind === "auto" || style.box.maxWidth.kind === "none"
      ? availableOuterWidth : this.#length(style.box.maxWidth, "horizontal", width);
    const chromeWidth = paddingLeft + paddingRight + border * 2;
    const autoContentWidth = Math.max(1, availableOuterWidth - chromeWidth);
    const contentBoxWidth = Math.max(minimumWidth, Math.min(maximumWidth, specifiedWidth ?? autoContentWidth));
    const outerWidth = Math.max(1, Math.min(availableOuterWidth, contentBoxWidth + chromeWidth));
    const contentX = x + marginLeft + paddingLeft + border;
    const contentY = y + marginTop + paddingTop + border;
    const contentWidth = Math.max(1, outerWidth - paddingLeft - paddingRight - border * 2);
    const specifiedHeight = style?.box.height.kind === "auto" || style === null
      ? 0 : this.#length(style.box.height, "vertical", this.#input.viewport.rows);
    const childClip = this.#clipFor(
      node,
      rect(
        y + marginTop,
        x + marginLeft,
        outerWidth,
        specifiedHeight > 0 ? paddingTop + border + specifiedHeight + paddingBottom + border : this.#budgets.maxRows
      ),
      clip
    );
    const tracks = style?.box.gridTemplateColumns ?? [];
    const count = grid
      ? Math.max(1, tracks.length)
      : Math.max(1, node.children.length);
    const gap = style === null ? 0 : this.#length(style.box.columnGap, "horizontal", contentWidth);
    const availableWidth = Math.max(count, contentWidth - gap * (count - 1));
    const trackWidths = grid && tracks.length > 0
      ? (() => {
        const fixed = tracks.map((track) => {
          if (track.kind === "length") return Math.max(0, this.#length(track.value, "horizontal", contentWidth));
          if (track.kind !== "minmax") return 0;
          if (track.minimum.kind === "length") {
            return Math.max(0, this.#length(track.minimum.value, "horizontal", contentWidth));
          }
          if (track.maximum.kind === "length") {
            return Math.max(0, this.#length(track.maximum.value, "horizontal", contentWidth));
          }
          return 0;
        });
        const fixedTotal = fixed.reduce((total, value) => total + value, 0);
        const weights = tracks.map((track) => {
          if (track.kind === "fraction") return track.value;
          if (track.kind === "auto") return 1;
          if (track.kind === "minmax" && track.maximum.kind === "fraction") return track.maximum.value;
          if (track.kind === "minmax" && track.maximum.kind === "auto") return 1;
          return 0;
        });
        let remainingWeight = weights.reduce((total, value) => total + value, 0);
        let remaining = Math.max(0, availableWidth - fixedTotal);
        return tracks.map((_track, index) => {
          const base = fixed[index] ?? 0;
          const weight = weights[index] ?? 0;
          const share = weight <= 0 ? 0 : Math.max(0, remainingWeight <= weight
            ? remaining
            : Math.floor(remaining * weight / Math.max(remainingWeight, 1)));
          remaining = Math.max(0, remaining - share);
          remainingWeight = Math.max(0, remainingWeight - weight);
          return Math.max(1, base + share);
        });
      })()
      : Array.from({ length: count }, () => Math.max(1, Math.floor(availableWidth / count)));
    const offsets: number[] = [];
    let offset = 0;
    for (const trackWidth of trackWidths) {
      offsets.push(offset);
      offset += trackWidth + gap;
    }
    const children: FragmentId[] = [];
    const childRects: TerminalRect[] = [];
    if (grid) {
      let currentY = contentY;
      const rowGap = style === null ? 0 : this.#length(style.box.rowGap, "vertical", this.#input.viewport.rows);
      for (let rowStart = 0; rowStart < node.children.length; rowStart += count) {
        let rowBottom = currentY + 1;
        const rowChildren = node.children.slice(rowStart, rowStart + count);
        const rowEntries = rowChildren.map((child, rowIndex) => {
          const requestedColumn = this.#computed(this.#formatting.node(child))?.box.gridColumn;
          const column = Math.max(0, Math.min(count - 1, (requestedColumn ?? rowIndex + 1) - 1));
          const trackWidth = trackWidths[column] ?? 1;
          return { child, column, trackWidth, estimatedHeight: this.#estimatedHeight(child, trackWidth) };
        });
        const rowHeight = rowEntries.reduce(
          (maximum, entry) => Math.max(maximum, entry.estimatedHeight),
          1
        );
        for (const entry of rowEntries) {
          const rowOffset = style?.box.alignItems === "center"
            ? Math.floor((rowHeight - entry.estimatedHeight) / 2)
            : style?.box.alignItems === "end" ? rowHeight - entry.estimatedHeight : 0;
          const result = this.#layoutNode(
            entry.child,
            contentX + (offsets[entry.column] ?? 0),
            currentY + rowOffset,
            entry.trackWidth,
            childClip,
            depth + 1
          );
          children.push(result.fragment);
          childRects.push(result.rect);
          rowBottom = Math.max(rowBottom, result.rect.row + result.rect.height);
        }
        currentY = rowBottom + rowGap;
      }
    } else {
      const orderedChildren = direction === "row-reverse" ? [...node.children].reverse() : node.children;
      const lines: { readonly child: FormattingNodeId; readonly basis: number }[][] = [];
      let line: { readonly child: FormattingNodeId; readonly basis: number }[] = [];
      let occupied = 0;
      for (const child of orderedChildren) {
        const basis = this.#flexBasis(child, contentWidth);
        const next = occupied + (line.length === 0 ? 0 : gap) + basis;
        if (style?.box.flexWrap !== "nowrap" && line.length > 0 && next > contentWidth) {
          lines.push(line);
          line = [];
          occupied = 0;
        }
        line.push({ child, basis });
        occupied += (line.length === 1 ? 0 : gap) + basis;
      }
      if (line.length > 0) lines.push(line);
      if (style?.box.flexWrap === "wrap-reverse") lines.reverse();
      const rowGap = style === null ? 0 : this.#length(style.box.rowGap, "vertical", this.#input.viewport.rows);
      let currentY = contentY;
      for (const [lineIndex, entries] of lines.entries()) {
        const estimates = entries.map((entry) => this.#estimatedHeight(entry.child, entry.basis));
        const lineHeight = estimates.reduce((maximum, height) => Math.max(maximum, height), 1);
        const required = entries.reduce((total, entry) => total + entry.basis, 0)
          + gap * Math.max(0, entries.length - 1);
        const spare = Math.max(0, contentWidth - required);
        let currentX = contentX + (style?.box.justifyContent === "center"
          ? Math.floor(spare / 2)
          : style?.box.justifyContent === "end" ? spare : 0);
        const between = style?.box.justifyContent === "space-between" && entries.length > 1
          ? gap + Math.floor(spare / (entries.length - 1))
          : gap;
        let actualBottom = currentY + lineHeight;
        for (const [entryIndex, entry] of entries.entries()) {
          const estimate = estimates[entryIndex] ?? 1;
          const rowOffset = style?.box.alignItems === "center"
            ? Math.floor((lineHeight - estimate) / 2)
            : style?.box.alignItems === "end" ? lineHeight - estimate : 0;
          const result = this.#layoutNode(
            entry.child,
            currentX,
            currentY + rowOffset,
            entry.basis,
            childClip,
            depth + 1
          );
          children.push(result.fragment);
          childRects.push(result.rect);
          actualBottom = Math.max(actualBottom, result.rect.row + result.rect.height);
          currentX += entry.basis + between;
        }
        currentY = actualBottom + (lineIndex < lines.length - 1 ? rowGap : 0);
      }
    }
    const childBottom = childRects.reduce(
      (bottom, child) => Math.max(bottom, child.row + child.height),
      contentY
    );
    const minimumHeight = style === null ? 0 : this.#length(style.box.minHeight, "vertical", this.#input.viewport.rows);
    const contentHeight = Math.max(1, specifiedHeight, minimumHeight, childBottom - contentY);
    const box = rect(
      y + marginTop,
      x + marginLeft,
      outerWidth,
      paddingTop + border + contentHeight + paddingBottom + border
    );
    const fragment = this.#containerFragment(node, box, this.#clipFor(node, box, clip), children);
    return { fragment: fragment.id, rect: rect(box.row, box.column, box.width, box.height + marginBottom) };
  }

  #layoutNode(
    id: FormattingNodeId,
    x: number,
    y: number,
    width: number,
    clip: TerminalRect,
    depth: number,
    tableColumns?: number
  ): LayoutResult {
    this.#input.signal?.throwIfAborted();
    if (depth > this.#budgets.maxDepth) {
      this.#truncated ??= "maxDepth";
      const node = this.#formatting.node(id);
      const box = rect(y, x, 0, 0);
      const fragment = this.#containerFragment(node, box, intersection(clip, box), []);
      return { fragment: fragment.id, rect: box };
    }
    const node = this.#formatting.node(id);
    if (this.#visuallyClipped(node, width)) return this.#clippedFragment(node, x, y, clip);
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker"
      || node.kind === "forced-line-break" || node.kind === "form-control"
      || node.kind === "replaced-element" || node.kind === "image-fallback") {
      const cursor: InlineCursor = {
        startColumn: x,
        continuationColumn: x,
        maxColumn: x + width,
        row: y,
        column: x,
        maxRow: y,
        collapsedSpace: false
      };
      return this.#layoutInline(id, cursor, clip, depth + 1);
    }
    if (node.kind === "table-column" || node.kind === "table-column-group") {
      const children = node.children.map((child) =>
        this.#layoutNode(child, x, y, 0, clip, depth + 1, tableColumns).fragment
      );
      const box = rect(y, x, 0, 0);
      const fragment = this.#containerFragment(node, box, intersection(clip, box), children);
      return { fragment: fragment.id, rect: box };
    }
    if (node.kind === "table" || node.kind === "table-header-group" || node.kind === "table-body-group"
      || node.kind === "table-footer-group" || node.kind === "table-row") {
      return this.#table(node, x, y, width, clip, depth, tableColumns);
    }
    if (node.kind === "flex-container") return this.#columns(node, x, y, width, clip, depth, false);
    if (node.kind === "grid-container") return this.#columns(node, x, y, width, clip, depth, true);
    return this.#flow(node, x, y, width, clip, depth);
  }

  #rows(rootHeight: number): readonly TerminalRow[] {
    const placementsByRow = new Map<number, Placement[]>();
    let placementRows = 1;
    for (const placement of this.#placements) {
      placementRows = Math.max(placementRows, placement.row + 1);
      const entries = placementsByRow.get(placement.row) ?? [];
      entries.push(placement);
      placementsByRow.set(placement.row, entries);
    }
    const count = Math.min(this.#budgets.maxRows, Math.max(rootHeight, placementRows, 1));
    if (rootHeight > this.#budgets.maxRows) this.#truncated ??= "maxRows";
    const rows: TerminalRow[] = [];
    for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
      const placements = (placementsByRow.get(rowIndex) ?? [])
        .sort((left, right) => left.paintOrder - right.paintOrder);
      let text = "";
      let cellColumn = 0;
      const fragments: TerminalRowFragment[] = [];
      const styles: TerminalRowStyleRun[] = [];
      const units: PaintUnit[] = [];
      const ownerByCell = new Map<number, PaintUnit>();
      for (const placement of placements) {
        if (rowIndex < placement.clip.row || rowIndex >= placement.clip.row + placement.clip.height) continue;
        const clipStart = Math.max(placement.column, placement.clip.column);
        const clipEnd = Math.min(
          placement.column + placement.width,
          placement.clip.column + placement.clip.width,
          this.#input.viewport.columns
        );
        if (clipEnd <= clipStart) continue;
        let sourceCell = placement.column;
        for (const grapheme of this.#input.measurer.graphemes(placement.text)) {
          const startCell = sourceCell;
          const endCell = startCell + grapheme.cells;
          sourceCell = endCell;
          if (grapheme.cells <= 0 || startCell < clipStart || endCell > clipEnd) continue;
          const unit: PaintUnit = {
            placement,
            column: startCell,
            width: grapheme.cells,
            text: grapheme.text,
            startCodeUnit: grapheme.startCodeUnit,
            endCodeUnit: grapheme.endCodeUnit
          };
          units.push(unit);
          for (let cell = startCell; cell < endCell; cell += 1) ownerByCell.set(cell, unit);
        }
      }
      const visible = units.filter((unit) => {
        for (let cell = unit.column; cell < unit.column + unit.width; cell += 1) {
          if (ownerByCell.get(cell) !== unit) return false;
        }
        return true;
      }).sort((left, right) => left.column - right.column || left.placement.paintOrder - right.placement.paintOrder);
      for (let unitIndex = 0; unitIndex < visible.length;) {
        const first = visible[unitIndex];
        if (first === undefined) break;
        let visibleText = first.text;
        let visibleWidth = first.width;
        let visibleEndCodeUnit = first.endCodeUnit;
        let nextIndex = unitIndex + 1;
        while (nextIndex < visible.length) {
          const next = visible[nextIndex];
          if (next === undefined || next.placement !== first.placement
            || next.column !== first.column + visibleWidth
            || next.startCodeUnit !== visibleEndCodeUnit) break;
          visibleText += next.text;
          visibleWidth += next.width;
          visibleEndCodeUnit = next.endCodeUnit;
          nextIndex += 1;
        }
        const gap = Math.max(0, first.column - cellColumn);
        if (gap > 0) {
          text += " ".repeat(gap);
          cellColumn += gap;
        }
        const start = text.length;
        text += visibleText;
        const end = text.length;
        const placement = first.placement;
        const visibleSourceRange = placement.sourceRange !== null
          && placement.sourceRange.end - placement.sourceRange.start === placement.text.length
          ? Object.freeze({
              start: placement.sourceRange.start + first.startCodeUnit,
              end: placement.sourceRange.start + visibleEndCodeUnit,
              provenance: placement.sourceRange.provenance
            })
          : placement.sourceRange;
        fragments.push(Object.freeze({
          fragment: placement.fragment,
          formatting: placement.formatting,
          source: placement.source,
          sourceRange: visibleSourceRange,
          startCodeUnit: start,
          endCodeUnit: end,
          column: first.column,
          width: visibleWidth
        }));
        styles.push(Object.freeze({ startCodeUnit: start, endCodeUnit: end, style: placement.style }));
        cellColumn = first.column + visibleWidth;
        unitIndex = nextIndex;
      }
      rows.push(Object.freeze({
        row: rowIndex,
        text,
        fragments: Object.freeze(fragments),
        styles: Object.freeze(styles)
      }));
    }
    return Object.freeze(rows);
  }

  public build(): FragmentTree {
    const colorDepth: unknown = this.#input.profile.colorDepth;
    const unicode: unknown = this.#input.profile.unicode;
    const ambiguousWidth: unknown = this.#input.profile.ambiguousWidth;
    const viewportValid = Number.isSafeInteger(this.#input.viewport.columns) && this.#input.viewport.columns > 0
      && Number.isSafeInteger(this.#input.viewport.rows) && this.#input.viewport.rows > 0;
    const profileValid = Number.isFinite(this.#input.profile.cellWidthPx) && this.#input.profile.cellWidthPx > 0
      && Number.isFinite(this.#input.profile.rowHeightPx) && this.#input.profile.rowHeightPx > 0
      && (colorDepth === 0 || colorDepth === 4 || colorDepth === 8 || colorDepth === 24)
      && typeof unicode === "boolean"
      && (ambiguousWidth === 1 || ambiguousWidth === 2);
    if (!viewportValid || !profileValid) {
      return ImmutableFragmentTree.rejected(
        this.#input,
        viewportValid ? "invalid-profile" : "invalid-viewport"
      );
    }
    let rootResult: LayoutResult;
    try {
      rootResult = this.#layoutNode(
        this.#formatting.root,
        0,
        0,
        this.#input.viewport.columns,
        this.#viewportClip,
        0
      );
    } catch (error) {
      if (!(error instanceof FragmentBudgetExhausted)) throw error;
      this.#fragments.clear();
      this.#placements.length = 0;
      this.#sourceIndex.clear();
      this.#hitRegions.length = 0;
      this.#anchors.length = 0;
      this.#accessibility.length = 0;
      this.#fragmentOrdinals.clear();
      this.#visualOrder = 0;
      this.#paintOrder = 0;
      this.#paintCells = 0;
      const rootNode = this.#formatting.node(this.#formatting.root);
      const box = rect(0, 0, this.#input.viewport.columns, 1);
      const fragment = this.#containerFragment(rootNode, box, intersection(this.#viewportClip, box), []);
      rootResult = { fragment: fragment.id, rect: box };
    }
    const rows = this.#rows(rootResult.rect.height);
    this.#projectUnboxedAccessibility();
    const focusByNode = new Map<DocumentNodeRef, { action: TerminalAction; fragments: FragmentId[]; rects: TerminalRect[] }>();
    for (const hit of this.#hitRegions) {
      const current = focusByNode.get(hit.action.node) ?? { action: hit.action, fragments: [], rects: [] };
      current.fragments.push(hit.fragment);
      current.rects.push(hit.rect);
      focusByNode.set(hit.action.node, current);
    }
    const focusTargets: TerminalFocusTarget[] = [...focusByNode.entries()].map(([node, value]) => Object.freeze({
      node,
      action: value.action,
      fragments: Object.freeze(value.fragments),
      rects: Object.freeze(value.rects),
      label: (() => {
        const summary = this.#formatting.document.disclosure(node)?.summary;
        return summary === undefined || summary === null
          ? this.#formatting.document.semantic(node)?.accessibleName || "Action"
          : this.#formatting.document.text(summary) || "Disclosure";
      })()
    }));
    const outcome: FragmentOutcome = this.#truncated === null
      ? { status: "complete", fragments: this.#fragments.size, rows: rows.length }
      : {
          status: "truncated",
          fragments: this.#fragments.size,
          rows: rows.length,
          budget: this.#truncated,
          limit: this.#budgets[this.#truncated]
        };
    return new ImmutableFragmentTree(
      this.#input,
      rootResult.fragment,
      this.#fragments,
      this.#sourceIndex,
      rows,
      this.#hitRegions,
      focusTargets,
      this.#anchors,
      this.#accessibility,
      outcome,
      this.#budgets.maxSearchMatches
    );
  }
}

class ImmutableFragmentTree implements FragmentTree {
  readonly formatting: FormattingTree;
  readonly viewport: BuildFragmentTreeInput["viewport"];
  readonly profile: BuildFragmentTreeInput["profile"];
  readonly root: FragmentId;
  readonly rows: readonly TerminalRow[];
  readonly hitRegions: readonly TerminalHitRegion[];
  readonly focusTargets: readonly TerminalFocusTarget[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
  readonly accessibility: readonly TerminalAccessibilityNode[];
  readonly outcome: FragmentOutcome;
  readonly #fragments: ReadonlyMap<FragmentId, TerminalFragment>;
  readonly #parents: ReadonlyMap<FragmentId, FragmentId>;
  readonly #sourceIndex: ReadonlyMap<DocumentNodeRef, readonly FragmentId[]>;
  readonly #maxSearchMatches: number;

  public constructor(
    input: BuildFragmentTreeInput,
    root: FragmentId,
    fragments: ReadonlyMap<FragmentId, TerminalFragment>,
    sourceIndex: ReadonlyMap<DocumentNodeRef, readonly FragmentId[]>,
    rows: readonly TerminalRow[],
    hitRegions: readonly TerminalHitRegion[],
    focusTargets: readonly TerminalFocusTarget[],
    anchors: readonly TerminalScrollAnchor[],
    accessibility: readonly TerminalAccessibilityNode[],
    outcome: FragmentOutcome,
    maxSearchMatches: number
  ) {
    this.formatting = input.formatting;
    this.viewport = Object.freeze({ ...input.viewport });
    this.profile = Object.freeze({ ...input.profile });
    this.root = root;
    this.#fragments = fragments;
    this.#sourceIndex = sourceIndex;
    this.rows = Object.freeze([...rows]);
    this.hitRegions = Object.freeze([...hitRegions]);
    this.focusTargets = Object.freeze([...focusTargets]);
    this.scrollAnchors = Object.freeze([...anchors]);
    this.accessibility = Object.freeze([...accessibility]);
    this.outcome = Object.freeze(outcome);
    this.#maxSearchMatches = maxSearchMatches;
    const parents = new Map<FragmentId, FragmentId>();
    for (const fragment of fragments.values()) {
      for (const child of fragment.children) parents.set(child, fragment.id);
    }
    this.#parents = parents;
    Object.freeze(this);
  }

  public static rejected(input: BuildFragmentTreeInput, reason: "invalid-viewport" | "invalid-profile"): FragmentTree {
    const id = fragmentId("fragment:rejected");
    const empty = new Map<FragmentId, TerminalFragment>();
    empty.set(id, Object.freeze({
      id,
      kind: "container",
      formatting: input.formatting.root,
      source: null,
      sourceRange: null,
      rect: rect(0, 0, 0, 0),
      clip: rect(0, 0, 0, 0),
      children: Object.freeze([]),
      visualOrder: 0,
      paintOrder: 0,
      action: null,
      semantic: null
    }));
    return new ImmutableFragmentTree(
      input, id, empty, new Map(), [], [], [], [], [],
      { status: "rejected", reason },
      DEFAULT_FRAGMENT_BUDGETS.maxSearchMatches
    );
  }

  public fragment(id: FragmentId): TerminalFragment {
    const fragment = this.#fragments.get(id);
    if (fragment === undefined) throw new RangeError(`Unknown terminal fragment: ${id}`);
    return fragment;
  }

  public parent(id: FragmentId): TerminalFragment | null {
    const parent = this.#parents.get(id);
    return parent === undefined ? null : this.fragment(parent);
  }

  public children(id: FragmentId): readonly TerminalFragment[] {
    return this.fragment(id).children.map((child) => this.fragment(child));
  }

  public forSource(source: DocumentNodeRef): readonly TerminalFragment[] {
    return (this.#sourceIndex.get(source) ?? []).map((id) => this.fragment(id));
  }

  public hitTest(row: number, column: number): TerminalHitRegion | null {
    for (let index = this.hitRegions.length - 1; index >= 0; index -= 1) {
      const hit = this.hitRegions[index];
      if (hit !== undefined
        && row >= hit.rect.row && row < hit.rect.row + hit.rect.height
        && column >= hit.rect.column && column < hit.rect.column + hit.rect.width) return hit;
    }
    return null;
  }

  public search(query: string): TerminalSearchResult {
    const normalized = query.toLowerCase().slice(0, 1_024);
    if (normalized.length === 0) {
      return Object.freeze({ query, ranges: Object.freeze([]), truncated: false });
    }
    const ranges: TerminalSearchRange[] = [];
    let truncated = false;
    for (const row of this.rows) {
      const folded = transformTextWithSourceMap(row.text, "lowercase");
      const haystack = folded.value;
      let start = 0;
      while (start <= haystack.length - normalized.length) {
        const index = haystack.indexOf(normalized, start);
        if (index < 0) break;
        const foldedEnd = index + normalized.length;
        const [originalStart, originalEnd] = mappedSourceRange(folded, index, foldedEnd);
        const overlapping = row.fragments.filter((fragment) =>
          originalStart < fragment.endCodeUnit && originalEnd > fragment.startCodeUnit
        );
        const candidateFragment = overlapping[0];
        const rowFragment = overlapping.length === 1
          && candidateFragment !== undefined
          && candidateFragment.startCodeUnit <= originalStart
          && candidateFragment.endCodeUnit >= originalEnd
          ? candidateFragment
          : undefined;
        const sourceRange = rowFragment?.sourceRange !== null
          && rowFragment?.sourceRange !== undefined
          && rowFragment.sourceRange.end - rowFragment.sourceRange.start
            === rowFragment.endCodeUnit - rowFragment.startCodeUnit
          ? Object.freeze({
              start: rowFragment.sourceRange.start + originalStart - rowFragment.startCodeUnit,
              end: rowFragment.sourceRange.start + originalEnd - rowFragment.startCodeUnit,
              provenance: rowFragment.sourceRange.provenance
            })
          : rowFragment?.sourceRange ?? null;
        ranges.push(Object.freeze({
          row: row.row,
          startCodeUnit: originalStart,
          endCodeUnit: originalEnd,
          fragment: rowFragment?.fragment ?? null,
          source: rowFragment?.source ?? null,
          sourceRange
        }));
        if (ranges.length >= this.#maxSearchMatches) {
          truncated = true;
          return Object.freeze({ query, ranges: Object.freeze(ranges), truncated });
        }
        start = Math.max(foldedEnd, index + 1);
      }
    }
    return Object.freeze({ query, ranges: Object.freeze(ranges), truncated });
  }
}

export function buildFragmentTree(input: BuildFragmentTreeInput): FragmentTree {
  return new FragmentBuilder(input).build();
}
