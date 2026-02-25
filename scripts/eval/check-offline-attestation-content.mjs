import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./json-report-io.mjs";

const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const HEX_SHA1_PATTERN = /^[a-f0-9]{40}$/i;

function parseArgs(argv) {
  const options = {
    packageOfflineInput: "reports/offline-verification/package-offline-verify.json",
    lockOfflineInput: "reports/offline-verification/oracle-lock-offline-verify.json",
    output: "reports/offline-attestation-content-policy.json",
    expectedRepo: "",
    expectedSourceRef: "",
    expectedSourceDigest: "",
    expectedWorkflow: "",
    expectedPackageSha256: "",
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
    if (rawKey === "package-offline-input") {
      options.packageOfflineInput = value;
      continue;
    }
    if (rawKey === "lock-offline-input") {
      options.lockOfflineInput = value;
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
    if (rawKey === "expected-package-sha256") {
      options.expectedPackageSha256 = value;
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
  if (options.expectedSourceDigest.length === 0 || !HEX_SHA1_PATTERN.test(options.expectedSourceDigest)) {
    throw new Error("invalid --expected-source-digest");
  }
  if (options.expectedWorkflow.length === 0) {
    throw new Error("missing --expected-workflow");
  }
  if (options.expectedPackageSha256.length === 0 || !HEX_SHA256_PATTERN.test(options.expectedPackageSha256)) {
    throw new Error("invalid --expected-package-sha256");
  }

  return options;
}

async function readJson(path) {
  const content = await readFile(resolve(path), "utf8");
  return JSON.parse(content);
}

function normalize(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.map((entry, index) => {
    const verificationResult = entry?.verificationResult ?? {};
    const certificate = verificationResult?.signature?.certificate ?? {};
    const statement = verificationResult?.statement ?? {};
    const subjects = Array.isArray(statement.subject)
      ? statement.subject.map((subject) => ({
          name: typeof subject?.name === "string" ? subject.name : "",
          sha256: typeof subject?.digest?.sha256 === "string" ? subject.digest.sha256 : ""
        }))
      : [];
    return {
      index,
      certificate: {
        san: typeof certificate.subjectAlternativeName === "string" ? certificate.subjectAlternativeName : "",
        issuer: typeof certificate.issuer === "string" ? certificate.issuer : "",
        runnerEnvironment: typeof certificate.runnerEnvironment === "string" ? certificate.runnerEnvironment : "",
        sourceRepositoryURI: typeof certificate.sourceRepositoryURI === "string" ? certificate.sourceRepositoryURI : "",
        sourceRepositoryRef: typeof certificate.sourceRepositoryRef === "string" ? certificate.sourceRepositoryRef : "",
        sourceRepositoryDigest: typeof certificate.sourceRepositoryDigest === "string" ? certificate.sourceRepositoryDigest : ""
      },
      predicateType: typeof statement.predicateType === "string" ? statement.predicateType : "",
      subjects
    };
  });
}

function validate(records, expected, subjectMatcher, expectedDigest = "") {
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
    if (!record.certificate.san.startsWith(expected.workflowSanPrefix)) {
      failures.push(`${label}: subjectAlternativeName mismatch`);
    }
    if (record.certificate.issuer !== expected.issuer) {
      failures.push(`${label}: issuer mismatch`);
    }
    if (record.certificate.runnerEnvironment !== "github-hosted") {
      failures.push(`${label}: runnerEnvironment mismatch`);
    }
    if (record.predicateType !== expected.predicateType) {
      failures.push(`${label}: predicateType mismatch`);
    }
    if (record.subjects.length === 0) {
      failures.push(`${label}: subject list is empty`);
    }
    for (const [subjectIndex, subject] of record.subjects.entries()) {
      if (!HEX_SHA256_PATTERN.test(subject.sha256)) {
        failures.push(`${label}: subject[${String(subjectIndex)}] missing sha256`);
      }
    }
  }

  const matchingSubjects = records.flatMap((record) => record.subjects.filter((subject) => subjectMatcher(subject.name)));
  if (matchingSubjects.length === 0) {
    failures.push("no subject matched expected identity");
  }

  if (expectedDigest.length > 0) {
    const normalized = expectedDigest.toLowerCase();
    const digestMatch = matchingSubjects.some((subject) => subject.sha256.toLowerCase() === normalized);
    if (!digestMatch) {
      failures.push("no subject matched expected digest");
    }
  }

  return {
    attestationCount: records.length,
    uniqueSubjects: [...new Set(records.flatMap((record) => record.subjects.map((subject) => subject.name)))],
    failures,
    ok: failures.length === 0
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [packagePayload, lockPayload] = await Promise.all([
    readJson(options.packageOfflineInput),
    readJson(options.lockOfflineInput)
  ]);

  const expected = {
    sourceRepositoryURI: `https://github.com/${options.expectedRepo}`,
    sourceRepositoryRef: options.expectedSourceRef,
    sourceRepositoryDigest: options.expectedSourceDigest,
    workflowSanPrefix: `https://github.com/${options.expectedWorkflow}@`,
    issuer: options.expectedIssuer,
    predicateType: options.expectedPredicateType
  };

  const packageResult = validate(
    normalize(packagePayload),
    expected,
    (name) => name.endsWith(".tgz"),
    options.expectedPackageSha256
  );
  const lockResult = validate(
    normalize(lockPayload),
    expected,
    (name) => name === "oracle-image.lock.json"
  );

  const report = {
    suite: "offline-attestation-content-policy",
    timestamp: new Date().toISOString(),
    expected: {
      sourceRepositoryURI: expected.sourceRepositoryURI,
      sourceRepositoryRef: expected.sourceRepositoryRef,
      sourceRepositoryDigest: expected.sourceRepositoryDigest,
      workflowSanPrefix: expected.workflowSanPrefix,
      issuer: expected.issuer,
      predicateType: expected.predicateType,
      packageSha256: options.expectedPackageSha256.toLowerCase()
    },
    package: {
      inputPath: options.packageOfflineInput,
      ...packageResult
    },
    oracleLock: {
      inputPath: options.lockOfflineInput,
      ...lockResult
    },
    overall: {
      ok: packageResult.ok && lockResult.ok
    }
  };

  const reportPath = resolve(options.output);
  await writeJsonReport(reportPath, report);

  if (!report.overall.ok) {
    throw new Error("offline attestation content policy check failed");
  }

  process.stdout.write(`offline attestation content policy ok: ${reportPath}\n`);
}

await main();
