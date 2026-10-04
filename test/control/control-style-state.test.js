import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { controlDisplayText } from "../../dist/presentation/formatting/control-display-text.js";

const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen", prefersColorScheme: "dark", reducedMotion: true, hover: "hover", pointer: "fine" };

function fixture(markup) {
  const document = parseWebDocument(`<style>option {font-weight:400} option:checked {font-weight:700}</style>${markup}`, { requestUrl: "https://example.test/", finalUrl: "https://example.test/" });
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  return { document, resolve: (state) => resolveStyles({ program, state, environment }) };
}

test(":checked shares canonical first-enabled, listbox and duplicate-option identity state", () => {
  const { document, resolve } = fixture(`<form>
    <select><option disabled>Disabled</option><option>Enabled</option></select>
    <select size="2"><option>None selected</option></select>
    <select><option value="same" selected>First</option><option value="same" selected>Last</option></select>
  </form>`);
  const [fallback, listbox, duplicate] = document.controls;
  let state = createDocumentState(document);
  const weights = () => {
    const styles = resolve(state);
    return document.controls.map((control) => control.options.map((option) => styles.style(option.node).text.fontWeight));
  };
  assert.deepEqual(weights(), [[400, 700], [400], [400, 700]]);
  state = applyDocumentAction(document, state, { kind: "set-selected-options", target: duplicate.node, options: [duplicate.options[0].node] });
  state = applyDocumentAction(document, state, { kind: "set-selected-options", target: fallback.node, options: [] });
  state = applyDocumentAction(document, state, { kind: "set-selected-options", target: listbox.node, options: [listbox.options[0].node] });
  assert.deepEqual(weights(), [[400, 400], [700], [700, 400]]);
  state = applyDocumentAction(document, state, { kind: "reset-form", target: document.forms[0].node });
  assert.deepEqual(weights(), [[400, 700], [400], [400, 700]]);
});

test("atomic control painting uses visible captions while keeping names and submitted values separate", () => {
  const { document, resolve } = fixture(`<form><input type="submit" value="Go" aria-label="Search now"><input type="submit" value=""><button value="send" aria-label="Send message"><img alt="Paper plane"></button></form>`);
  const state = createDocumentState(document);
  const formatting = buildFormattingTree({ document, state, styles: resolve(state) });
  const displays = document.controls.map((control) => controlDisplayText(formatting.forSource(control.node).find((node) => node.kind === "form-control"), formatting));
  assert.deepEqual(displays.map(({ text, label, value }) => [text, label, value]), [["[Go]", "Search now", "Go"], ["[]", "", ""], ["[Paper plane]", "Send message", "send"]]);
});
