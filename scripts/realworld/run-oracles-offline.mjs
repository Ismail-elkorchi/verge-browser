import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

import { parseBytes, visibleTextTokens } from "html-parser";
import { collectEngineFingerprints, ensureOracleImage, runEngineDump } from "../oracles/real-oracle-lib.mjs";

import {
  corpusPath,
  ensureCorpusDirs,
  readNdjson,
  resolveCorpusDir,
  sha256HexBytes,
  sha256HexString,
  tokenF1,
  tokenizeText,
  writeJson,
  writeNdjson
} from "./lib.mjs";

const ORACLE_TOOLS = Object.freeze([
  {
    name: "lynx",
    versionArgs: ["-version"],
    renderArgs(width) {
      return ["-dump", `-width=${String(width)}`, "-nolist", "-stdin"];
    },
    mode: "stdin"
  },
  {
    name: "w3m",
    versionArgs: ["-version"],
    renderArgs(width) {
      return ["-dump", "-T", "text/html", "-cols", String(width)];
    },
    mode: "stdin"
  },
  {
    name: "links2",
    versionArgs: ["-version"],
    renderArgs(width, filePath) {
      return ["-dump", "-width", String(width), "-codepage", "utf-8", filePath];
    },
    mode: "file"
  }
]);

const WIDTHS = Object.freeze([80, 120]);

