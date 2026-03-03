/**
 * Demonstrates deterministic URL normalization and protocol policy checks.
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
