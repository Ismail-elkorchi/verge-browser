import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWptDeltaCase } from "../../scripts/eval/wpt-delta-lib.mjs";

test("wpt delta case evaluation is deterministic", () => {
  const caseEntry = {
    id: "sample",
    snapshotId: "snapshot-a",
    sourcePath: "sample.html",
    sha256: "dummy",
    html: "<!doctype html><html><body><p>Hello <a href='/a'>link</a></p></body></html>"
  };

  const first = evaluateWptDeltaCase(caseEntry);
  const second = evaluateWptDeltaCase(caseEntry);
  assert.deepEqual(second, first);
});
