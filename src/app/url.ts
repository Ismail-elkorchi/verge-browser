import { assertAllowedProtocol } from "./security.js";

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
