import {
  parseStylesheet,
  parseStylesheetBytes,
  serializeCssComponentValues,
  type ComponentValue,
  type CssAtRule,
  type CssBlockItem
} from "@ismail-elkorchi/css-parser";

import type {
  StylesheetDependencyInspection,
  StylesheetImportDependency
} from "./types.js";

function significant(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

function importDependency(
  rule: CssAtRule,
  order: number,
  precedingLayers: readonly string[]
): StylesheetImportDependency | null {
  const values = significant(rule.prelude);
  const location = values[0];
  const request = location?.kind === "string" || location?.kind === "url" ? location.value
    : location?.kind === "function-block" && location.name.toLowerCase() === "url"
      ? (() => {
          const nested = significant(location.value);
          const token = nested[0];
          return nested.length === 1 && (token?.kind === "string" || token?.kind === "url" || token?.kind === "ident")
            ? token.value : null;
        })()
      : null;
  if (request === null || request.length === 0) return null;
  let layer: string | null = null;
  let mediaStart = 1;
  const modifier = values[1];
  if (modifier?.kind === "ident" && modifier.value.toLowerCase() === "layer") {
    layer = "";
    mediaStart = 2;
  } else if (modifier?.kind === "function-block" && modifier.name.toLowerCase() === "layer") {
    layer = serializeCssComponentValues(modifier.value).trim();
    mediaStart = 2;
  }
  const supportsFunction = values.slice(mediaStart).find((value) =>
    value.kind === "function-block" && value.name.toLowerCase() === "supports"
  );
  const supports = supportsFunction?.kind === "function-block"
    ? serializeCssComponentValues(supportsFunction.value).trim()
    : null;
  const mediaValues = values.slice(mediaStart).filter((value) => value !== supportsFunction);
  const media = serializeCssComponentValues(mediaValues).trim();
  return Object.freeze({
    request,
    media: media.length === 0 ? null : media,
    layer,
    supports: supports === null || supports.length === 0 ? null : supports,
    order,
    precedingLayers: Object.freeze([...precedingLayers])
  });
}

function layerStatementNames(rule: CssAtRule): readonly string[] {
  if (rule.name.toLowerCase() !== "layer" || rule.block !== null) return Object.freeze([]);
  const names: string[] = [];
  let current: ComponentValue[] = [];
  const finish = (): void => {
    const name = serializeCssComponentValues(current).trim();
    if (name.length > 0) names.push(name);
    current = [];
  };
  for (const value of rule.prelude) {
    if (value.kind === "comma") finish();
    else current.push(value);
  }
  finish();
  return Object.freeze(names);
}

function countRules(items: readonly CssBlockItem[]): number {
  let count = 0;
  const pending = [...items];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item.kind === "declaration") continue;
    count += 1;
    if (item.block !== null) pending.push(...item.block.items);
  }
  return count;
}

function inspectParsed(
  parsed: ReturnType<typeof parseStylesheet> | ReturnType<typeof parseStylesheetBytes>
): StylesheetDependencyInspection {
  if (!parsed.ok) return Object.freeze({ status: "rejected", reason: "parse" });
  const imports: StylesheetImportDependency[] = [];
  let importOrder = 0;
  let importsAllowed = true;
  const precedingLayers: string[] = [];
  for (const rule of parsed.value.rules) {
    if (rule.kind === "at-rule") precedingLayers.push(...layerStatementNames(rule));
    if (rule.kind !== "at-rule" || rule.name.toLowerCase() !== "import") {
      if (!(rule.kind === "at-rule" && ["charset", "layer"].includes(rule.name.toLowerCase()) && rule.block === null)) {
        importsAllowed = false;
      }
      continue;
    }
    if (!importsAllowed || rule.block !== null) continue;
    const dependency = importDependency(rule, importOrder, precedingLayers);
    importOrder += 1;
    if (dependency !== null) imports.push(dependency);
  }
  return Object.freeze({
    status: "complete",
    imports: Object.freeze(imports),
    parsedRules: countRules(parsed.value.rules)
  });
}

/** Style-owned syntax inspection used by the application-owned dependency fetcher. */
export function inspectStylesheetText(
  css: string,
  signal?: AbortSignal
): StylesheetDependencyInspection {
  return inspectParsed(parseStylesheet(css, { ...(signal === undefined ? {} : { signal }) }));
}

/** Style-owned CSS decoding and syntax inspection for fetched stylesheet bytes. */
export function inspectStylesheetBytes(
  bytes: Uint8Array,
  transportEncodingLabel: string | null,
  signal?: AbortSignal
): StylesheetDependencyInspection {
  try {
    return inspectParsed(parseStylesheetBytes(bytes, {
      ...(transportEncodingLabel === null ? {} : { transportEncodingLabel }),
      limits: {
        maxInputBytes: bytes.byteLength,
        maxTokens: 200_000,
        maxNodes: 100_000,
        maxDepth: 128,
        maxSteps: 2_000_000
      },
      ...(signal === undefined ? {} : { signal })
    }));
  } catch {
    signal?.throwIfAborted();
    return Object.freeze({ status: "rejected", reason: "encoding" });
  }
}
