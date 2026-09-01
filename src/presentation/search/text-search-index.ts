import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import type {
  FormattingNode,
  FormattingNodeId,
  FormattingTree
} from "../formatting/index.js";
import { formattingNodeLogicalText } from "../formatting/index.js";
import type { InlineItemStreamSet } from "../text/index.js";
import type { LayoutFragmentId, LayoutFragmentTree } from "../layout/index.js";

export type TextSearchMatchId = string & { readonly __textSearchMatchId: unique symbol };

export interface TextSearchMatchSlice {
  readonly formatting: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface TextSearchMatch {
  readonly id: TextSearchMatchId;
  readonly start: number;
  readonly end: number;
  readonly slices: readonly TextSearchMatchSlice[];
}

export interface TextSearchResult {
  readonly matches: readonly TextSearchMatch[];
  readonly truncated: boolean;
}

export interface TextSearchLayoutSpan {
  readonly match: TextSearchMatchId;
  readonly fragment: LayoutFragmentId;
  readonly documentNode: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
}

export interface TextSearchLayoutProjection {
  readonly query: string;
  readonly matches: readonly TextSearchMatch[];
  readonly truncated: boolean;
  readonly spans: readonly TextSearchLayoutSpan[];
  readonly spansByFragment: ReadonlyMap<LayoutFragmentId, readonly TextSearchLayoutSpan[]>;
}

export interface TextSearchIndex {
  readonly text: string;
  search(query: string, limit: number, signal?: AbortSignal): TextSearchResult;
}

interface TextSearchSegment {
  readonly start: number;
  readonly end: number;
  readonly formatting: FormattingNodeId | null;
  readonly source: DocumentNodeRef | null;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly sourceRange: DocumentSourceRange | null;
}

function foldText(value: string): {
  readonly text: string;
  readonly originalBoundaryByFoldedOffset: Uint32Array;
} {
  const parts: string[] = [];
  const boundaries: number[] = [0];
  let originalOffset = 0;
  for (const codePoint of value) {
    const folded = codePoint.toLowerCase();
    parts.push(folded);
    const nextOriginal = originalOffset + codePoint.length;
    for (let offset = 0; offset < folded.length; offset += 1) boundaries.push(nextOriginal);
    originalOffset = nextOriginal;
  }
  return Object.freeze({
    text: parts.join(""),
    originalBoundaryByFoldedOffset: Uint32Array.from(boundaries),
  });
}

class ImmutableTextSearchIndex implements TextSearchIndex {
  readonly text: string;
  readonly #segments: readonly TextSearchSegment[];
  readonly #foldedText: string;
  readonly #originalBoundaryByFoldedOffset: Uint32Array;

  public constructor(
    text: string,
    segments: readonly TextSearchSegment[]
  ) {
    this.text = text;
    this.#segments = Object.freeze(segments.map((segment) => Object.freeze(segment)));
    const folded = foldText(text);
    this.#foldedText = folded.text;
    this.#originalBoundaryByFoldedOffset = folded.originalBoundaryByFoldedOffset;
    Object.freeze(this);
  }

