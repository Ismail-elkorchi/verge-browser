import assert from "node:assert/strict";
import test from "node:test";
import { validateDependencyInstall } from "../../scripts/release/dependency-package-contract.mjs";

const name = "@ismail-elkorchi/terminal-ui";
const revision = "196b35b6440966cab5928b8a26d50e3ad2bc2911";
const integrity = `sha512-${"a".repeat(86)}==`;
function fixture() {
  const lockEntry = { version: "0.1.5", resolved: `git+ssh://git@github.com/Ismail-elkorchi/terminal-ui.git#${revision}`, integrity };
  return { name, dependencySpec: `github:Ismail-elkorchi/terminal-ui#${revision}`, lockEntry,
    installedManifest: { name, version: "0.1.5" }, installedLockEntry: { ...lockEntry } };
}

test("source dependency binds the approved upstream commit, lock, and installed record", () => {
  assert.equal(validateDependencyInstall(fixture()).revision, revision);
  const https = fixture();
  https.dependencySpec = `git+https://github.com/Ismail-elkorchi/terminal-ui.git#${revision}`;
  assert.equal(validateDependencyInstall(https).revision, revision);
});

test("source dependency rejects floating refs, short hashes, foreign hosts and forks", () => {
  for (const dependencySpec of [
    "github:Ismail-elkorchi/terminal-ui#main", "github:Ismail-elkorchi/terminal-ui#v0.1.5",
    "github:Ismail-elkorchi/terminal-ui#196b35b", `github:someone/terminal-ui#${revision}`,
    `git+https://example.test/Ismail-elkorchi/terminal-ui.git#${revision}`
  ]) assert.throws(() => validateDependencyInstall({ ...fixture(), dependencySpec }), /exact/u);
});

test("source dependency rejects lock revision and installed source mismatches", () => {
  for (const field of ["lockEntry", "installedLockEntry"]) {
    const input = fixture();
    input[field].resolved = input[field].resolved.replace(revision, "a".repeat(40));
    assert.throws(() => validateDependencyInstall(input), /match/u);
  }
  const installed = fixture();
  installed.installedManifest.name = "another-package";
  assert.throws(() => validateDependencyInstall(installed), /installed/u);
});

test("source dependency rejects absent integrity, symlinks and development-only locks", () => {
  for (const change of [{ integrity: undefined }, { integrity: "sha256-invalid" }, { link: true }, { dev: true }]) {
    const input = fixture();
    Object.assign(input.lockEntry, change);
    assert.throws(() => validateDependencyInstall(input), /lock/u);
  }
});

test("other dependencies retain exact public-registry version and integrity requirements", () => {
  const input = fixture();
  input.name = "@ismail-elkorchi/http-client";
  input.dependencySpec = "0.1.1";
  input.lockEntry = { version: "0.1.1", resolved: "https://registry.npmjs.org/@ismail-elkorchi/http-client/-/http-client-0.1.1.tgz", integrity };
  input.installedLockEntry = { ...input.lockEntry };
  input.installedManifest = { name: input.name, version: "0.1.1" };
  assert.equal(validateDependencyInstall(input).version, "0.1.1");
  assert.throws(() => validateDependencyInstall({ ...input, dependencySpec: "^0.1.1" }), /exact/u);
  input.lockEntry.resolved = "https://example.test/http-client.tgz";
  assert.throws(() => validateDependencyInstall(input), /exact source/u);
  assert.throws(() => validateDependencyInstall({ ...fixture(), name: input.name }), /exact/u);
});

for (const repository of ["html-parser", "css-parser", "http-client", "terminal-ui"]) {
  test(`${repository} binds its own exact Git source and rejects cross-package substitution`, () => {
    const input = fixture();
    input.name = `@ismail-elkorchi/${repository}`;
    input.dependencySpec = `git+https://github.com/Ismail-elkorchi/${repository}.git#${revision}`;
    input.lockEntry.resolved = `git+ssh://git@github.com/Ismail-elkorchi/${repository}.git#${revision}`;
    input.installedLockEntry = { ...input.lockEntry };
    input.installedManifest.name = input.name;
    assert.equal(validateDependencyInstall(input).revision, revision);
    assert.throws(() => validateDependencyInstall({ ...input, installedManifest: { ...input.installedManifest, version: "0.0.0" } }), /installed/u);
    for (const source of [
      `git+https://github.com/Ismail-elkorchi/${repository}.git#main`,
      `git+https://github.com/another/${repository}.git#${revision}`,
      `git+https://example.test/Ismail-elkorchi/${repository}.git#${revision}`,
      `git+https://github.com/Ismail-elkorchi/${repository === "html-parser" ? "css-parser" : "html-parser"}.git#${revision}`
    ]) assert.throws(() => validateDependencyInstall({ ...input, dependencySpec: source }), /exact/u);
  });
}