const CHALLENGE_PATTERNS = Object.freeze([
  /just a moment/i,
  /enable javascript and cookies to continue/i,
  /attention required/i,
  /\bcf[-_ ]challenge\b/i,
  /captcha/i
]);

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      rejectProcess(error);
    });
    child.on("close", (code, signal) => {
      resolveProcess({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });

    if (options.stdinText) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

async function resolveToolBinary(toolName) {
  const result = await runProcess("bash", ["-lc", `command -v ${toolName}`]);
  if (result.code !== 0) {
    return null;
  }
  const path = result.stdout.trim();
  return path.length > 0 ? path : null;
}

async function resolveHostTools() {
  const toolMetadata = [];
  const availableTools = [];

  for (const tool of ORACLE_TOOLS) {
    const binaryPath = await resolveToolBinary(tool.name);
    if (!binaryPath) {
      toolMetadata.push({
        tool: tool.name,
        source: "host",
        available: false
      });
      continue;
    }
    const versionResult = await runProcess(binaryPath, tool.versionArgs);
    const toolEntry = {
      ...tool,
      source: "host",
      binaryPath
    };
    availableTools.push(toolEntry);
    toolMetadata.push({
      tool: tool.name,
      source: "host",
      available: true,
      binaryPath,
      binarySha256: await binarySha256(binaryPath),
      version: versionResult.stdout.trim() || versionResult.stderr.trim() || "unknown"
    });
  }

  return {
    sourceMode: "host",
    tools: availableTools,
    metadata: toolMetadata,
    image: null
  };
}

async function resolveImageTools() {
  const imageRoot = resolve(process.env.VERGE_ORACLE_IMAGE_ROOT ?? "tmp/oracle-image-field");
  const lockPath = resolve(process.env.VERGE_ORACLE_IMAGE_LOCK ?? `${imageRoot}/oracle-image.lock.json`);
  const rebuildLock = process.env.VERGE_ORACLE_REBUILD_LOCK !== "0";

  const imageState = await ensureOracleImage({
    imageRoot,
    lockPath,
    rebuildLock
  });
  const fingerprints = await collectEngineFingerprints({
    rootfsPath: imageState.rootfsPath
  });

  const toolMetadata = [];
  const availableTools = [];
  for (const tool of ORACLE_TOOLS) {
    const fingerprint = fingerprints[tool.name];
    if (!fingerprint) {
      toolMetadata.push({
        tool: tool.name,
        source: "image",
        available: false
      });
      continue;
    }
    availableTools.push({
      ...tool,
      source: "image",
      rootfsPath: imageState.rootfsPath,
      binaryPath: fingerprint.path
    });
    toolMetadata.push({
      tool: tool.name,
      source: "image",
      available: true,
      binaryPath: fingerprint.path,
      binarySha256: fingerprint.sha256,
      version: fingerprint.version
    });
  }

  return {
    sourceMode: "image",
    tools: availableTools,
    metadata: toolMetadata,
    image: {
      rootfsPath: imageState.rootfsPath,
      lockPath: imageState.lockPath,
      fingerprint: imageState.fingerprint,
      packageCount: imageState.packageCount
    }
  };
}

async function resolveOracleTools() {
  const sourceMode = (process.env.VERGE_ORACLE_SOURCE ?? "auto").trim().toLowerCase();
  if (sourceMode === "host") {
    return resolveHostTools();
  }
  if (sourceMode === "image") {
    return resolveImageTools();
  }

  const hostResolution = await resolveHostTools();
  if (hostResolution.tools.length === ORACLE_TOOLS.length) {
    return hostResolution;
  }

  try {
    return await resolveImageTools();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hostResolution.metadata.push({
      tool: "image-fallback",
      source: "image",
      available: false,
      error: message
    });
    return hostResolution;
  }
}

async function binarySha256(path) {
  const bytes = new Uint8Array(await readFile(path));
  return sha256HexBytes(bytes);
}

function computeExpectedTokens(htmlBytes) {
  const tree = parseBytes(htmlBytes, {
    captureSpans: false,
    trace: false
  });
  const tokens = visibleTextTokens(tree)
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ");
  return tokenizeText(tokens);
}

async function runToolOnHtml(tool, htmlText, width) {
  if (tool.source === "image") {
    const tempRoot = await mkdtemp(join(tmpdir(), "verge-oracle-image-"));
    const tempFilePath = resolve(tempRoot, "page.html");
    try {
      await writeFile(tempFilePath, htmlText, "utf8");
      const lines = runEngineDump({
        rootfsPath: tool.rootfsPath,
        engineName: tool.name,
        width,
        htmlPath: tempFilePath
      });
      return `${lines.join("\n")}\n`;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  if (tool.mode === "stdin") {
    const result = await runProcess(tool.binaryPath, tool.renderArgs(width), {
      stdinText: htmlText
    });
    if (result.code !== 0) {
      throw new Error(`${tool.name} exited with ${String(result.code)}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "verge-oracle-"));
  const tempFilePath = resolve(tempRoot, "page.html");
  try {
    await writeFile(tempFilePath, htmlText, "utf8");
    const result = await runProcess(tool.binaryPath, tool.renderArgs(width, tempFilePath));
    if (result.code !== 0) {
      throw new Error(`${tool.name} exited with ${String(result.code)}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function summarizeByTool(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.tool)) {
      grouped.set(record.tool, []);
    }
    grouped.get(record.tool).push(record);
  }
  return [...grouped.entries()].map(([tool, toolRecords]) => {
    const meanTokenF1 = toolRecords.reduce((sum, entry) => sum + entry.tokenF1, 0) / toolRecords.length;
    const worst = [...toolRecords]
      .sort((left, right) => left.tokenF1 - right.tokenF1)
      .slice(0, 10)
      .map((entry) => ({
        sha256: entry.pageSha256,
        finalUrl: entry.finalUrl,
        width: entry.width,
        tokenF1: Number(entry.tokenF1.toFixed(6))
      }));
    return {
      tool,
      compared: toolRecords.length,
      meanTokenF1: Number(meanTokenF1.toFixed(6)),
      worst
    };
  }).sort((left, right) => left.tool.localeCompare(right.tool));
}

function classifyPageSurface(htmlText, expectedTokens) {
  const reasons = [];
  const normalizedHtml = htmlText.toLowerCase();
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(normalizedHtml)) {
    reasons.push("meta-refresh");
  }
  if (CHALLENGE_PATTERNS.some((pattern) => pattern.test(htmlText))) {
    reasons.push("challenge-pattern");
  }
  if (expectedTokens.length < 8 && /<script\b/i.test(normalizedHtml)) {
    reasons.push("low-visible-text-script-shell");
  }

  let surface = "meaningful-content";
  if (reasons.includes("challenge-pattern")) {
    surface = "challenge-shell";
  } else if (reasons.includes("meta-refresh")) {
    surface = "redirect-shell";
  } else if (reasons.length > 0) {
    surface = "shell-other";
  }

  return {
    surface,
    reasons,
    visibleTokenCount: expectedTokens.length
  };
}

function summarizeBySurface(records, pageClassificationBySha) {
  const bySurface = new Map();
  for (const [sha256, classification] of pageClassificationBySha.entries()) {
    const surface = classification.surface;
    if (!bySurface.has(surface)) {
      bySurface.set(surface, {
        pageShaSet: new Set(),
        records: []
      });
    }
    bySurface.get(surface).pageShaSet.add(sha256);
  }

  for (const record of records) {
    const surface = record.pageSurface ?? "meaningful-content";
    if (!bySurface.has(surface)) {
      bySurface.set(surface, {
        pageShaSet: new Set(),
        records: []
      });
    }
    bySurface.get(surface).pageShaSet.add(record.pageSha256);
    bySurface.get(surface).records.push(record);
  }

  return [...bySurface.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([surface, group]) => ({
      surface,
      pages: group.pageShaSet.size,
      toolScores: summarizeByTool(group.records)
    }));
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const pagesManifestPath = corpusPath(corpusDir, "manifests/pages.ndjson");
  const pageRecords = await readNdjson(pagesManifestPath);
  const uniquePages = new Map();
  for (const record of pageRecords) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (typeof record.sha256 !== "string" || record.sha256.length === 0) {
      continue;
    }
    if (!uniquePages.has(record.sha256)) {
      uniquePages.set(record.sha256, record);
    }
  }

  const pages = [...uniquePages.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
  const runId = sha256HexString(
    JSON.stringify({
      script: "run-oracles-offline-v1",
      pages: pages.map((page) => page.sha256),
      sourceMode: process.env.VERGE_ORACLE_SOURCE ?? "auto"
    })
  );

  const oracleTools = await resolveOracleTools();
  const availableTools = oracleTools.tools;
  const toolMetadata = oracleTools.metadata;

  const comparisonRecords = [];
  const pageClassificationBySha = new Map();
  for (const page of pages) {
    const pagePath = corpusPath(corpusDir, `cache/html/${page.sha256}.bin`);
    const htmlBytes = new Uint8Array(await readFile(pagePath));
    const htmlText = new TextDecoder().decode(htmlBytes);
    const expectedTokens = computeExpectedTokens(htmlBytes);
    const pageClassification = classifyPageSurface(htmlText, expectedTokens);
    pageClassificationBySha.set(page.sha256, pageClassification);

    for (const tool of availableTools) {
      for (const width of WIDTHS) {
        try {
          const oracleOutput = await runToolOnHtml(tool, htmlText, width);
          const oracleOutputSha = sha256HexString(oracleOutput);
          const oracleDir = corpusPath(corpusDir, `cache/oracle/${tool.name}`);
          await mkdir(oracleDir, { recursive: true });
          await writeFile(resolve(oracleDir, `${oracleOutputSha}.txt`), oracleOutput, "utf8");
          const oracleTokens = tokenizeText(oracleOutput);
          const tokenScore = tokenF1(expectedTokens, oracleTokens);

          comparisonRecords.push({
            runId,
            pageSha256: page.sha256,
            finalUrl: page.finalUrl,
            tool: tool.name,
            width,
            tokenF1: Number(tokenScore.toFixed(6)),
            stdoutSha256: oracleOutputSha,
            binaryPath: tool.binaryPath,
            source: tool.source,
            pageSurface: pageClassification.surface,
            pageSurfaceReasons: pageClassification.reasons
          });
        } catch (error) {
          comparisonRecords.push({
            runId,
            pageSha256: page.sha256,
            finalUrl: page.finalUrl,
            tool: tool.name,
            width,
            tokenF1: 0,
            stdoutSha256: null,
            binaryPath: tool.binaryPath,
            source: tool.source,
            pageSurface: pageClassification.surface,
            pageSurfaceReasons: pageClassification.reasons,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  comparisonRecords.sort((left, right) => {
    if (left.pageSha256 !== right.pageSha256) {
      return left.pageSha256.localeCompare(right.pageSha256);
    }
    if (left.tool !== right.tool) {
      return left.tool.localeCompare(right.tool);
    }
    return left.width - right.width;
  });

  const summary = {
    suite: "field-oracles",
    runId,
    generatedAtIso: new Date().toISOString(),
    pagesCompared: pages.length,
    sourceMode: oracleTools.sourceMode,
    image: oracleTools.image,
    tools: toolMetadata,
    pageSurfaceCounts: [...pageClassificationBySha.values()].reduce((acc, entry) => {
      const key = entry.surface;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    toolScores: summarizeByTool(comparisonRecords.filter((record) => !record.error)),
    toolScoresBySurface: summarizeBySurface(
      comparisonRecords.filter((record) => !record.error),
      pageClassificationBySha
    )
  };

  const reportPath = corpusPath(corpusDir, "reports/oracle-compare.ndjson");
  const summaryPath = corpusPath(corpusDir, "reports/oracle-summary.json");
  await writeNdjson(reportPath, comparisonRecords);
  await writeJson(summaryPath, summary);
  process.stdout.write(`field-oracles ok: tools=${String(availableTools.length)} pages=${String(pages.length)} runId=${runId}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-oracles failed: ${message}\n`);
  process.exit(1);
});
