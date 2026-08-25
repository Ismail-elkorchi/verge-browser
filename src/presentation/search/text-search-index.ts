import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import type {
  FormattingNode,
  FormattingNodeId,
  FormattingTree
} from "../formatting/index.js";
import { formattingNodeLogicalText } from "../formatting/index.js";
import { transformTextWithSourceRanges, transformedSourceRange } from "../text/index.js";

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

export interface TextSearchIndex {
  readonly text: string;
  search(query: string, limit: number): TextSearchResult;
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

function foldedBoundaries(value: string, targets: readonly number[]): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  let originalOffset = 0;
  let foldedOffset = 0;
  let targetIndex = 0;
  while (targetIndex < targets.length && targets[targetIndex] === 0) {
    result.set(0, 0);
    targetIndex += 1;
  }
  for (const codePoint of value) {
    const foldedLength = codePoint.toLowerCase().length;
    const nextFolded = foldedOffset + foldedLength;
    const nextOriginal = originalOffset + codePoint.length;
    while (targetIndex < targets.length && (targets[targetIndex] ?? Number.POSITIVE_INFINITY) <= nextFolded) {
      const target = targets[targetIndex];
      if (target !== undefined) result.set(target, target === foldedOffset ? originalOffset : nextOriginal);
      targetIndex += 1;
    }
    originalOffset = nextOriginal;
    foldedOffset = nextFolded;
  }
  for (; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (target !== undefined) result.set(target, value.length);
  }
  return result;
}

class ImmutableTextSearchIndex implements TextSearchIndex {
  readonly text: string;
  readonly #segments: readonly TextSearchSegment[];

  public constructor(text: string, segments: readonly TextSearchSegment[]) {
    this.text = text;
    this.#segments = Object.freeze(segments.map((segment) => Object.freeze(segment)));
    Object.freeze(this);
  }

  public search(query: string, limit: number): TextSearchResult {
    const needle = query.toLowerCase().replace(/\s+/gu, " ").trim().slice(0, 1_024);
    if (needle.length === 0) return Object.freeze({ matches: Object.freeze([]), truncated: false });
    const haystack = this.text.toLowerCase();
    const foldedMatches: { readonly start: number; readonly end: number }[] = [];
    let cursor = 0;
    let truncated = false;
    while (cursor <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, cursor);
      if (start < 0) break;
      if (foldedMatches.length >= limit) {
        truncated = true;
        break;
      }
      foldedMatches.push({ start, end: start + needle.length });
      cursor = Math.max(start + needle.length, start + 1);
    }
    const targets = [...new Set(foldedMatches.flatMap((match) => [match.start, match.end]))]
      .sort((left, right) => left - right);
    const boundaries = foldedBoundaries(this.text, targets);
    const matches = foldedMatches.map((folded): TextSearchMatch => {
      const start = boundaries.get(folded.start) ?? 0;
      const end = boundaries.get(folded.end) ?? this.text.length;
      const slices: TextSearchMatchSlice[] = [];
      for (const segment of this.#segments) {
        if (segment.formatting === null || start >= segment.end || end <= segment.start) continue;
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

export function buildTextSearchIndex(tree: FormattingTree, signal?: AbortSignal): TextSearchIndex {
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
  const appendRenderedText = (node: FormattingNode, raw: string): void => {
    const style = node.styleNode === null ? null : node.pseudo === null
      ? tree.styles.style(node.styleNode)
      : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
    if (style?.visibility !== "visible") return;
    const mapped = transformTextWithSourceRanges(raw, style.text.textTransform);
    for (const match of mapped.value.matchAll(/\s+|\S+/gu)) {
      const value = match[0];
      const start = match.index;
      const end = start + value.length;
      const [contentStart, contentEnd] = transformedSourceRange(mapped, start, end);
      const segment = nodeSegment(node, contentStart, contentEnd);
      if (/^\s+$/u.test(value)) separator(segment);
      else append(value, segment);
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
      if (node.outer === "block") separator(nodeSegment(node, 0, 0));
      continue;
    }
    if (node.outer === "block") separator(nodeSegment(node, 0, 0));
    const logicalText = formattingNodeLogicalText(node, tree);
    if (logicalText !== null) {
      appendRenderedText(node, logicalText);
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
