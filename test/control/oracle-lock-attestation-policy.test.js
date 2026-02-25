import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/eval/check-oracle-lock-attestation-policy.mjs");
const FIXTURE_DIR = resolve(REPO_ROOT, "test/fixtures/oracle-lock-attestation-policy");

function runPolicyScript(workflowPath, outputPath) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--workflow=${workflowPath}`,
      `--output=${outputPath}`
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }
  );
}

test("oracle lock attestation policy passes for valid fixture", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-lock-policy-ok-"));
  try {
    const outputPath = resolve(tempDir, "oracle-lock-policy-ok.json");
    const result = runPolicyScript(resolve(FIXTURE_DIR, "workflow-valid.yml"), outputPath);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.checks.every((check) => check.ok), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("oracle lock attestation policy fails when source digest flag is wrong", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-lock-policy-bad-digest-"));
  try {
    const outputPath = resolve(tempDir, "oracle-lock-policy-bad-digest.json");
    const result = runPolicyScript(resolve(FIXTURE_DIR, "workflow-wrong-source-digest.yml"), outputPath);

    assert.notEqual(result.status, 0, "expected script to fail");
    assert.match(result.stderr, /oracle lock attestation policy check failed/);

    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.ok, false);
    const verifyCheck = report.checks.find((check) => check.id === "release-workflow-verifies-oracle-lock-attestation");
    assert.equal(verifyCheck?.ok, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
