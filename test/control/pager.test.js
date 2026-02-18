import assert from "node:assert/strict";
import test from "node:test";

import {
  createPager,
  pagerBottom,
  pagerLineDown,
  pagerLineUp,
  pagerPageDown,
  pagerPageUp,
  pagerTop,
  pagerJumpToLine,
  pagerViewport,
  setPagerLines
} from "../../dist/app/pager.js";

test("pager viewport updates with line and page movement", () => {
  const lines = ["1", "2", "3", "4", "5", "6", "7"];
  const pager = createPager(lines, 3);

  assert.deepEqual(pagerViewport(pager).lines, ["1", "2", "3"]);

  pagerLineDown(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["2", "3", "4"]);

  pagerPageDown(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["5", "6", "7"]);

  pagerPageUp(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["2", "3", "4"]);

  pagerBottom(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["5", "6", "7"]);

  pagerTop(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["1", "2", "3"]);

  pagerLineUp(pager);
  assert.deepEqual(pagerViewport(pager).lines, ["1", "2", "3"]);
});

test("setPagerLines clamps offset to valid range", () => {
  const pager = createPager(["a", "b", "c", "d"], 2);
  pagerPageDown(pager);
  pagerPageDown(pager);

  setPagerLines(pager, ["x", "y"], 2);
  const viewport = pagerViewport(pager);
  assert.equal(viewport.startLine, 1);
  assert.deepEqual(viewport.lines, ["x", "y"]);
});

test("pagerJumpToLine moves viewport to requested line", () => {
  const pager = createPager(["a", "b", "c", "d", "e"], 2);
  pagerJumpToLine(pager, 3);
  const viewport = pagerViewport(pager);
  assert.deepEqual(viewport.lines, ["d", "e"]);
});
