import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const HEX_SHA1_PATTERN = /^[a-f0-9]{40}$/i;

function parseArgs(argv) {
  const options = {
    packageInput: "reports/attestation-package-verify.json",
    lockInput: "reports/attestation-oracle-lock-verify.json",
    output: "reports/release-attestation-runtime.json",
    expectedRepo: "",
    expectedSourceRef: "",
    expectedSourceDigest: "",
    expectedWorkflow: "",
    expectedIssuer: "https://token.actions.githubusercontent.com",
    expectedPredicateType: "https://slsa.dev/provenance/v1"
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
    if (rawKey === "package-input") {
      options.packageInput = value;
      continue;
    }
    if (rawKey === "lock-input") {
      options.lockInput = value;
      continue;
    }
    if (rawKey === "output") {
      options.output = value;
      continue;
    }
    if (rawKey === "expected-repo") {
      options.expectedRepo = value;
      continue;
    }
    if (rawKey === "expected-source-ref") {
      options.expectedSourceRef = value;
      continue;
    }
    if (rawKey === "expected-source-digest") {
      options.expectedSourceDigest = value;
      continue;
    }
    if (rawKey === "expected-workflow") {
      options.expectedWorkflow = value;
      continue;
    }
    if (rawKey === "expected-issuer") {
      options.expectedIssuer = value;
      continue;
    }
    if (rawKey === "expected-predicate-type") {
      options.expectedPredicateType = value;
      continue;
    }
    throw new Error(`unsupported argument key: ${rawKey}`);
  }

  if (options.expectedRepo.length === 0) {
    throw new Error("missing --expected-repo");
  }
  if (options.expectedSourceRef.length === 0) {
    throw new Error("missing --expected-source-ref");
  }
  if (options.expectedSourceDigest.length === 0) {
    throw new Error("missing --expected-source-digest");
  }
  if (!HEX_SHA1_PATTERN.test(options.expectedSourceDigest)) {
    throw new Error("invalid --expected-source-digest");
  }
  if (options.expectedWorkflow.length === 0) {
    throw new Error("missing --expected-workflow");
  }

  return options;
}

async function readJson(path) {
  const content = await readFile(resolve(path), "utf8");
  return JSON.parse(content);
}

function normalizeRecords(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map((entry, index) => {
    const verificationResult = entry?.verificationResult ?? {};
    const certificate = verificationResult?.signature?.certificate ?? {};
    const statement = verificationResult?.statement ?? {};
    const subjects = Array.isArray(statement?.subject)
      ? statement.subject.map((subject) => ({
          name: typeof subject?.name === "string" ? subject.name : "",
          sha256: typeof subject?.digest?.sha256 === "string" ? subject.digest.sha256 : ""
        }))
      : [];

    return {
      index,
      certificate: {
        subjectAlternativeName: typeof certificate?.subjectAlternativeName === "string" ? certificate.subjectAlternativeName : "",
        issuer: typeof certificate?.issuer === "string" ? certificate.issuer : "",
        runnerEnvironment: typeof certificate?.runnerEnvironment === "string" ? certificate.runnerEnvironment : "",
        sourceRepositoryURI: typeof certificate?.sourceRepositoryURI === "string" ? certificate.sourceRepositoryURI : "",
        sourceRepositoryRef: typeof certificate?.sourceRepositoryRef === "string" ? certificate.sourceRepositoryRef : "",
        sourceRepositoryDigest: typeof certificate?.sourceRepositoryDigest === "string" ? certificate.sourceRepositoryDigest : ""
      },
      predicateType: typeof statement?.predicateType === "string" ? statement.predicateType : "",
      subjects
    };
  });
}

