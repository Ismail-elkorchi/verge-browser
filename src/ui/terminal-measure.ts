import {
  terminalTextWidth,
  type TextWidthProfile
} from "@ismail-elkorchi/terminal-ui/text";

import {
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

function asciiCellWidth(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit > 0x7e) return null;
  }
  return text.length;
}

export function terminalCellMeasurer(ambiguousWidth: 1 | 2 = 1): TerminalCellMeasurer {
  const profile = widthProfile(ambiguousWidth);
  return {
    width(text) {
      return asciiCellWidth(text) ?? terminalTextWidth(text, { widthProfile: profile });
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
    const visible = fontSize > 0;
    const ascent = visible ? cssMultiply(rowHeightCssPx, 0.75) : cssPx(0);
    const descent = visible ? cssMultiply(rowHeightCssPx, 0.25) : cssPx(0);
    const lineGap = cssPx(0);
    return Object.freeze({
      fontSize,
      ascent,
      descent,
      lineGap,
      baseline: ascent,
      xHeight: visible ? cssMultiply(rowHeightCssPx, 0.5) : cssPx(0),
      chAdvance: visible ? cellWidthCssPx : cssPx(0)
    });
  };
  return {
    measure(text, fontSize) {
      return fontSize > 0 ? cssMultiply(cellWidthCssPx, cells.width(text)) : cssPx(0);
    },
    fontMetrics: metrics,
    defaultFontMetrics() {
      return metrics(cssPx(16));
    }
  };
}
