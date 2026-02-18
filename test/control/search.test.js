import assert from "node:assert/strict";
import test from "node:test";

import { activeSearchLineIndex, createSearchState, moveSearchMatch } from "../../dist/app/search.js";

test("createSearchState finds case-insensitive line matches", () => {
  const state = createSearchState(["Alpha", "beta", "ALPHA beta"], "alpha");
  assert.equal(state.query, "alpha");
  assert.deepEqual(state.matchLineIndices, [0, 2]);
  assert.equal(activeSearchLineIndex(state), 0);
});

test("moveSearchMatch cycles through matches", () => {
  const state = createSearchState(["one", "two one", "three"], "one");
  const next = moveSearchMatch(state, "next");
  assert.equal(activeSearchLineIndex(next), 1);

  const wrap = moveSearchMatch(next, "next");
  assert.equal(activeSearchLineIndex(wrap), 0);

  const prev = moveSearchMatch(wrap, "prev");
  assert.equal(activeSearchLineIndex(prev), 1);
});
