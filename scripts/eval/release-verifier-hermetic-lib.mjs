import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";

const IMPORT_PATTERN = /(?:^|\n)\s*import(?:[\s\w{},*]+from\s+)?["']([^"']+)["']/g;
const RE_EXPORT_PATTERN = /(?:^|\n)\s*export\s+[^"'\\n]*\sfrom\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

export const DEFAULT_VERIFIER_ENTRY_SCRIPTS = [
  "scripts/eval/write-release-attestation-runtime-report.mjs",
  "scripts/eval/check-offline-attestation-content.mjs"
];

function collectModuleSpecifiers(sourceText) {
  const specifiers = [];
  for (const pattern of [IMPORT_PATTERN, RE_EXPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const match of sourceText.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function extractReleaseVerifierBlock(workflowText) {
  const startMatch = /^\s{2}release-verifier:\n/m.exec(workflowText);
  if (!startMatch || typeof startMatch.index !== "number") {
    return "";
  }
  const startIndex = startMatch.index + startMatch[0].length;
  const tail = workflowText.slice(startIndex);
  const endMatch = /^\s{2}[a-zA-Z0-9_-]+:\n/m.exec(tail);
  if (!endMatch || typeof endMatch.index !== "number") {
    return tail;
  }
  return tail.slice(0, endMatch.index);
}

export async function discoverVerifierEntryScriptsFromWorkflow(workflowPath, repoRoot = process.cwd()) {
  const workflowText = await readFile(resolve(repoRoot, workflowPath), "utf8");
  const verifierBlock = extractReleaseVerifierBlock(workflowText);
  if (verifierBlock.length === 0) {
    return [];
  }

  const scripts = new Set();
  const scriptPattern = /\bnode\s+(scripts\/eval\/[a-zA-Z0-9/_-]+\.mjs)\b/g;
  for (const match of verifierBlock.matchAll(scriptPattern)) {
    scripts.add(match[1]);
  }

  return [...scripts]
    .filter((scriptPath) => scriptPath !== "scripts/eval/check-release-verifier-hermetic.mjs")
    .sort();
}

async function resolveRelativeImportPath(importerPath, specifier) {
  const basePath = resolve(dirname(importerPath), specifier);
  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.js`,
    resolve(basePath, "index.mjs"),
    resolve(basePath, "index.js")
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export async function scanVerifierHermeticity(entryScripts, repoRoot = process.cwd()) {
  const visited = new Set();
  const pending = entryScripts.map((entryScript) => resolve(repoRoot, entryScript));
  const violations = [];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const sourceText = await readFile(currentPath, "utf8");
    const specifiers = collectModuleSpecifiers(sourceText);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        continue;
      }
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolvedImportPath = await resolveRelativeImportPath(currentPath, specifier);
        if (!resolvedImportPath) {
          violations.push({
            type: "unresolved-relative-import",
            importer: currentPath,
            specifier
          });
          continue;
        }
        if (!visited.has(resolvedImportPath)) {
          pending.push(resolvedImportPath);
        }
        continue;
      }

      violations.push({
        type: "bare-import",
        importer: currentPath,
        specifier
      });
    }
  }

  return {
    entryScripts: entryScripts.map((entryScript) => resolve(repoRoot, entryScript)),
    scannedFiles: [...visited].sort(),
    violations
  };
}
