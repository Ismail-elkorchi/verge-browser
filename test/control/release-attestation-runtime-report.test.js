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
  output
}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--package-input=${packageInput}`,
      `--lock-input=${lockInput}`,
      `--output=${output}`,
      "--expected-repo=Ismail-elkorchi/verge-browser",
      "--expected-source-ref=refs/heads/main",
      "--expected-source-digest=0123456789abcdef0123456789abcdef01234567",
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
      output: outputPath
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.overall.ok, true);
    assert.equal(report.package.ok, true);
    assert.equal(report.oracleLock.ok, true);
    assert.equal(report.package.attestationCount, 1);
    assert.equal(report.oracleLock.attestationCount, 1);
    assert.deepEqual(report.package.failures, []);
    assert.deepEqual(report.oracleLock.failures, []);
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
      output: outputPath
    });

    assert.notEqual(result.status, 0, "expected script to fail");
    assert.match(result.stderr, /release attestation runtime validation failed/);

    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.overall.ok, false);
    assert.equal(report.package.ok, true);
    assert.equal(report.oracleLock.ok, false);
    assert.ok(
      report.oracleLock.failures.includes("record[0]: sourceRepositoryRef mismatch")
    );
    assert.ok(
      report.oracleLock.failures.includes("record[0]: sourceRepositoryDigest mismatch")
    );
    assert.ok(
      report.oracleLock.failures.includes("record[0]: subject[0] missing sha256")
    );
    assert.ok(
      report.oracleLock.failures.includes("no subject matched expected identity")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
