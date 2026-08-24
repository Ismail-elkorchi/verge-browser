import type {
  HttpFieldsInput,
  HttpSessionAdapter,
  HttpSessionRequestContext
} from "@ismail-elkorchi/http-client";
import { getPublicSuffix } from "tough-cookie";

export type CookieSameSiteContext = "strict" | "lax" | "none";

const PREPARE_CONTEXTUAL_REQUEST = Symbol("prepareContextualRequest");
const NAVIGATION_SOURCE_URL = Symbol("navigationSourceUrl");

export interface ContextualHttpSession extends HttpSessionAdapter {
  [PREPARE_CONTEXTUAL_REQUEST](
    context: HttpSessionRequestContext,
    sameSiteContext: CookieSameSiteContext
  ): HttpFieldsInput | PromiseLike<HttpFieldsInput | undefined> | undefined;
}

export function withNavigationSource<T extends object>(
  value: T,
  sourceUrl: string
): T {
  return Object.assign({}, value, { [NAVIGATION_SOURCE_URL]: sourceUrl });
}

export function navigationSource(value: object): string | undefined {
  return (value as { readonly [NAVIGATION_SOURCE_URL]?: string })[
    NAVIGATION_SOURCE_URL
  ];
}

function schemefulSite(rawUrl: string): string {
  const url = new URL(rawUrl);
  const registrableDomain = getPublicSuffix(url.hostname, {
    allowSpecialUseDomain: true
  }) ?? url.hostname;
  return `${url.protocol}//${registrableDomain}`;
}

function sameSiteContext(
  sourceUrl: string,
  targetUrl: string,
  method: string
): CookieSameSiteContext {
  if (schemefulSite(sourceUrl) === schemefulSite(targetUrl)) return "strict";
  return method === "GET" || method === "HEAD" ? "lax" : "none";
}

function supportsContextualRequests(
  session: HttpSessionAdapter
): session is ContextualHttpSession {
  return PREPARE_CONTEXTUAL_REQUEST in session;
}

export function navigationHttpSession(
  session: HttpSessionAdapter | undefined,
  sourceUrl: string | undefined
): HttpSessionAdapter | undefined {
  if (session === undefined || sourceUrl === undefined) return session;
  return {
    prepareRequest(context) {
      if (!supportsContextualRequests(session)) {
        return session.prepareRequest(context);
      }
      return session[PREPARE_CONTEXTUAL_REQUEST](
        context,
        sameSiteContext(sourceUrl, context.url, context.method)
      );
    },
    acceptResponse(context) {
      return session.acceptResponse(context);
    }
  };
}

export { PREPARE_CONTEXTUAL_REQUEST };