  public search(query: string, limit: number, signal?: AbortSignal): TextSearchResult {
    const needle = query.toLowerCase().replace(/\s+/gu, " ").trim().slice(0, 1_024);
    if (needle.length === 0) return Object.freeze({ matches: Object.freeze([]), truncated: false });
    const foldedMatches: { readonly start: number; readonly end: number }[] = [];
    let cursor = 0;
    let truncated = false;
    while (cursor <= this.#foldedText.length - needle.length) {
      if ((foldedMatches.length & 255) === 0) signal?.throwIfAborted();
      const start = this.#foldedText.indexOf(needle, cursor);
      if (start < 0) break;
      if (foldedMatches.length >= limit) {
        truncated = true;
        break;
      }
      foldedMatches.push({ start, end: start + needle.length });
      cursor = Math.max(start + needle.length, start + 1);
    }
    const matches = foldedMatches.map((folded, matchIndex): TextSearchMatch => {
      if ((matchIndex & 255) === 0) signal?.throwIfAborted();
      const start = this.#originalBoundaryByFoldedOffset[folded.start] ?? 0;
      const end = this.#originalBoundaryByFoldedOffset[folded.end] ?? this.text.length;
      const slices: TextSearchMatchSlice[] = [];
      let lower = 0;
      let upper = this.#segments.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if ((this.#segments[middle]?.end ?? Number.POSITIVE_INFINITY) <= start) lower = middle + 1;
        else upper = middle;
      }
      for (let segmentIndex = lower; segmentIndex < this.#segments.length; segmentIndex += 1) {
        const segment = this.#segments[segmentIndex];
        if (segment === undefined || segment.start >= end) break;
        if (segment.formatting === null || end <= segment.start) continue;
        const overlapStart = Math.max(start, segment.start);
        const overlapEnd = Math.min(end, segment.end);
        const segmentLength = segment.end - segment.start;
        const contentLength = segment.contentEnd - segment.contentStart;
        const exact = segmentLength === contentLength;
        const contentStart = exact
          ? segment.contentStart + overlapStart - segment.start
          : segment.contentStart;
        const contentEnd = exact
          ? segment.contentStart + overlapEnd - segment.start
          : segment.contentEnd;
        let sourceRange = segment.sourceRange;
        if (sourceRange !== null && exact && sourceRange.end - sourceRange.start === contentLength) {
          sourceRange = Object.freeze({
            start: sourceRange.start + contentStart - segment.contentStart,
            end: sourceRange.start + contentEnd - segment.contentStart,
            provenance: sourceRange.provenance
          });
        }
        slices.push(Object.freeze({
          formatting: segment.formatting,
          source: segment.source,
          sourceRange,
          contentStart,
          contentEnd
        }));
      }
      return Object.freeze({
        id: `text-search:${String(start)}:${String(end)}` as TextSearchMatchId,
        start,
        end,
        slices: Object.freeze(slices)
      });
    });
    return Object.freeze({ matches: Object.freeze(matches), truncated });
  }
}

export function buildTextSearchIndex(
  tree: FormattingTree,
  inlineItemStreams: InlineItemStreamSet,
  signal?: AbortSignal
): TextSearchIndex {
  if (inlineItemStreams.formatting !== tree) {
    throw new RangeError("Inline item streams and text search must use the same box tree.");
  }
  const parts: string[] = [];
  const segments: TextSearchSegment[] = [];
  let length = 0;
  let pendingSeparator: Omit<TextSearchSegment, "start" | "end"> | null = null;
  const append = (
    value: string,
    segment: Omit<TextSearchSegment, "start" | "end">
  ): void => {
    if (value.length === 0) return;
    if (pendingSeparator !== null && length > 0) {
      parts.push(" ");
      segments.push({ ...pendingSeparator, start: length, end: length + 1 });
      length += 1;
      pendingSeparator = null;
    }
    parts.push(value);
    segments.push({ ...segment, start: length, end: length + value.length });
    length += value.length;
  };
  const separator = (segment: Omit<TextSearchSegment, "start" | "end">): void => {
    if (length > 0) pendingSeparator = segment;
  };
  const nodeSegment = (
    node: FormattingNode,
    contentStart: number,
    contentEnd: number
  ): Omit<TextSearchSegment, "start" | "end"> => {
    let sourceRange = node.sourceRange;
    if (node.kind === "text-sequence" && node.source !== null) {
      sourceRange = tree.document.textSourceRange(node.source, contentStart, contentEnd);
    }
    return {
      formatting: node.id,
      source: node.source,
      contentStart,
      contentEnd,
      sourceRange
    };
  };
  const appendRenderedText = (node: FormattingNode): void => {
    const style = node.styleNode === null ? null : node.pseudo === null
      ? tree.styles.style(node.styleNode)
      : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
    if (style === null) return;
    const processed = inlineItemStreams.textForFormattingNode(node.id);
    if (processed === null || processed.outcome.status !== "complete") {
      throw new RangeError("Inline item streams do not contain logical text for a retained formatting node.");
    }
    if (style.visibility !== "visible") return;
    for (const unit of processed.units) {
      const segment = nodeSegment(node, unit.contentStartCodeUnit, unit.contentEndCodeUnit);
      if (unit.kind === "soft-hyphen") continue;
      if (unit.kind === "forced-break" || unit.kind === "tab" || unit.collapsibleSpace) separator(segment);
      else append(unit.text, segment);
    }
  };
  const pending: ({ readonly phase: "enter"; readonly id: FormattingNodeId }
    | { readonly phase: "exit"; readonly id: FormattingNodeId })[] = [
      { phase: "enter", id: tree.root }
    ];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = tree.node(entry.id);
    if (entry.phase === "exit") {
      if (node.outer === "block") {
        separator(nodeSegment(node, 0, 0));
      }
      continue;
    }
    if (node.outer === "block") {
      separator(nodeSegment(node, 0, 0));
    }
    const logicalText = formattingNodeLogicalText(node, tree);
    if (logicalText !== null) {
      appendRenderedText(node);
      continue;
    }
    if (node.kind === "forced-line-break") {
      separator(nodeSegment(node, 0, 0));
      continue;
    }
    pending.push({ phase: "exit", id: node.id });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push({ phase: "enter", id: child });
    }
  }
  return new ImmutableTextSearchIndex(parts.join(""), segments);
}

