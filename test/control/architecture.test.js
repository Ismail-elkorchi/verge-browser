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
    if (/^src\/(document|presentation\/(style|formatting|terminal))\//u.test(path)) {
      assert.doesNotMatch(text, /from\s+["'](?:node:|[^"']*(?:terminal-ui|http-client|cookie|storage\.js|fetch-page\.js))/u, `${path} imports an outer subsystem`);
    }
    if (path.startsWith("src/ui/")) {
      assert.doesNotMatch(text, /@ismail-elkorchi\/(?:html|css)-parser/u, `${path} imports a parser directly`);
    }
  }
});

test("legacy flat renderer contracts and files are absent", async () => {
  const forbidden = /\b(?:PageContent|PageBlock|PageLayout|RenderedPage|RenderedActionable|RenderedLink|RenderInput|PageRenderer|renderDocumentToTerminal|renderPageContent|buildPageContent|widthProvider)\b/u;
  for (const [path, text] of await files(await sourcePaths())) {
    assert.doesNotMatch(text, forbidden, `${relative(root, resolve(root, path))} retains a flat renderer contract`);
  }
});

test("the public document barrel exposes no concrete snapshot or parser implementation", async () => {
  const declaration = await source("dist/document/index.d.ts");
  assert.doesNotMatch(
    declaration,
    /(?:WebDocumentSnapshot|snapshot\.js|@ismail-elkorchi\/html-parser)/u
  );
});
