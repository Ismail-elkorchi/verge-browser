import type { DocumentNodeRef, WebDocumentSnapshot } from "./types.js";

/** HTML integer prefix parsing, with ASCII whitespace and signs only. */
export function parseHtmlInteger(value: string | null): number | null {
  const prefix = value?.match(/^[\t\n\f\r ]*([+-]?[0-9]+)/u)?.[1];
  if (prefix === undefined) return null;
  const number = Number(prefix);
  return Number.isSafeInteger(number) ? number : null;
}

export function htmlListMetadata(document: WebDocumentSnapshot, ref: DocumentNodeRef): {
  readonly start: number | null;
  readonly reversed: boolean;
} | null {
  const node = document.node(ref);
  if (node.kind !== "element" || node.namespace !== "http://www.w3.org/1999/xhtml" || node.name !== "ol") return null;
  return Object.freeze({ start: parseHtmlInteger(document.attribute(ref, "start")), reversed: document.attribute(ref, "reversed") !== null });
}

export function htmlListItemValue(document: WebDocumentSnapshot, ref: DocumentNodeRef): number | null {
  const node = document.node(ref);
  return node.kind === "element" && node.namespace === "http://www.w3.org/1999/xhtml" && node.name === "li"
    ? parseHtmlInteger(document.attribute(ref, "value")) : null;
}
