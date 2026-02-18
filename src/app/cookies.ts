export interface CookieEntry {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "Lax" | "Strict" | "None" | null;
  readonly expiresAtIso: string | null;
}

function normalizeDomain(input: string): string {
  return input.trim().replace(/^\./, "").toLowerCase();
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") {
    return "/";
  }
  const slashIndex = pathname.lastIndexOf("/");
  if (slashIndex <= 0) {
    return "/";
  }
  return pathname.slice(0, slashIndex);
}

function isDomainMatch(cookieDomain: string, host: string, hostOnly: boolean): boolean {
  if (hostOnly) {
    return host === cookieDomain;
  }
  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

function isPathMatch(cookiePath: string, pathname: string): boolean {
  if (pathname === cookiePath) {
    return true;
  }
  if (!pathname.startsWith(cookiePath)) {
    return false;
  }
  if (cookiePath.endsWith("/")) {
    return true;
  }
  return pathname[cookiePath.length] === "/";
}

function parseSameSite(value: string): CookieEntry["sameSite"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "lax") return "Lax";
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  return null;
}

function parseExpires(value: string): string | null {
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

export function parseSetCookie(
  headerValue: string,
  requestUrl: string,
  nowMs = Date.now()
): CookieEntry | null {
  const parts = headerValue.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const nameValue = parts[0];
  if (!nameValue) {
    return null;
  }
  const attributeParts = parts.slice(1);
  const separatorIndex = nameValue.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const cookieName = nameValue.slice(0, separatorIndex).trim();
  const cookieValue = nameValue.slice(separatorIndex + 1).trim();
  if (cookieName.length === 0) {
    return null;
  }

  const request = new URL(requestUrl);
  const requestHost = request.hostname.toLowerCase();

  let domain = requestHost;
  let hostOnly = true;
  let path = defaultPath(request.pathname);
  let secure = false;
  let httpOnly = false;
  let sameSite: CookieEntry["sameSite"] = null;
  let expiresAtIso: string | null = null;

  for (const attributePart of attributeParts) {
    const attributeSeparator = attributePart.indexOf("=");
    const rawName = attributeSeparator === -1 ? attributePart : attributePart.slice(0, attributeSeparator);
    const rawValue = attributeSeparator === -1 ? "" : attributePart.slice(attributeSeparator + 1);
    const attributeName = rawName.trim().toLowerCase();
    const attributeValue = rawValue.trim();

    if (attributeName === "domain" && attributeValue.length > 0) {
      const normalizedDomain = normalizeDomain(attributeValue);
      if (normalizedDomain.length === 0) {
        continue;
      }
      if (!isDomainMatch(normalizedDomain, requestHost, false)) {
        return null;
      }
      domain = normalizedDomain;
      hostOnly = false;
      continue;
    }

    if (attributeName === "path" && attributeValue.startsWith("/")) {
      path = attributeValue;
      continue;
    }

    if (attributeName === "secure") {
      secure = true;
      continue;
    }

    if (attributeName === "httponly") {
      httpOnly = true;
      continue;
    }

    if (attributeName === "samesite") {
      sameSite = parseSameSite(attributeValue);
      continue;
    }

    if (attributeName === "expires") {
      expiresAtIso = parseExpires(attributeValue);
      continue;
    }

    if (attributeName === "max-age") {
      const seconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(seconds)) {
        expiresAtIso = new Date(nowMs + seconds * 1000).toISOString();
      }
    }
  }

  return {
    name: cookieName,
    value: cookieValue,
    domain,
    path,
    hostOnly,
    secure,
    httpOnly,
    sameSite,
    expiresAtIso
  };
}

function isExpired(cookie: CookieEntry, nowMs: number): boolean {
  if (!cookie.expiresAtIso) {
    return false;
  }
  const expiresMs = Date.parse(cookie.expiresAtIso);
  if (!Number.isFinite(expiresMs)) {
    return false;
  }
  return expiresMs <= nowMs;
}

function identityKey(cookie: CookieEntry): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

export function pruneExpiredCookies(cookies: readonly CookieEntry[], nowMs = Date.now()): CookieEntry[] {
  return cookies.filter((cookie) => !isExpired(cookie, nowMs));
}

export function mergeSetCookieHeaders(
  existingCookies: readonly CookieEntry[],
  setCookieHeaders: readonly string[],
  requestUrl: string,
  nowMs = Date.now()
): CookieEntry[] {
  const liveCookies = pruneExpiredCookies(existingCookies, nowMs);
  const byKey = new Map<string, CookieEntry>(liveCookies.map((cookie) => [identityKey(cookie), cookie]));

  for (const headerValue of setCookieHeaders) {
    const parsed = parseSetCookie(headerValue, requestUrl, nowMs);
    if (!parsed) {
      continue;
    }
    if (isExpired(parsed, nowMs) || parsed.value.length === 0) {
      byKey.delete(identityKey(parsed));
      continue;
    }
    byKey.set(identityKey(parsed), parsed);
  }

  return [...byKey.values()].sort((left, right) => {
    if (left.domain !== right.domain) return left.domain.localeCompare(right.domain);
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.name.localeCompare(right.name);
  });
}

export function cookieHeaderForUrl(
  cookies: readonly CookieEntry[],
  requestUrl: string,
  nowMs = Date.now()
): string | null {
  const request = new URL(requestUrl);
  const requestHost = request.hostname.toLowerCase();
  const requestPath = request.pathname.length > 0 ? request.pathname : "/";
  const isHttps = request.protocol === "https:";

  const matchedCookies = pruneExpiredCookies(cookies, nowMs)
    .filter((cookie) => isDomainMatch(cookie.domain, requestHost, cookie.hostOnly))
    .filter((cookie) => isPathMatch(cookie.path, requestPath))
    .filter((cookie) => (cookie.secure ? isHttps : true))
    .sort((left, right) => {
      if (left.path.length !== right.path.length) {
        return right.path.length - left.path.length;
      }
      return left.name.localeCompare(right.name);
    });

  if (matchedCookies.length === 0) {
    return null;
  }

  return matchedCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
