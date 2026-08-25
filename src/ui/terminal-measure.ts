import {
  measureTerminalCellText,
  terminalTextWidth,
  type TextWidthProfile
} from "@ismail-elkorchi/terminal-ui/text";

import type { TerminalTextMeasurer } from "../presentation/terminal/index.js";

export function terminalTextMeasurer(ambiguousWidth: 1 | 2 = 1): TerminalTextMeasurer {
  const widthProfile: TextWidthProfile = {
    emoji: "wide",
    ambiguous: ambiguousWidth === 2 ? "wide" : "narrow"
  };
  return {
    width(text) {
      return terminalTextWidth(text, { widthProfile });
    },
    graphemes(text) {
      return measureTerminalCellText(text, { widthProfile }).graphemes.map((segment) => ({
        text: segment.text,
        startCodeUnit: segment.startOffset,
        endCodeUnit: segment.endOffsetExclusive,
        cells: segment.cells
      }));
    }
  };
}
