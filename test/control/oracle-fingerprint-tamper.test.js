import assert from "node:assert/strict";
import test from "node:test";

import { computeOracleLockFingerprint, validateOracleLockFingerprintInputs } from "../../scripts/oracles/real-oracle-lib.mjs";

function sampleLock() {
  return {
    packages: [
      {
        name: "links2",
        version: "2.30-1build1",
        debSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/l/links2/links2_2.30-1build1_amd64.deb"
      },
      {
        name: "lynx",
        version: "2.9.2dev.1-1build1",
        debSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/l/lynx/lynx_2.9.2dev.1-1build1_amd64.deb"
      },
      {
        name: "w3m",
        version: "0.5.3+git20230121-2",
        debSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/w/w3m/w3m_0.5.3+git20230121-2_amd64.deb"
      }
    ]
  };
}

test("oracle lock fingerprint inputs enforce canonical package ordering", () => {
  const lockPayload = sampleLock();
  const validation = validateOracleLockFingerprintInputs(lockPayload);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.issues, []);

  const reorderedPackages = [lockPayload.packages[1], lockPayload.packages[0], lockPayload.packages[2]];
  const reorderedValidation = validateOracleLockFingerprintInputs({
    packages: reorderedPackages
  });
  assert.equal(reorderedValidation.ok, false);
  assert.ok(reorderedValidation.issues.some((issue) => issue.includes("out-of-order indexes")));

  assert.throws(
    () => computeOracleLockFingerprint({ packages: reorderedPackages }),
    /invalid oracle lock fingerprint inputs/
  );
});

test("oracle lock fingerprint detects downloadUrl tampering", () => {
  const lockPayload = sampleLock();
  const expectedFingerprint = computeOracleLockFingerprint(lockPayload);

  const tampered = sampleLock();
  tampered.packages[0].downloadUrl = "https://snapshot.ubuntu.com/ubuntu/pool/universe/l/links2/links2_tampered_amd64.deb";

  const tamperedFingerprint = computeOracleLockFingerprint(tampered);
  assert.notEqual(tamperedFingerprint, expectedFingerprint);
});

test("oracle lock fingerprint detects debSha256 tampering", () => {
  const lockPayload = sampleLock();
  const expectedFingerprint = computeOracleLockFingerprint(lockPayload);

  const tampered = sampleLock();
  tampered.packages[2].debSha256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

  const tamperedFingerprint = computeOracleLockFingerprint(tampered);
  assert.notEqual(tamperedFingerprint, expectedFingerprint);
});
