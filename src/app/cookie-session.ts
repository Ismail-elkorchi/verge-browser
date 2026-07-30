import {
  type HttpFieldsInput,
  type HttpSessionAdapter,
  type HttpSessionRequestContext,
  type HttpSessionResponseContext
} from "@ismail-elkorchi/http-client";
import {
  CookieJar,
  type SerializedCookie,
  type SerializedCookieJar
} from "tough-cookie";

export interface CookieSummary {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expiresAt: string | null;
}

type PersistCookieJar = (serialized: SerializedCookieJar) => Promise<void>;

export class BrowserCookieSession implements HttpSessionAdapter {
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
    await this.#mutationTail;
    const value = await this.#jar.getCookieString(context.url);
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
        await this.#jar.setCookie(field, context.url, {
          ignoreError: true
        });
      }
      await this.#persist(await this.#jar.serialize());
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

  #mutate(operation: () => Promise<void>): Promise<void> {
    const completion = this.#mutationTail.then(operation);
    this.#mutationTail = completion.catch(() => undefined);
    return completion;
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
    CookieJar.deserializeSync(value as SerializedCookieJar);
    return value as SerializedCookieJar;
  } catch {
    return null;
  }
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
