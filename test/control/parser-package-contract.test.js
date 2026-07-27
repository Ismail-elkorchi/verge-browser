import assert from "node:assert/strict";
import test from "node:test";

import {
  HTML_PARSER_PACKAGE_NAME,
  parserTarballUrl,
  validateWorkspaceParserInstall
} from "../../scripts/release/parser-package-contract.mjs";

const VERSION = "0.2.1";
const INTEGRITY =
  "sha512-zJJXCTnLjHUqGxK7lc31d5IhbdvxGJVwB0oElWCcbjRhRF68oJuJYt/v6vUDTQ3EAbEyHY9K8UTfXDEDDro/kA==";

function fixture({
  dependencySpec = VERSION,
  rootDependency = dependencySpec,
  lockedVersion = VERSION,
  resolved = parserTarballUrl(VERSION),
  integrity = INTEGRITY,
  installedVersion = VERSION
} = {}) {
  return {
    manifest: {
      dependencies: {
        [HTML_PARSER_PACKAGE_NAME]: dependencySpec
      }
    },
    lockfile: {
      packages: {
        "": {
          dependencies: {
            [HTML_PARSER_PACKAGE_NAME]: rootDependency
          }
        },
        [`node_modules/${HTML_PARSER_PACKAGE_NAME}`]: {
          version: lockedVersion,
          resolved,
          integrity
        }
      }
    },
    installedManifest: {
      name: HTML_PARSER_PACKAGE_NAME,
      version: installedVersion
    }
  };
}

test("clean parser contract binds manifest, public lock entry, and installation", () => {
  assert.deepEqual(validateWorkspaceParserInstall(fixture()), {
    name: HTML_PARSER_PACKAGE_NAME,
    version: VERSION,
    resolved: parserTarballUrl(VERSION),
    integrity: INTEGRITY
  });
});

test("clean parser contract rejects the stale canary installation shape", () => {
  assert.throws(
    () => validateWorkspaceParserInstall(fixture({ installedVersion: "0.1.1" })),
    /installed html-parser version 0\.1\.1 does not match 0\.2\.1/u
  );
});

test("clean parser contract rejects ranges and manifest-lock disagreement", () => {
  assert.throws(
    () => validateWorkspaceParserInstall(fixture({ dependencySpec: "^0.2.1" })),
    /must be an exact version/u
  );
  assert.throws(
    () => validateWorkspaceParserInstall(fixture({ rootDependency: "0.2.0" })),
    /package\.json and package-lock\.json disagree/u
  );
});

test("clean parser contract rejects non-public resolution and invalid integrity", () => {
  assert.throws(
    () => validateWorkspaceParserInstall(fixture({
      resolved: "https://registry.example.test/html-parser-0.2.1.tgz"
    })),
    /must resolve from https:\/\/registry\.npmjs\.org/u
  );
  assert.throws(
    () => validateWorkspaceParserInstall(fixture({ integrity: "sha256-not-sri" })),
    /must be a SHA-512 SRI value/u
  );
});
