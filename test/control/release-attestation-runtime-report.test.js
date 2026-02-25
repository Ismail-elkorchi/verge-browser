import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/eval/write-release-attestation-runtime-report.mjs");
const FIXTURE_DIR = resolve(REPO_ROOT, "test/fixtures/release-attestation-runtime");

function runRuntimeReportScript({
  packageInput,
  lockInput,
  certIdentityPackageInput,
  certIdentityLockInput,
  offlinePackageInput,
  offlineLockInput,
  expectedPackageSha256,
  output
}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--package-input=${packageInput}`,
      `--lock-input=${lockInput}`,
      `--cert-identity-package-input=${certIdentityPackageInput}`,
      `--cert-identity-lock-input=${certIdentityLockInput}`,
      `--offline-package-input=${offlinePackageInput}`,
      `--offline-lock-input=${offlineLockInput}`,
      `--output=${output}`,
      "--expected-repo=Ismail-elkorchi/verge-browser",
      "--expected-source-ref=refs/heads/main",
      "--expected-source-digest=0123456789abcdef0123456789abcdef01234567",
      `--expected-package-sha256=${expectedPackageSha256}`,
      "--expected-workflow=Ismail-elkorchi/verge-browser/.github/workflows/release.yml"
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }
  );
}

test("write-release-attestation-runtime-report succeeds for valid fixtures", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-attestation-runtime-ok-"));
  try {
    const outputPath = resolve(tempDir, "release-attestation-runtime-ok.json");
    const result = runRuntimeReportScript({
      packageInput: resolve(FIXTURE_DIR, "package-verify-valid.json"),
      lockInput: resolve(FIXTURE_DIR, "lock-verify-valid.json"),
      certIdentityPackageInput: resolve(FIXTURE_DIR, "package-cert-identity-verify-valid.json"),
      certIdentityLockInput: resolve(FIXTURE_DIR, "lock-cert-identity-verify-valid.json"),
      offlinePackageInput: resolve(FIXTURE_DIR, "package-offline-verify-valid.json"),
      offlineLockInput: resolve(FIXTURE_DIR, "lock-offline-verify-valid.json"),
      expectedPackageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      output: outputPath
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.overall.ok, true);
    assert.equal(report.package.ok, true);
    assert.equal(report.oracleLock.ok, true);
    assert.equal(report.package.signerWorkflow.attestationCount, 1);
    assert.equal(report.package.certIdentity.attestationCount, 1);
    assert.equal(report.package.offline.attestationCount, 1);
    assert.equal(report.oracleLock.signerWorkflow.attestationCount, 1);
    assert.equal(report.oracleLock.certIdentity.attestationCount, 1);
    assert.equal(report.oracleLock.offline.attestationCount, 1);
    assert.equal(report.package.expectedTarballSha256, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepEqual(report.package.signerWorkflow.failures, []);
    assert.deepEqual(report.package.certIdentity.failures, []);
    assert.deepEqual(report.package.offline.failures, []);
    assert.deepEqual(report.oracleLock.signerWorkflow.failures, []);
    assert.deepEqual(report.oracleLock.certIdentity.failures, []);
    assert.deepEqual(report.oracleLock.offline.failures, []);
    assert.equal(report.package.verifierAgreement.ok, true);
    assert.equal(report.oracleLock.verifierAgreement.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("write-release-attestation-runtime-report fails deterministically for invalid lock fixture", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-attestation-runtime-fail-"));
  try {
    const outputPath = resolve(tempDir, "release-attestation-runtime-fail.json");
    const result = runRuntimeReportScript({
      packageInput: resolve(FIXTURE_DIR, "package-verify-valid.json"),
      lockInput: resolve(FIXTURE_DIR, "lock-verify-invalid.json"),
      certIdentityPackageInput: resolve(FIXTURE_DIR, "package-cert-identity-verify-valid.json"),
      certIdentityLockInput: resolve(FIXTURE_DIR, "lock-cert-identity-verify-valid.json"),
      offlinePackageInput: resolve(FIXTURE_DIR, "package-offline-verify-valid.json"),
      offlineLockInput: resolve(FIXTURE_DIR, "lock-offline-verify-valid.json"),
      expectedPackageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      output: outputPath
    });

    assert.notEqual(result.status, 0, "expected script to fail");
    assert.match(result.stderr, /release attestation runtime validation failed/);

    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.overall.ok, false);
    assert.equal(report.package.ok, true);
    assert.equal(report.oracleLock.ok, false);
    assert.equal(report.oracleLock.signerWorkflow.ok, false);
    assert.equal(report.oracleLock.certIdentity.ok, true);
    assert.equal(report.oracleLock.offline.ok, true);
    assert.ok(
      report.oracleLock.signerWorkflow.failures.includes("record[0]: sourceRepositoryRef mismatch")
    );
    assert.ok(
      report.oracleLock.signerWorkflow.failures.includes("record[0]: sourceRepositoryDigest mismatch")
    );
    assert.ok(
      report.oracleLock.signerWorkflow.failures.includes("record[0]: subject[0] missing sha256")
    );
    assert.ok(
      report.oracleLock.signerWorkflow.failures.includes("no subject matched expected identity")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("write-release-attestation-runtime-report fails when expected package digest mismatches", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-attestation-runtime-bad-digest-"));
  try {
    const outputPath = resolve(tempDir, "release-attestation-runtime-bad-digest.json");
    const result = runRuntimeReportScript({
      packageInput: resolve(FIXTURE_DIR, "package-verify-valid.json"),
      lockInput: resolve(FIXTURE_DIR, "lock-verify-valid.json"),
      certIdentityPackageInput: resolve(FIXTURE_DIR, "package-cert-identity-verify-valid.json"),
      certIdentityLockInput: resolve(FIXTURE_DIR, "lock-cert-identity-verify-valid.json"),
      offlinePackageInput: resolve(FIXTURE_DIR, "package-offline-verify-valid.json"),
      offlineLockInput: resolve(FIXTURE_DIR, "lock-offline-verify-valid.json"),
      expectedPackageSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      output: outputPath
    });

    assert.notEqual(result.status, 0, "expected script to fail");
    assert.match(result.stderr, /release attestation runtime validation failed/);

    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.overall.ok, false);
    assert.equal(report.package.ok, false);
    assert.ok(
      report.package.signerWorkflow.failures.includes("no subject matched expected digest")
    );
    assert.ok(
      report.package.certIdentity.failures.includes("no subject matched expected digest")
    );
    assert.ok(
      report.package.offline.failures.includes("no subject matched expected digest")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
