import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../../dist/app/commands.js";

test("parseCommand handles link index", () => {
  assert.deepEqual(parseCommand("open 7"), { kind: "open-link", index: 7 });
  assert.deepEqual(parseCommand("7"), { kind: "open-link", index: 7 });
});

test("parseCommand handles navigation and control", () => {
  assert.deepEqual(parseCommand("go example.com"), { kind: "go", target: "example.com" });
  assert.deepEqual(parseCommand("stream example.com"), { kind: "go-stream", target: "example.com" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("reader"), { kind: "reader" });
  assert.deepEqual(parseCommand("back"), { kind: "back" });
  assert.deepEqual(parseCommand("diag"), { kind: "diag" });
  assert.deepEqual(parseCommand("outline"), { kind: "outline" });
});

test("parseCommand handles bookmark and history commands", () => {
  assert.deepEqual(parseCommand("bookmark"), { kind: "bookmark-list" });
  assert.deepEqual(parseCommand("bookmark add"), { kind: "bookmark-add" });
  assert.deepEqual(parseCommand("bookmark add Main Site"), { kind: "bookmark-add", name: "Main Site" });
  assert.deepEqual(parseCommand("bookmark open 2"), { kind: "bookmark-open", index: 2 });
  assert.deepEqual(parseCommand("cookie"), { kind: "cookie-list" });
  assert.deepEqual(parseCommand("cookie clear"), { kind: "cookie-clear" });
  assert.deepEqual(parseCommand("history"), { kind: "history-list" });
  assert.deepEqual(parseCommand("history open 1"), { kind: "history-open", index: 1 });
  assert.deepEqual(parseCommand("recall alpha beta"), { kind: "recall", query: "alpha beta" });
  assert.deepEqual(parseCommand("recall open 1"), { kind: "recall-open", index: 1 });
  assert.deepEqual(parseCommand("form"), { kind: "form-list" });
  assert.deepEqual(parseCommand("form submit 1"), { kind: "form-submit", index: 1, overrides: {} });
  assert.deepEqual(parseCommand("form submit 2 q=term page=3"), {
    kind: "form-submit",
    index: 2,
    overrides: { q: "term", page: "3" }
  });
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
  assert.deepEqual(parseCommand("download ./snapshot.html"), {
    kind: "download",
    path: "./snapshot.html"
  });
});

test("parseCommand rejects non-positive indices", () => {
  assert.deepEqual(parseCommand("open 0"), {
    kind: "go",
    target: "0"
  });
  assert.deepEqual(parseCommand("bookmark open 0"), {
    kind: "invalid",
    reason: "bookmark open requires a positive numeric index"
  });
  assert.deepEqual(parseCommand("history open 0"), {
    kind: "invalid",
    reason: "history open requires a positive numeric index"
  });
});
