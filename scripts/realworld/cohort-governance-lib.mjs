import { createHash } from "node:crypto";

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeHost(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  try {
    return new globalThis.URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

function normalizePolicy(policyConfig) {
  const cohortById = new Map();
  for (const cohort of policyConfig.cohorts ?? []) {
    cohortById.set(cohort.id, cohort);
  }
  return {
    ...policyConfig,
    cohortById,
    rules: {
      applicationSurfaces: new Set(policyConfig.rules?.applicationSurfaces ?? []),
      dynamicSurfaces: new Set(policyConfig.rules?.dynamicSurfaces ?? []),
      standardsHostsExact: new Set((policyConfig.rules?.standardsHostsExact ?? []).map((entry) => entry.toLowerCase())),
      standardsHostSuffixes: (policyConfig.rules?.standardsHostSuffixes ?? []).map((entry) => entry.toLowerCase()),
      dynamicScriptTagThreshold: Number(policyConfig.rules?.dynamicScriptTagThreshold ?? 0)
    }
  };
}

function hostIsStandards(host, rules) {
  if (!host) {
    return false;
  }
  if (rules.standardsHostsExact.has(host)) {
    return true;
  }
  return rules.standardsHostSuffixes.some((suffix) => host.endsWith(suffix));
}

export function classifyPageToCohort(page, policy) {
  const host = normalizeHost(page.finalUrl);
  const surface = String(page.surface ?? "");
  const scriptTagCount = Number(page.scriptTagCount ?? 0);
  const rules = {
    applicationSurfaces:
      policy.rules?.applicationSurfaces instanceof Set
        ? policy.rules.applicationSurfaces
        : new Set(policy.rules?.applicationSurfaces ?? []),
    dynamicSurfaces:
      policy.rules?.dynamicSurfaces instanceof Set
        ? policy.rules.dynamicSurfaces
        : new Set(policy.rules?.dynamicSurfaces ?? []),
    standardsHostsExact:
      policy.rules?.standardsHostsExact instanceof Set
        ? policy.rules.standardsHostsExact
        : new Set((policy.rules?.standardsHostsExact ?? []).map((entry) => String(entry).toLowerCase())),
    standardsHostSuffixes: (policy.rules?.standardsHostSuffixes ?? []).map((entry) => String(entry).toLowerCase()),
    dynamicScriptTagThreshold: Number(policy.rules?.dynamicScriptTagThreshold ?? 0)
  };

  if (rules.applicationSurfaces.has(surface)) {
    return {
      cohortId: "application-auth-challenge",
      reason: `surface:${surface}`
    };
  }
  if (rules.dynamicSurfaces.has(surface)) {
    return {
      cohortId: "dynamic-interaction-heavy",
      reason: `surface:${surface}`
    };
  }
  if (hostIsStandards(host, rules)) {
    return {
      cohortId: "standards-reference",
      reason: `host:${host}`
    };
  }
  if (scriptTagCount >= rules.dynamicScriptTagThreshold) {
    return {
      cohortId: "dynamic-interaction-heavy",
      reason: `scriptTagCount>=${String(rules.dynamicScriptTagThreshold)}`
    };
  }
  return {
    cohortId: "dynamic-interaction-heavy",
    reason: "fallback:meaningful-or-unknown"
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const next = {};
    for (const key of sortedKeys) {
      next[key] = canonicalize(value[key]);
    }
    return next;
  }
  return value;
}

function sha256Object(value) {
  return hashText(JSON.stringify(canonicalize(value)));
}

function toMillis(value) {
  return Number(value.toFixed(6));
}

function buildResidualMap(residualReport) {
  const map = new Map();
  for (const record of residualReport.records ?? []) {
    const key = `${record.pageSha256}|${record.tool}|${String(record.width)}`;
    map.set(key, Number(record.residualMass ?? 1));
  }
  return map;
}

export function buildCohortGovernance({
  policyConfig,
  pageSurfaceReport,
  policySummary,
  policyRecords,
  residualReport,
  inputHashes
}) {
  const normalizedPolicy = normalizePolicy(policyConfig);
  const cohorts = normalizedPolicy.cohorts ?? [];
  const cohortIds = new Set(cohorts.map((entry) => entry.id));
  const promotedPolicyId =
    policySummary?.policySelection?.promotedPolicyId ??
    policySummary?.recommendedCandidatePolicyId ??
    null;
  if (!promotedPolicyId) {
    throw new Error("promoted policy id missing from visible-text-policy-compare report");
  }

  const pageBySha = new Map();
  const cohortByPageSha = new Map();
  const cohortMembership = {};

  for (const cohort of cohorts) {
    cohortMembership[cohort.id] = [];
  }

  for (const page of pageSurfaceReport.pages ?? []) {
    const pageSha256 = String(page.pageSha256 ?? "");
    if (!pageSha256) {
      continue;
    }
    pageBySha.set(pageSha256, page);
    const classification = classifyPageToCohort(page, normalizedPolicy);
    if (!cohortIds.has(classification.cohortId)) {
      throw new Error(`page assigned to unknown cohort '${classification.cohortId}'`);
    }
    cohortByPageSha.set(pageSha256, classification);
    cohortMembership[classification.cohortId].push({
      pageSha256,
      finalUrl: page.finalUrl,
      surface: page.surface,
      reason: classification.reason
    });
  }

  for (const cohortId of Object.keys(cohortMembership)) {
    cohortMembership[cohortId].sort((left, right) => left.pageSha256.localeCompare(right.pageSha256));
  }

  const residualByRecord = buildResidualMap(residualReport);

  const statsByCohort = new Map(
    cohorts.map((cohort) => [
      cohort.id,
      {
        id: cohort.id,
        description: cohort.description,
        weight: Number(cohort.weight ?? 0),
        quota: {
          minPages: Number(cohort.quota?.minPages ?? 0),
          minRecords: Number(cohort.quota?.minRecords ?? 0)
        },
        pages: new Set(),
        records: 0,
        snapshots: new Set(),
        baselineSum: 0,
        candidateSum: 0,
        deltaSum: 0,
        weightedDeltaNumerator: 0,
        weightedDeltaDenominator: 0,
        betterCount: 0,
        worseCount: 0,
        sameCount: 0
      }
    ])
  );

  for (const record of policyRecords) {
    const pageSha256 = String(record.pageSha256 ?? "");
    if (!pageSha256) {
      continue;
    }
    const classification = cohortByPageSha.get(pageSha256);
    if (!classification) {
      continue;
    }
    const cohortStats = statsByCohort.get(classification.cohortId);
    if (!cohortStats) {
      continue;
    }
    const baseline = Number(
      record?.scores?.baseline?.normalizedTokenF1 ??
        record?.baseline?.normalizedTokenF1 ??
        NaN
    );
    const candidate = Number(
      record?.scores?.[promotedPolicyId]?.normalizedTokenF1 ??
        record?.candidate?.normalizedTokenF1 ??
        NaN
    );
    if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) {
      continue;
    }
    const delta = candidate - baseline;
    const residualKey = `${pageSha256}|${record.tool}|${String(record.width)}`;
    const residualWeight = Number(residualByRecord.get(residualKey) ?? 1);

    cohortStats.records += 1;
    cohortStats.pages.add(pageSha256);
    cohortStats.snapshots.add(String(record.pageSnapshotId ?? "unknown"));
    cohortStats.baselineSum += baseline;
    cohortStats.candidateSum += candidate;
    cohortStats.deltaSum += delta;
    cohortStats.weightedDeltaNumerator += delta * residualWeight;
    cohortStats.weightedDeltaDenominator += residualWeight;
    if (delta > 0) {
      cohortStats.betterCount += 1;
    } else if (delta < 0) {
      cohortStats.worseCount += 1;
    } else {
      cohortStats.sameCount += 1;
    }
  }

  const cohortsReport = [];
  let weightedBaselineMeanNormalizedTokenF1 = 0;
  let weightedCandidateMeanNormalizedTokenF1 = 0;
  let weightedMeanDeltaNormalizedTokenF1 = 0;
  let weightedResidualDeltaNormalizedTokenF1 = 0;
  let weightSum = 0;
  let comparedRecordCount = 0;
  let comparedPageCount = 0;
  const allSnapshotIds = new Set();

  for (const cohort of cohorts) {
    const entry = statsByCohort.get(cohort.id);
    const pageCount = entry.pages.size;
    const recordCount = entry.records;
    const baselineMean = recordCount > 0 ? entry.baselineSum / recordCount : 0;
    const candidateMean = recordCount > 0 ? entry.candidateSum / recordCount : 0;
    const meanDelta = recordCount > 0 ? entry.deltaSum / recordCount : 0;
    const residualWeightedDelta =
      entry.weightedDeltaDenominator > 0
        ? entry.weightedDeltaNumerator / entry.weightedDeltaDenominator
        : 0;

    comparedRecordCount += recordCount;
    comparedPageCount += pageCount;
    for (const snapshotId of entry.snapshots) {
      allSnapshotIds.add(snapshotId);
    }

    const quotaPass = pageCount >= entry.quota.minPages && recordCount >= entry.quota.minRecords;
    cohortsReport.push({
      id: entry.id,
      description: entry.description,
      weight: entry.weight,
      quota: {
        minPages: entry.quota.minPages,
        minRecords: entry.quota.minRecords
      },
      observed: {
        pages: pageCount,
        records: recordCount,
        snapshots: [...entry.snapshots].sort()
      },
      scores: {
        baselineMeanNormalizedTokenF1: toMillis(baselineMean),
        candidateMeanNormalizedTokenF1: toMillis(candidateMean),
        meanDeltaNormalizedTokenF1: toMillis(meanDelta),
        residualWeightedDeltaNormalizedTokenF1: toMillis(residualWeightedDelta),
        betterCount: entry.betterCount,
        worseCount: entry.worseCount,
        sameCount: entry.sameCount
      },
      checks: {
        quota: {
          pass: quotaPass,
          observedPages: pageCount,
          observedRecords: recordCount
        }
      }
    });

    weightSum += entry.weight;
    weightedBaselineMeanNormalizedTokenF1 += entry.weight * baselineMean;
    weightedCandidateMeanNormalizedTokenF1 += entry.weight * candidateMean;
    weightedMeanDeltaNormalizedTokenF1 += entry.weight * meanDelta;
    weightedResidualDeltaNormalizedTokenF1 += entry.weight * residualWeightedDelta;
  }

  cohortsReport.sort((left, right) => left.id.localeCompare(right.id));

  const weightsPass = Math.abs(weightSum - 1) <= 1e-9;
  const cohortsCoveredPass = cohortsReport.length >= 3;
  const cohortQuotaPass = cohortsReport.every((entry) => entry.checks.quota.pass);
  const policyGatesPass = policySummary?.gates?.ok === true;
  const decisionSurfacePass =
    String(policySummary?.policySelection?.decisionSurface ?? "") === String(policyConfig.decisionSurface ?? "");
  const snapshotCount = allSnapshotIds.size;
  const snapshotsPass = snapshotCount >= Number(policyConfig.minSnapshots ?? 2);

  const snapshotIds = [...allSnapshotIds].sort();

  const fingerprintInputs = {
    promotedPolicyId,
    decisionSurface: policySummary?.policySelection?.decisionSurface ?? null,
    snapshotIds,
    cohortMembership: Object.fromEntries(
      Object.entries(cohortMembership).map(([cohortId, pages]) => [
        cohortId,
        pages.map((entry) => entry.pageSha256)
      ])
    ),
    inputHashes
  };
  const snapshotFingerprint = sha256Object(fingerprintInputs);
  const runId = sha256Object({
    suite: "cohort-governance-v4",
    snapshotFingerprint
  });

  const snapshotReport = {
    suite: "cohort-snapshot-fingerprint",
    version: "v1",
    generatedAtIso: new Date().toISOString(),
    runId,
    promotedPolicyId,
    decisionSurface: policySummary?.policySelection?.decisionSurface ?? null,
    snapshotIds,
    inputHashes,
    cohortMembershipHash: sha256Object(fingerprintInputs.cohortMembership),
    snapshotFingerprint
  };

  const checks = {
    policyGates: {
      pass: policyGatesPass,
      expected: true,
      observed: policySummary?.gates?.ok ?? null
    },
    decisionSurfaceMatch: {
      pass: decisionSurfacePass,
      expected: policyConfig.decisionSurface,
      observed: policySummary?.policySelection?.decisionSurface ?? null
    },
    cohortCoverage: {
      pass: cohortsCoveredPass,
      expectedMinCohorts: 3,
      observedCohorts: cohortsReport.length
    },
    cohortQuotas: {
      pass: cohortQuotaPass
    },
    weightSum: {
      pass: weightsPass,
      expected: 1,
      observed: toMillis(weightSum)
    },
    snapshotCoverage: {
      pass: snapshotsPass,
      expectedMinSnapshots: Number(policyConfig.minSnapshots ?? 2),
      observedSnapshots: snapshotCount
    }
  };

  const ok = Object.values(checks).every((entry) => entry.pass);

  const governanceReport = {
    suite: "cohort-governance-v4",
    generatedAtIso: new Date().toISOString(),
    runId,
    policy: {
      configPath: policyConfig.__path ?? null,
      version: policyConfig.version ?? null,
      promotedPolicyId,
      decisionSurface: policySummary?.policySelection?.decisionSurface ?? null
    },
    counts: {
      comparedPages: comparedPageCount,
      comparedRecords: comparedRecordCount
    },
    cohorts: cohortsReport,
    weightedAggregate: {
      baselineMeanNormalizedTokenF1: toMillis(weightedBaselineMeanNormalizedTokenF1),
      candidateMeanNormalizedTokenF1: toMillis(weightedCandidateMeanNormalizedTokenF1),
      meanDeltaNormalizedTokenF1: toMillis(weightedMeanDeltaNormalizedTokenF1),
      residualWeightedDeltaNormalizedTokenF1: toMillis(weightedResidualDeltaNormalizedTokenF1)
    },
    snapshot: {
      ids: snapshotIds,
      fingerprint: snapshotFingerprint
    },
    cohortMembership,
    checks,
    ok
  };

  return {
    governanceReport,
    snapshotReport
  };
}
