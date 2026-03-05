/**
 * What it does: normalizes input URLs and enforces allowed protocol policy.
 * Expected output: prints "url-policy ok" after normalization and allowlist checks pass.
 * Constraints: inputs must stay within supported URL protocol policy semantics.
 * Run: npm run build && node examples/url-policy.mjs
 */
import { assertAllowedUrl, resolveInputUrl } from "../dist/mod.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runUrlPolicy() {
  const absolute = resolveInputUrl("example.com");
  assert(absolute === "https://example.com/", "resolveInputUrl should normalize hostnames");

  const resolved = resolveInputUrl("/docs", "https://example.com/base");
  assert(resolved === "https://example.com/docs", "resolveInputUrl should resolve relative paths");

  const allowed = assertAllowedUrl("https://example.com/docs");
  assert(allowed.protocol === "https:", "assertAllowedUrl should accept https");
  return resolved;
}

if (import.meta.main) {
  runUrlPolicy();
  console.log("url-policy ok");
}
