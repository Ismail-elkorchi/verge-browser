import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

function parseProfile(argv) {
  const profileArg = argv.find((argument) => argument.startsWith("--profile="));
  if (!profileArg) {
    return "ci";
  }
  const value = profileArg.slice("--profile=".length).trim();
  if (value !== "ci" && value !== "release") {
    throw new Error(`invalid profile: ${value}`);
  }
  return value;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit"
  });

  return {
    ok: result.status === 0,
    code: result.status ?? 1
  };
}

async function loadOptionalJson(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const config = await readJson("evaluation.config.json");

  const requiredRuntimes = Array.isArray(config.runtime?.targets)
    ? config.runtime.targets
    : ["node", "deno", "bun"];
  const requireRuntimeMatrix = Boolean(config.render?.profiles?.[profile]?.requireRuntimeMatrix);

  const commandByRuntime = {
    node: ["npm", ["run", "smoke:node"]],
    deno: ["npm", ["run", "smoke:deno"]],
    bun: ["npm", ["run", "smoke:bun"]]
  };

  for (const runtime of requiredRuntimes) {
    const commandEntry = commandByRuntime[runtime];
    if (!commandEntry) {
      continue;
    }
    runCommand(commandEntry[0], commandEntry[1]);
  }

  const reports = {
    node: await loadOptionalJson("reports/smoke-node.json"),
    deno: await loadOptionalJson("reports/smoke-deno.json"),
    bun: await loadOptionalJson("reports/smoke-bun.json")
  };

  const runtimeChecks = {};
  for (const runtime of requiredRuntimes) {
    const report = reports[runtime] ?? null;
    runtimeChecks[runtime] = {
      ok: Boolean(report?.ok),
      hash: typeof report?.hash === "string" ? report.hash : null,
      error: report?.error ?? null,
      missing: report === null
    };
  }

  const hashValues = requiredRuntimes
    .map((runtime) => runtimeChecks[runtime]?.hash)
    .filter((value) => typeof value === "string");
  const hashesAgree = hashValues.length === requiredRuntimes.length && new Set(hashValues).size === 1;

  const allRuntimesOk = requiredRuntimes.every((runtime) => runtimeChecks[runtime]?.ok === true);
  const actualOk = allRuntimesOk && hashesAgree;
  const gateOk = requireRuntimeMatrix ? actualOk : true;

  await writeJsonReport("reports/runtime-matrix.json", {
    suite: "runtime-matrix",
    profile,
    timestamp: new Date().toISOString(),
    requiredRuntimes,
    requireRuntimeMatrix,
    runtimes: runtimeChecks,
    hashesAgree,
    overall: {
      ok: gateOk,
      actualOk
    }
  });

  if (!gateOk) {
    throw new Error("runtime matrix check failed");
  }
}

await main();
