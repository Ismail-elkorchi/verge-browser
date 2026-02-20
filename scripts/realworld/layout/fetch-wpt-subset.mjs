import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { corpusPath, ensureCorpusDirs, resolveCorpusDir, sha256HexString, writeJson } from "../lib.mjs";

const MANIFEST_PATH = resolve(process.cwd(), "scripts/realworld/layout/wpt-subset.v1.json");
const USER_AGENT = "verge-browser-layout-pilot/1.0";

function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest() {
  const source = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(source);
  if (!manifest?.source?.commit || !Array.isArray(manifest?.snapshots)) {
    throw new Error("invalid WPT subset manifest");
  }
  return manifest;
}

function allCases(manifest) {
  const seen = new Set();
  const entries = [];
  for (const snapshot of manifest.snapshots) {
    for (const entry of snapshot.cases ?? []) {
      if (!entry?.id || !entry?.path || !entry?.sha256) {
        throw new Error(`invalid manifest case in snapshot ${snapshot.id ?? "unknown"}`);
      }
      if (seen.has(entry.id)) {
        throw new Error(`duplicate case id: ${entry.id}`);
      }
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

function buildWptRawUrl(commit, relativePath) {
  return `https://raw.githubusercontent.com/web-platform-tests/wpt/${commit}/${relativePath}`;
}

async function writeBytes(filePath, bytes) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

async function fetchCase(caseEntry, commit, cacheRoot) {
  const url = buildWptRawUrl(commit, caseEntry.path);
  const response = await globalThis.fetch(url, {
    headers: {
      "user-agent": USER_AGENT
    }
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${caseEntry.id} (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = sha256HexBytes(bytes);
  if (sha256 !== caseEntry.sha256) {
    throw new Error(`sha mismatch for ${caseEntry.id}: expected ${caseEntry.sha256} got ${sha256}`);
  }
  const cachePath = resolve(cacheRoot, caseEntry.path);
  await writeBytes(cachePath, bytes);
  return {
    id: caseEntry.id,
    path: caseEntry.path,
    sha256,
    bytes: bytes.byteLength,
    cachePath
  };
}

async function main() {
  const manifest = await readManifest();
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const commit = manifest.source.commit;
  const cacheRoot = corpusPath(corpusDir, `layout/cache/wpt/${commit}`);
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(corpusPath(corpusDir, "layout/reports"), { recursive: true });

  const cases = allCases(manifest);
  const fetched = [];
  for (const caseEntry of cases) {
    fetched.push(await fetchCase(caseEntry, commit, cacheRoot));
  }

  const report = {
    suite: "layout-wpt-fetch",
    runId: sha256HexString(JSON.stringify({
      commit,
      cases: fetched.map((entry) => ({
        id: entry.id,
        sha256: entry.sha256
      }))
    })),
    generatedAtIso: new Date().toISOString(),
    source: {
      repository: manifest.source.repository,
      commit
    },
    fetchedCount: fetched.length,
    totalBytes: fetched.reduce((sum, entry) => sum + entry.bytes, 0),
    cases: fetched
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
        cachePath: entry.cachePath
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };

  await writeJson(corpusPath(corpusDir, "layout/reports/layout-wpt-fetch.json"), report);
  process.stdout.write(
    `layout-wpt-fetch ok: commit=${commit} cases=${String(fetched.length)} bytes=${String(report.totalBytes)}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`layout-wpt-fetch failed: ${message}\n`);
  process.exit(1);
});
