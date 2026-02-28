import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

const { fetch, TextDecoder } = globalThis;

const DEFAULT_POLICY_PATH = resolve("scripts/oracles/corpus/wpt-delta-refresh-policy.json");
const DEFAULT_OUTPUT_PATH = resolve("scripts/oracles/corpus/wpt-delta-v1.json");
const ALLOWED_OUTPUT_ROOT = resolve("scripts/oracles/corpus");
const WPT_REPOSITORY = "https://github.com/web-platform-tests/wpt";
const RAW_WPT_HOST = "raw.githubusercontent.com";
const RAW_WPT_PATH_PREFIX = "/web-platform-tests/wpt/";
const USER_AGENT = "verge-browser-wpt-delta-refresh/1.0";
const OPTIONAL_GITHUB_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

function reject(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function parseArgs(argv) {
  const options = {
    policyPath: DEFAULT_POLICY_PATH,
    outputPath: DEFAULT_OUTPUT_PATH
  };

  for (const argument of argv) {
    if (argument.startsWith("--policy=")) {
      options.policyPath = resolve(argument.slice("--policy=".length).trim());
      continue;
    }
    if (argument.startsWith("--output=")) {
      options.outputPath = resolve(argument.slice("--output=".length).trim());
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }

  const outputRel = relative(ALLOWED_OUTPUT_ROOT, options.outputPath);
  if (outputRel !== "" && (outputRel.startsWith("..") || isAbsolute(outputRel))) {
    reject("SECURITY_REJECT_OUTPUT_PATH", options.outputPath);
  }

  return options;
}

function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256HexText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function rawUrl(commit, path) {
  const url = new globalThis.URL(`https://${RAW_WPT_HOST}${RAW_WPT_PATH_PREFIX}${commit}/${path}`);
  if (url.protocol !== "https:" || url.hostname !== RAW_WPT_HOST) {
    reject("SECURITY_REJECT_FETCH_URL", "host-or-scheme");
  }
  if (!url.pathname.startsWith(`${RAW_WPT_PATH_PREFIX}${commit}/`)) {
    reject("SECURITY_REJECT_FETCH_URL", "path-prefix");
  }
  return url.toString();
}

function requestHeaders() {
  const headers = {
    "user-agent": USER_AGENT
  };
  if (typeof OPTIONAL_GITHUB_TOKEN === "string" && OPTIONAL_GITHUB_TOKEN.length > 0) {
    headers.authorization = `Bearer ${OPTIONAL_GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: requestHeaders()
  });
  if (response.status >= 300 && response.status < 400) {
    reject("SECURITY_REJECT_FETCH_REDIRECT", String(response.status));
  }
  if (!response.ok) {
    throw new Error(`fetch failed (${response.status}) for ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function caseId(category, path) {
  const digest = sha256HexText(path).slice(0, 12);
  const slug = path
    .split("/")
    .at(-1)
    ?.replace(/\.[^/.]+$/, "")
    ?.replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() ?? "case";
  return `wpt-${category}-${slug}-${digest}`;
}

function normalizeSourcePath(rawPath, label) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    reject("SECURITY_REJECT_POLICY_SOURCE_PATH", `${label}:empty`);
  }
  if (rawPath.includes("\\")) {
    reject("SECURITY_REJECT_POLICY_SOURCE_PATH", `${label}:backslash`);
  }
  const normalized = posix.normalize(rawPath);
  if (isAbsolute(normalized) || normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    reject("SECURITY_REJECT_POLICY_SOURCE_PATH", `${label}:outside-root`);
  }
  if (normalized.includes("/../") || normalized.includes("/./") || normalized === ".") {
    reject("SECURITY_REJECT_POLICY_SOURCE_PATH", `${label}:dot-segment`);
  }
  if (!normalized.startsWith("html/")) {
    reject("SECURITY_REJECT_POLICY_SOURCE_PATH", `${label}:scope`);
  }
  return normalized;
}

async function readPolicy(policyPath) {
  const source = await readFile(policyPath, "utf8");
  const policy = JSON.parse(source);
  const repository = policy?.source?.repository;
  const commit = policy?.source?.commit;
  if (repository !== WPT_REPOSITORY) {
    reject("SECURITY_REJECT_POLICY_REPOSITORY", "source.repository");
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit)) {
    reject("SECURITY_REJECT_POLICY_COMMIT", "source.commit");
  }
  if (!Array.isArray(policy?.casePlan) || policy.casePlan.length === 0) {
    throw new Error("invalid WPT refresh policy case plan");
  }
  if (!Array.isArray(policy?.cases) || policy.cases.length === 0) {
    throw new Error("invalid WPT refresh policy cases");
  }

  for (const entry of policy.casePlan) {
    if (typeof entry?.category !== "string" || entry.category.length === 0) {
      throw new Error("invalid WPT refresh policy category");
    }
    if (typeof entry?.root !== "string" || entry.root.length === 0) {
      throw new Error(`invalid WPT refresh policy root for ${entry?.category ?? "unknown"}`);
    }
    if (!Number.isSafeInteger(entry?.targetCount) || entry.targetCount < 1) {
      throw new Error(`invalid WPT refresh policy targetCount for ${entry.category}`);
    }
    entry.root = normalizeSourcePath(entry.root, `root:${entry.category}`);
  }

  const rootsByCategory = new Map(policy.casePlan.map((entry) => [entry.category, entry.root]));
  const caseIds = new Set();
  for (const entry of policy.cases) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      throw new Error("invalid WPT refresh policy case id");
    }
    if (caseIds.has(entry.id)) {
      throw new Error(`duplicate WPT refresh policy case id: ${entry.id}`);
    }
    caseIds.add(entry.id);
    if (typeof entry?.category !== "string" || entry.category.length === 0) {
      throw new Error(`invalid WPT refresh policy category for case ${entry.id}`);
    }
    if (typeof entry?.sourcePath !== "string" || entry.sourcePath.length === 0) {
      throw new Error(`invalid WPT refresh policy sourcePath for case ${entry.id}`);
    }
    const normalizedSourcePath = normalizeSourcePath(entry.sourcePath, entry.id);
    const categoryRoot = rootsByCategory.get(entry.category);
    if (!categoryRoot) {
      reject("SECURITY_REJECT_POLICY_CATEGORY_ROOT", `${entry.id}:missing-root`);
    }
    if (!normalizedSourcePath.startsWith(categoryRoot)) {
      reject("SECURITY_REJECT_POLICY_CATEGORY_ROOT", `${entry.id}:outside-category-root`);
    }
    entry.sourcePath = normalizedSourcePath;
  }

  return {
    policy,
    policySha256: sha256HexText(source)
  };
}

