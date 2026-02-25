import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateOracleSupplyChain } from "../../scripts/oracles/analyze-supply-chain.mjs";

function baseConfig() {
  return {
    oracleSupplyChain: {
      maxOraclePackageCount: 110,
      requiredRootPackages: ["lynx", "w3m", "links2"],
      provenancePolicy: {
        requireSnapshotReplayMode: true,
        requireHttpsSnapshotRoot: true,
        requireSnapshotId: true,
        requireKeyringPath: true,
        requireReleaseMetadata: true,
        requireSignatureKeyHex: true,
        rejectUnknownSignatureKey: true,
        requirePackageIndexes: true,
        requireHttpsReleaseUrls: true,
        requireHttpsIndexUrls: true,
        requireIndexSha256: true,
        requireHttpsPackageDownloadUrls: true
      }
    }
  };
}

function baseLockFile() {
  return {
    rootPackages: ["lynx", "w3m", "links2"],
    sourcePolicy: {
      mode: "snapshot-replay",
      snapshotRoot: "https://snapshot.ubuntu.com/ubuntu",
      snapshotId: "20260219T043421Z",
      keyringPath: "/usr/share/keyrings/ubuntu-archive-keyring.gpg"
    },
    releaseMetadata: [
      {
        suite: "questing",
        inReleaseUrl: "https://snapshot.ubuntu.com/ubuntu/20260219T043421Z/dists/questing/InRelease",
        inReleaseSha256: "9e5889fd7c39f73bfad7847e355b514c600e004602fd4227c8cc53d4fd94b1c4",
        signatureKey: "F6ECB3762474EDA9D21B7022871920D1991BC93C",
        packageIndexes: [
          {
            component: "main",
            indexPath: "dists/questing/main/binary-amd64/Packages.xz",
            indexUrl: "https://snapshot.ubuntu.com/ubuntu/20260219T043421Z/dists/questing/main/binary-amd64/Packages.xz",
            indexSha256: "a7fb68d80f6f36e03f3bd4fdb901e7f3f055e66c5d9f5dc63b55f07e4ab2e4f4"
          }
        ]
      }
    ],
    packages: [
      {
        name: "lynx",
        version: "2.9.2-1",
        debSha256: "3333333333333333333333333333333333333333333333333333333333333333",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/l/lynx/lynx_2.9.2-1_amd64.deb"
      },
      {
        name: "w3m",
        version: "0.5.3+git20230121-2",
        debSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/w/w3m/w3m_0.5.3+git20230121-2_amd64.deb"
      },
      {
        name: "links2",
        version: "2.30-1build1",
        debSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        downloadUrl: "https://snapshot.ubuntu.com/ubuntu/pool/universe/l/links2/links2_2.30-1build1_amd64.deb"
      }
    ]
  };
}

function baseRuntimeReport() {
  return {
    image: {
      fingerprint: "8400c50d57e931489a92afdc5fb127510183b6076fafdba1a5e5c97c95f09edd"
    },
    engines: {
      lynx: { version: "2.9.2", sha256: "1".repeat(64), sizeBytes: 12345 },
      w3m: { version: "0.5.3", sha256: "2".repeat(64), sizeBytes: 22345 },
      links2: { version: "2.30", sha256: "3".repeat(64), sizeBytes: 32345 }
    }
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyMutation(target, mutation) {
  const pathParts = mutation.path.split(".");
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = Number.isNaN(Number(pathParts[index])) ? pathParts[index] : Number(pathParts[index]);
    cursor = cursor[key];
  }
  const terminalKeyRaw = pathParts[pathParts.length - 1];
  const terminalKey = Number.isNaN(Number(terminalKeyRaw)) ? terminalKeyRaw : Number(terminalKeyRaw);
  cursor[terminalKey] = mutation.value;
}

async function readCases() {
  const fixturePath = resolve("test/fixtures/oracle-supply-chain-policy-cases.json");
  const raw = await readFile(fixturePath, "utf8");
  const fixture = JSON.parse(raw);
  return fixture.cases;
}

test("oracle supply-chain fixture cases fail deterministically for malformed lock inputs", async () => {
  const cases = await readCases();
  assert.ok(Array.isArray(cases));
  assert.ok(cases.length >= 8);

  for (const caseRecord of cases) {
    const lockFile = deepClone(baseLockFile());
    for (const mutation of caseRecord.mutations) {
      applyMutation(lockFile, mutation);
    }

    const report = evaluateOracleSupplyChain({
      config: baseConfig(),
      lockFile,
      runtimeReport: baseRuntimeReport()
    });

    assert.equal(report.ok, false, `${caseRecord.id} unexpectedly passed`);
    assert.equal(report.provenance.ok, false, `${caseRecord.id} unexpectedly had provenance ok=true`);
    for (const expected of caseRecord.expectedFailureIncludes) {
      assert.ok(
        report.provenance.failures.some((failure) => failure.includes(expected)),
        `${caseRecord.id} missing failure fragment: ${expected}`
      );
    }
  }
});
