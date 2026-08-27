import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

async function files(paths) {
  return Promise.all(paths.map(async (path) => [path, await source(path)]));
}

async function sourcePaths() {
  const entries = await readdir(resolve(root, "src"), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

test("parser and framework imports obey rendering ownership boundaries", async () => {
  for (const [path, text] of await files(await sourcePaths())) {
    if (text.includes("@ismail-elkorchi/html-parser")) {
      assert.match(path, /^src\/document\//u, `${path} bypasses the document boundary`);
    }
    if (text.includes("@ismail-elkorchi/css-parser")) {
      assert.match(path, /^src\/presentation\/style\//u, `${path} bypasses the style boundary`);
    }
    if (/^src\/(document|presentation\/(style|formatting|layout|search|terminal|text))\//u.test(path)) {
      assert.doesNotMatch(text, /from\s+["'](?:node:|[^"']*(?:terminal-ui|http-client|cookie|storage\.js|fetch-page\.js))/u, `${path} imports an outer subsystem`);
    }
    if (path.startsWith("src/ui/")) {
      assert.doesNotMatch(text, /@ismail-elkorchi\/(?:html|css)-parser/u, `${path} imports a parser directly`);
      assert.doesNotMatch(
        text,
        /\b(?:resolveCssLength|collapseMargins|buildLineBoxes|calculateTableColumns|calculateFlexLines|calculateGridTracks)\b/u,
        `${path} implements a CSS layout algorithm`
      );
    }
    if (path.startsWith("src/presentation/layout/")) {
      assert.doesNotMatch(text, /(?:presentation\/terminal|terminal-ui|Terminal(?:Cell|Row|Column|Profile|Viewport|Style))/u, `${path} crosses into terminal rendering`);
    }
    if (path.startsWith("src/document/")) {
      assert.doesNotMatch(text, /from\s+["'][^"']*presentation\//u, `${path} imports the rendering hierarchy`);
    }
    if (path.startsWith("src/unicode/")) {
      assert.doesNotMatch(
        text,
        /from\s+["'][^"']*(?:document|presentation|ui|app)\//u,
        `${path} imports a browser-engine subsystem`
      );
    }
  }
});

test("legacy flat renderer contracts and files are absent", async () => {
  const forbidden = /\b(?:PageContent|PageBlock|PageLayout|RenderedPage|RenderedActionable|RenderedLink|RenderInput|PageRenderer|renderDocumentToTerminal|renderPageContent|buildPageContent|widthProvider)\b/u;
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, forbidden, `${relative(root, resolve(root, path))} retains a flat renderer contract`);
  }
});

test("rendering internals use precise domain contracts rather than generic aliases", async () => {
  const forbidden = /\b(?:DocumentPresentation|PresentationTree|TerminalProjection|RenderedRepresentation|SearchProjection|ProjectionResult|ViewModel|RenderData|LayoutData|Output)\b/u;
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, forbidden, `${path} contains an imprecise rendering contract`);
  }
});

test("layout, display-list, and cell-rasterizer boundaries are explicit", async () => {
  const displayList = await source("src/presentation/terminal/display-list.ts");
  const rasterizer = await source("src/presentation/terminal/rasterizer.ts");
  const terminalFiles = await readdir(resolve(root, "src/presentation/terminal"));
  assert.match(displayList, /LayoutFragment/u);
  assert.match(displayList, /inlineContinuations/u);
  assert.match(displayList, /buildTerminalDisplayList/u);
  assert.match(displayList, /input\.layout\.fragment\(childId\)/u);
  assert.match(displayList, /input\.layout\.stacking\(/u);
  assert.match(displayList, /paintStackingContext/u);
  assert.doesNotMatch(displayList, /visualFragment|visualLineFragments|lineForFragment/u);
  assert.doesNotMatch(displayList, /FormattingTree|ComputedStyle|CssLength/u);
  assert.match(rasterizer, /TerminalPaintCommand/u);
  assert.match(rasterizer, /rasterizeTerminalDisplayList/u);
  assert.match(rasterizer, /rasterizeTerminalCells/u);
  assert.match(rasterizer, /buildTerminalIndexes/u);
  assert.doesNotMatch(rasterizer, /FormattingTree|ComputedStyle|CssLength/u);
  assert.doesNotMatch(rasterizer, /Math\.(?:min|max)\(\.\.\./u);
  const fixed = await source("src/presentation/layout/fixed.ts");
  const layout = await source("src/presentation/layout/layout.ts");
  assert.doesNotMatch(fixed, /Math\.(?:min|max)\(\.\.\./u);
  assert.doesNotMatch(layout, /\.\.\.profiles\.flatMap/u);
  assert.doesNotMatch(layout, /stretchFlexItemCrossSize|stretch.*Rect(?:angle)?/u);
  assert.ok(!terminalFiles.includes("layout.ts"));
  assert.ok(!terminalFiles.includes("visible-text.ts"));
  const formerHelpers = /\b(?:buildFragmentTree|FragmentTree|TerminalFragment|TerminalRow|estimatedHeight|InlineCursor|buildVisibleTextIndex|VisibleTextIndex)\b/u;
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, formerHelpers, `${path} retains former terminal-cell layout ownership`);
  }
});

test("rendering cancellation and text ownership have one precise boundary", async () => {
  const pipeline = await source("src/presentation/pipeline.ts");
  const layoutTypes = await source("src/presentation/layout/types.ts");
  const terminalTypes = await source("src/presentation/terminal/types.ts");
  const search = await source("src/presentation/search/text-search-index.ts");
  const inlineItems = await source("src/presentation/text/inline-item-stream.ts");
  const formattingText = await source("src/presentation/formatting/control-display-text.ts");
  const sharedText = await source("src/presentation/text/css-text.ts");
  assert.match(pipeline, /interface RenderDocumentInput[\s\S]*signal\?: AbortSignal/u);
  assert.doesNotMatch(layoutTypes, /interface LayoutContext\s*\{[^}]*\bsignal/u);
  assert.doesNotMatch(terminalTypes, /interface TerminalRenderContext\s*\{[^}]*\bsignal/u);
  assert.doesNotMatch(search, /FormattingFormControlNode|controlDisplayText/u);
  assert.match(search, /formattingNodeLogicalText/u);
  assert.match(formattingText, /controlDisplayText/u);
  assert.match(search, /InlineItemStreamSet/u);
  assert.doesNotMatch(search, /processCssText|processedText\(/u);
  assert.match(inlineItems, /processCssText/u);
  assert.match(layoutTypes, /InlineItemStreamSet/u);
  assert.doesNotMatch(layoutTypes, /TextSearchIndex/u);
  assert.match(sharedText, /transformTextWithSourceRanges/u);
  assert.doesNotMatch(search, /matchAll\(\/\\s\+\|\\S\+/u);
});

test("Unicode text analysis has one pinned internal ownership path", async () => {
  const document = await source("src/document/snapshot.ts");
  const style = await source("src/presentation/style/types.ts");
  const layout = await source("src/presentation/layout/layout.ts");
  const displayList = await source("src/presentation/terminal/display-list.ts");
  const rasterizer = await source("src/presentation/terminal/rasterizer.ts");
  const generated = await source("src/unicode/generated/unicode-17.ts");
  const rootDeclaration = await source("dist/mod.d.ts");
  assert.match(document, /DocumentDirectionality/u);
  assert.match(document, /bidiClass/u);
  assert.match(style, /readonly direction: "ltr" \| "rtl"/u);
  assert.match(style, /readonly unicodeBidi:/u);
  assert.match(layout, /resolveBidiParagraphs/u);
  assert.match(layout, /buildLineBreakMap/u);
  assert.match(layout, /bidiVisualOrderForLine/u);
  assert.doesNotMatch(displayList, /visualFragment|visualLineFragments|lineForFragment/u);
  assert.doesNotMatch(rasterizer, /segmentGraphemeClusters|resolveBidi|buildLineBreakMap|bidiClass/u);
  assert.match(generated, /UNICODE_VERSION = "17\.0\.0"/u);
  const generatedOwners = (await sourcePaths()).filter((path) => path.endsWith("generated/unicode-17.ts"));
  assert.deepEqual(generatedOwners, ["src/unicode/generated/unicode-17.ts"]);
  assert.doesNotMatch(rootDeclaration, /\b(?:BidiParagraph|BidiRun|LineBreakMap|GraphemeClusterStream|ProcessedCssText)\b/u);
});

test("web compatibility tooling and CSS ownership remain outside the runtime rendering path", async () => {
  const manifest = JSON.parse(await source("package.json"));
  const lockfile = await source("package-lock.json");
  const application = await source("src/app/session.ts");
  const styleTypes = await source("src/presentation/style/types.ts");
  const dependencyInspection = await source("src/presentation/style/stylesheet-dependencies.ts");
  const valueEvaluator = await source("src/presentation/style/css-values.ts");
  const flexLayout = await source("src/presentation/layout/flex.ts");
  const terminal = (await files((await sourcePaths()).filter((path) => path.startsWith("src/presentation/terminal/"))))
    .map(([, text]) => text).join("\n");
  assert.equal(manifest.dependencies?.["playwright-core"], undefined);
  assert.equal(manifest.devDependencies?.["playwright-core"], undefined);
  assert.doesNotMatch(lockfile, /(?:playwright|puppeteer|chromium)/iu);
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, /(?:playwright|puppeteer|chromium)/iu, `${path} contains a browser-backed runtime path`);
  }
  assert.match(application, /inspectStylesheetBytes/u);
  assert.match(application, /implementationSupportsCondition/u);
  assert.doesNotMatch(application, /(?:supportedProperties|SUPPORTED_PROPERTIES|implementationSupportsDeclaration)/u);
  for (const field of [
    "rootOrder", "dependencyOrder", "importDepth", "importedFrom", "importLayer",
    "mediaConditions", "supportsConditions", "predeclaredLayers", "parsedRules"
  ]) {
    assert.match(styleTypes, new RegExp(`readonly ${field}:`, "u"));
    assert.doesNotMatch(styleTypes, new RegExp(`readonly ${field}\\?:`, "u"));
  }
  assert.doesNotMatch(dependencyInspection, /(?:fetch\(|Http|Cookie|node:)/u);
  assert.match(valueEvaluator, /parseComponentValues/u);
  assert.match(valueEvaluator, /resolveCssVariables/u);
  assert.match(flexLayout, /resolveFlexibleLengths/u);
  assert.match(flexLayout, /collectLines/u);
  assert.doesNotMatch(terminal, /(?:flexBaseSize|resolveFlexLines|positionedContainingBlock|float:\s*["'])/u);
  const compatibilityHarness = await source("scripts/compat/run.mjs");
  assert.match(compatibilityHarness, /BrowserSession/u);
  assert.match(compatibilityHarness, /paintedCellMeaningfulTextRecall/u);
  assert.doesNotMatch(compatibilityHarness, /parseWebDocument/u);
});

test("the document barrel exposes no concrete snapshot or parser implementation", async () => {
  const declaration = await source("dist/document/index.d.ts");
  assert.doesNotMatch(
    declaration,
    /(?:snapshot\.js|@ismail-elkorchi\/html-parser)/u
  );
});

test("the root API does not publish document construction, editing, or mutable state contracts", async () => {
  const declaration = await source("dist/mod.d.ts");
  assert.doesNotMatch(
    declaration,
    /\b(?:parseWebDocument|createDocumentState|applyDocumentAction|DocumentEdit|applySourceEdits|applyEdits)\b/u
  );
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, /\b(?:DocumentEdit|applySourceEdits|applyEdits)\b/u, `${path} retains source editing`);
  }
  assert.doesNotMatch(
    declaration,
    /\b(?:StyleSnapshot|FormattingTree|InlineItemStreamSet|LayoutFragmentTree|TerminalDisplayList|TerminalCellBuffer|TextSearchIndex|RenderPipelineResult|ReaderDocument)\b/u
  );
});
