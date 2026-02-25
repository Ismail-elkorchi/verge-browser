import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const HEX_SHA1_PATTERN = /^[a-f0-9]{40}$/i;

function parseArgs(argv) {
  const options = {
    packageInput: "reports/attestation-package-verify.json",
    lockInput: "reports/attestation-oracle-lock-verify.json",
    certIdentityPackageInput: "reports/attestation-package-verify-cert-identity.json",
    certIdentityLockInput: "reports/attestation-oracle-lock-verify-cert-identity.json",
    offlinePackageInput: "reports/offline-verification/package-offline-verify.json",
    offlineLockInput: "reports/offline-verification/oracle-lock-offline-verify.json",
    output: "reports/release-attestation-runtime.json",
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
    if (rawKey === "package-input") {
      options.packageInput = value;
      continue;
    }
    if (rawKey === "lock-input") {
      options.lockInput = value;
      continue;
    }
    if (rawKey === "cert-identity-package-input") {
      options.certIdentityPackageInput = value;
      continue;
    }
    if (rawKey === "cert-identity-lock-input") {
      options.certIdentityLockInput = value;
      continue;
    }
    if (rawKey === "offline-package-input") {
      options.offlinePackageInput = value;
      continue;
    }
    if (rawKey === "offline-lock-input") {
      options.offlineLockInput = value;
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
  if (options.expectedSourceDigest.length === 0) {
    throw new Error("missing --expected-source-digest");
  }
  if (!HEX_SHA1_PATTERN.test(options.expectedSourceDigest)) {
    throw new Error("invalid --expected-source-digest");
  }
  if (options.expectedWorkflow.length === 0) {
    throw new Error("missing --expected-workflow");
  }
  if (options.expectedPackageSha256.length === 0) {
    throw new Error("missing --expected-package-sha256");
  }
  if (!HEX_SHA256_PATTERN.test(options.expectedPackageSha256)) {
    throw new Error("invalid --expected-package-sha256");
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

function validateRecords(records, expected, subjectMatcher, expectedSubjectSha256 = "") {
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

  if (expectedSubjectSha256.length > 0) {
    const normalizedDigest = expectedSubjectSha256.toLowerCase();
    const matchedDigest = records.some((record) =>
      record.subjects.some((subject) => subjectMatcher(subject.name) && subject.sha256.toLowerCase() === normalizedDigest)
    );
    if (!matchedDigest) {
      failures.push("no subject matched expected digest");
    }
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

function summarizeSource(inputPath, records, failures) {
  return {
    inputPath,
    ...summarize(records),
    failures,
    ok: failures.length === 0
  };
}

function collectIdentityKeys(records, subjectMatcher) {
  return records
    .flatMap((record) => record.subjects
      .filter((subject) => subjectMatcher(subject.name))
      .map((subject) => `${subject.name}:${subject.sha256.toLowerCase()}`))
    .sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [
    packagePayload,
    lockPayload,
    certIdentityPackagePayload,
    certIdentityLockPayload,
    offlinePackagePayload,
    offlineLockPayload
  ] = await Promise.all([
    readJson(options.packageInput),
    readJson(options.lockInput),
    readJson(options.certIdentityPackageInput),
    readJson(options.certIdentityLockInput),
    readJson(options.offlinePackageInput),
    readJson(options.offlineLockInput)
  ]);

  const expected = {
    sourceRepositoryURI: `https://github.com/${options.expectedRepo}`,
    sourceRepositoryRef: options.expectedSourceRef,
    sourceRepositoryDigest: options.expectedSourceDigest,
    workflowSanPrefix: `https://github.com/${options.expectedWorkflow}@`,
    issuer: options.expectedIssuer,
    predicateType: options.expectedPredicateType,
    packageSha256: options.expectedPackageSha256.toLowerCase()
  };

  const packageRecords = normalizeRecords(packagePayload);
  const lockRecords = normalizeRecords(lockPayload);
  const certIdentityPackageRecords = normalizeRecords(certIdentityPackagePayload);
  const certIdentityLockRecords = normalizeRecords(certIdentityLockPayload);
  const offlinePackageRecords = normalizeRecords(offlinePackagePayload);
  const offlineLockRecords = normalizeRecords(offlineLockPayload);

  const packageSubjectMatcher = (subjectName) => subjectName.endsWith(".tgz");
  const lockSubjectMatcher = (subjectName) => subjectName === "oracle-image.lock.json";

  const packageFailures = validateRecords(
    packageRecords,
    expected,
    packageSubjectMatcher,
    expected.packageSha256
  );
  const lockFailures = validateRecords(
    lockRecords,
    expected,
    lockSubjectMatcher
  );
  const certIdentityPackageFailures = validateRecords(
    certIdentityPackageRecords,
    expected,
    packageSubjectMatcher,
    expected.packageSha256
  );
  const certIdentityLockFailures = validateRecords(
    certIdentityLockRecords,
    expected,
    lockSubjectMatcher
  );
  const offlinePackageFailures = validateRecords(
    offlinePackageRecords,
    expected,
    packageSubjectMatcher,
    expected.packageSha256
  );
  const offlineLockFailures = validateRecords(
    offlineLockRecords,
    expected,
    lockSubjectMatcher
  );

  const packageSignerKeys = collectIdentityKeys(packageRecords, packageSubjectMatcher);
  const packageCertKeys = collectIdentityKeys(certIdentityPackageRecords, packageSubjectMatcher);
  const lockSignerKeys = collectIdentityKeys(lockRecords, lockSubjectMatcher);
  const lockCertKeys = collectIdentityKeys(certIdentityLockRecords, lockSubjectMatcher);

  const packageAgreement = {
    ok: JSON.stringify(packageSignerKeys) === JSON.stringify(packageCertKeys),
    signerWorkflowKeys: packageSignerKeys,
    certIdentityKeys: packageCertKeys
  };
  const lockAgreement = {
    ok: JSON.stringify(lockSignerKeys) === JSON.stringify(lockCertKeys),
    signerWorkflowKeys: lockSignerKeys,
    certIdentityKeys: lockCertKeys
  };

  if (!packageAgreement.ok) {
    packageFailures.push("signer-workflow and cert-identity package subjects disagree");
  }
  if (!lockAgreement.ok) {
    lockFailures.push("signer-workflow and cert-identity lock subjects disagree");
  }

  const report = {
    suite: "release-attestation-runtime",
    timestamp: new Date().toISOString(),
    expected: {
      sourceRepositoryURI: expected.sourceRepositoryURI,
      sourceRepositoryRef: expected.sourceRepositoryRef,
      sourceRepositoryDigest: expected.sourceRepositoryDigest,
      workflowSanPrefix: expected.workflowSanPrefix,
      issuer: expected.issuer,
      predicateType: expected.predicateType,
      packageSha256: expected.packageSha256
    },
    package: {
      expectedTarballSha256: expected.packageSha256,
      signerWorkflow: summarizeSource(options.packageInput, packageRecords, packageFailures),
      certIdentity: summarizeSource(options.certIdentityPackageInput, certIdentityPackageRecords, certIdentityPackageFailures),
      offline: summarizeSource(options.offlinePackageInput, offlinePackageRecords, offlinePackageFailures),
      verifierAgreement: packageAgreement
    },
    oracleLock: {
      signerWorkflow: summarizeSource(options.lockInput, lockRecords, lockFailures),
      certIdentity: summarizeSource(options.certIdentityLockInput, certIdentityLockRecords, certIdentityLockFailures),
      offline: summarizeSource(options.offlineLockInput, offlineLockRecords, offlineLockFailures),
      verifierAgreement: lockAgreement
    }
  };

  report.package.ok = report.package.signerWorkflow.ok
    && report.package.certIdentity.ok
    && report.package.offline.ok
    && report.package.verifierAgreement.ok;
  report.oracleLock.ok = report.oracleLock.signerWorkflow.ok
    && report.oracleLock.certIdentity.ok
    && report.oracleLock.offline.ok
    && report.oracleLock.verifierAgreement.ok;
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
