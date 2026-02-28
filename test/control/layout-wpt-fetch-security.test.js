import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/realworld/layout/fetch-wpt-subset.mjs");

async function writeManifest(cwd, manifest) {
  const manifestPath = resolve(cwd, "scripts/realworld/layout/wpt-subset.v1.json");
  await mkdir(resolve(cwd, "scripts/realworld/layout"), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runScript(cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      VERGE_CORPUS_DIR: resolve(cwd, "corpus")
    }
  });
}

test("fetch-wpt-subset rejects non-WPT repository in manifest", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "verge-layout-fetch-repo-"));
  try {
    await writeManifest(cwd, {
      source: { repository: "https://example.com/other", commit: "a".repeat(40) },
      snapshots: [{ id: "s1", cases: [] }]
    });
    const result = runScript(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY_REJECT_MANIFEST_REPOSITORY/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fetch-wpt-subset rejects traversal case paths deterministically", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "verge-layout-fetch-path-"));
  try {
    await writeManifest(cwd, {
      source: {
        repository: "https://github.com/web-platform-tests/wpt",
        commit: "a".repeat(40)
      },
      snapshots: [
        {
          id: "s1",
          cases: [{ id: "case-1", path: "../escape.html", sha256: "0".repeat(64) }]
        }
      ]
    });
    const result = runScript(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY_REJECT_CASE_PATH/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
