import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/eval/check-offline-attestation-content.mjs");
const FIXTURE_DIR = resolve(REPO_ROOT, "test/fixtures/release-attestation-runtime");

function runPolicy({ packageInput, lockInput, expectedPackageSha256, output }) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--package-offline-input=${packageInput}`,
      `--lock-offline-input=${lockInput}`,
      `--output=${output}`,
      "--expected-repo=Ismail-elkorchi/verge-browser",
      "--expected-source-ref=refs/heads/main",
      "--expected-source-digest=0123456789abcdef0123456789abcdef01234567",
      "--expected-workflow=Ismail-elkorchi/verge-browser/.github/workflows/release.yml",
      `--expected-package-sha256=${expectedPackageSha256}`
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }
  );
}

test("offline attestation content policy passes for valid fixtures", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-offline-policy-ok-"));
  try {
    const output = resolve(tempDir, "offline-attestation-content-ok.json");
    const result = runPolicy({
      packageInput: resolve(FIXTURE_DIR, "package-offline-verify-valid.json"),
      lockInput: resolve(FIXTURE_DIR, "lock-offline-verify-valid.json"),
      expectedPackageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      output
    });
    assert.equal(result.status, 0, result.stderr);

    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.overall.ok, true);
    assert.equal(report.package.ok, true);
    assert.equal(report.oracleLock.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("offline attestation content policy fails on wrong package digest", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-offline-policy-fail-"));
  try {
    const output = resolve(tempDir, "offline-attestation-content-fail.json");
    const result = runPolicy({
      packageInput: resolve(FIXTURE_DIR, "package-offline-verify-valid.json"),
      lockInput: resolve(FIXTURE_DIR, "lock-offline-verify-valid.json"),
      expectedPackageSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      output
    });
    assert.notEqual(result.status, 0, "expected policy check to fail");
    assert.match(result.stderr, /offline attestation content policy check failed/);

    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.overall.ok, false);
    assert.equal(report.package.ok, false);
    assert.ok(report.package.failures.includes("no subject matched expected digest"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
