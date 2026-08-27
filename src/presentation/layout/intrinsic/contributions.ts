import { cssAdd, cssMax, cssNonNegativeLength, cssPx, type CssPixelLength } from "../fixed.js";
import type { IntrinsicSizeContributions } from "./types.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export function intrinsicContributions(
  content: {
    readonly minContentInlineSize: CssPixelLength;
    readonly maxContentInlineSize: CssPixelLength;
    readonly minimumBlockContribution: CssPixelLength;
    readonly maximumBlockContribution: CssPixelLength;
  },
  borderPadding: { readonly inline: CssPixelLength; readonly block: CssPixelLength },
  dependencies: { readonly inline?: boolean; readonly block?: boolean } = {}
): IntrinsicSizeContributions {
  const box = (inlineAddition: CssPixelLength, blockAddition: CssPixelLength) => {
    const minimumInline = cssNonNegativeLength(cssMax(ZERO, cssAdd(content.minContentInlineSize, inlineAddition)));
    const maximumInline = cssNonNegativeLength(cssMax(minimumInline, cssAdd(content.maxContentInlineSize, inlineAddition)));
    const minimumBlock = cssNonNegativeLength(cssMax(ZERO, cssAdd(content.minimumBlockContribution, blockAddition)));
    const maximumBlock = cssNonNegativeLength(cssMax(minimumBlock, cssAdd(content.maximumBlockContribution, blockAddition)));
    return Object.freeze({
      minContentInlineSize: minimumInline,
      maxContentInlineSize: maximumInline,
      minimumBlockContribution: minimumBlock,
      maximumBlockContribution: maximumBlock
    });
  };
  const contentBox = box(ZERO, ZERO);
  const borderBox = box(borderPadding.inline, borderPadding.block);
  return Object.freeze({
    contentBox,
    borderBox,
    automaticMinimumSize: Object.freeze({
      inline: contentBox.minContentInlineSize,
      block: contentBox.minimumBlockContribution
    }),
    percentageDependence: Object.freeze({
      inline: dependencies.inline ?? false,
      block: dependencies.block ?? false
    })
  });
}
