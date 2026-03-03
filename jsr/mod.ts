/**
 * Default protocol policy used by the JSR utility surface.
 */
export const DEFAULT_SECURITY_POLICY: {
  readonly allowHttp: boolean;
  readonly allowHttps: boolean;
  readonly allowFile: boolean;
} = Object.freeze({
  allowHttp: true,
  allowHttps: true,
  allowFile: true
});

/**
 * Reject unsupported URL protocols.
 */
export function assertAllowedProtocol(urlValue: URL): void {
  const protocol = urlValue.protocol.toLowerCase();
  if (protocol === "https:" || protocol === "http:" || protocol === "file:") {
    return;
  }
  throw new Error(`Unsupported protocol: ${protocol}`);
}

/**
 * Parse a URL and validate protocol policy.
 */
export function assertAllowedUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  assertAllowedProtocol(parsed);
  return parsed;
}

/**
 * Check whether an HTTP content type should be treated as HTML-like.
 */
export function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

/**
 * Resolve user input into a normalized URL string.
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
 * Resolve a page-local href against a base URL with protocol validation.
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
