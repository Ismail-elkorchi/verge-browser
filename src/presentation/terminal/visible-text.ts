import type { DocumentNodeRef, DocumentSourceRange } from "../../document/index.js";
import type {
  FormattingFormControlNode,
  FormattingNode,
  FormattingNodeId,
  FormattingTree
} from "../formatting/index.js";

export type VisibleTextMatchId = string & { readonly __visibleTextMatchId: unique symbol };

export interface VisibleTextMatchSlice {
  readonly formatting: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface VisibleTextMatch {
  readonly id: VisibleTextMatchId;
  readonly start: number;
  readonly end: number;
  readonly slices: readonly VisibleTextMatchSlice[];
}

export interface VisibleTextSearchResult {
  readonly matches: readonly VisibleTextMatch[];
  readonly truncated: boolean;
}

export interface VisibleTextIndex {
  readonly text: string;
  search(query: string, limit: number): VisibleTextSearchResult;
}

interface VisibleTextSegment {
  readonly start: number;
  readonly end: number;
  readonly formatting: FormattingNodeId | null;
  readonly source: DocumentNodeRef | null;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly sourceRange: DocumentSourceRange | null;
}

interface MappedText {
  readonly value: string;
  readonly units: readonly { readonly start: number; readonly end: number }[];
}

function transformedText(
  value: string,
  transform: "none" | "uppercase" | "lowercase" | "capitalize"
): MappedText {
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

export function presentedControlText(
  node: FormattingFormControlNode,
  tree: FormattingTree
): { readonly label: string; readonly value: string; readonly text: string } {
  const control = node.control;
  const state = tree.state.controls.get(control.node);
  if (control.kind === "text" || control.kind === "textarea") {
    const value = state?.values[0] ?? control.defaultValue;
    return { label: control.label, value, text: `${control.label}: ${value || control.placeholder || ""}` };
  }
  if (control.kind === "checkbox" || control.kind === "radio") {
    const checked = state?.checked ?? control.defaultChecked;
    return { label: control.label, value: checked ? control.value : "", text: `${checked ? "[x]" : "[ ]"} ${control.label}` };
  }
  if (control.kind === "select") {
    const values = state?.values ?? control.options
      .filter((option) => option.defaultSelected)
      .map((option) => option.value);
    return { label: control.label, value: values.join(", "), text: `${control.label}: ${values.join(", ")}` };
  }
  if (control.kind === "submit" || control.kind === "reset") {
    return { label: control.label, value: control.value, text: `[${control.label || control.value}]` };
  }
  if (control.kind === "hidden") return { label: "", value: control.defaultValue, text: "" };
  return { label: control.label, value: "", text: `${control.label}: unsupported control` };
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

class ImmutableVisibleTextIndex implements VisibleTextIndex {
  readonly text: string;
  readonly #segments: readonly VisibleTextSegment[];

  public constructor(text: string, segments: readonly VisibleTextSegment[]) {
    this.text = text;
    this.#segments = Object.freeze(segments.map((segment) => Object.freeze(segment)));
    Object.freeze(this);
  }

  public search(query: string, limit: number): VisibleTextSearchResult {
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
    const matches = foldedMatches.map((folded): VisibleTextMatch => {
      const start = boundaries.get(folded.start) ?? 0;
      const end = boundaries.get(folded.end) ?? this.text.length;
      const slices: VisibleTextMatchSlice[] = [];
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
        id: `visible:${String(start)}:${String(end)}` as VisibleTextMatchId,
        start,
        end,
        slices: Object.freeze(slices)
      });
    });
    return Object.freeze({ matches: Object.freeze(matches), truncated });
  }
}

export function buildVisibleTextIndex(tree: FormattingTree, signal?: AbortSignal): VisibleTextIndex {
  const parts: string[] = [];
  const segments: VisibleTextSegment[] = [];
  let length = 0;
  let pendingSeparator: Omit<VisibleTextSegment, "start" | "end"> | null = null;
  const append = (
    value: string,
    segment: Omit<VisibleTextSegment, "start" | "end">
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
  const separator = (segment: Omit<VisibleTextSegment, "start" | "end">): void => {
    if (length > 0) pendingSeparator = segment;
  };
  const nodeSegment = (
    node: FormattingNode,
    contentStart: number,
    contentEnd: number
  ): Omit<VisibleTextSegment, "start" | "end"> => {
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
    const mapped = transformedText(raw, style.text.textTransform);
    for (const match of mapped.value.matchAll(/\s+|\S+/gu)) {
      const value = match[0];
      const start = match.index;
      const end = start + value.length;
      const [contentStart, contentEnd] = mappedRange(mapped, start, end);
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
    if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
      appendRenderedText(node, node.text);
      continue;
    }
    if (node.kind === "forced-line-break") {
      separator(nodeSegment(node, 0, 0));
      continue;
    }
    if (node.kind === "form-control") {
      appendRenderedText(node, presentedControlText(node, tree).text);
      continue;
    }
    if (node.kind === "replaced-element" || node.kind === "image-fallback") {
      appendRenderedText(node, node.fallbackText);
      continue;
    }
    pending.push({ phase: "exit", id: node.id });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push({ phase: "enter", id: child });
    }
  }
  return new ImmutableVisibleTextIndex(parts.join(""), segments);
}
