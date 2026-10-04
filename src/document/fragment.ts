import type { DocumentNodeRef, IndexedWebDocumentSnapshot } from "./types.js";

export type DocumentFragmentTarget = { readonly kind: "node"; readonly node: DocumentNodeRef }
  | { readonly kind: "top" } | { readonly kind: "none" };

function match(document: IndexedWebDocumentSnapshot, fragment: string): DocumentNodeRef | null {
  const id = document.elementById(fragment);
  if (id !== null) return id;
  // Traverse the already-budgeted immutable tree; no parallel name cache or unbounded index.
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined) continue;
    const node = document.node(ref);
    if (node.kind === "element" && node.namespace === "http://www.w3.org/1999/xhtml"
      && node.name === "a" && document.attribute(ref, "name") === fragment) return ref;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return null;
}
function decodeFragment(fragment: string): string {
  const input = new TextEncoder().encode(fragment);
  const bytes: number[] = [];
  const hex = (byte: number | undefined): number => byte === undefined ? -1
    : byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === undefined) continue;
    const high = hex(input[index + 1]);
    const low = hex(input[index + 2]);
    if (byte === 37 && high >= 0 && low >= 0) { bytes.push(high * 16 + low); index += 2; }
    else bytes.push(byte);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
/** HTML fragment matching, with raw matching before tolerant percent/UTF-8 decoding. */
export function resolveDocumentFragment(document: IndexedWebDocumentSnapshot, entryUrl: string): DocumentFragmentTarget {
  let url: string;
  try { url = new URL(entryUrl).href; } catch { return { kind: "none" }; }
  const hash = url.indexOf("#");
  if (hash < 0) return { kind: "none" };
  const raw = url.slice(hash + 1);
  if (raw.length === 0) return { kind: "top" };
  const exact = match(document, raw);
  if (exact !== null) return { kind: "node", node: exact };
  const decoded = decodeFragment(raw);
  const target = match(document, decoded);
  if (target !== null) return { kind: "node", node: target };
  return decoded.toLowerCase() === "top" ? { kind: "top" } : { kind: "none" };
}
