import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const WORKFLOW_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/oracle-runtime-validation.yml",
  ".github/workflows/oracle-validation-ladder.yml"
];

function collectViolations(path, sourceText) {
  const violations = [];
  const lines = sourceText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("--rebuild-lock")) {
      continue;
    }
    violations.push({
      path,
      line: index + 1,
      reason: "oracle workflow must replay lock and must not rebuild lock in CI"
    });
  }
  return violations;
}

async function main() {
  const violations = [];
  for (const workflowPath of WORKFLOW_PATHS) {
    const sourceText = await readFile(resolve(workflowPath), "utf8");
    violations.push(...collectViolations(workflowPath, sourceText));
  }

  const report = {
    suite: "oracle-workflow-policy",
    timestamp: new Date().toISOString(),
    workflows: WORKFLOW_PATHS,
    violations,
    ok: violations.length === 0
  };

  const reportPath = resolve("reports/oracle-workflow-policy.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle workflow policy check failed");
  }

  process.stdout.write(`oracle workflow policy ok: ${reportPath}\n`);
}

await main();
