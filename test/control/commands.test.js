import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../../dist/app/commands.js";

test("parseCommand handles navigation and control", () => {
  assert.deepEqual(parseCommand("go example.com"), { kind: "go", target: "example.com" });
  assert.deepEqual(parseCommand("stream example.com"), { kind: "go-stream", target: "example.com" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("reader"), { kind: "reader" });
  assert.deepEqual(parseCommand("back"), { kind: "back" });
  assert.deepEqual(parseCommand("diag"), { kind: "diag" });
  assert.deepEqual(parseCommand("diagnostics"), { kind: "diag" });
  assert.deepEqual(parseCommand("outline"), { kind: "outline" });
  assert.deepEqual(parseCommand("close"), { kind: "close-document" });
  assert.deepEqual(parseCommand("reopen"), { kind: "reopen-document" });
  assert.deepEqual(parseCommand("open-external"), { kind: "open-external" });
});

test("parseCommand handles bookmark and history commands", () => {
  assert.deepEqual(parseCommand("bookmark"), { kind: "bookmark-list" });
  assert.deepEqual(parseCommand("bookmarks"), { kind: "bookmark-list" });
  assert.deepEqual(parseCommand("bookmark add"), { kind: "bookmark-add" });
  assert.deepEqual(parseCommand("bookmark add Main Site"), { kind: "bookmark-add", name: "Main Site" });
  assert.deepEqual(parseCommand("cookie"), { kind: "cookie-list" });
  assert.deepEqual(parseCommand("cookie clear"), { kind: "cookie-clear" });
  assert.deepEqual(parseCommand("history"), { kind: "history-list" });
  assert.deepEqual(parseCommand("downloads"), { kind: "download-list" });
  assert.deepEqual(parseCommand("recall alpha beta"), { kind: "recall", query: "alpha beta" });
});

test("parseCommand handles viewport commands", () => {
  assert.deepEqual(parseCommand("pagedown"), { kind: "page-down" });
  assert.deepEqual(parseCommand("pageup"), { kind: "page-up" });
  assert.deepEqual(parseCommand("top"), { kind: "page-top" });
  assert.deepEqual(parseCommand("bottom"), { kind: "page-bottom" });
  assert.deepEqual(parseCommand("find alpha"), { kind: "find", query: "alpha" });
  assert.deepEqual(parseCommand("find next"), { kind: "find-next" });
  assert.deepEqual(parseCommand("find prev"), { kind: "find-prev" });
  assert.deepEqual(parseCommand("patch remove-node 11"), { kind: "patch-remove-node", target: 11 });
  assert.deepEqual(parseCommand("patch replace-text 22 alpha beta"), {
    kind: "patch-replace-text",
    target: 22,
    value: "alpha beta"
  });
  assert.deepEqual(parseCommand("patch set-attr 7 class nav primary"), {
    kind: "patch-set-attr",
    target: 7,
    name: "class",
    value: "nav primary"
  });
  assert.deepEqual(parseCommand("patch remove-attr 7 class"), {
    kind: "patch-remove-attr",
    target: 7,
    name: "class"
  });
  assert.deepEqual(parseCommand("patch insert-before 9 <span>z</span>"), {
    kind: "patch-insert-before",
    target: 9,
    html: "<span>z</span>"
  });
  assert.deepEqual(parseCommand("patch insert-after 9 <span>z</span>"), {
    kind: "patch-insert-after",
    target: 9,
    html: "<span>z</span>"
  });
  assert.deepEqual(parseCommand("download"), { kind: "download" });
  assert.deepEqual(parseCommand("download https://example.com/archive.zip"), {
    kind: "download",
    target: "https://example.com/archive.zip"
  });
  assert.deepEqual(parseCommand("save page ./snapshot.html"), {
    kind: "save-page",
    path: "./snapshot.html"
  });
  assert.deepEqual(parseCommand("save text ./view.txt"), {
    kind: "save-text",
    path: "./view.txt"
  });
});

test("parseCommand treats unrecognized input as a location or search", () => {
  assert.deepEqual(parseCommand("0"), {
    kind: "go",
    target: "0"
  });
});
