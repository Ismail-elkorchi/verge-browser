import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const WORKFLOW_PATH = ".github/workflows/release.yml";

function hasArtifactAttestationStep(sourceText) {
  return /uses:\s*actions\/attest-build-provenance@v3/.test(sourceText);
}

function hasTarballSubjectPath(sourceText) {
  return /subject-path:\s*(?:\|\s*[\s\S]*?\*\.tgz|'\*\.tgz'|"\*\.tgz")/.test(sourceText);
}

function hasAttestationVerifyStep(sourceText) {
  if (!/gh\s+attestation\s+verify/.test(sourceText)) {
    return false;
  }
  return /--repo\s+"\$\{\s*GITHUB_REPOSITORY\s*\}"/.test(sourceText)
    && /--signer-workflow\s+"\$\{\s*GITHUB_REPOSITORY\s*\}\/\.github\/workflows\/release\.yml"/.test(sourceText)
    && /--source-ref\s+"\$\{\s*GITHUB_REF\s*\}"/.test(sourceText)
    && /--source-digest\s+"\$\{\s*GITHUB_SHA\s*\}"/.test(sourceText)
    && /--cert-oidc-issuer\s+"https:\/\/token\.actions\.githubusercontent\.com"/.test(sourceText)
    && /--deny-self-hosted-runners/.test(sourceText)
    && /--predicate-type\s+"https:\/\/slsa\.dev\/provenance\/v1"/.test(sourceText)
    && /--format\s+json\s*>\s*reports\/attestation-package-verify\.json/.test(sourceText);
}

function hasRuntimeReportStep(sourceText) {
  return sourceText.includes("Validate attestation runtime reports")
    && sourceText.includes("scripts/eval/write-release-attestation-runtime-report.mjs")
    && sourceText.includes("--output=reports/release-attestation-runtime.json")
    && sourceText.includes("--expected-source-digest=\"${GITHUB_SHA}\"");
}

async function main() {
  const workflowText = await readFile(resolve(WORKFLOW_PATH), "utf8");

  const checks = [
    {
      id: "release-workflow-has-attest-build-provenance",
      ok: hasArtifactAttestationStep(workflowText),
      reason: "release workflow must generate build provenance attestation"
    },
    {
      id: "release-workflow-attests-tarball-subject",
      ok: hasTarballSubjectPath(workflowText),
      reason: "release workflow attestation subject-path must include *.tgz"
    },
    {
      id: "release-workflow-verifies-attestation",
      ok: hasAttestationVerifyStep(workflowText),
      reason: "release workflow must verify artifact attestations with repo, signer-workflow, source-ref, source-digest, OIDC issuer, hosted-runner, predicate constraints, and JSON output"
    },
    {
      id: "release-workflow-writes-attestation-runtime-report",
      ok: hasRuntimeReportStep(workflowText),
      reason: "release workflow must validate and write reports/release-attestation-runtime.json from verification outputs"
    }
  ];

  const report = {
    suite: "release-attestation-policy",
    timestamp: new Date().toISOString(),
    workflow: WORKFLOW_PATH,
    checks,
    ok: checks.every((check) => check.ok)
  };

  const reportPath = resolve("reports/release-attestation-policy.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("release attestation policy check failed");
  }

  process.stdout.write(`release attestation policy ok: ${reportPath}\n`);
}

await main();
