import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";

const UTF8_ENCODER = new TextEncoder();

export function resolveCorpusDir() {
  return resolve(process.env.VERGE_CORPUS_DIR ?? resolve(process.cwd(), "realworld/corpus"));
}

export function corpusPath(corpusDir, relativePath) {
  return resolve(corpusDir, relativePath);
}

export async function ensureCorpusDirs(corpusDir) {
  await Promise.all([
    mkdir(corpusPath(corpusDir, "cache/html"), { recursive: true }),
    mkdir(corpusPath(corpusDir, "cache/css"), { recursive: true }),
    mkdir(corpusPath(corpusDir, "cache/oracle"), { recursive: true }),
    mkdir(corpusPath(corpusDir, "manifests"), { recursive: true }),
    mkdir(corpusPath(corpusDir, "reports"), { recursive: true }),
    mkdir(corpusPath(corpusDir, "triage"), { recursive: true })
  ]);
}

export function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256HexString(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function readNdjson(path) {
  let sourceText = "";
  try {
    sourceText = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function writeNdjson(path, records) {
  const lines = records.map((record) => JSON.stringify(record));
  await writeFile(path, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

export async function writeJson(path, value) {
  const formatted = JSON.stringify(value, null, 2);
  await writeFile(path, `${formatted}\n`, "utf8");
}

export function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

export function encodeUtf8(value) {
  return UTF8_ENCODER.encode(value);
}

export function toFixedMillis(value) {
  return Number(value.toFixed(3));
}

export function percentile(values, fraction) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

export function normalizeToken(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function tokenizeText(value) {
  const normalized = normalizeToken(value);
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split(" ").filter((token) => token.length > 0);
}

export function tokenF1(expectedTokens, actualTokens) {
  if (expectedTokens.length === 0 && actualTokens.length === 0) {
    return 1;
  }
  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return 0;
  }

  const expectedMap = new Map();
  for (const token of expectedTokens) {
    expectedMap.set(token, (expectedMap.get(token) ?? 0) + 1);
  }

  const actualMap = new Map();
  for (const token of actualTokens) {
    actualMap.set(token, (actualMap.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const [token, expectedCount] of expectedMap.entries()) {
    const actualCount = actualMap.get(token) ?? 0;
    overlap += Math.min(expectedCount, actualCount);
  }

  const precision = overlap / actualTokens.length;
  const recall = overlap / expectedTokens.length;
  if (precision === 0 || recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}
