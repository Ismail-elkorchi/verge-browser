const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:", "about:"]);

/**
 * Fetch-safety limits shared by `fetchPage()`, `fetchPageStream()`, and the JSR utility entrypoint.
 *
 * All fields are optional because callers can override only the limits they need.
 */
export interface SecurityPolicyOptions {
  /** Maximum number of HTTP redirects to follow before a fetch fails. Default: `5`. */
  readonly maxRedirects?: number;
  /** Maximum response bytes allowed before buffered or streamed fetch helpers fail. Default: `2 * 1024 * 1024`. */
  readonly maxContentBytes?: number;
  /** Maximum retry attempts for transient GET failures. Default: `1`. */
  readonly maxRequestRetries?: number;
  /** Delay in milliseconds between transient retry attempts. Default: `75`. */
  readonly retryDelayMs?: number;
}

/** Default fetch-safety limits used when callers do not override `SecurityPolicyOptions`. */
export const DEFAULT_SECURITY_POLICY: Required<SecurityPolicyOptions> = Object.freeze({
  maxRedirects: 5,
  maxContentBytes: 2 * 1024 * 1024,
  maxRequestRetries: 1,
  retryDelayMs: 75
});

/**
 * Validates that a parsed URL uses one of the supported protocols.
 *
 * Supported protocols are `https:`, `http:`, `file:`, and `about:`.
 *
 * @param urlValue Parsed URL instance to validate.
 * @throws {Error} When the protocol is outside the supported allow-list.
 */
export function assertAllowedProtocol(urlValue: URL): void {
  if (ALLOWED_PROTOCOLS.has(urlValue.protocol)) {
    return;
  }
  throw new Error(`Blocked unsupported protocol: ${urlValue.protocol}`);
}

/**
 * Parses a URL string and enforces the package's protocol allow-list.
 *
 * @param rawUrl Absolute URL string to validate.
 * @returns Parsed `URL` instance when the value is valid and allowed.
 * @throws {TypeError} When `rawUrl` is not a valid URL string.
 * @throws {Error} When the parsed protocol is unsupported.
 */
export function assertAllowedUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  assertAllowedProtocol(parsed);
  return parsed;
}

/**
 * Determines whether a response content type should be treated as HTML-like input.
 *
 * Missing content types are treated as HTML-compatible so callers can still inspect ambiguous responses.
 *
 * @param contentType Raw `Content-Type` header value, or `null` when absent.
 * @returns `true` for HTML, XHTML, XML, or missing content types.
 */
export function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml") || normalized.includes("application/xml");
}
