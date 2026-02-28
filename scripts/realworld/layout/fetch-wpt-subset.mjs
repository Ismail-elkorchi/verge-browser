import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { corpusPath, ensureCorpusDirs, resolveCorpusDir, sha256HexString, writeJson } from "../lib.mjs";

const MANIFEST_PATH = resolve(process.cwd(), "scripts/realworld/layout/wpt-subset.v1.json");
const USER_AGENT = "verge-browser-layout-pilot/1.0";
const WPT_REPOSITORY = "https://github.com/web-platform-tests/wpt";
const RAW_WPT_HOST = "raw.githubusercontent.com";
const RAW_WPT_PATH_PREFIX = "/web-platform-tests/wpt/";

function reject(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest() {
  const source = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(source);
  if (!manifest?.source?.commit || !Array.isArray(manifest?.snapshots)) {
    reject("SECURITY_REJECT_MANIFEST_FORMAT", "invalid-manifest");
  }
  if (manifest?.source?.repository !== WPT_REPOSITORY) {
    reject("SECURITY_REJECT_MANIFEST_REPOSITORY", "source.repository");
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.source.commit)) {
    reject("SECURITY_REJECT_MANIFEST_COMMIT", "source.commit");
  }
  return manifest;
}

function normalizeCasePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    reject("SECURITY_REJECT_CASE_PATH", "empty");
  }
  if (rawPath.includes("\\")) {
    reject("SECURITY_REJECT_CASE_PATH", "backslash");
  }
  const normalized = posix.normalize(rawPath);
  if (isAbsolute(normalized) || normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    reject("SECURITY_REJECT_CASE_PATH", "outside-root");
  }
  if (normalized.includes("/../") || normalized.includes("/./") || normalized === ".") {
    reject("SECURITY_REJECT_CASE_PATH", "dot-segment");
  }
  if (!normalized.startsWith("html/")) {
    reject("SECURITY_REJECT_CASE_PATH", "scope");
  }
  return normalized;
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
      entries.push({
        ...entry,
        path: normalizeCasePath(entry.path)
      });
    }
  }
  return entries;
}

function buildWptRawUrl(commit, relativePath) {
  const url = new globalThis.URL(`https://${RAW_WPT_HOST}${RAW_WPT_PATH_PREFIX}${commit}/${relativePath}`);
  if (url.protocol !== "https:" || url.hostname !== RAW_WPT_HOST) {
    reject("SECURITY_REJECT_FETCH_URL", "host-or-scheme");
  }
  if (!url.pathname.startsWith(`${RAW_WPT_PATH_PREFIX}${commit}/`)) {
    reject("SECURITY_REJECT_FETCH_URL", "path-prefix");
  }
  return url.toString();
}

async function writeBytes(filePath, bytes) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

function resolveWithinRoot(rootPath, relativePath, label) {
  const targetPath = resolve(rootPath, relativePath);
  const rel = relative(resolve(rootPath), targetPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return targetPath;
  }
  reject("SECURITY_REJECT_WRITE_PATH", label);
}

async function fetchCase(caseEntry, commit, cacheRoot) {
  const url = buildWptRawUrl(commit, caseEntry.path);
  const response = await globalThis.fetch(url, {
    redirect: "manual",
    headers: {
      "user-agent": USER_AGENT
    }
  });
  if (response.status >= 300 && response.status < 400) {
    reject("SECURITY_REJECT_FETCH_REDIRECT", caseEntry.id);
  }
  if (!response.ok) {
    throw new Error(`failed to fetch ${caseEntry.id} (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = sha256HexBytes(bytes);
  if (sha256 !== caseEntry.sha256) {
    throw new Error(`sha mismatch for ${caseEntry.id}: expected ${caseEntry.sha256} got ${sha256}`);
  }
  const cachePath = resolveWithinRoot(cacheRoot, caseEntry.path, caseEntry.id);
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
