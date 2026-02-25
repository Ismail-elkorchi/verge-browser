import assert from "node:assert/strict";
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

test("oracle supply-chain policy passes when provenance constraints hold", () => {
  const report = evaluateOracleSupplyChain({
    config: baseConfig(),
    lockFile: baseLockFile(),
    runtimeReport: baseRuntimeReport()
  });

  assert.equal(report.ok, true);
  assert.equal(report.provenance.ok, true);
  assert.deepEqual(report.provenance.failures, []);
});

test("oracle supply-chain policy fails on UNKNOWN signature key", () => {
  const lockFile = baseLockFile();
  lockFile.releaseMetadata[0].signatureKey = "UNKNOWN";

  const report = evaluateOracleSupplyChain({
    config: baseConfig(),
    lockFile,
    runtimeReport: baseRuntimeReport()
  });

  assert.equal(report.ok, false);
  assert.equal(report.provenance.ok, false);
  assert.ok(report.provenance.failures.some((failure) => failure.includes("must not be UNKNOWN")));
});

test("oracle supply-chain policy fails on insecure package download URL", () => {
  const lockFile = baseLockFile();
  lockFile.packages[0].downloadUrl = "http://snapshot.ubuntu.com/ubuntu/pool/universe/l/lynx/lynx_2.9.2-1_amd64.deb";

  const report = evaluateOracleSupplyChain({
    config: baseConfig(),
    lockFile,
    runtimeReport: baseRuntimeReport()
  });

  assert.equal(report.ok, false);
  assert.equal(report.provenance.ok, false);
  assert.ok(report.provenance.failures.some((failure) => failure.includes("downloadUrl must be an https URL")));
});
