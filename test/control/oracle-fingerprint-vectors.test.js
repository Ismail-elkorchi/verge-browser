import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { computeOracleLockFingerprint, validateOracleLockFingerprintInputs } from "../../scripts/oracles/real-oracle-lib.mjs";

async function readVectors() {
  const fixturePath = resolve("test/fixtures/oracle-fingerprint-vectors.json");
  const rawText = await readFile(fixturePath, "utf8");
  const fixture = JSON.parse(rawText);
  return fixture.vectors;
}

test("oracle fingerprint vectors validate and hash to canonical values", async () => {
  const vectors = await readVectors();
  assert.ok(Array.isArray(vectors));
  assert.ok(vectors.length > 0);

  for (const vector of vectors) {
    const lockPayload = { packages: vector.packages };
    const validation = validateOracleLockFingerprintInputs(lockPayload);
    assert.equal(
      validation.ok,
      true,
      `vector ${vector.id} failed validation: ${JSON.stringify(validation.issues)}`
    );

    const fingerprint = computeOracleLockFingerprint(lockPayload);
    assert.equal(fingerprint, vector.expectedFingerprint, `vector ${vector.id} fingerprint mismatch`);
  }
});
