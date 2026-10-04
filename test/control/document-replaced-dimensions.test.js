import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { buildLayoutFragmentTree, cssCoordinate, cssPixels, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import { terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

const context = { requestUrl: "https://dimensions.test/", finalUrl: "https://dimensions.test/" };

test("SVG replacement metadata preserves explicit nonnegative finite dimensions", () => {
  for (const [attributes, width, height] of [
    ['width="20" height="20"', 20, 20], ['width="12.5" height="3e1"', 12.5, 30],
    ['width="0" height="0"', 0, 0], ['width="-1" height="Infinity"', null, null],
    ['width="100%" height="auto"', null, null], ["", null, null],
  ]) {
    const document = parseWebDocument(`<!doctype html><svg id=t ${attributes}><title>Icon</title></svg>`, context);
    const replacement = document.replaced(document.elementById("t"));
    assert.equal(replacement.kind, "svg");
    assert.equal(replacement.width, width);
    assert.equal(replacement.height, height);
    assert.equal(replacement.fallbackText, "Icon");
  }
});

test("SVG intrinsic dimensions flow through formatting while CSS sizing takes precedence", () => {
  for (const [css, expectedWidth, expectedHeight] of [["", 20, 24], ["width:40px;height:32px", 40, 32]]) {
    const document = parseWebDocument(`<!doctype html><svg id=t width=20 height=24 style="${css}"></svg>`, context);
    const state = createDocumentState(document);
    const styles = resolveStyles({ program: compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) }), state,
      environment: { viewportWidthCssPx: 640, viewportHeightCssPx: 384, mediaType: "screen", prefersColorScheme: "dark", reducedMotion: false, hover: "none", pointer: "none" } });
    const formatting = buildFormattingTree({ document, state, styles });
    const inlineItemStreams = buildInlineItemStreamSet(formatting);
    const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(640), cssPx(384));
    const layout = buildLayoutFragmentTree({ formatting, inlineItemStreams, context: {
      viewport: { width: rect.width, height: rect.height }, initialContainingBlock: rect, scrollport: rect,
      controlMeasurer: terminalCssControlMeasurer(),
      textMeasurer: terminalCssTextMeasurer(cssPx(8), cssPx(16)),
    } });
    assert.equal(layout.outcome.status, "complete");
    const fragment = layout.forDocumentNode(document.elementById("t")).find((entry) => entry.kind === "replaced");
    assert.ok(fragment);
    assert.equal(cssPixels(fragment.contentRect.width), expectedWidth);
    assert.equal(cssPixels(fragment.contentRect.height), expectedHeight);
  }
});
