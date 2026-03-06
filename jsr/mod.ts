/**
 * Deno/JSR utility entrypoint for the safe fetch policy and URL-resolution pieces of verge-browser's terminal browsing surface.
 *
 * Quickstart:
 * @example
 * ```ts
 * import { assertAllowedUrl, resolveHref } from "./mod.ts";
 * // Published package form:
 * // import { assertAllowedUrl, resolveHref } from "jsr:@ismail-elkorchi/verge-browser";
 *
 * const target = assertAllowedUrl("https://example.com/docs");
 * console.log(target.hostname);
 * console.log(resolveHref("../guide", target.toString()));
 * ```
 *
 * Additional docs:
 * - `./docs/index.md`
 * - `./docs/reference/options.md`
 */

/**
 * Fetch policy knobs exposed by the main package surface.
 *
 * The JSR utility entrypoint exports the same shape so callers can document or
 * mirror the package's default fetch policy values even when they only use the
 * URL helpers from this module.
 */
export interface SecurityPolicyOptions {
  /** Maximum redirect hops a fetch workflow should follow. */
  readonly maxRedirects?: number;
  /** Maximum response bytes allowed before fetch helpers abort. */
  readonly maxContentBytes?: number;
  /** Maximum retry attempts for transient network failures. */
  readonly maxRequestRetries?: number;
  /** Delay in milliseconds between retry attempts. */
  readonly retryDelayMs?: number;
}

/**
 * Default fetch policy values used by the package's network helpers.
 */
export const DEFAULT_SECURITY_POLICY: Required<SecurityPolicyOptions> = Object.freeze({
  maxRedirects: 5,
  maxContentBytes: 2 * 1024 * 1024,
  maxRequestRetries: 1,
  retryDelayMs: 75
});

/**
 * Validates that a parsed URL uses an allowed protocol.
 *
 * @param urlValue Parsed URL instance to validate.
 * @returns Nothing when protocol is allowed.
 * @throws {Error} When protocol is not one of `https:`, `http:`, `file:`, or `about:`.
 *
 * @example
 * ```ts
 * const urlValue = new URL("https://example.com/docs");
 * assertAllowedProtocol(urlValue);
 * console.log(urlValue.protocol);
 * ```
 */
export function assertAllowedProtocol(urlValue: URL): void {
  const protocol = urlValue.protocol.toLowerCase();
  if (protocol === "https:" || protocol === "http:" || protocol === "file:" || protocol === "about:") {
    return;
  }
  throw new Error(`Blocked unsupported protocol: ${protocol}`);
}

/**
 * Parses and validates a URL string against the default protocol policy.
 *
 * @param rawUrl Absolute URL string to parse and validate.
 * @returns Parsed `URL` instance when protocol is allowed.
 * @throws {TypeError} When `rawUrl` is not a valid URL.
 * @throws {Error} When protocol is unsupported.
 *
 * Security note:
 * - Call this before any network fetch to reject unsafe schemes early.
 *
 * @example
 * ```ts
 * import { assertAllowedUrl } from "./mod.ts";
 *
 * const parsed = assertAllowedUrl("https://example.com/path");
 * console.log(parsed.protocol);
 * ```
 */
export function assertAllowedUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  assertAllowedProtocol(parsed);
  return parsed;
}

/**
 * Determines whether an HTTP content-type should be treated as HTML-like.
 *
 * @param contentType Raw `Content-Type` header value, or `null` when absent.
 * @returns `true` for HTML/XHTML-compatible values, XML-family values, and for missing content-type headers.
 *
 * @example
 * ```ts
 * console.log(isHtmlLikeContentType("text/html; charset=utf-8"));
 * console.log(isHtmlLikeContentType("application/json"));
 * ```
 */
export function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html")
    || normalized.includes("application/xhtml+xml")
    || normalized.includes("application/xml");
}

/**
 * Resolves user-provided input into a normalized absolute URL string.
 *
 * @param rawInput User input (absolute URL, relative URL, or bare host).
 * @param currentUrl Current page URL used as base for relative resolution.
 * @returns Normalized absolute URL string.
 * @throws {Error} When input is empty.
 * @throws {TypeError} When URL parsing fails.
 * @throws {Error} When resolved protocol is unsupported.
 *
 * Security note:
 * - The function enforces protocol allow-listing through `assertAllowedProtocol`.
 *
 * @example
 * ```ts
 * import { resolveInputUrl } from "./mod.ts";
 *
 * console.log(resolveInputUrl("example.com"));
 * console.log(resolveInputUrl("../help", "https://example.com/docs/start"));
 * ```
 */
export function resolveInputUrl(rawInput: string, currentUrl?: string): string {
  const trimmedInput = rawInput.trim();
  if (trimmedInput.length === 0) {
    throw new Error("URL input is empty");
  }

  if (trimmedInput === "about:help") {
    return trimmedInput;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmedInput)) {
    const parsed = new URL(trimmedInput);
    assertAllowedProtocol(parsed);
    return parsed.toString();
  }

  if (currentUrl) {
    try {
      const resolved = new URL(trimmedInput, currentUrl);
      assertAllowedProtocol(resolved);
      return resolved.toString();
    } catch {
      // Fall through to absolute URL fallback.
    }
  }

  const fallback = new URL(`https://${trimmedInput}`);
  assertAllowedProtocol(fallback);
  return fallback.toString();
}

/**
 * Resolves a page-local href against a base URL and validates resulting protocol.
 *
 * @param href Relative or absolute href string.
 * @param baseUrl Absolute base URL for resolution.
 * @returns Resolved absolute URL string when valid, otherwise the original `href`.
 *
 * @example
 * ```ts
 * import { resolveHref } from "./mod.ts";
 *
 * const baseUrl = "https://example.com/docs/start";
 * console.log(resolveHref("../api", baseUrl));
 * ```
 */
export function resolveHref(href: string, baseUrl: string): string {
  try {
    const resolved = new URL(href, baseUrl);
    assertAllowedProtocol(resolved);
    return resolved.toString();
  } catch {
    return href;
  }
}
