/**
 * Public npm/Node entrypoint for verge-browser.
 *
 * This module exposes the package's terminal browsing primitives, deterministic
 * HTML rendering helpers, fetch/safety utilities, and runtime adapters used by
 * the supported Node.js CLI and the full npm library surface.
 *
 * ```ts
 * import { parseCommand, parseHtml, renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";
 *
 * const command = parseCommand("open https://example.com");
 * const tree = parseHtml("<h1>Hello</h1><a href=\"/docs\">Docs</a>");
 * const page = renderDocumentToTerminal({
 *   tree,
 *   requestUrl: "https://example.com",
 *   finalUrl: "https://example.com",
 *   status: 200,
 *   statusText: "OK",
 *   fetchedAtIso: "2026-01-01T00:00:00.000Z",
 *   width: 80
 * });
 *
 * console.log(command.kind);
 * console.log(page.title);
 * ```
 *
 * The published JSR entrypoint intentionally exposes a smaller, utility-only
 * surface. Use the npm package when you need the interactive `verge` CLI or
 * the full browser/session runtime.
 *
 * @module
 */
export { formatHelpText, parseCommand, type BrowserCommand } from "./app/commands.js";
export { parseSetCookie, mergeSetCookieHeaders, pruneExpiredCookies, cookieHeaderForUrl, type CookieEntry } from "./app/cookies.js";
export {
  fetchPage,
  fetchPageStream,
  readByteStreamToText,
  classifyNetworkFailure,
  NetworkFetchError,
  type LocalFileReader
} from "./app/fetch-page.js";
export {
  extractForms,
  buildGetSubmissionUrl,
  buildFormSubmissionRequest,
  type FormEntry,
  type FormField,
  type FormSubmissionRequest
} from "./app/forms.js";
export {
  createPager,
  pagerViewport,
  pagerTop,
  pagerBottom,
  pagerLineDown,
  pagerLineUp,
  pagerPageDown,
  pagerPageUp,
  pagerJumpToLine,
  setPagerLines,
  type PagerState,
  type PagerViewport
} from "./app/pager.js";
export { parseHtml } from "./app/parse-html.js";
export { renderDocumentToTerminal } from "./app/render.js";
export { createSearchState, hasSearchMatches, activeSearchLineIndex, moveSearchMatch, type SearchState } from "./app/search.js";
export { DEFAULT_SECURITY_POLICY, assertAllowedProtocol, assertAllowedUrl, isHtmlLikeContentType, type SecurityPolicyOptions } from "./app/security.js";
export {
  BrowserSession,
  type BrowserSessionOptions,
  type PageLoader,
  type PageStreamLoader,
  type PageRenderer
} from "./app/session.js";
export { terminalWidth, terminalHeight, clearTerminal, formatRenderedPage, formatLinkTable } from "./app/terminal.js";
export type {
  NetworkOutcome,
  NetworkOutcomeKind,
  RenderedLink,
  RenderedPage,
  FetchPageResult,
  FetchPageStreamResult,
  FetchPagePayload,
  PageRequestOptions,
  PageDiagnostics,
  RenderInput,
  PageSnapshot,
  KeyboardKey
} from "./app/types.js";
export { resolveInputUrl, resolveHref } from "./app/url.js";
export { createBunHost } from "./runtime/bun-host.js";
export { createDenoHost } from "./runtime/deno-host.js";
export { createNodeHost } from "./runtime/node-host.js";
export type { RuntimeHost, RuntimeName } from "./runtime/host.js";
