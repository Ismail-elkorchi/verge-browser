import assert from "node:assert/strict";
import test from "node:test";

import {
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
  parseSetCookie,
  pruneExpiredCookies
} from "../../dist/app/cookies.js";

test("parseSetCookie parses scoped cookie attributes", () => {
  const parsed = parseSetCookie("sid=abc; Path=/app; HttpOnly; Secure; SameSite=Lax", "https://example.com/app/login");
  assert.ok(parsed);
  assert.equal(parsed.name, "sid");
  assert.equal(parsed.value, "abc");
  assert.equal(parsed.path, "/app");
  assert.equal(parsed.domain, "example.com");
  assert.equal(parsed.httpOnly, true);
  assert.equal(parsed.secure, true);
  assert.equal(parsed.sameSite, "Lax");
});

test("mergeSetCookieHeaders updates and deletes cookie identities", () => {
  const initial = mergeSetCookieHeaders([], ["sid=abc; Path=/; HttpOnly"], "https://example.com/");
  const updated = mergeSetCookieHeaders(initial, ["sid=xyz; Path=/; HttpOnly"], "https://example.com/");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.value, "xyz");

  const deleted = mergeSetCookieHeaders(updated, ["sid=; Path=/; Max-Age=0"], "https://example.com/");
  assert.equal(deleted.length, 0);
});

test("cookieHeaderForUrl applies domain, path, secure, and expiry checks", () => {
  const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const cookies = mergeSetCookieHeaders(
    [],
    [
      "sid=abc; Path=/; HttpOnly",
      "prefs=dark; Path=/app",
      "secure_only=1; Path=/; Secure",
      "expired=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    ],
    "https://example.com/app/start",
    nowMs
  );
  const live = pruneExpiredCookies(cookies, nowMs);
  assert.equal(live.some((cookie) => cookie.name === "expired"), false);

  assert.equal(cookieHeaderForUrl(live, "https://example.com/app/dashboard", nowMs), "prefs=dark; secure_only=1; sid=abc");
  assert.equal(cookieHeaderForUrl(live, "http://example.com/app/dashboard", nowMs), "prefs=dark; sid=abc");
  assert.equal(cookieHeaderForUrl(live, "https://example.com/other", nowMs), "secure_only=1; sid=abc");
});