function validateRecords(records, expected, subjectMatcher) {
  const failures = [];

  if (records.length === 0) {
    failures.push("verification payload is empty");
  }

  for (const record of records) {
    const label = `record[${String(record.index)}]`;
    if (record.certificate.sourceRepositoryURI !== expected.sourceRepositoryURI) {
      failures.push(`${label}: sourceRepositoryURI mismatch`);
    }
    if (record.certificate.sourceRepositoryRef !== expected.sourceRepositoryRef) {
      failures.push(`${label}: sourceRepositoryRef mismatch`);
    }
    if (record.certificate.sourceRepositoryDigest !== expected.sourceRepositoryDigest) {
      failures.push(`${label}: sourceRepositoryDigest mismatch`);
    }
    if (record.certificate.issuer !== expected.issuer) {
      failures.push(`${label}: issuer mismatch`);
    }
    if (record.certificate.runnerEnvironment !== "github-hosted") {
      failures.push(`${label}: runnerEnvironment must be github-hosted`);
    }
    if (!record.certificate.subjectAlternativeName.startsWith(expected.workflowSanPrefix)) {
      failures.push(`${label}: subjectAlternativeName mismatch`);
    }
    if (record.predicateType !== expected.predicateType) {
      failures.push(`${label}: predicateType mismatch`);
    }
    if (record.subjects.length === 0) {
      failures.push(`${label}: missing statement subjects`);
    }
    for (const [subjectIndex, subject] of record.subjects.entries()) {
      if (!HEX_SHA256_PATTERN.test(subject.sha256)) {
        failures.push(`${label}: subject[${String(subjectIndex)}] missing sha256`);
      }
    }
  }

  const matchedSubject = records.some((record) =>
    record.subjects.some((subject) => subjectMatcher(subject.name))
  );

  if (!matchedSubject) {
    failures.push("no subject matched expected identity");
  }

  return failures;
}

function summarize(records) {
  const uniqueSubjects = [...new Set(records.flatMap((record) => record.subjects.map((subject) => subject.name)))];
  return {
    attestationCount: records.length,
    uniqueSubjects
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [packagePayload, lockPayload] = await Promise.all([
    readJson(options.packageInput),
    readJson(options.lockInput)
  ]);

  const expected = {
    sourceRepositoryURI: `https://github.com/${options.expectedRepo}`,
    sourceRepositoryRef: options.expectedSourceRef,
    sourceRepositoryDigest: options.expectedSourceDigest,
    workflowSanPrefix: `https://github.com/${options.expectedWorkflow}@`,
    issuer: options.expectedIssuer,
    predicateType: options.expectedPredicateType
  };

  const packageRecords = normalizeRecords(packagePayload);
  const lockRecords = normalizeRecords(lockPayload);

  const packageFailures = validateRecords(
    packageRecords,
    expected,
    (subjectName) => subjectName.endsWith(".tgz")
  );
  const lockFailures = validateRecords(
    lockRecords,
    expected,
    (subjectName) => subjectName === "oracle-image.lock.json"
  );

  const report = {
    suite: "release-attestation-runtime",
    timestamp: new Date().toISOString(),
    expected: {
      sourceRepositoryURI: expected.sourceRepositoryURI,
      sourceRepositoryRef: expected.sourceRepositoryRef,
      sourceRepositoryDigest: expected.sourceRepositoryDigest,
      workflowSanPrefix: expected.workflowSanPrefix,
      issuer: expected.issuer,
      predicateType: expected.predicateType
    },
    package: {
      inputPath: options.packageInput,
      ...summarize(packageRecords),
      failures: packageFailures,
      ok: packageFailures.length === 0
    },
    oracleLock: {
      inputPath: options.lockInput,
      ...summarize(lockRecords),
      failures: lockFailures,
      ok: lockFailures.length === 0
    }
  };
  report.overall = {
    ok: report.package.ok && report.oracleLock.ok
  };

  const outputPath = resolve(options.output);
  await writeJsonReport(outputPath, report);

  if (!report.overall.ok) {
    throw new Error("release attestation runtime validation failed");
  }

  process.stdout.write(`release attestation runtime report ok: ${outputPath}\n`);
}

await main();
