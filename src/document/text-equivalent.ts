import type { DocumentNodeRef, IndexedWebDocumentSnapshot, WebDocumentNode, DocumentSemanticRole } from "./types.js";

export type GeneratedTextEquivalent = (ref: DocumentNodeRef, pseudo: "marker" | "before" | "after", referenced: boolean) => string;

export interface TextEquivalentSource {
  node(ref: DocumentNodeRef): WebDocumentNode | undefined;
  attribute(ref: DocumentNodeRef, name: string): string | null;
  elementById(id: string): DocumentNodeRef | null;
  labelText(ref: DocumentNodeRef): string | undefined;
  labelNodes?(ref: DocumentNodeRef): readonly DocumentNodeRef[];
  labelTarget?(ref: DocumentNodeRef): DocumentNodeRef | null;
  hidden(ref: DocumentNodeRef): boolean;
}

/** Supported native/ARIA text alternatives with explicit work/text limits and cycle protection. */
export function computeTextEquivalent(
  source: TextEquivalentSource,
  root: DocumentNodeRef,
  options: { readonly name?: boolean; readonly includeContents?: boolean; readonly maxWork: number; readonly maxText: number; readonly generated?: GeneratedTextEquivalent },
): string {
  type NodePending = { readonly kind: "node"; readonly ref: DocumentNodeRef; readonly name: boolean;
    readonly referenced: boolean; readonly exclude: DocumentNodeRef | null; readonly skipNaming?: boolean };
  type Pending = NodePending | { readonly kind: "text"; readonly value: string }
    | { readonly kind: "label-fallback"; readonly node: NodePending; readonly checkpoint: number };
  const pending: Pending[] = [{ kind: "node", ref: root, name: options.name ?? true, referenced: false, exclude: null }];
  const parts: string[] = [];
  const visited = new Set<string>();
  let remaining = options.maxText;
  let work = 0;
  let rootContentFallback = "";
  let nonWhitespaceParts = 0;
  const append = (value: string): void => {
    const retained = value.slice(0, remaining);
    parts.push(retained);
    if (/\S/u.test(retained)) nonWhitespaceParts++;
    remaining -= retained.length;
  };
  while (pending.length > 0 && remaining > 0 && work++ < options.maxWork) {
    const item = pending.pop();
    if (item === undefined) continue;
    if (item.kind === "text") { append(item.value); continue; }
    if (item.kind === "label-fallback") {
      if (nonWhitespaceParts === item.checkpoint) pending.push({ ...item.node, skipNaming: true });
      continue;
    }
    if (item.ref === item.exclude) continue;
    const key = `${item.ref}:${String(item.referenced)}:${String(item.skipNaming === true)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = source.node(item.ref);
    if (node?.kind === "text") { append(node.value); continue; }
    if (node?.kind !== "element") continue;
    const html = node.namespace === "http://www.w3.org/1999/xhtml";
    if (html && ["script", "style", "template"].includes(node.name)) continue;
    if (node.ref !== root && !item.referenced && source.hidden(node.ref)) continue;
    if (item.name && item.skipNaming !== true) {
      const references = (source.attribute(node.ref, "aria-labelledby") ?? "").split(/[\t\n\f\r ]+/u)
        .flatMap((id) => { const ref = source.elementById(id); return ref === null ? [] : [ref]; });
      if (references.length > 0 && !item.referenced) {
        for (let index = references.length - 1; index >= 0; index--) {
          const ref = references[index];
          if (ref !== undefined) {
            pending.push({ kind: "node", ref, name: true, referenced: true, exclude: item.exclude });
            if (index > 0) pending.push({ kind: "text", value: " " });
          }
        }
        continue;
      }
      const aria = source.attribute(node.ref, "aria-label");
      if (aria !== null && aria.trim().length > 0) { append(aria); continue; }
      const labels = source.labelNodes?.(node.ref);
      if (labels !== undefined && labels.length > 0) {
        pending.push({ kind: "label-fallback", node: item, checkpoint: nonWhitespaceParts });
        for (let index = labels.length - 1; index >= 0; index--) {
          const ref = labels[index];
          if (ref !== undefined) {
            pending.push({ kind: "node", ref, name: true, referenced: true, exclude: node.ref });
            if (index > 0) pending.push({ kind: "text", value: " " });
          }
        }
        continue;
      }
      const label = source.labelText(node.ref);
      if (label !== undefined) { append(label); continue; }
    }
    if (html && node.name === "img") {
      append(source.attribute(node.ref, "alt") ?? source.attribute(node.ref, "title") ?? "");
      continue;
    }
    if (html && node.name === "input") {
      const type = (source.attribute(node.ref, "type") ?? "text").toLowerCase();
      if (type === "image") {
        append(source.attribute(node.ref, "alt") ?? source.attribute(node.ref, "title") ?? "");
      } else if ((node.ref === root || item.referenced) && ["submit", "reset", "button"].includes(type)) {
        append(source.attribute(node.ref, "value") ?? (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""));
      } else if ((node.ref === root || item.referenced) && item.name) {
        append(source.attribute(node.ref, "title") ?? source.attribute(node.ref, "placeholder") ?? "");
      }
      continue;
    }
    if (node.ref === root && !item.referenced && options.includeContents === false) {
      append(source.attribute(node.ref, "title") ?? source.attribute(node.ref, "placeholder") ?? "");
      continue;
    }
    if (node.ref === root && !item.referenced && item.name) rootContentFallback = source.attribute(node.ref, "title") ?? "";
    const marker = options.generated?.(node.ref, "marker", item.referenced) ?? "";
    const before = options.generated?.(node.ref, "before", item.referenced) ?? "";
    const after = options.generated?.(node.ref, "after", item.referenced) ?? "";
    if (item.name && node.children.length === 0 && marker.length === 0 && before.length === 0 && after.length === 0) {
      append(source.attribute(node.ref, "title") ?? source.attribute(node.ref, "placeholder") ?? "");
    }
    if (after.length > 0) pending.push({ kind: "text", value: after });
    for (let index = node.children.length - 1; index >= 0; index--) {
      const ref = node.children[index];
      if (ref !== undefined) pending.push({ kind: "node", ref, name: item.name, referenced: item.referenced, exclude: source.labelTarget?.(node.ref) ?? item.exclude });
    }
    if (before.length > 0) pending.push({ kind: "text", value: before });
    if (marker.length > 0) pending.push({ kind: "text", value: marker });
  }
  const value = parts.join("").replace(/\s+/gu, " ").trim();
  return value || rootContentFallback.slice(0, options.maxText).replace(/\s+/gu, " ").trim();
}

export function documentTextEquivalent(
  document: IndexedWebDocumentSnapshot,
  ref: DocumentNodeRef,
  generated?: GeneratedTextEquivalent,
  isHidden?: (ref: DocumentNodeRef) => boolean,
): string {
  return computeTextEquivalent({
    node: (node) => document.node(node),
    attribute: (node, name) => document.attribute(node, name),
    elementById: (id) => document.elementById(id),
    labelText: () => undefined,
    labelNodes: (node) => document.labels.filter((label) => label.target === node).map((label) => label.node),
    labelTarget: (node) => document.label(node)?.target ?? null,
    hidden: (node) => (document.semantic(node)?.accessibilityHidden ?? false) || (isHidden?.(node) ?? false),
  }, ref, { maxWork: 100_000, maxText: 32_768, ...(generated === undefined ? {} : { generated }) });
}

const CONTENT_NAME_ROLES = new Set<DocumentSemanticRole>([
  "heading", "link", "button", "listitem", "term", "definition", "cell", "columnheader", "rowheader",
  "figure", "paragraph", "blockquote", "code", "article",
]);

export function semanticNameFromContents(role: DocumentSemanticRole): boolean {
  return CONTENT_NAME_ROLES.has(role);
}
