export interface SecurityPolicyOptions {
  readonly allowHttp: boolean;
  readonly allowHttps: boolean;
  readonly allowFile: boolean;
}

export const DEFAULT_SECURITY_POLICY: Required<SecurityPolicyOptions> = Object.freeze({
  allowHttp: true,
  allowHttps: true,
  allowFile: true
});

export function assertAllowedProtocol(urlValue: URL): void {
  const protocol = urlValue.protocol.toLowerCase();
  if (protocol === "https:" || protocol === "http:" || protocol === "file:") {
    return;
  }
  throw new Error(`Unsupported protocol: ${protocol}`);
}

export function assertAllowedUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  assertAllowedProtocol(parsed);
  return parsed;
}

export function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

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

export function resolveHref(href: string, baseUrl: string): string {
  try {
    const resolved = new URL(href, baseUrl);
    assertAllowedProtocol(resolved);
    return resolved.toString();
  } catch {
    return href;
  }
}
