import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const WORKFLOW_PATH = ".github/workflows/release.yml";
const LOCK_PATH = "scripts/oracles/oracle-image.lock.json";

function hasLockAttestationStep(sourceText) {
  return sourceText.includes("uses: actions/attest-build-provenance@v3")
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
    && /--cert-oidc-issuer\s+"https:\/\/token\.actions\.githubusercontent\.com"/.test(sourceText)
    && /--deny-self-hosted-runners/.test(sourceText)
    && /--predicate-type\s+"https:\/\/slsa\.dev\/provenance\/v1"/.test(sourceText)
    && /--format\s+json\s*>\s*reports\/attestation-oracle-lock-verify\.json/.test(sourceText);
}

async function main() {
  const workflowText = await readFile(resolve(WORKFLOW_PATH), "utf8");

  const checks = [
    {
      id: "release-workflow-attests-oracle-lock",
      ok: hasLockAttestationStep(workflowText),
      reason: "release workflow must generate provenance attestation for oracle lock file"
    },
    {
      id: "release-workflow-verifies-oracle-lock-attestation",
      ok: hasLockAttestationVerifyStep(workflowText),
      reason: "release workflow must verify oracle lock attestation with repo, signer-workflow, source-ref, OIDC issuer, hosted-runner, predicate constraints, and JSON output"
    }
  ];

  const report = {
    suite: "oracle-lock-attestation-policy",
    timestamp: new Date().toISOString(),
    workflow: WORKFLOW_PATH,
    lockPath: LOCK_PATH,
    checks,
    ok: checks.every((check) => check.ok)
  };

  const reportPath = resolve("reports/oracle-lock-attestation-policy.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle lock attestation policy check failed");
  }

  process.stdout.write(`oracle lock attestation policy ok: ${reportPath}\n`);
}

await main();
