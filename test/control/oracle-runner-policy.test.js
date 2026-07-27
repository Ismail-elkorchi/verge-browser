import test from "node:test";
import assert from "node:assert/strict";

import {
  oracleDownloadCurlArgs,
  oracleDumpArgs,
  oracleRunnerPolicy
} from "../../scripts/oracles/real-oracle-lib.mjs";

test("oracle runner policy pins deterministic environment", () => {
  const policy = oracleRunnerPolicy();
  assert.equal(policy.environment.LANG, "C.UTF-8");
  assert.equal(policy.environment.LC_ALL, "C.UTF-8");
  assert.equal(policy.environment.LANGUAGE, "C");
  assert.equal(policy.environment.TZ, "UTC");
  assert.equal(policy.environment.TERM, "dumb");
  assert.equal(policy.environment.NO_COLOR, "1");
});

test("oracle dump args use deterministic encoding and width placeholders", () => {
  const htmlPath = "/tmp/case.html";
  const fileUrl = "file:///tmp/case.html";

  const lynxArgs = oracleDumpArgs({ engineName: "lynx", width: 80, htmlPath, fileUrl });
  assert.deepEqual(lynxArgs, [
    "-dump",
    "-nolist",
    "-assume_charset=utf-8",
    "-display_charset=utf-8",
    "-width=80",
    "file:///tmp/case.html"
  ]);

  const w3mArgs = oracleDumpArgs({ engineName: "w3m", width: 120, htmlPath, fileUrl });
  assert.deepEqual(w3mArgs, [
    "-dump",
    "-T",
    "text/html",
    "-I",
    "UTF-8",
    "-O",
    "UTF-8",
    "-cols",
    "120",
    "/tmp/case.html"
  ]);

  const links2Args = oracleDumpArgs({ engineName: "links2", width: 100, htmlPath, fileUrl });
  assert.deepEqual(links2Args, [
    "-dump",
    "-codepage",
    "utf-8",
    "-width",
    "100",
    "file:///tmp/case.html"
  ]);
});

test("oracle downloads resume atomically with bounded stalls instead of short total deadlines", () => {
  const args = oracleDownloadCurlArgs("https://example.test/archive", "/tmp/archive.partial");
  const optionValue = (option) => args[args.indexOf(option) + 1];

  assert.equal(optionValue("--continue-at"), "-");
  assert.equal(optionValue("--output"), "/tmp/archive.partial");
  assert.equal(optionValue("--connect-timeout"), "15");
  assert.equal(optionValue("--speed-limit"), "1024");
  assert.equal(optionValue("--speed-time"), "60");
  assert.equal(optionValue("--max-time"), "900");
  assert.equal(optionValue("--retry-max-time"), "1800");
  assert.equal(args.at(-1), "https://example.test/archive");
});
