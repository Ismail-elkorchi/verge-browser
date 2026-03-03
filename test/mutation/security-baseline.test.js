import test from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";

import { assertAllowedProtocol } from "../../dist/app/security.js";

test("baseline: assertAllowedProtocol rejects javascript protocol", () => {
  assert.throws(
    () => assertAllowedProtocol(new URL("javascript:alert(1)")),
    /Blocked unsupported protocol/
  );
});
