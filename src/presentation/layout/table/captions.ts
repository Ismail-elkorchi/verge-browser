import type { FormattingNode, FormattingNodeId } from "../../formatting/index.js";
import type { ComputedStyle, CssLength } from "../../style/index.js";
import {
  cssAdd,
  cssMax,
  cssNonNegativeLength,
  cssPx,
  type CssNonNegativeLength,
  type CssPixelLength,
} from "../fixed.js";
import type { TableLayoutHost, TableSlotGrid } from "./types.js";
import type { IntrinsicSizeContributions } from "../intrinsic/index.js";

const ZERO = cssNonNegativeLength(cssPx(0));

export interface TableCaptionGroups {
  readonly top: readonly FormattingNodeId[];
  readonly bottom: readonly FormattingNodeId[];
}

export function groupTableCaptions(host: TableLayoutHost, grid: TableSlotGrid): TableCaptionGroups {
  const top: FormattingNodeId[] = [];
  const bottom: FormattingNodeId[] = [];
  for (const id of grid.captions) {
    const node = host.formattingNode(id);
    const side = host.computed(node)?.box.captionSide ?? "top";
    (side === "bottom" ? bottom : top).push(id);
  }
  return Object.freeze({ top: Object.freeze(top), bottom: Object.freeze(bottom) });
}

interface TableCaptionSizingHost {
  readonly signal: AbortSignal | undefined;
  formattingNode(id: FormattingNodeId): FormattingNode;
  computed(node: FormattingNode): ComputedStyle | null;
  usedLength(value: CssLength, basis: CssPixelLength | null, style: ComputedStyle | null): CssPixelLength | null;
  intrinsicContributions(id: FormattingNodeId, availableInlineSize: CssPixelLength | null): IntrinsicSizeContributions;
  consume(budget: "maxTableIntrinsicMeasureWork", amount?: number): void;
}

export interface TableCaptionInlineSizes {
  readonly minimum: CssNonNegativeLength;
  readonly maximum: CssNonNegativeLength;
}

/** Return caption margin-box intrinsic inline contributions. */
export function captionInlineSizes(
  host: TableCaptionSizingHost,
  ids: readonly FormattingNodeId[],
  availableInlineSize: CssPixelLength | null,
): TableCaptionInlineSizes {
  let minimum: CssPixelLength = ZERO;
  let maximum: CssPixelLength = ZERO;
  for (const id of ids) {
    host.signal?.throwIfAborted();
    host.consume("maxTableIntrinsicMeasureWork");
    const node = host.formattingNode(id);
    const style = host.computed(node);
    const contribution = host.intrinsicContributions(id, availableInlineSize);
    const margins = style === null
      ? ZERO
      : cssAdd(
          host.usedLength(style.box.margin.left, availableInlineSize, style) ?? ZERO,
          host.usedLength(style.box.margin.right, availableInlineSize, style) ?? ZERO,
        );
    minimum = cssMax(
      minimum,
      cssAdd(contribution.borderBox.minContentInlineSize, margins),
    );
    maximum = cssMax(
      maximum,
      cssAdd(contribution.borderBox.maxContentInlineSize, margins),
    );
  }
  return Object.freeze({
    minimum: cssNonNegativeLength(minimum),
    maximum: cssNonNegativeLength(cssMax(minimum, maximum)),
  });
}
