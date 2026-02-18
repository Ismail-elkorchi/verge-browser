const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:", "about:"]);

export interface SecurityPolicyOptions {
  readonly maxRedirects?: number;
  readonly maxContentBytes?: number;
}

export const DEFAULT_SECURITY_POLICY: Required<SecurityPolicyOptions> = Object.freeze({
  maxRedirects: 5,
  maxContentBytes: 2 * 1024 * 1024
});

export function assertAllowedProtocol(urlValue: URL): void {
  if (ALLOWED_PROTOCOLS.has(urlValue.protocol)) {
    return;
  }
  throw new Error(`Blocked unsupported protocol: ${urlValue.protocol}`);
}

export function assertAllowedUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  assertAllowedProtocol(parsed);
  return parsed;
}

export function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml") || normalized.includes("application/xml");
}
