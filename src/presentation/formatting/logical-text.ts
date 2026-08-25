import { controlDisplayText } from "./control-display-text.js";
import type { FormattingNode, FormattingTree } from "./types.js";

/** Logical visible text owned by a formatting node, before CSS text transformation and line construction. */
export function formattingNodeLogicalText(node: FormattingNode, tree: FormattingTree): string | null {
  if (node.kind === "text-sequence" || node.kind === "generated-text" || node.kind === "marker") {
    return node.text;
  }
  if (node.kind === "form-control") return controlDisplayText(node, tree).text;
  if (node.kind === "replaced-element" || node.kind === "image-fallback") return node.fallbackText;
  return null;
}
