import { measureElement } from "@ismail-elkorchi/terminal-ui/renderer";
import { nativeFormControl } from "./native-control.js";
import type { CssControlMeasurer } from "../presentation/layout/index.js";
import {
  terminalTextWidth,
  type TextWidthProfile
} from "@ismail-elkorchi/terminal-ui/text";

import {
  cssMultiply,
  cssNonNegativeLength,
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

const TEXT_MEASURERS = new Map<string, CssTextMeasurer>();

export function terminalCssTextMeasurer(
  cellWidthCssPx: CssPixelLength = cssPx(8),
  rowHeightCssPx: CssPixelLength = cssPx(16),
  ambiguousWidth: 1 | 2 = 1
): CssTextMeasurer {
  const identity = `${String(cellWidthCssPx)}:${String(rowHeightCssPx)}:${String(ambiguousWidth)}`;
  const retained = TEXT_MEASURERS.get(identity);
  if (retained !== undefined) return retained;
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
  const measurer: CssTextMeasurer = {
    measure(text, fontSize) {
      return fontSize > 0 ? cssMultiply(cellWidthCssPx, cells.width(text)) : cssPx(0);
    },
    fontMetrics: metrics,
    defaultFontMetrics() {
      return metrics(cssPx(16));
    }
  };
  Object.freeze(measurer);
  if (TEXT_MEASURERS.size >= 32) { const oldest = TEXT_MEASURERS.keys().next().value; if (oldest !== undefined) TEXT_MEASURERS.delete(oldest); }
  TEXT_MEASURERS.set(identity, measurer);
  return measurer;
}

/** Uses the exact mounted component factory; presentation never imports terminal-ui. */
export function terminalCssControlMeasurer(
  cellWidthCssPx: CssPixelLength = cssPx(8),
  rowHeightCssPx: CssPixelLength = cssPx(16),
  ambiguousWidth: 1 | 2 = 1
): CssControlMeasurer {
  return {
    identity: `native-controls:${String(cellWidthCssPx)}:${String(rowHeightCssPx)}:${String(ambiguousWidth)}`,
    measure(control, document, state) {
      let measuredControl = control;
      let measuredState = state;
      if (control.kind === "text" || control.kind === "textarea") {
        // HTML size/cols/rows, rather than the current value, owns editor sizing.
        measuredState = { ...state, controls: new Map([[control.node, { kind: "value", value: "" }]]) };
      } else if (control.kind === "select" && !control.multiple) {
        // An auto-sized HTML select reserves its widest option even while closed.
        // Measure that caption with the native anatomy once; do not build N collections.
        const cells = terminalCellMeasurer(ambiguousWidth);
        let widest = control.options[0];
        let widestCells = -1;
        for (const option of control.options) {
          const width = cells.width(option.label);
          if (width > widestCells) { widest = option; widestCells = width; }
        }
        measuredControl = { ...control, options: widest === undefined ? [] : [{ ...widest, disabled: false }] };
        measuredState = { ...state, controls: new Map([[control.node,
          { kind: "selected", selected: widest === undefined ? [] : [widest.node] }]]) };
      }
      const element = nativeFormControl({ document, documentState: measuredState, formEditors: {} }, measuredControl, control.form);
      if (element === null) return { width: cssNonNegativeLength(cssPx(0)), height: cssNonNegativeLength(cssPx(0)), baseline: null };
      const measured = measureElement(element, { columns: 10_000, rows: 1 }, { widthProfile: widthProfile(ambiguousWidth) });
      return Object.freeze({ width: cssNonNegativeLength(cssMultiply(cellWidthCssPx, measured.preferredWidth)),
        // Scrolling multiline widgets export no intrinsic text baseline.
        baseline: control.kind === "textarea" || (control.kind === "select" && control.multiple) ? null
          : terminalCssTextMeasurer(cellWidthCssPx, rowHeightCssPx, ambiguousWidth).defaultFontMetrics().baseline,
        height: cssNonNegativeLength(cssMultiply(rowHeightCssPx, control.kind === "textarea" ? measured.minHeight : measured.preferredHeight)) });
    },
  };
}
