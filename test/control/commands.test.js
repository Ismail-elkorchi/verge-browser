import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../../dist/app/commands.js";

test("parseCommand handles link index", () => {
  assert.deepEqual(parseCommand("open 7"), { kind: "open-link", index: 7 });
  assert.deepEqual(parseCommand("7"), { kind: "open-link", index: 7 });
});

test("parseCommand handles navigation and control", () => {
  assert.deepEqual(parseCommand("go example.com"), { kind: "go", target: "example.com" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("back"), { kind: "back" });
});
