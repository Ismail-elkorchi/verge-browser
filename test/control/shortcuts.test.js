import assert from "node:assert/strict";
import test from "node:test";

import { resolveShortcutAction } from "../../dist/app/shortcuts.js";

test("resolveShortcutAction maps pager movement keys", () => {
  assert.deepEqual(resolveShortcutAction("j", { sequence: "j" }), { kind: "scroll-line-down" });
  assert.deepEqual(resolveShortcutAction("", { sequence: "\u001b[B", name: "down" }), { kind: "scroll-line-down" });
  assert.deepEqual(resolveShortcutAction("k", { sequence: "k" }), { kind: "scroll-line-up" });
  assert.deepEqual(resolveShortcutAction(" ", { sequence: " " }), { kind: "scroll-page-down" });
  assert.deepEqual(resolveShortcutAction("b", { sequence: "b" }), { kind: "scroll-page-up" });
  assert.deepEqual(resolveShortcutAction("g", { sequence: "g", shift: false }), { kind: "scroll-top" });
  assert.deepEqual(resolveShortcutAction("G", { sequence: "G", shift: true }), { kind: "scroll-bottom" });
});

test("resolveShortcutAction maps command shortcuts", () => {
  assert.deepEqual(resolveShortcutAction("?", { sequence: "?" }), {
    kind: "run-command",
    command: { kind: "help" }
  });
  assert.deepEqual(resolveShortcutAction("l", { sequence: "l" }), {
    kind: "run-command",
    command: { kind: "links" }
  });
  assert.deepEqual(resolveShortcutAction("o", { sequence: "o" }), {
    kind: "run-command",
    command: { kind: "outline" }
  });
  assert.deepEqual(resolveShortcutAction("d", { sequence: "d" }), {
    kind: "run-command",
    command: { kind: "diag" }
  });
  assert.deepEqual(resolveShortcutAction("m", { sequence: "m" }), {
    kind: "run-command",
    command: { kind: "bookmark-add" }
  });
  assert.deepEqual(resolveShortcutAction("", { sequence: "H", name: "h", shift: true }), {
    kind: "run-command",
    command: { kind: "history-list" }
  });
});

test("resolveShortcutAction maps lifecycle keys", () => {
  assert.deepEqual(resolveShortcutAction(":", { sequence: ":" }), { kind: "prompt" });
  assert.deepEqual(resolveShortcutAction("/", { sequence: "/" }), { kind: "search-prompt" });
  assert.deepEqual(resolveShortcutAction("n", { sequence: "n" }), { kind: "search-next" });
  assert.deepEqual(resolveShortcutAction("N", { sequence: "N", shift: true }), { kind: "search-prev" });
  assert.deepEqual(resolveShortcutAction("", { sequence: "\u0003", name: "c", ctrl: true }), { kind: "quit" });
  assert.deepEqual(resolveShortcutAction("q", { sequence: "q" }), { kind: "quit" });
  assert.deepEqual(resolveShortcutAction("", { sequence: "\u001b", name: "escape" }), { kind: "show-page" });
});

test("resolveShortcutAction ignores unmapped keys", () => {
  assert.equal(resolveShortcutAction("x", { sequence: "x" }), null);
});
