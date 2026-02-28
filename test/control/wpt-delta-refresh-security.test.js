import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/oracles/corpus/refresh-wpt-delta-corpus.mjs");

function runScript(cwd, policyPath, outputPath) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--policy=${policyPath}`,
      `--output=${outputPath}`
    ],
    {
      cwd,
      encoding: "utf8"
    }
  );
}

async function writePolicy(path, policy) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}

test("refresh-wpt-delta rejects non-WPT policy repository", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "verge-delta-repo-"));
  try {
    const policyPath = resolve(cwd, "policy.json");
    const outputPath = resolve(cwd, "scripts/oracles/corpus/out.json");
    await writePolicy(policyPath, {
      source: { repository: "https://example.com/not-wpt", commit: "a".repeat(40) },
      casePlan: [{ category: "a", root: "html/dom/", targetCount: 1 }],
      cases: [{ id: "c1", category: "a", sourcePath: "html/dom/sample.html" }]
    });
    const result = runScript(cwd, policyPath, outputPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY_REJECT_POLICY_REPOSITORY/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refresh-wpt-delta rejects source path traversal deterministically", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "verge-delta-path-"));
  try {
    const policyPath = resolve(cwd, "policy.json");
    const outputPath = resolve(cwd, "scripts/oracles/corpus/out.json");
    await writePolicy(policyPath, {
      source: { repository: "https://github.com/web-platform-tests/wpt", commit: "a".repeat(40) },
      casePlan: [{ category: "a", root: "html/dom/", targetCount: 1 }],
      cases: [{ id: "c1", category: "a", sourcePath: "../escape.html" }]
    });
    const result = runScript(cwd, policyPath, outputPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY_REJECT_POLICY_SOURCE_PATH/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refresh-wpt-delta rejects output paths outside corpus root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "verge-delta-output-"));
  try {
    const policyPath = resolve(cwd, "policy.json");
    const outputPath = resolve(cwd, "..", "outside.json");
    await writePolicy(policyPath, {
      source: { repository: "https://github.com/web-platform-tests/wpt", commit: "a".repeat(40) },
      casePlan: [{ category: "a", root: "html/dom/", targetCount: 1 }],
      cases: [{ id: "c1", category: "a", sourcePath: "html/dom/sample.html" }]
    });
    const result = runScript(cwd, policyPath, outputPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY_REJECT_OUTPUT_PATH/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
