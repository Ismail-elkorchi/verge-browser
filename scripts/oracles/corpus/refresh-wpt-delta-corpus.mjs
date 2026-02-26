import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const { fetch, TextDecoder } = globalThis;

const WPT_COMMIT = "3d3a9202727fcceb8da22df8ee0ec86dde8361ce";
const REPOSITORY = "https://github.com/web-platform-tests/wpt";
const OUTPUT_PATH = resolve("scripts/oracles/corpus/wpt-delta-v1.json");
const USER_AGENT = "verge-browser-wpt-delta-refresh/1.0";
const EXCLUDED_SEGMENTS = new Set(["support", "resources"]);
const CASE_PLAN = Object.freeze([
  {
    category: "flow-content",
    root: "html/rendering/non-replaced-elements/flow-content-0",
    targetCount: 10
  },
  {
    category: "lists",
    root: "html/rendering/non-replaced-elements/lists",
    targetCount: 25
  },
  {
    category: "phrasing",
    root: "html/rendering/non-replaced-elements/phrasing-content-0",
    targetCount: 8
  },
  {
    category: "tables",
    root: "html/rendering/non-replaced-elements/tables",
    targetCount: 25
  },
  {
    category: "replaced-elements",
    root: "html/rendering/replaced-elements",
    targetCount: 45
  },
  {
    category: "ua-style",
    root: "html/rendering/the-css-user-agent-style-sheet-and-presentational-hints",
    targetCount: 5
  },
  {
    category: "sections-headings",
    root: "html/rendering/non-replaced-elements/sections-and-headings",
    targetCount: 1
  },
  {
    category: "sections",
    root: "html/rendering/sections",
    targetCount: 1
  }
]);

function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256HexText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function rawUrl(path) {
  return `https://raw.githubusercontent.com/web-platform-tests/wpt/${WPT_COMMIT}/${path}`;
}

function apiUrl(path) {
  return `https://api.github.com/repos/web-platform-tests/wpt/contents/${path}?ref=${WPT_COMMIT}`;
}

function isRenderableFixture(path) {
  const lower = path.toLowerCase();
  if (!(lower.endsWith(".html") || lower.endsWith(".xhtml"))) {
    return false;
  }
  if (lower.includes("-ref.")) {
    return false;
  }
  if (lower.includes("-manual.")) {
    return false;
  }
  return true;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT
    }
  });
  if (!response.ok) {
    throw new Error(`fetch failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT
    }
  });
  if (!response.ok) {
    throw new Error(`fetch failed (${response.status}) for ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function collectPaths(rootPath) {
  const stack = [rootPath];
  const collected = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fetchJson(apiUrl(current));
    if (!Array.isArray(entries)) {
      throw new Error(`unexpected directory payload for ${current}`);
    }

    const sortedEntries = entries.slice().sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of sortedEntries) {
      if (entry.type === "file") {
        if (isRenderableFixture(entry.path)) {
          collected.push(entry.path);
        }
        continue;
      }
      if (entry.type === "dir") {
        if (EXCLUDED_SEGMENTS.has(entry.name)) {
          continue;
        }
        stack.push(entry.path);
      }
    }
  }

  return collected.sort((left, right) => left.localeCompare(right));
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

async function main() {
  const selected = [];

  for (const plan of CASE_PLAN) {
    const candidates = await collectPaths(plan.root);
    const picked = candidates.slice(0, plan.targetCount);
    if (picked.length < plan.targetCount) {
      throw new Error(
        `insufficient fixtures in ${plan.root}: expected ${String(plan.targetCount)}, got ${String(picked.length)}`
      );
    }

    for (const path of picked) {
      const bytes = await fetchBytes(rawUrl(path));
      const html = new TextDecoder("utf-8").decode(bytes);
      selected.push({
        id: caseId(plan.category, path),
        category: plan.category,
        sourcePath: path,
        sha256: sha256HexBytes(bytes),
        html
      });
    }
  }

  selected.sort((left, right) => left.id.localeCompare(right.id));

  const payload = {
    suite: "wpt-delta-v1",
    version: 1,
    source: {
      repository: REPOSITORY,
      commit: WPT_COMMIT,
      retrievedAtIso: new Date().toISOString()
    },
    casePlan: CASE_PLAN,
    cases: selected
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `wrote ${OUTPUT_PATH} with ${String(selected.length)} cases from ${String(CASE_PLAN.length)} categories\n`
  );
}

await main();
