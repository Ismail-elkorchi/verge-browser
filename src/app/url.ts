import { assertAllowedProtocol } from "./security.js";

/**
 * Resolves user input into a normalized absolute URL string.
 *
 * The function accepts:
 * - absolute URLs,
 * - relative URLs when `currentUrl` is supplied,
 * - bare hosts such as `example.com`,
 * - the built-in `about:help` page.
 *
 * @param rawInput User-provided location input.
 * @param currentUrl Optional current page URL used as the base for relative paths.
 * @returns Normalized absolute URL string.
 * @throws {Error} When `rawInput` is empty or resolves to an unsupported protocol.
 * @throws {TypeError} When URL parsing fails.
 *
 * @example
 * ```ts
 * console.log(resolveInputUrl("example.com"));
 * console.log(resolveInputUrl("../guide", "https://example.com/docs/start"));
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
 * Resolves an href-like value against a base URL when possible.
 *
 * @param href Relative or absolute href value to resolve.
 * @param baseUrl Absolute base URL for resolution.
 * @returns Resolved absolute URL string when resolution succeeds and the protocol is allowed; otherwise returns the original `href`.
 *
 * @example
 * ```ts
 * console.log(resolveHref("../api", "https://example.com/docs/start"));
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
