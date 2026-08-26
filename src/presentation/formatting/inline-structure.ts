import type { FormattingNode, FormattingTree } from "./types.js";

/** Whether a formatting node participates in its parent's inline formatting context. */
export function isInlineFormattingNode(node: FormattingNode): boolean {
  return node.outer === "inline"
    || node.kind === "text-sequence"
    || node.kind === "generated-text"
    || node.kind === "marker"
    || node.kind === "forced-line-break"
    || node.kind === "line-break-opportunity"
    || node.kind === "form-control"
    || node.kind === "replaced-element"
    || node.kind === "image-fallback";
}

/** CSS display-structure classification for an indivisible inline-level box. */
export function isAtomicInlineBox(tree: FormattingTree, node: FormattingNode): boolean {
  if (node.outer !== "inline") return false;
  if (node.kind === "form-control" || node.kind === "replaced-element" || node.kind === "image-fallback") return true;
  if (!node.appliesBoxStyle || node.styleNode === null) return false;
  const style = node.pseudo === null
    ? tree.styles.style(node.styleNode)
    : tree.styles.pseudo(node.styleNode, node.pseudo) ?? tree.styles.style(node.styleNode);
  return style.display.box === "principal" && (style.display.replaced || style.display.inner !== "flow");
}
