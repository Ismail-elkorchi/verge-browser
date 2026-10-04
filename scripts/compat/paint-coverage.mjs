import { bidiMirroringGlyph } from "../../dist/unicode/index.js";

// Evidence must come from surviving cells, never merely a search highlight.
// Source intervals prevent another occurrence from satisfying the assertion.
function intervalContains(outerStart, outerEnd, innerStart, innerEnd) {
  return outerStart !== null && outerEnd !== null && outerStart <= innerStart && outerEnd >= innerEnd;
}

function sameSourceRange(actual, expected) {
  return expected === null ? actual === null : actual !== null
    && actual.provenance === expected.provenance
    && intervalContains(actual.start, actual.end, expected.start, expected.end);
}

function meaningful(unit) {
  return unit.kind === "text" && !/^[\s\p{Default_Ignorable_Code_Point}]*$/u.test(unit.text);
}

function isZeroFont(style) {
  return style?.text.fontSize.kind === "zero"
    || (style?.text.fontSize.kind === "length" && style.text.fontSize.value === 0);
}

function sourceUnits(artifacts, formatting) {
  const tree = artifacts.boxTree;
  const node = tree.node(formatting);
  const style = node.styleNode === null ? null : node.pseudo === null
    ? tree.styles.style(node.styleNode)
    : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
  if (style === null || style.visibility !== "visible") return [];
  return (artifacts.inlineItemStreams.textForFormattingNode(formatting)?.units ?? []).filter(meaningful).map((unit) => ({
    formattingNode: formatting,
    documentNode: node.source,
    contentStartCodeUnit: unit.contentStartCodeUnit,
    contentEndCodeUnit: unit.contentEndCodeUnit,
    sourceRange: node.kind === "text-sequence" && node.source !== null
      ? tree.document.textSourceRange(node.source, unit.contentStartCodeUnit, unit.contentEndCodeUnit)
      : node.sourceRange,
    text: unit.text,
    zeroFont: isZeroFont(style)
  }));
}

// A merged span is accepted only if its actual row text equals its retained
// clusters. Logical offsets retain source ownership across RTL visual order.
export function paintedSourceUnits(rows, commands, layout = null) {
  const byCommand = new Map(commands.filter((command) => command.kind === "text").map((command) => [command.id, command]));
  const units = [];
  const malformedSpans = [];
  for (const row of rows) {
    for (const span of row.spans) {
      const command = byCommand.get(span.command);
      if (command === undefined || command.formattingNode !== span.formattingNode
        || command.documentNode !== span.documentNode || command.layoutFragment !== span.layoutFragment) {
        malformedSpans.push({ row: row.row, command: span.command, reason: "span-source-ownership-mismatch" });
        continue;
      }
      const clusters = command.clusters.filter((cluster) => intervalContains(
        span.contentStartCodeUnit, span.contentEndCodeUnit, cluster.contentStartCodeUnit, cluster.contentEndCodeUnit
      ));
      const actualText = row.text.slice(span.startCodeUnit, span.endCodeUnit);
      if (clusters.length === 0 || clusters.map((cluster) => cluster.text).join("") !== actualText) {
        malformedSpans.push({ row: row.row, command: span.command, reason: "span-text-mismatch", actualText });
        continue;
      }
      for (const cluster of clusters) {
        if (!sameSourceRange(span.sourceRange, cluster.sourceRange)) {
          malformedSpans.push({ row: row.row, command: span.command, reason: "span-source-range-mismatch" });
          continue;
        }
        units.push({
          formattingNode: span.formattingNode,
          documentNode: span.documentNode,
          contentStartCodeUnit: cluster.contentStartCodeUnit,
          contentEndCodeUnit: cluster.contentEndCodeUnit,
          sourceRange: cluster.sourceRange,
          text: cluster.text,
          row: row.row,
          embeddingLevel: layout?.fragment(command.layoutFragment).embeddingLevel ?? 0
        });
      }
    }
  }
  return { units, malformedSpans };
}

