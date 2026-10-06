import { cssCoordinateAdd, cssCoordinateFromFixed, cssCoordinateSubtract, cssRect,
  type CssPixelLength, type CssRect, type LayoutFragmentTree } from "../layout/index.js";

/** A terminal cell has one device baseline, independent of CSS line height.
 * Quantize the actual, translated glyph baseline against it. Half-leading and
 * vertical-align remain layout geometry; peers sharing a baseline share a row.
 */
export function textCellRow(rect: CssRect, baseline: CssPixelLength, layout: LayoutFragmentTree,
  rowHeight: CssPixelLength): number {
  const deviceBaseline = layout.context.textMeasurer.defaultFontMetrics().baseline;
  return Math.floor(cssCoordinateSubtract(cssCoordinateAdd(rect.y, baseline), deviceBaseline) / rowHeight);
}

/** Semantic bounds use the same single-row projection as the painted glyphs. */
export function textCellCssRect(rect: CssRect, baseline: CssPixelLength, layout: LayoutFragmentTree,
  rowHeight: CssPixelLength): CssRect {
  return cssRect(rect.x, cssCoordinateFromFixed(textCellRow(rect, baseline, layout, rowHeight) * rowHeight), rect.width, rowHeight);
}
