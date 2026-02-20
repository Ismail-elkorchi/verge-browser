import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextEncoder } from "node:util";

import { parseBytes, visibleText } from "html-parser";

import {
  corpusPath,
  ensureCorpusDirs,
  resolveCorpusDir,
  sha256HexString,
  tokenF1,
  tokenizeText,
  writeJson,
  writeNdjson
} from "../lib.mjs";

const MANIFEST_PATH = resolve(process.cwd(), "scripts/realworld/layout/wpt-subset.v1.json");
const DEFAULT_PLAYWRIGHT_MODULE = resolve(process.cwd(), "../html-parser/node_modules/playwright/index.mjs");
const MIN_ENGINE_COUNT = 2;
const MIN_ENGINE_AGREEMENT = 0.9;
const MAX_SNAPSHOT_VERGE_DRIFT = 0.05;
const MAX_SNAPSHOT_ENGINE_DRIFT = 0.05;
const VISIBLE_TEXT_POLICY_ID = "rendered-terminal-v1";
const VISIBLE_TEXT_OPTIONS = Object.freeze({
  skipHiddenSubtrees: false,
  includeControlValues: true,
  includeAccessibleNameFallback: false,
  trim: true
});
const UTF8_ENCODER = new TextEncoder();

function fixed6(value) {
  return Number(value.toFixed(6));
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function loadManifest() {
  const source = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(source);
  if (!manifest?.source?.commit || !Array.isArray(manifest?.snapshots)) {
    throw new Error("invalid WPT layout subset manifest");
  }
  return manifest;
}

function flattenCases(manifest) {
  const entries = [];
  for (const snapshot of manifest.snapshots) {
    for (const caseEntry of snapshot.cases ?? []) {
      entries.push({
        snapshotId: snapshot.id,
        ...caseEntry
      });
    }
  }
  return entries.sort((left, right) => {
    if (left.snapshotId !== right.snapshotId) {
      return left.snapshotId.localeCompare(right.snapshotId);
    }
    return left.id.localeCompare(right.id);
  });
}

async function loadPlaywright() {
  const override = process.env.VERGE_PLAYWRIGHT_MODULE_PATH;
  const modulePath = override && override.trim().length > 0
    ? resolve(process.cwd(), override)
    : DEFAULT_PLAYWRIGHT_MODULE;
  const moduleUrl = pathToFileURL(modulePath).href;
  return {
    modulePath,
    api: await import(moduleUrl)
  };
}

async function evaluateInnerText(browserType, html) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort("blockedbyclient"));
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await page.evaluate(() => {
      const body = globalThis.document?.body;
      return body ? body.innerText : "";
    });
  } finally {
    await browser.close();
  }
}

function vergeTokens(html) {
  const tree = parseBytes(UTF8_ENCODER.encode(html), {
    captureSpans: false,
    trace: false
  });
  return tokenizeText(visibleText(tree, VISIBLE_TEXT_OPTIONS));
}

