import { assertAllowedProtocol } from "./security.js";

export const DEFAULT_SEARCH_URL_TEMPLATE = "https://html.duckduckgo.com/html/?q={query}";

function looksLikeDirectLocation(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value)) return true;
  if (/^(?:\.{0,2}\/|[?#])/u.test(value)) return true;
  const authority = value.split("/")[0] ?? "";
  return authority === "localhost"
    || /^localhost:\d+$/u.test(authority)
    || /^\[[0-9a-fA-F:]+\](?::\d+)?$/u.test(authority)
    || /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/u.test(authority)
    || /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?$/u.test(authority);
}

function looksLikeRelativeLocation(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("#")
    || value.startsWith("?");
}

export function resolveOmniboxInput(
  rawInput: string,
  currentUrl?: string,
  searchUrlTemplate = DEFAULT_SEARCH_URL_TEMPLATE
): string {
  const value = rawInput.trim();
  if (value.length === 0) throw new Error("Location or search input is empty");
  if (looksLikeDirectLocation(value)) {
    return resolveInputUrl(value, looksLikeRelativeLocation(value) ? currentUrl : undefined);
  }
  if (!searchUrlTemplate.includes("{query}")) {
    throw new Error("Search URL template must contain {query}.");
  }
  return resolveInputUrl(searchUrlTemplate.replaceAll("{query}", encodeURIComponent(value)));
}

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

  if (trimmedInput === "about:help" || trimmedInput === "about:newtab") {
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