/** Maps logical search matches to the visual text fragments created by layout. */
export function mapTextSearchMatchesToLayout(
  index: TextSearchIndex,
  layout: LayoutFragmentTree,
  query: string,
  limit: number,
  signal?: AbortSignal,
): readonly TextSearchLayoutSpan[] {
  return projectTextSearchToLayout(index, layout, query, limit, signal).spans;
}

/** Retains one logical query and its fragment mapping for viewport projection. */
export function projectTextSearchToLayout(
  index: TextSearchIndex,
  layout: LayoutFragmentTree,
  query: string,
  limit: number,
  signal?: AbortSignal,
): TextSearchLayoutProjection {
  const spans: TextSearchLayoutSpan[] = [];
  const logical = index.search(query, limit, signal);
  for (const [matchIndex, match] of logical.matches.entries()) {
    if ((matchIndex & 255) === 0) signal?.throwIfAborted();
    for (const slice of match.slices) {
      for (const fragment of layout.forFormattingNode(slice.formatting)) {
        const fragmentStart = fragment.contentStartCodeUnit;
        const fragmentEnd = fragment.contentEndCodeUnit;
        if (fragmentStart === null || fragmentEnd === null
          || !(fragment.kind === "text" || (fragment.visualClusters?.length ?? 0) > 0)
          || slice.contentStart >= fragmentEnd || slice.contentEnd <= fragmentStart) continue;
        const contentStartCodeUnit = Math.max(slice.contentStart, fragmentStart);
        const contentEndCodeUnit = Math.min(slice.contentEnd, fragmentEnd);
        let sourceRange: DocumentSourceRange | null = slice.sourceRange;
        if (sourceRange !== null && fragment.sourceRange !== null) {
          const start = Math.max(sourceRange.start, fragment.sourceRange.start);
          const end = Math.min(sourceRange.end, fragment.sourceRange.end);
          sourceRange = end > start
            ? Object.freeze({ start, end, provenance: sourceRange.provenance })
            : null;
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
  const spansByFragment = new Map<LayoutFragmentId, TextSearchLayoutSpan[]>();
  for (const span of spans) {
    const retained = spansByFragment.get(span.fragment) ?? [];
    retained.push(span);
    spansByFragment.set(span.fragment, retained);
  }
  return Object.freeze({
    query,
    matches: logical.matches,
    truncated: logical.truncated,
    spans: Object.freeze(spans),
    spansByFragment: new Map([...spansByFragment].map(([fragment, values]) => [
      fragment,
      Object.freeze(values),
    ])),
  });
}
