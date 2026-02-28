import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const WORKFLOW_PATH = ".github/workflows/release.yml";
const LOCK_PATH = "scripts/oracles/oracle-image.lock.json";
const REPORT_PATH = "reports/oracle-lock-attestation-policy.json";

function parseArgs(argv) {
  const options = {
    workflow: WORKFLOW_PATH,
    output: REPORT_PATH
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      throw new Error(`unsupported argument: ${arg}`);
    }
    const [rawKey, ...rawValueParts] = arg.slice(2).split("=");
    const value = rawValueParts.join("=").trim();
    if (value.length === 0) {
      throw new Error(`missing value for argument: ${arg}`);
    }
    if (rawKey === "workflow") {
      options.workflow = value;
      continue;
    }
    if (rawKey === "output") {
      options.output = value;
      continue;
    }
    throw new Error(`unsupported argument key: ${rawKey}`);
  }

  return options;
}

function hasLockAttestationStep(sourceText) {
  return /uses:\s*actions\/attest-build-provenance@[^\s#]+/.test(sourceText)
    && sourceText.includes("Generate oracle lock provenance attestation")
    && sourceText.includes(`subject-path: ${LOCK_PATH}`);
}

function hasLockAttestationVerifyStep(sourceText) {
  if (!sourceText.includes(`gh attestation verify "${LOCK_PATH}"`)) {
    return false;
  }
  return /--repo\s+"\$\{\s*GITHUB_REPOSITORY\s*\}"/.test(sourceText)
    && /--signer-workflow\s+"\$\{\s*GITHUB_REPOSITORY\s*\}\/\.github\/workflows\/release\.yml"/.test(sourceText)
    && /--source-ref\s+"\$\{\s*GITHUB_REF\s*\}"/.test(sourceText)
    && /--source-digest\s+"\$\{\s*GITHUB_SHA\s*\}"/.test(sourceText)
    && /--cert-oidc-issuer\s+"https:\/\/token\.actions\.githubusercontent\.com"/.test(sourceText)
    && /--deny-self-hosted-runners/.test(sourceText)
    && /--predicate-type\s+"https:\/\/slsa\.dev\/provenance\/v1"/.test(sourceText)
    && /--format\s+json\s*>\s*reports\/attestation-oracle-lock-verify\.json/.test(sourceText);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflowText = await readFile(resolve(options.workflow), "utf8");

  const checks = [
    {
      id: "release-workflow-attests-oracle-lock",
      ok: hasLockAttestationStep(workflowText),
      reason: "release workflow must generate provenance attestation for oracle lock file"
    },
    {
      id: "release-workflow-verifies-oracle-lock-attestation",
      ok: hasLockAttestationVerifyStep(workflowText),
      reason: "release workflow must verify oracle lock attestation with repo, signer-workflow, source-ref, source-digest, OIDC issuer, hosted-runner, predicate constraints, and JSON output"
    }
  ];

  const report = {
    suite: "oracle-lock-attestation-policy",
    timestamp: new Date().toISOString(),
    workflow: options.workflow,
    lockPath: LOCK_PATH,
    checks,
    ok: checks.every((check) => check.ok)
  };

  const reportPath = resolve(options.output);
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle lock attestation policy check failed");
  }

  process.stdout.write(`oracle lock attestation policy ok: ${reportPath}\n`);
}

await main();
