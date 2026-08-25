import {
  parse,
  parseBytes,
  parseStream
} from "@ismail-elkorchi/html-parser";

import { createIndexedWebDocumentSnapshot } from "./snapshot.js";
import type { DocumentIndexLimits, IndexedWebDocumentSnapshot } from "./types.js";

export interface WebDocumentParseContext {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly indexLimits?: Partial<DocumentIndexLimits>;
}

export interface WebDocumentParseBudgetOptions {
  readonly maxInputBytes?: number;
  readonly maxDecodedUtf8Bytes?: number;
  readonly maxSteps?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxParseErrors?: number;
  readonly maxAttributesPerElement?: number;
  readonly maxAttributeBytes?: number;
  readonly maxTimeMs?: number;
}

export interface WebDocumentStreamBudgetOptions extends WebDocumentParseBudgetOptions {
  readonly maxEncodingPrescanBytes?: number;
}

export interface WebDocumentParseOptions {
  readonly budgets?: WebDocumentParseBudgetOptions;
  readonly signal?: AbortSignal;
}

export interface WebDocumentBytesOptions extends WebDocumentParseOptions {
  readonly transportEncodingLabel?: string;
}

export interface WebDocumentStreamOptions extends Omit<WebDocumentBytesOptions, "budgets"> {
  readonly budgets?: WebDocumentStreamBudgetOptions;
}

const structuralParseOptions = {
  scriptingMode: "disabled" as const,
  captureSpans: true,
  sourceRetention: "text" as const,
  trace: "summary" as const
};

export function parseWebDocument(
  html: string,
  context: WebDocumentParseContext,
  options: WebDocumentParseOptions = {}
): IndexedWebDocumentSnapshot {
  return createIndexedWebDocumentSnapshot(parse(html, { ...options, ...structuralParseOptions }), {
    requestUrl: context.requestUrl,
    finalUrl: context.finalUrl,
    ...(context.indexLimits === undefined ? {} : { limits: context.indexLimits })
  });
}

export function parseWebDocumentBytes(
  bytes: Uint8Array,
  context: WebDocumentParseContext,
  options: WebDocumentBytesOptions = {}
): IndexedWebDocumentSnapshot {
  return createIndexedWebDocumentSnapshot(parseBytes(bytes, { ...options, ...structuralParseOptions }), {
    requestUrl: context.requestUrl,
    finalUrl: context.finalUrl,
    ...(context.indexLimits === undefined ? {} : { limits: context.indexLimits })
  });
}

export async function parseWebDocumentStream(
  stream: ReadableStream<Uint8Array>,
  context: WebDocumentParseContext,
  options: WebDocumentStreamOptions = {}
): Promise<IndexedWebDocumentSnapshot> {
  const parsed = await parseStream(stream, { ...options, ...structuralParseOptions });
  return createIndexedWebDocumentSnapshot(parsed, {
    requestUrl: context.requestUrl,
    finalUrl: context.finalUrl,
    ...(context.indexLimits === undefined ? {} : { limits: context.indexLimits })
  });
}
