import assert from "node:assert/strict";
import test from "node:test";

import { buildCohortGovernance, classifyPageToCohort } from "../../scripts/realworld/cohort-governance-lib.mjs";

function basePolicy() {
  return {
    version: "v4",
    decisionSurface: "meaningful-content",
    minSnapshots: 2,
    cohorts: [
      {
        id: "standards-reference",
        description: "spec pages",
        weight: 0.4,
        quota: { minPages: 1, minRecords: 2 }
      },
      {
        id: "application-auth-challenge",
        description: "auth pages",
        weight: 0.35,
        quota: { minPages: 1, minRecords: 2 }
      },
      {
        id: "dynamic-interaction-heavy",
        description: "dynamic pages",
        weight: 0.25,
        quota: { minPages: 1, minRecords: 2 }
      }
    ],
    rules: {
      applicationSurfaces: ["auth-wall", "challenge-shell", "redirect-shell"],
      dynamicSurfaces: ["script-critical"],
      dynamicScriptTagThreshold: 8,
      standardsHostsExact: ["www.w3.org"],
      standardsHostSuffixes: [".spec.whatwg.org"]
    }
  };
}

function basePageSurfaceReport() {
  return {
    pages: [
      {
        pageSha256: "a",
        finalUrl: "https://www.w3.org/TR/css-grid-2/",
        surface: "meaningful-content",
        scriptTagCount: 2
      },
      {
        pageSha256: "b",
        finalUrl: "https://example.test/login",
        surface: "auth-wall",
        scriptTagCount: 1
      },
      {
        pageSha256: "c",
        finalUrl: "https://app.example.test/dashboard",
        surface: "meaningful-content",
        scriptTagCount: 12
      }
    ]
  };
}

function basePolicySummary() {
  return {
    policySelection: {
      promotedPolicyId: "rendered-terminal-v1",
      decisionSurface: "meaningful-content"
    },
    gates: {
      ok: true
    }
  };
}

function basePolicyRecords() {
  return [
    {
      pageSha256: "a",
      tool: "lynx",
      width: 80,
      pageSnapshotId: "2026-02-19",
      scores: {
        baseline: { normalizedTokenF1: 0.8 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.82 }
      }
    },
    {
      pageSha256: "a",
      tool: "w3m",
      width: 120,
      pageSnapshotId: "2026-02-20",
      scores: {
        baseline: { normalizedTokenF1: 0.79 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.81 }
      }
    },
    {
      pageSha256: "b",
      tool: "lynx",
      width: 80,
      pageSnapshotId: "2026-02-19",
      scores: {
        baseline: { normalizedTokenF1: 0.71 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.72 }
      }
    },
    {
      pageSha256: "b",
      tool: "w3m",
      width: 120,
      pageSnapshotId: "2026-02-20",
      scores: {
        baseline: { normalizedTokenF1: 0.7 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.71 }
      }
    },
    {
      pageSha256: "c",
      tool: "lynx",
      width: 80,
      pageSnapshotId: "2026-02-19",
      scores: {
        baseline: { normalizedTokenF1: 0.74 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.75 }
      }
    },
    {
      pageSha256: "c",
      tool: "w3m",
      width: 120,
      pageSnapshotId: "2026-02-20",
      scores: {
        baseline: { normalizedTokenF1: 0.73 },
        "rendered-terminal-v1": { normalizedTokenF1: 0.74 }
      }
    }
  ];
}

function baseResidualReport() {
  return {
    records: [
      { pageSha256: "a", tool: "lynx", width: 80, residualMass: 0.2 },
      { pageSha256: "a", tool: "w3m", width: 120, residualMass: 0.2 },
      { pageSha256: "b", tool: "lynx", width: 80, residualMass: 0.5 },
      { pageSha256: "b", tool: "w3m", width: 120, residualMass: 0.5 },
      { pageSha256: "c", tool: "lynx", width: 80, residualMass: 0.3 },
      { pageSha256: "c", tool: "w3m", width: 120, residualMass: 0.3 }
    ]
  };
}

test("classifyPageToCohort follows deterministic cohort rules", () => {
  const policy = basePolicy();
  const standardsPage = basePageSurfaceReport().pages[0];
  const authPage = basePageSurfaceReport().pages[1];
  const dynamicPage = basePageSurfaceReport().pages[2];

  assert.equal(classifyPageToCohort(standardsPage, policy).cohortId, "standards-reference");
  assert.equal(classifyPageToCohort(authPage, policy).cohortId, "application-auth-challenge");
  assert.equal(classifyPageToCohort(dynamicPage, policy).cohortId, "dynamic-interaction-heavy");
});

test("buildCohortGovernance reports weighted cohort table and passes quotas", () => {
  const result = buildCohortGovernance({
    policyConfig: basePolicy(),
    pageSurfaceReport: basePageSurfaceReport(),
    policySummary: basePolicySummary(),
    policyRecords: basePolicyRecords(),
    residualReport: baseResidualReport(),
    inputHashes: {
      cohortConfigSha256: "a",
      pageSurfaceReportSha256: "b",
      policySummaryReportSha256: "c",
      policyNdjsonReportSha256: "d",
      residualReportSha256: "e"
    }
  });

  assert.equal(result.governanceReport.ok, true);
  assert.equal(result.governanceReport.cohorts.length, 3);
  assert.equal(result.governanceReport.checks.cohortQuotas.pass, true);
  assert.equal(result.governanceReport.checks.snapshotCoverage.pass, true);
  assert.ok(result.snapshotReport.snapshotFingerprint.length > 0);
});

test("buildCohortGovernance fails when one cohort is absent", () => {
  const pageSurfaceReport = basePageSurfaceReport();
  pageSurfaceReport.pages = pageSurfaceReport.pages.filter((page) => page.pageSha256 !== "c");
  const policyRecords = basePolicyRecords().filter((record) => record.pageSha256 !== "c");
  const residualReport = baseResidualReport();
  residualReport.records = residualReport.records.filter((record) => record.pageSha256 !== "c");

  const result = buildCohortGovernance({
    policyConfig: basePolicy(),
    pageSurfaceReport,
    policySummary: basePolicySummary(),
    policyRecords,
    residualReport,
    inputHashes: {
      cohortConfigSha256: "a",
      pageSurfaceReportSha256: "b",
      policySummaryReportSha256: "c",
      policyNdjsonReportSha256: "d",
      residualReportSha256: "e"
    }
  });

  assert.equal(result.governanceReport.ok, false);
  assert.equal(result.governanceReport.checks.cohortQuotas.pass, false);
});

