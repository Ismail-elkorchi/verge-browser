import assert from "node:assert/strict";
import test from "node:test";

import { resolveShellKeyAction } from "../../dist/ui/keymap.js";

test("resolveShellKeyAction maps browse-screen navigation keys", () => {
  assert.deepEqual(resolveShellKeyAction("]", { sequence: "]" }, { screen: "browse" }), { kind: "next-actionable" });
  assert.deepEqual(resolveShellKeyAction("[", { sequence: "[" }, { screen: "browse" }), { kind: "prev-actionable" });
  assert.deepEqual(resolveShellKeyAction("g", { sequence: "g" }, { screen: "browse" }), { kind: "open-location" });
  assert.deepEqual(resolveShellKeyAction(":", { sequence: ":" }, { screen: "browse" }), { kind: "open-action-palette" });
  assert.deepEqual(resolveShellKeyAction("/", { sequence: "/" }, { screen: "browse" }), { kind: "open-search" });
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\r", name: "return" }, { screen: "browse" }), {
    kind: "activate"
  });
});

test("resolveShellKeyAction maps picker navigation and filtering", () => {
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\u001b[B", name: "down" }, {
    screen: "picker",
    pickerFocusTarget: "list"
  }), { kind: "picker-down" });
  assert.deepEqual(resolveShellKeyAction("/", { sequence: "/" }, {
    screen: "picker",
    pickerFocusTarget: "list"
  }), { kind: "picker-toggle-filter" });
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\r", name: "return" }, {
    screen: "picker",
    pickerFocusTarget: "list"
  }), { kind: "picker-activate" });
});

test("resolveShellKeyAction maps editor select and edit modes separately", () => {
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\r", name: "return" }, {
    screen: "editor",
    editorMode: "select"
  }), { kind: "editor-enter-edit" });
  assert.deepEqual(resolveShellKeyAction("s", { sequence: "s" }, {
    screen: "editor",
    editorMode: "select"
  }), { kind: "editor-submit" });
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\u007f", name: "backspace" }, {
    screen: "editor",
    editorMode: "edit"
  }), { kind: "text-backspace" });
  assert.deepEqual(resolveShellKeyAction("", { sequence: "\u001b", name: "escape" }, {
    screen: "editor",
    editorMode: "edit"
  }), { kind: "editor-cancel" });
});
