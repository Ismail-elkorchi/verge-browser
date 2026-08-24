import {
  type HttpFieldsInput,
  type HttpSessionRequestContext,
  type HttpSessionResponseContext
} from "@ismail-elkorchi/http-client";
import {
  Cookie,
  CookieJar,
  type SerializedCookie,
  type SerializedCookieJar
} from "tough-cookie";

import {
  PREPARE_CONTEXTUAL_REQUEST,
  type ContextualHttpSession,
  type CookieSameSiteContext
} from "./http-session-context.js";

export interface CookieSummary {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expiresAt: string | null;
}

type PersistCookieJar = (serialized: SerializedCookieJar) => Promise<void>;
const MAX_PERSISTED_COOKIES = 1000;
const MAX_PERSISTED_COOKIE_BYTES = 4 * 1024 * 1024;
const MAX_COOKIE_CANDIDATES = 5000;
const MAX_COOKIE_PROPERTIES = 32;
const MAX_COOKIE_PROPERTY_CODE_UNITS = 16 * 1024;
const UTF8_ENCODER = new TextEncoder();

function recentCookieIndexes(cookies: readonly SerializedCookie[]): ReadonlySet<number> {
  const ranked = cookies.map((cookie, index) => ({
    index,
    cookie,
    timestamp: Date.parse(
      stringProperty(cookie, "lastAccessed")
        ?? stringProperty(cookie, "creation")
        ?? ""
    ) || 0
  })).sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const retained = new Set<number>();
  let bytes = 0;
  for (const entry of ranked) {
    if (retained.size >= MAX_PERSISTED_COOKIES) break;
    const cookieBytes = UTF8_ENCODER.encode(JSON.stringify(entry.cookie)).byteLength + 1;
    if (bytes + cookieBytes > MAX_PERSISTED_COOKIE_BYTES) continue;
    bytes += cookieBytes;
    retained.add(entry.index);
  }
  return retained;
}

function boundedCookieJar(serialized: SerializedCookieJar): SerializedCookieJar {
  const retained = recentCookieIndexes(serialized.cookies);
  return retained.size === serialized.cookies.length
    ? serialized
    : {
      ...serialized,
      cookies: serialized.cookies.filter((_, index) => retained.has(index))
    };
}

export class BrowserCookieSession implements ContextualHttpSession {
  readonly #jar: CookieJar;
  readonly #persist: PersistCookieJar;
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    serialized: SerializedCookieJar | null,
    persist: PersistCookieJar
  ) {
    this.#jar = deserializeCookieJar(serialized);
    this.#persist = persist;
  }

  public async prepareRequest(
    context: HttpSessionRequestContext
  ): Promise<HttpFieldsInput | undefined> {
    return this.#prepareRequest(context);
  }

  public async [PREPARE_CONTEXTUAL_REQUEST](
    context: HttpSessionRequestContext,
    sameSiteContext: CookieSameSiteContext
  ): Promise<HttpFieldsInput | undefined> {
    return this.#prepareRequest(context, sameSiteContext);
  }

  async #prepareRequest(
    context: HttpSessionRequestContext,
    sameSiteContext?: CookieSameSiteContext
  ): Promise<HttpFieldsInput | undefined> {
    await this.#mutationTail;
    const value = sameSiteContext === "none"
      ? (await this.#jar.getCookies(context.url, { sameSiteContext }))
        .filter((cookie) => cookie.sameSite === "none" && cookie.secure)
        .map((cookie) => cookie.cookieString())
        .join("; ")
      : await this.#jar.getCookieString(context.url, {
        ...(sameSiteContext === undefined ? {} : { sameSiteContext })
      });
    return value.length === 0
      ? undefined
      : [{ name: "cookie", value }];
  }

  public async acceptResponse(
    context: HttpSessionResponseContext
  ): Promise<void> {
    const setCookieFields = context.fields.all("set-cookie");
    if (setCookieFields.length === 0) return;
    await this.#mutate(async () => {
      for (const field of setCookieFields) {
        const parsed = Cookie.parse(field);
        if (parsed?.sameSite === "none" && !parsed.secure) continue;
        if (parsed?.secure === true && new URL(context.url).protocol !== "https:") continue;
        await this.#jar.setCookie(field, context.url, {
          ignoreError: true
        });
      }
      await this.#pruneAndPersist();
    });
  }

  public async clear(): Promise<void> {
    await this.#mutate(async () => {
      await this.#jar.removeAllCookies();
      await this.#persist(await this.#jar.serialize());
    });
  }

  public list(): readonly CookieSummary[] {
    const serialized = this.#jar.serializeSync();
    if (serialized === undefined) return [];
    return serialized.cookies
      .flatMap(cookieSummary)
      .sort((left, right) => {
        if (left.domain !== right.domain) {
          return left.domain.localeCompare(right.domain);
        }
        if (left.path !== right.path) {
          return left.path.localeCompare(right.path);
        }
        return left.name.localeCompare(right.name);
      });
  }

  public async flush(): Promise<void> {
    await this.#mutationTail;
  }

  #mutate(operation: () => Promise<void>): Promise<void> {
    const completion = this.#mutationTail.then(operation);
    this.#mutationTail = completion.catch(() => undefined);
    return completion;
  }

  async #pruneAndPersist(): Promise<void> {
    const serialized = await this.#jar.serialize();
    const retained = recentCookieIndexes(serialized.cookies);
    for (const [index, cookie] of serialized.cookies.entries()) {
      if (retained.has(index)) continue;
      const domain = stringProperty(cookie, "domain");
      const path = stringProperty(cookie, "path") ?? "/";
      const key = stringProperty(cookie, "key");
      if (domain !== null && key !== null) {
        await this.#jar.store.removeCookie(domain, path, key);
      }
    }
    await this.#persist(await this.#jar.serialize());
  }
}

