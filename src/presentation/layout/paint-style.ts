import { RecordSharing, sameCssColor, compareComputedRecord } from "../style/immutable-records.js";
import type { FormattingNode } from "../formatting/types.js";
import type { ComputedStyle, StyleSnapshot } from "../style/types.js";
import type { LayoutPaintStyle, LayoutFragment, LayoutFragmentTree } from "./types.js";

const fields: { readonly [K in keyof LayoutPaintStyle]: (a: LayoutPaintStyle[K], b: LayoutPaintStyle[K]) => boolean } = {
  visible: (a, b) => a === b,
  foreground: sameCssColor,
  background: sameCssColor,
  bold: (a, b) => a === b,
  italic: (a, b) => a === b,
  underline: (a, b) => a === b,
  strikethrough: (a, b) => a === b,
  borderColors: (a, b) => a === b || (sameCssColor(a.top, b.top) && sameCssColor(a.right, b.right)
    && sameCssColor(a.bottom, b.bottom) && sameCssColor(a.left, b.left)),
  borderStyles: (a, b) => a === b || (a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left),
};
export const sameLayoutPaintStyle = compareComputedRecord(fields);

/** Construction-only sharing; no history of styles survives the layout operation. */
export function createPaintStyleSharing(): RecordSharing<LayoutPaintStyle> {
  return new RecordSharing((s) => `${String(s.visible)}:${String(s.bold)}:${String(s.italic)}:${String(s.underline)}:${String(s.strikethrough)}`, sameLayoutPaintStyle);
}

/** Resolve the same principal/pseudo owner for layout and later paint-only updates. */
export function formattingComputedStyle(node: FormattingNode, styles: StyleSnapshot): ComputedStyle | null {
  if (node.styleNode === null) return null;
  return node.pseudo === null ? styles.style(node.styleNode)
    : styles.pseudo(node.styleNode, node.pseudo) ?? styles.style(node.styleNode);
}

export function computedPaintBackground(style: ComputedStyle | null, appliesBoxStyle: boolean, hideEmptyCell = false): LayoutPaintStyle["background"] {
  return appliesBoxStyle && !hideEmptyCell ? style?.text.background ?? null : null;
}

/** The layout boundary projects verified current paint inputs without reconstructing geometry. */
export function createLayoutPaintResolver(layout: LayoutFragmentTree, styles: StyleSnapshot): (fragment: LayoutFragment) => LayoutPaintStyle {
  const sharing = createPaintStyleSharing();
  return (fragment) => {
    if (styles === layout.formatting.styles) return fragment.style;
    const node = layout.formatting.node(fragment.formattingNode);
    const previous = formattingComputedStyle(node, layout.formatting.styles);
    const current = formattingComputedStyle(node, styles);
    if (sameCssColor(previous?.text.background ?? null, current?.text.background ?? null)) return fragment.style;
    const background = computedPaintBackground(current, node.appliesBoxStyle);
    return sameCssColor(fragment.style.background, background) ? fragment.style
      : sharing.share(Object.freeze({ ...fragment.style, background }));
  };
}
