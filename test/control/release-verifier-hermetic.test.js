import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_VERIFIER_ENTRY_SCRIPTS,
  discoverVerifierEntryScriptsFromWorkflow,
  scanVerifierHermeticity
} from "../../scripts/eval/release-verifier-hermetic-lib.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

test("release verifier scripts stay hermetic", async () => {
  const result = await scanVerifierHermeticity(DEFAULT_VERIFIER_ENTRY_SCRIPTS, REPO_ROOT);
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations, null, 2));
});

test("release verifier hermetic scan rejects bare imports", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-release-verifier-hermetic-"));
  try {
    const entryPath = resolve(tempDir, "entry.mjs");
    const localPath = resolve(tempDir, "local.mjs");
    await writeFile(localPath, "export const ok = true;\n", "utf8");
    await writeFile(
      entryPath,
      "import './local.mjs';\nimport { parse } from 'html-parser';\nvoid parse;\n",
      "utf8"
    );

    const result = await scanVerifierHermeticity([entryPath], tempDir);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].type, "bare-import");
    assert.equal(result.violations[0].specifier, "html-parser");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("release verifier hermetic scan rejects bare dynamic imports", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "verge-release-verifier-hermetic-dynamic-"));
  try {
    const entryPath = resolve(tempDir, "entry.mjs");
    await writeFile(
      entryPath,
      "const mod = await import('html-parser');\nvoid mod;\n",
      "utf8"
    );

    const result = await scanVerifierHermeticity([entryPath], tempDir);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].type, "bare-import");
    assert.equal(result.violations[0].specifier, "html-parser");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("release verifier entry scripts are discovered from workflow", async () => {
  const scripts = await discoverVerifierEntryScriptsFromWorkflow(".github/workflows/release.yml", REPO_ROOT);
  assert.equal(scripts.length > 0, true);
  assert.equal(scripts.includes("scripts/eval/write-release-attestation-runtime-report.mjs"), true);
  assert.equal(scripts.includes("scripts/eval/check-offline-attestation-content.mjs"), true);
});
