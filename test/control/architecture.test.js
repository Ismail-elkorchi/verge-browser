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
    if (/^src\/(document|presentation\/(style|formatting|layout|search|terminal))\//u.test(path)) {
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
  assert.match(displayList, /buildTerminalDisplayList/u);
  assert.doesNotMatch(displayList, /FormattingTree|CssLength/u);
  assert.match(rasterizer, /TerminalPaintCommand/u);
  assert.match(rasterizer, /rasterizeTerminalDisplayList/u);
  assert.doesNotMatch(rasterizer, /FormattingTree|ComputedStyle|CssLength/u);
  assert.ok(!terminalFiles.includes("layout.ts"));
  assert.ok(!terminalFiles.includes("visible-text.ts"));
  const formerHelpers = /\b(?:buildFragmentTree|FragmentTree|TerminalFragment|TerminalRow|estimatedHeight|flexBasis|InlineCursor|buildVisibleTextIndex|VisibleTextIndex)\b/u;
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, formerHelpers, `${path} retains former terminal-cell layout ownership`);
  }
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
    /\b(?:StyleSnapshot|FormattingTree|LayoutFragmentTree|TerminalDisplayList|TerminalCellBuffer|TextSearchIndex|RenderPipelineResult|ReaderDocument)\b/u
  );
});
