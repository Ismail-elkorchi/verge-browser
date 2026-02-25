import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./json-report-io.mjs";

const WORKFLOW_PATH = ".github/workflows/release.yml";
const REPORT_PATH = "reports/release-attestation-policy.json";

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

function escapeRegex(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStepBody(sourceText, stepName) {
  const pattern = new RegExp(`-\\s+name:\\s+${escapeRegex(stepName)}\\n([\\s\\S]*?)(?=\\n\\s*-\\s+name:|$)`);
  const match = sourceText.match(pattern);
  return match?.[1] ?? "";
}

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

function hasCertIdentityVerifyStep(sourceText) {
  const stepText = extractStepBody(sourceText, "Verify attestations with certificate identity");
  if (stepText.length === 0) {
    return false;
  }
  return /gh\s+attestation\s+verify\s+"\$\{package_file\}"/.test(stepText)
    && /--cert-identity\s+"\$\{cert_identity\}"/.test(stepText)
    && /--source-digest\s+"\$\{GITHUB_SHA\}"/.test(stepText)
    && /--format\s+json\s*>\s*reports\/attestation-package-verify-cert-identity\.json/.test(stepText)
    && /gh\s+attestation\s+verify\s+"scripts\/oracles\/oracle-image\.lock\.json"/.test(stepText)
    && /--format\s+json\s*>\s*reports\/attestation-oracle-lock-verify-cert-identity\.json/.test(stepText);
}

function hasRuntimeReportStep(sourceText) {
  return sourceText.includes("Validate attestation runtime reports")
    && sourceText.includes("scripts/eval/write-release-attestation-runtime-report.mjs")
    && sourceText.includes("--cert-identity-package-input=reports/attestation-package-verify-cert-identity.json")
    && sourceText.includes("--cert-identity-lock-input=reports/attestation-oracle-lock-verify-cert-identity.json")
    && sourceText.includes("--offline-package-input=reports/offline-verification/package-offline-verify.json")
    && sourceText.includes("--offline-lock-input=reports/offline-verification/oracle-lock-offline-verify.json")
    && sourceText.includes("--output=reports/release-attestation-runtime.json")
    && sourceText.includes("--expected-source-digest=\"${GITHUB_SHA}\"")
    && sourceText.includes("--expected-package-sha256=\"${package_sha256}\"");
}

function hasOfflineVerificationExportStep(sourceText) {
  return sourceText.includes("Export offline verification materials")
    && /gh\s+attestation\s+trusted-root\s*>\s*trusted_root\.jsonl/.test(sourceText)
    && /gh\s+attestation\s+download\s+"\$\{workspace\}\/\$\{package_file\}"\s+--repo\s+"\$\{GITHUB_REPOSITORY\}"/.test(sourceText)
    && /gh\s+attestation\s+download\s+"\$\{workspace\}\/scripts\/oracles\/oracle-image\.lock\.json"\s+--repo\s+"\$\{GITHUB_REPOSITORY\}"/.test(sourceText)
    && sourceText.includes("reports/offline-verification/package-attestation-bundle.jsonl")
    && sourceText.includes("reports/offline-verification/oracle-lock-attestation-bundle.jsonl")
    && sourceText.includes("reports/offline-verification/trusted_root.jsonl")
    && sourceText.includes("reports/offline-verification/sha256.txt");
}

function hasOfflineVerificationReplayStep(sourceText) {
  const stepText = extractStepBody(sourceText, "Verify package and lock attestations offline");
  if (stepText.length === 0) {
    return false;
  }

  const trustedRootMentions = stepText.match(/--custom-trusted-root\s+"reports\/offline-verification\/trusted_root\.jsonl"/g) ?? [];
  const sourceDigestMentions = stepText.match(/--source-digest\s+"\$\{GITHUB_SHA\}"/g) ?? [];

  return /gh\s+attestation\s+verify\s+"\$\{package_file\}"/.test(stepText)
    && /--bundle\s+"reports\/offline-verification\/package-attestation-bundle\.jsonl"/.test(stepText)
    && /--format\s+json\s*>\s*reports\/offline-verification\/package-offline-verify\.json/.test(stepText)
    && /gh\s+attestation\s+verify\s+"scripts\/oracles\/oracle-image\.lock\.json"/.test(stepText)
    && /--bundle\s+"reports\/offline-verification\/oracle-lock-attestation-bundle\.jsonl"/.test(stepText)
    && /--format\s+json\s*>\s*reports\/offline-verification\/oracle-lock-offline-verify\.json/.test(stepText)
    && trustedRootMentions.length >= 2
    && sourceDigestMentions.length >= 2;
}

function hasOfflineContentPolicyStep(sourceText) {
  const stepText = extractStepBody(sourceText, "Check offline attestation content policy");
  if (stepText.length === 0) {
    return false;
  }
  return stepText.includes("scripts/eval/check-offline-attestation-content.mjs")
    && stepText.includes("--package-offline-input=reports/offline-verification/package-offline-verify.json")
    && stepText.includes("--lock-offline-input=reports/offline-verification/oracle-lock-offline-verify.json")
    && stepText.includes("--output=reports/offline-attestation-content-policy.json")
    && stepText.includes("--expected-source-digest=\"${GITHUB_SHA}\"")
    && stepText.includes("--expected-package-sha256=\"${package_sha256}\"");
}

function hasVerifierHermeticStep(sourceText) {
  const stepText = extractStepBody(sourceText, "Check release verifier hermetic imports");
  if (stepText.length === 0) {
    return false;
  }
  return stepText.includes("scripts/eval/check-release-verifier-hermetic.mjs")
    && stepText.includes("--output=reports/release-verifier-hermetic.json");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflowText = await readFile(resolve(options.workflow), "utf8");

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
      id: "release-workflow-verifies-attestation-cert-identity",
      ok: hasCertIdentityVerifyStep(workflowText),
      reason: "release workflow must verify package and oracle lock attestations using certificate-identity constrained checks"
    },
    {
      id: "release-workflow-writes-attestation-runtime-report",
      ok: hasRuntimeReportStep(workflowText),
      reason: "release workflow must validate and write reports/release-attestation-runtime.json from verification outputs"
    },
    {
      id: "release-workflow-exports-offline-verification-materials",
      ok: hasOfflineVerificationExportStep(workflowText),
      reason: "release workflow must export trusted_root and attestation bundles for offline verification"
    },
    {
      id: "release-workflow-replays-offline-verification",
      ok: hasOfflineVerificationReplayStep(workflowText),
      reason: "release workflow must replay package and lock attestation verification against exported bundles and trusted root"
    },
    {
      id: "release-workflow-checks-offline-attestation-content",
      ok: hasOfflineContentPolicyStep(workflowText),
      reason: "release workflow must validate offline verification JSON content against expected source and package digest"
    },
    {
      id: "release-workflow-checks-verifier-hermetic-imports",
      ok: hasVerifierHermeticStep(workflowText),
      reason: "release workflow verifier must enforce hermetic imports for verifier scripts"
    }
  ];

  const report = {
    suite: "release-attestation-policy",
    timestamp: new Date().toISOString(),
    workflow: options.workflow,
    checks,
    ok: checks.every((check) => check.ok)
  };

  const reportPath = resolve(options.output);
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("release attestation policy check failed");
  }

  process.stdout.write(`release attestation policy ok: ${reportPath}\n`);
}

await main();
