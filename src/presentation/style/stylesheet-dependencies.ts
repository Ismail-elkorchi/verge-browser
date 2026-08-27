import {
  parseStylesheet,
  parseStylesheetBytes,
  serializeCssComponentValues,
  type ComponentValue,
  type CssAtRule,
  type CssBlockItem
} from "@ismail-elkorchi/css-parser";

import type { IndexedWebDocumentSnapshot } from "../../document/index.js";

import type {
  CascadeLayerPath,
  StylesheetDependencyInspection,
  StylesheetImportDependency,
  StylesheetResource
} from "./types.js";

function significant(values: readonly ComponentValue[]): readonly ComponentValue[] {
  return values.filter((value) => value.kind !== "whitespace");
}

function layerPath(values: readonly ComponentValue[]): CascadeLayerPath | null {
  const serialized = serializeCssComponentValues(values).trim();
  if (serialized.length === 0) return null;
  const segments = serialized.split(/\s*\.\s*/u);
  return segments.length > 0 && segments.every((segment) => segment.length > 0)
    ? Object.freeze(segments) : null;
}

function importDependency(
  rule: CssAtRule,
  order: number,
  precedingLayers: readonly CascadeLayerPath[]
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
  let layer: CascadeLayerPath | null = null;
  let mediaStart = 1;
  const modifier = values[1];
  if (modifier?.kind === "ident" && modifier.value.toLowerCase() === "layer") {
    layer = Object.freeze([]);
    mediaStart = 2;
  } else if (modifier?.kind === "function-block" && modifier.name.toLowerCase() === "layer") {
    layer = layerPath(modifier.value);
    if (layer === null) return null;
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

function layerStatementNames(rule: CssAtRule): readonly CascadeLayerPath[] {
  if (rule.name.toLowerCase() !== "layer" || rule.block !== null) return Object.freeze([]);
  const names: CascadeLayerPath[] = [];
  let current: ComponentValue[] = [];
  const finish = (): void => {
    const name = layerPath(current);
    if (name !== null) names.push(name);
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
  const precedingLayers: CascadeLayerPath[] = [];
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

/** Builds complete source records for embedded roots when no resource loader is involved. */
export function embeddedStylesheetSources(
  document: IndexedWebDocumentSnapshot,
  signal?: AbortSignal
): readonly StylesheetResource[] {
  const encoder = new TextEncoder();
  const resources: StylesheetResource[] = [];
  let dependencyOrder = 0;
  for (const reference of document.stylesheets) {
    signal?.throwIfAborted();
    if (reference.kind !== "embedded") continue;
    const sourceUrl = `${document.finalUrl}#style-${String(reference.order)}`;
    const inspection = inspectStylesheetText(reference.cssText, signal);
    if (inspection.status !== "complete") continue;
    resources.push(Object.freeze({
      sourceKind: "embedded",
      owner: reference.owner,
      requestUrl: sourceUrl,
      finalUrl: sourceUrl,
      contentType: "text/css",
      bytes: encoder.encode(reference.cssText),
      transportEncodingLabel: "utf-8",
      rootOrder: reference.order,
      dependencyOrder: dependencyOrder++,
      importDepth: 0,
      importedFrom: null,
      importLayer: null,
      mediaConditions: Object.freeze(reference.media === null ? [] : [reference.media]),
      supportsConditions: Object.freeze([]),
      predeclaredLayers: Object.freeze([]),
      parsedRules: inspection.parsedRules
    }));
  }
  return Object.freeze(resources);
}
