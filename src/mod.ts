/**
 * Public npm/Node entrypoint for Verge Browser.
 *
 * The package exposes navigation, transport safety, and Verge's immutable web
 * document boundary. Style, formatting, fragmentation, and terminal projection
 * remain internal while their contracts mature.
 *
 * ```ts
 * import { parseWebDocument } from "@ismail-elkorchi/verge-browser";
 *
 * const document = parseWebDocument(
 *   "<h1>Hello</h1><a href='/docs'>Docs</a>",
 *   { requestUrl: "https://example.com", finalUrl: "https://example.com" }
 * );
 * console.log(document.title, document.links[0]?.destination);
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
  buildGetSubmissionUrl,
  buildFormSubmissionRequest,
  type FormSubmissionRequest
} from "./app/forms.js";
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
export {
  parseWebDocument,
  parseWebDocumentBytes,
  parseWebDocumentStream,
  createDocumentState,
  applyDocumentAction
} from "./document/index.js";
export type {
  WebDocumentBytesOptions,
  WebDocumentParseBudgetOptions,
  WebDocumentParseContext,
  WebDocumentParseOptions,
  WebDocumentStreamBudgetOptions,
  WebDocumentStreamOptions,
  DocumentAction,
  DocumentAttribute,
  DocumentControlState,
  DocumentButtonControl,
  DocumentChoiceControl,
  DocumentDisclosure,
  DocumentEdit,
  DocumentForm,
  DocumentFormControl,
  DocumentFormControlBase,
  DocumentHeading,
  DocumentIndexLimits,
  DocumentIndexOutcome,
  DocumentLabel,
  DocumentLandmark,
  DocumentLink,
  DocumentMetadataEntry,
  DocumentNodeRef,
  DocumentOutlineEntry,
  DocumentParserDiagnostic,
  DocumentReplacedContent,
  DocumentSelectControl,
  DocumentSelectOption,
  DocumentSemanticEntry,
  DocumentSemanticRole,
  DocumentSourceMetadata,
  DocumentSourceRange,
  DocumentState,
  DocumentStylesheetReference,
  DocumentTextControl,
  DocumentTextareaControl,
  DocumentHiddenControl,
  DocumentUnsupportedControl,
  WebDocumentNode,
  WebDocumentSnapshotView,
  WebElementNode,
  WebTextNode
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