async function main() {
  const manifest = await loadManifest();
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);
  await mkdir(corpusPath(corpusDir, "layout/reports"), { recursive: true });

  const commit = manifest.source.commit;
  const cacheRoot = corpusPath(corpusDir, `layout/cache/wpt/${commit}`);
  const cases = flattenCases(manifest);

  if (cases.length === 0) {
    throw new Error("manifest contains no cases");
  }

  const { modulePath, api: playwright } = await loadPlaywright();
  const availableEngines = [];
  const unavailableEngines = [];

  for (const engine of ["chromium", "firefox", "webkit"]) {
    const browserType = playwright[engine];
    if (!browserType) {
      unavailableEngines.push({ engine, reason: "not exported by playwright module" });
      continue;
    }
    try {
      const browser = await browserType.launch({ headless: true });
      const version = await browser.version();
      await browser.close();
      availableEngines.push({ engine, version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unavailableEngines.push({ engine, reason: message });
    }
  }

  if (availableEngines.length < MIN_ENGINE_COUNT) {
    throw new Error(
      `insufficient engines: required ${String(MIN_ENGINE_COUNT)}, available ${String(availableEngines.length)}`
    );
  }

  const detailRecords = [];
  for (const caseEntry of cases) {
    const casePath = resolve(cacheRoot, caseEntry.path);
    let html;
    try {
      html = await readFile(casePath, "utf8");
    } catch {
      throw new Error(`missing cached WPT file: ${caseEntry.path}; run layout fetch first`);
    }

    const expectedSha = caseEntry.sha256;
    const observedSha = sha256HexString(html);
    if (expectedSha !== observedSha) {
      throw new Error(
        `cached WPT file hash mismatch for ${caseEntry.id}; expected ${expectedSha}, got ${observedSha}`
      );
    }

    const verge = vergeTokens(html);
    const engineTokens = {};
    for (const engine of availableEngines) {
      const engineText = await evaluateInnerText(playwright[engine.engine], html);
      engineTokens[engine.engine] = tokenizeText(engineText);
    }

    const vergeVsEngine = {};
    for (const engine of availableEngines) {
      vergeVsEngine[engine.engine] = fixed6(tokenF1(verge, engineTokens[engine.engine] ?? []));
    }

    const engineAgreementPairs = [];
    for (let leftIndex = 0; leftIndex < availableEngines.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < availableEngines.length; rightIndex += 1) {
        const left = availableEngines[leftIndex];
        const right = availableEngines[rightIndex];
        engineAgreementPairs.push({
          pair: `${left.engine}:${right.engine}`,
          tokenF1: fixed6(tokenF1(engineTokens[left.engine] ?? [], engineTokens[right.engine] ?? []))
        });
      }
    }

    detailRecords.push({
      caseId: caseEntry.id,
      snapshotId: caseEntry.snapshotId,
      path: caseEntry.path,
      vergeVsEngine,
      engineAgreementPairs
    });
  }

  const snapshotSummaries = manifest.snapshots
    .map((snapshot) => {
      const records = detailRecords.filter((record) => record.snapshotId === snapshot.id);
      const vergeValues = records.flatMap((record) => Object.values(record.vergeVsEngine));
      const engineAgreementValues = records.flatMap((record) =>
        record.engineAgreementPairs.map((entry) => entry.tokenF1)
      );
      return {
        snapshotId: snapshot.id,
        caseCount: records.length,
        meanVergeVsEngineF1: fixed6(mean(vergeValues)),
        meanEngineAgreementF1: fixed6(mean(engineAgreementValues))
      };
    })
    .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));

  const snapshotA = snapshotSummaries[0] ?? null;
  const snapshotB = snapshotSummaries[1] ?? null;

  const vergeDrift = snapshotA && snapshotB
    ? fixed6(Math.abs(snapshotA.meanVergeVsEngineF1 - snapshotB.meanVergeVsEngineF1))
    : null;
  const engineDrift = snapshotA && snapshotB
    ? fixed6(Math.abs(snapshotA.meanEngineAgreementF1 - snapshotB.meanEngineAgreementF1))
    : null;

  const checks = {
    minEngineCount: {
      pass: availableEngines.length >= MIN_ENGINE_COUNT,
      required: MIN_ENGINE_COUNT,
      observed: availableEngines.length
    },
    minEngineAgreementPerSnapshot: {
      pass: snapshotSummaries.every((entry) => entry.meanEngineAgreementF1 >= MIN_ENGINE_AGREEMENT),
      required: MIN_ENGINE_AGREEMENT,
      observed: snapshotSummaries.map((entry) => ({
        snapshotId: entry.snapshotId,
        meanEngineAgreementF1: entry.meanEngineAgreementF1
      }))
    },
    snapshotVergeDrift: {
      pass: vergeDrift !== null && vergeDrift <= MAX_SNAPSHOT_VERGE_DRIFT,
      maxAllowed: MAX_SNAPSHOT_VERGE_DRIFT,
      observed: vergeDrift
    },
    snapshotEngineDrift: {
      pass: engineDrift !== null && engineDrift <= MAX_SNAPSHOT_ENGINE_DRIFT,
      maxAllowed: MAX_SNAPSHOT_ENGINE_DRIFT,
      observed: engineDrift
    }
  };

  const ok = Object.values(checks).every((entry) => entry.pass === true);

  const report = {
    suite: "layout-pilot",
    runId: sha256HexString(JSON.stringify({
      commit,
      policyId: VISIBLE_TEXT_POLICY_ID,
      engines: availableEngines.map((entry) => `${entry.engine}:${entry.version}`),
      cases: detailRecords.map((entry) => `${entry.snapshotId}:${entry.caseId}`)
    })),
    generatedAtIso: new Date().toISOString(),
    source: {
      repository: manifest.source.repository,
      commit
    },
    policy: {
      id: VISIBLE_TEXT_POLICY_ID,
      options: VISIBLE_TEXT_OPTIONS
    },
    playwrightModulePath: modulePath,
    engines: {
      available: availableEngines,
      unavailable: unavailableEngines
    },
    snapshots: snapshotSummaries,
    stability: {
      vergeDrift,
      engineDrift
    },
    checks,
    ok
  };

  await writeNdjson(corpusPath(corpusDir, "layout/reports/layout-pilot.ndjson"), detailRecords);
  await writeJson(corpusPath(corpusDir, "layout/reports/layout-pilot.json"), report);

  if (!ok) {
    throw new Error("layout pilot checks failed");
  }

  process.stdout.write(
    `layout-pilot ok: commit=${commit} engines=${String(availableEngines.length)} cases=${String(detailRecords.length)}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`layout-pilot failed: ${message}\n`);
  process.exit(1);
});
