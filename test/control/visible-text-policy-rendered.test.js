import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeNdjson(path, records) {
  const lines = records.map((entry) => JSON.stringify(entry));
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

test("compare-visible-text-policies includes rendered-style-v1 policy and diagnostics", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "verge-visible-style-"));
  const corpusDir = join(fixtureRoot, "corpus");
  const cacheHtmlDir = join(corpusDir, "cache/html");
  const cacheOracleDir = join(corpusDir, "cache/oracle/lynx");
  const manifestsDir = join(corpusDir, "manifests");
  const reportsDir = join(corpusDir, "reports");
  const triageDir = join(corpusDir, "triage");

  await mkdir(cacheHtmlDir, { recursive: true });
  await mkdir(cacheOracleDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(triageDir, { recursive: true });

  const html = "<html><body><p style=\"display:none\">secret</p><p>public</p></body></html>";
  const pageSha = sha256Hex(html);
  const oracleOutput = "public";
  const stdoutSha = sha256Hex(oracleOutput);

  await writeFile(join(cacheHtmlDir, `${pageSha}.bin`), html, "utf8");
  await writeFile(join(cacheOracleDir, `${stdoutSha}.txt`), oracleOutput, "utf8");

  await writeNdjson(join(manifestsDir, "pages.ndjson"), [
    {
      url: "https://example.test/",
      finalUrl: "https://example.test/",
      sha256: pageSha
    }
  ]);

  await writeNdjson(join(reportsDir, "oracle-compare.ndjson"), [
    {
      runId: "fixture",
      pageSurface: "meaningful-content",
      pageSurfaceReasons: ["fixture"],
      error: null,
      pageSha256: pageSha,
      finalUrl: "https://example.test/",
      tool: "lynx",
      width: 80,
      stdoutSha256: stdoutSha
    }
  ]);

  const cssParserStubPath = join(fixtureRoot, "css-parser-stub.mjs");
  await writeFile(cssParserStubPath, `
export function extractInlineStyleSignals(styleText) {
  return styleText
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes(':'))
    .map((entry, index) => {
      const separator = entry.indexOf(':');
      const property = entry.slice(0, separator).trim().toLowerCase();
      const rawValue = entry.slice(separator + 1).trim();
      const important = /!important$/i.test(rawValue);
      const value = important ? rawValue.replace(/!important$/i, '').trim() : rawValue;
      return {
        declarationNodeId: index + 1,
        property,
        value,
        important,
        declarationOrder: index
      };
    });
}

export function extractStyleRuleSignals() {
  return [];
}

export function querySelectorAll() {
  return [];
}
`, "utf8");

  try {
    const execution = spawnSync(
      process.execPath,
      ["scripts/realworld/compare-visible-text-policies.mjs"],
      {
        cwd: resolve(process.cwd()),
        env: {
          ...process.env,
          VERGE_CORPUS_DIR: corpusDir,
          VERGE_CSS_PARSER_MODULE_PATH: cssParserStubPath
        },
        encoding: "utf8"
      }
    );

    assert.equal(execution.status, 0, `compare script failed: ${execution.stderr}`);

    const summary = JSON.parse(
      await readFile(join(reportsDir, "visible-text-policy-compare.json"), "utf8")
    );

    assert.equal(summary.gates.ok, true);
    assert.equal(
      summary.policies.some((entry) => entry.id === "rendered-style-v1"),
      true
    );
    assert.equal(summary.recommendedCandidatePolicyId, "rendered-style-v1");
    assert.equal(summary.renderedStyleDiagnostics.records, 1);
    assert.equal(summary.renderedStyleDiagnostics.meanHiddenRootNodeCount, 1);
    assert.equal(summary.renderedStyleDiagnostics.meanHiddenSubtreeNodeCount, 2);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
