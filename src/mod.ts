/**
 * Public npm/Node entrypoint for Verge Browser.
 *
 * The package exposes navigation, transport safety, and Verge's immutable web
 * document boundary. Style, formatting, fragmentation, and terminal projection
 * remain internal while their contracts mature.
 *
 * ```ts
 * import { BrowserSession } from "@ismail-elkorchi/verge-browser";
 *
 * const session = new BrowserSession();
 * const page = await session.open("about:help");
 * console.log(page.document.title);
 * await session.close();
 * ```
 *
 * @module
 */
export { formatHelpText, parseCommand, type BrowserCommand } from "./app/commands.js";
export {
  fetchPage,
  fetchPageStream,
  fetchStylesheet,
  readByteStreamToText,
  NetworkFetchError,
  PageNetworkClient,
  type LocalFileReader,
  type PageNetworkClientOptions
} from "./app/fetch-page.js";
export {
  DEFAULT_SECURITY_POLICY,
  assertAllowedProtocol,
  assertAllowedUrl,
  isHtmlLikeContentType,
  type SecurityPolicyOptions
} from "./app/security.js";
export {
  BrowserSession,
  type BrowserSessionOptions,
  type PageLoader,
  type PageStreamLoader,
  type StylesheetLoader,
  type StylesheetPolicyOptions
} from "./app/session.js";
export type {
  NetworkOutcome,
  NetworkOutcomeKind,
  FetchPageResult,
  FetchPageStreamResult,
  FetchPagePayload,
  PageRequestOptions,
  PageDiagnostics,
  FetchStylesheetResult,
  PageSnapshot
} from "./app/types.js";
export type {
  WebDocumentSnapshot
} from "./document/index.js";
export {
  DEFAULT_SEARCH_URL_TEMPLATE,
  resolveInputUrl,
  resolveOmniboxInput,
  resolveHref
} from "./app/url.js";
export { createBunHost } from "./runtime/bun-host.js";
export { createDenoHost } from "./runtime/deno-host.js";
export { createNodeHost } from "./runtime/node-host.js";
export type { RuntimeHost, RuntimeName } from "./runtime/host.js";