function checkCasePlanCounts(policy) {
  const counts = new Map();
  for (const caseEntry of policy.cases) {
    counts.set(caseEntry.category, (counts.get(caseEntry.category) ?? 0) + 1);
  }
  for (const planEntry of policy.casePlan) {
    const observed = counts.get(planEntry.category) ?? 0;
    if (observed !== planEntry.targetCount) {
      throw new Error(
        `policy case count mismatch for ${planEntry.category}: expected ${String(planEntry.targetCount)}, got ${String(observed)}`
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { policy, policySha256 } = await readPolicy(options.policyPath);
  checkCasePlanCounts(policy);

  const selected = [];
  const commit = policy.source.commit;

  for (const policyCase of policy.cases) {
    const expectedId = caseId(policyCase.category, policyCase.sourcePath);
    if (expectedId !== policyCase.id) {
      throw new Error(
        `policy case id mismatch for ${policyCase.sourcePath}: expected ${expectedId}, got ${policyCase.id}`
      );
    }
    const bytes = await fetchBytes(rawUrl(commit, policyCase.sourcePath));
    const html = new TextDecoder("utf-8").decode(bytes);
    selected.push({
      id: policyCase.id,
      category: policyCase.category,
      sourcePath: policyCase.sourcePath,
      sha256: sha256HexBytes(bytes),
      html
    });
  }

  selected.sort((left, right) => left.id.localeCompare(right.id));

  const payload = {
    suite: "wpt-delta-v1",
    version: 1,
    source: {
      repository: policy.source.repository,
      commit,
      retrievedAtIso: new Date().toISOString()
    },
    policy: {
      path: options.policyPath,
      sha256: policySha256
    },
    casePlan: policy.casePlan,
    cases: selected
  };

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `wrote ${options.outputPath} with ${String(selected.length)} cases from ${String(policy.casePlan.length)} categories\n`
  );
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wpt-delta-refresh failed: ${message}\n`);
  process.exit(1);
});
