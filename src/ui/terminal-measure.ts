import {
  measureTerminalCellText,
  terminalTextWidth,
  type TextWidthProfile
} from "@ismail-elkorchi/terminal-ui/text";

import {
  cssLengthFromFixed,
  cssMultiply,
  cssPx,
  type CssPixelLength,
  type CssTextMeasurer,
  type UsedFontMetrics
} from "../presentation/layout/index.js";
import type { TerminalCellMeasurer } from "../presentation/terminal/index.js";

function widthProfile(ambiguousWidth: 1 | 2): TextWidthProfile {
  return { emoji: "wide", ambiguous: ambiguousWidth === 2 ? "wide" : "narrow" };
}

export function terminalCellMeasurer(ambiguousWidth: 1 | 2 = 1): TerminalCellMeasurer {
  const profile = widthProfile(ambiguousWidth);
  return {
    width(text) {
      return terminalTextWidth(text, { widthProfile: profile });
    },
    graphemes(text) {
      return measureTerminalCellText(text, { widthProfile: profile }).graphemes.map((segment) => ({
        text: segment.text,
        startCodeUnit: segment.startOffset,
        endCodeUnit: segment.endOffsetExclusive,
        cells: segment.cells
      }));
    }
  };
}

export function terminalCssTextMeasurer(
  cellWidthCssPx: CssPixelLength = cssPx(8),
  rowHeightCssPx: CssPixelLength = cssPx(16),
  ambiguousWidth: 1 | 2 = 1
): CssTextMeasurer {
  const cells = terminalCellMeasurer(ambiguousWidth);
  const metrics = (fontSize: CssPixelLength): UsedFontMetrics => {
    const scale = fontSize / cssPx(16);
    const ascent = cssMultiply(cssPx(12), scale);
    const descent = cssMultiply(cssPx(4), scale);
    const natural = ascent + descent;
    const lineGap = cssLengthFromFixed(Math.max(0, rowHeightCssPx * scale - natural));
    return Object.freeze({
      fontSize,
      ascent,
      descent,
      lineGap,
      baseline: ascent,
      xHeight: cssMultiply(fontSize, 0.5),
      chAdvance: cssMultiply(cellWidthCssPx, scale)
    });
  };
  return {
    measure(text, fontSize) {
      return cssMultiply(cellWidthCssPx, cells.width(text) * fontSize / cssPx(16));
    },
    graphemes(text, fontSize) {
      const scale = fontSize / cssPx(16);
      return cells.graphemes(text).map((segment) => Object.freeze({
        text: segment.text,
        startCodeUnit: segment.startCodeUnit,
        endCodeUnit: segment.endCodeUnit,
        advance: cssMultiply(cellWidthCssPx, segment.cells * scale)
      }));
    },
    fontMetrics: metrics,
    defaultFontMetrics() {
      return metrics(cssPx(16));
    }
  };
}
