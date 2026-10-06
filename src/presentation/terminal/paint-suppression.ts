import type { DocumentNodeRef } from "../../document/index.js";
import type { FormattingNodeId } from "../formatting/index.js";
import type { LayoutFragmentTree } from "../layout/index.js";
import type { ComputedStyle, StyleSnapshot } from "../style/types.js";
import { formattingComputedStyle } from "../layout/paint-style.js";

/** Construction-only memoization. Opacity hides ink, never geometry or actions.
 * Source ancestry crosses boxless owners without applying their box effects;
 * formatting ancestry additionally covers generated/pseudo owners.
 */
export function createPaintSuppressionResolver(layout: LayoutFragmentTree, styles: StyleSnapshot, signal?: AbortSignal) {
  const suppresses = (style: ComputedStyle | null): boolean => style !== null
    && style.display.box === "principal" && style.opacity === 0;
  const sources = new Map<DocumentNodeRef, boolean>();
  const formatting = new Map<FormattingNodeId, boolean>();
  const sourceSuppressed = (source: DocumentNodeRef): boolean => {
    const path: DocumentNodeRef[] = [];
    let current: DocumentNodeRef | null = source;
    while (current !== null && !sources.has(current)) {
      signal?.throwIfAborted();
      path.push(current);
      current = styles.document.parent(current)?.ref ?? null;
    }
    let suppressed = current !== null && sources.get(current) === true;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const ref = path[index];
      if (ref === undefined) continue;
      suppressed ||= styles.document.node(ref).kind === "element" && suppresses(styles.style(ref));
      sources.set(ref, suppressed);
    }
    return sources.get(source) ?? false;
  };
  const formattingSuppressed = (id: FormattingNodeId): boolean => {
    const path: FormattingNodeId[] = [];
    let current: FormattingNodeId | null = id;
    while (current !== null && !formatting.has(current)) {
      signal?.throwIfAborted();
      path.push(current);
      current = layout.formatting.parent(current)?.id ?? null;
    }
    let suppressed = current !== null && formatting.get(current) === true;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const ref = path[index];
      if (ref === undefined) continue;
      const node = layout.formatting.node(ref);
      suppressed ||= suppresses(formattingComputedStyle(node, styles))
        || (node.styleNode !== null && sourceSuppressed(node.styleNode));
      formatting.set(ref, suppressed);
    }
    return formatting.get(id) ?? false;
  };
  return { sourceSuppressed, formattingSuppressed };
}
