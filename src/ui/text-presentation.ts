import { measureTextCells } from "@ismail-elkorchi/terminal-ui/text";
import type { TextPresentation, TextVisualCluster, TextVisualOrderRequest } from "@ismail-elkorchi/terminal-ui/text";
import { bidiVisualOrderForLine, mirroredBidiText, resolveBidiText, type BidiParagraph } from "../unicode/index.js";

type Paragraph = Pick<BidiParagraph, "items" | "embeddingLevels" | "baseLevel">;
const MAX_CACHED_PARAGRAPHS = 8;
const MAX_CACHED_CODE_UNITS = 2_000_000;

function itemAtOffset(paragraph: Paragraph, offset: number): number {
  let low = 0;
  let high = paragraph.items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((paragraph.items.at(middle)?.sourceStartCodeUnit ?? Infinity) < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** One session-owned adapter: Unicode resolution is shared with document layout, not reimplemented. */
export function createBrowserTextPresentation(): TextPresentation {
  const paragraphs = new Map<string, Paragraph>();
  let retainedCodeUnits = 0;
  function paragraphFor(text: string): Paragraph {
    const retained = paragraphs.get(text);
    if (retained !== undefined) {
      paragraphs.delete(text);
      paragraphs.set(text, retained);
      return retained;
    }
    const resolved = resolveBidiText(text, "auto");
    if (resolved.outcome.status !== "complete") throw new RangeError("Terminal text exceeds the Unicode paragraph budget.");
    const paragraph: Paragraph = Object.freeze({ items: resolved.items,
      embeddingLevels: resolved.embeddingLevels, baseLevel: resolved.baseLevel });
    if (text.length <= MAX_CACHED_CODE_UNITS) {
      while (paragraphs.size >= MAX_CACHED_PARAGRAPHS || retainedCodeUnits + text.length > MAX_CACHED_CODE_UNITS) {
        const oldest = paragraphs.keys().next().value;
        if (oldest === undefined) break;
        paragraphs.delete(oldest);
        retainedCodeUnits -= oldest.length;
      }
      paragraphs.set(text, paragraph);
      retainedCodeUnits += text.length;
    }
    return paragraph;
  }
  return Object.freeze({ map(request: TextVisualOrderRequest): readonly TextVisualCluster[] {
    const { text, graphemes, startOffset, endOffsetExclusive } = request;
    if (graphemes.length === 0) return Object.freeze([]);
    // ASCII has no directional formatting or right-to-left strong characters.
    if (/^[\x20-\x7e]*$/u.test(text)) {
      return Object.freeze(graphemes.map((cluster) => Object.freeze({ startOffset: cluster.startOffset,
        endOffsetExclusive: cluster.endOffsetExclusive, text: cluster.text, direction: "ltr" as const })));
    }
    const paragraph = paragraphFor(text);
    const itemStart = itemAtOffset(paragraph, startOffset);
    const itemEnd = itemAtOffset(paragraph, endOffsetExclusive);
    const order = bidiVisualOrderForLine(paragraph, itemStart, itemEnd);
    const itemOwners = new Int32Array(itemEnd - itemStart).fill(-1);
    const lineLevels = new Int16Array(itemEnd - itemStart).fill(paragraph.baseLevel);
    for (const run of order.runs) {
      for (let index = run.logicalStart; index < run.logicalEnd; index++) lineLevels[index - itemStart] = run.level;
    }
    const visible = new Uint8Array(graphemes.length);
    const clusters: TextVisualCluster[] = [];
    let itemIndex = itemStart;
    for (let index = 0; index < graphemes.length; index++) {
      const source = graphemes[index];
      if (source === undefined) continue;
      let value = "";
      let level = paragraph.baseLevel;
      let resolvedLevel = false;
      while (itemIndex < itemEnd) {
        const item = paragraph.items.at(itemIndex);
        if (item === undefined || item.sourceStartCodeUnit >= source.endOffsetExclusive) break;
        itemOwners[itemIndex - itemStart] = index;
        const itemLevel = paragraph.embeddingLevels.at(itemIndex);
        if (!resolvedLevel && itemLevel !== null && itemLevel !== undefined) { level = (lineLevels[itemIndex - itemStart] ?? itemLevel) as typeof level; resolvedLevel = true; }
        value += mirroredBidiText(paragraph, itemIndex);
        itemIndex++;
      }
      clusters.push(Object.freeze({ startOffset: source.startOffset, endOffsetExclusive: source.endOffsetExclusive,
        // Mirroring is glyph substitution; it must not change the established terminal allocation.
        text: value === source.text || measureTextCells(value, { widthProfile: request.widthProfile }).cells === source.cells
          ? value : source.text, direction: (level & 1) === 0 ? "ltr" : "rtl" }));
    }
    const visual: number[] = [];
    for (const item of order.itemIndices) {
      const owner = itemOwners[item - itemStart] ?? -1;
      if (owner < 0 || visible[owner] !== 0) continue;
      visible[owner] = 1;
      visual.push(owner);
    }
    // X9 removes formatting code points from ordering, not from the editor's source offsets.
    // Keep their zero-width clusters at the adjacent resolved source edge.
    if (visual.length === 0) return Object.freeze(clusters);
    const before = new Map<number, TextVisualCluster[]>();
    const after = new Map<number, TextVisualCluster[]>();
    let next = -1;
    let previous = -1;
    const nextVisible = new Int32Array(clusters.length).fill(-1);
    for (let index = clusters.length - 1; index >= 0; index--) {
      nextVisible[index] = next;
      if (visible[index] !== 0) next = index;
    }
    for (let index = 0; index < clusters.length; index++) {
      if (visible[index] !== 0) { previous = index; continue; }
      const following = nextVisible[index] ?? -1;
      const owner = following >= 0 ? following : previous;
      const cluster = clusters[index];
      const neighbor = clusters[owner];
      if (cluster === undefined || neighbor === undefined) continue;
      const leading = following >= 0 ? neighbor.direction === "ltr" : neighbor.direction === "rtl";
      const target = leading ? before : after;
      const group = target.get(owner) ?? [];
      group.push(cluster);
      target.set(owner, group);
    }
    const result: TextVisualCluster[] = [];
    for (const owner of visual) {
      for (const cluster of before.get(owner) ?? []) result.push(cluster);
      const cluster = clusters[owner];
      if (cluster !== undefined) result.push(cluster);
      for (const cluster of after.get(owner) ?? []) result.push(cluster);
    }
    return Object.freeze(result);
  } });
}