export function serializedCookieJar(
  value: unknown
): SerializedCookieJar | null {
  if (
    typeof value !== "object"
    || value === null
    || !("cookies" in value)
    || !Array.isArray(value.cookies)
    || !("rejectPublicSuffixes" in value)
    || value.rejectPublicSuffixes !== true
  ) {
    return null;
  }
  try {
    const record = value as Record<string, unknown> & { cookies: unknown[] };
    const cookies = record.cookies
      .slice(-MAX_COOKIE_CANDIDATES)
      .filter((cookie): cookie is SerializedCookie => safeSerializedCookie(cookie));
    const candidate = {
      version: typeof record["version"] === "string"
        ? record["version"].slice(0, 128)
        : "",
      storeType: typeof record["storeType"] === "string"
        ? record["storeType"].slice(0, 128)
        : null,
      rejectPublicSuffixes: true,
      enableLooseMode: record["enableLooseMode"] === true,
      allowSpecialUseDomain: record["allowSpecialUseDomain"] !== false,
      prefixSecurity: record["prefixSecurity"],
      cookies
    } satisfies SerializedCookieJar;
    const jar = CookieJar.deserializeSync(candidate);
    const canonical = jar.serializeSync();
    return canonical === undefined
      ? null
      : boundedCookieJar({
        ...canonical,
        cookies: canonical.cookies.filter((cookie) =>
          stringProperty(cookie, "sameSite") !== "none" || cookie["secure"] === true
        )
      });
  } catch {
    return null;
  }
}

function safeSerializedCookie(value: unknown): value is SerializedCookie {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length <= MAX_COOKIE_PROPERTIES && entries.every(([, property]) => (
    property === null
    || typeof property === "boolean"
    || typeof property === "number"
    || (typeof property === "string" && property.length <= MAX_COOKIE_PROPERTY_CODE_UNITS)
  ));
}

function deserializeCookieJar(
  serialized: SerializedCookieJar | null
): CookieJar {
  if (serialized === null) return new CookieJar();
  return CookieJar.deserializeSync(serialized);
}

function cookieSummary(cookie: SerializedCookie): readonly CookieSummary[] {
  const name = stringProperty(cookie, "key");
  const value = stringProperty(cookie, "value");
  const domain = stringProperty(cookie, "domain");
  if (name === null || value === null || domain === null) return [];
  const path = stringProperty(cookie, "path") ?? "/";
  return [{
    name,
    value,
    domain,
    path,
    expiresAt: stringProperty(cookie, "expires")
  }];
}

function stringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const property = value[key];
  return typeof property === "string" ? property : null;
}
