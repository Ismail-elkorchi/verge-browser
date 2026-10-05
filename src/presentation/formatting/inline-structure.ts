import type { FormattingNode, FormattingTree } from "./types.js";

/** Whether a formatting node participates in its parent's inline formatting context. */
export function isInlineFormattingNode(node: FormattingNode): boolean {
  if (node.kind === "marker") return node.markerPlacement === "inside";
  return node.outer === "inline"
    || node.kind === "text-sequence"
    || node.kind === "generated-text"
    || node.kind === "forced-line-break"
    || node.kind === "line-break-opportunity";
}

/** Atomic content owns its text stream even when blockified or positioned. */
export function isAtomicFormattingNode(node: FormattingNode): boolean {
  return node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image";
}

/** CSS display-structure classification for an indivisible inline-level box. */
export function isAtomicInlineBox(tree: FormattingTree, node: FormattingNode): boolean {
  if (node.outer !== "inline") return false;
  if (node.kind === "table-wrapper") return true;
  if (isAtomicFormattingNode(node)) return true;
  if (!node.appliesBoxStyle || node.styleNode === null) return false;
  const style = node.pseudo === null
    ? tree.styles.style(node.styleNode)
    : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
  return style.display.box === "principal" && (style.display.replaced || style.display.inner !== "flow");
}