export function sourceUnitPainted(expected, actual) {
  const candidates = actual.filter((unit) => unit.formattingNode === expected.formattingNode
    && unit.documentNode === expected.documentNode
    && unit.contentStartCodeUnit === expected.contentStartCodeUnit
    && unit.contentEndCodeUnit === expected.contentEndCodeUnit
    && sameSourceRange(unit.sourceRange, expected.sourceRange));
  return candidates.some((unit) => {
    const expectedVisual = (unit.embeddingLevel & 1) === 0 ? expected.text : [...expected.text].map((character) => {
      const codePoint = character.codePointAt(0);
      return String.fromCodePoint(bidiMirroringGlyph(codePoint) ?? codePoint);
    }).join("");
    return unit.text.normalize("NFC") === expectedVisual.normalize("NFC");
  });
}

export function phrasePaintCoverage(artifacts, rows, expectedText) {
  const painted = paintedSourceUnits(rows, artifacts.documentDisplayList.commands, artifacts.documentLayout);
  const unitsByFormatting = new Map();
  const unitsFor = (formatting) => {
    if (!unitsByFormatting.has(formatting)) unitsByFormatting.set(formatting, sourceUnits(artifacts, formatting));
    return unitsByFormatting.get(formatting);
  };
  const phrases = expectedText.map((assertion) => {
    const text = typeof assertion === "string" ? assertion : assertion.text;
    const within = typeof assertion === "string" ? null : artifacts.boxTree.document.elementById(assertion.within);
    const inScope = (source) => {
      if (typeof assertion === "string") return true;
      if (within === null) return false;
      let node = source === null ? null : artifacts.boxTree.document.node(source);
      while (node !== null) {
        if (node.ref === within) return true;
        node = artifacts.boxTree.document.parent(node.ref);
      }
      return false;
    };
    const search = artifacts.textSearchIndex.search(text, 10_000);
    const matches = search.matches.map((match) => {
      const expected = new Map();
      for (const slice of match.slices) {
        for (const unit of unitsFor(slice.formatting)) {
          if (unit.contentStartCodeUnit >= slice.contentEnd || unit.contentEndCodeUnit <= slice.contentStart || unit.zeroFont) continue;
          expected.set(`${unit.formattingNode}:${unit.contentStartCodeUnit}:${unit.contentEndCodeUnit}`, unit);
        }
      }
      const inSourceScope = [...expected.values()].every((unit) => inScope(unit.documentNode));
      const missing = [...expected.values()].filter((unit) => !sourceUnitPainted(unit, painted.units));
      return { id: match.id, inSourceScope, expected: expected.size, matched: expected.size - missing.length, missing };
    });
    // Require one complete occurrence; never union different occurrences.
    const complete = !search.truncated && matches.some((match) => match.inSourceScope && match.expected > 0 && match.missing.length === 0);
    return { text, ...(typeof assertion === "string" ? {} : { within: assertion.within }), complete, truncated: search.truncated, matches };
  });
  const zeroFontUnits = [];
  const pending = [artifacts.boxTree.root];
  while (pending.length > 0) {
    const id = pending.pop();
    pending.push(...artifacts.boxTree.node(id).children);
    zeroFontUnits.push(...unitsFor(id).filter((unit) => unit.zeroFont));
  }
  return {
    paintedPhrases: phrases.filter((phrase) => phrase.complete).map((phrase) => phrase.text),
    phrases,
    malformedSpans: painted.malformedSpans,
    zeroFont: {
      expectedSuppressedGraphemes: zeroFontUnits.length,
      painted: painted.units.filter((unit) => /\S/u.test(unit.text) && zeroFontUnits.some((expected) =>
        expected.formattingNode === unit.formattingNode && expected.documentNode === unit.documentNode
        && expected.contentStartCodeUnit < unit.contentEndCodeUnit && expected.contentEndCodeUnit > unit.contentStartCodeUnit))
    }
  };
}
