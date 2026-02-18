export function resolveInputUrl(rawInput: string, currentUrl?: string): string {
  const trimmedInput = rawInput.trim();
  if (trimmedInput.length === 0) {
    throw new Error("URL input is empty");
  }

  if (trimmedInput === "about:help") {
    return trimmedInput;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmedInput)) {
    return new URL(trimmedInput).toString();
  }

  if (currentUrl) {
    try {
      return new URL(trimmedInput, currentUrl).toString();
    } catch {
      // Fall through to absolute URL fallback.
    }
  }

  return new URL(`https://${trimmedInput}`).toString();
}

export function resolveHref(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
