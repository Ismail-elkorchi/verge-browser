# Changelog

All notable changes are documented in this file.

## Unreleased

- Use `@ismail-elkorchi/html-parser@0.2.1` from the public npm registry,
  preserve parser resource metadata, bound text extraction, and avoid duplicate
  buffering while parsing streamed responses.
- Require release qualification to start from a clean npm installation whose
  parser identity matches the manifest and lockfile, then install and exercise
  the packed Verge artifact in a clean consumer.
- Replace the duplicated fetch transport with the exact published shared HTTP
  client; reuse connections across a browser session; and release network
  resources when sessions and the terminal application close.
- **Breaking:** Remove `classifyNetworkFailure()`; fetch failures now come from
  the typed transport as `NetworkFetchError.networkOutcome`.
- **Breaking:** Require `BrowserServices.close()` so terminal hosts can release
  owned network resources.
- **Breaking:** Preserve response metadata as ordered `HttpFields` in
  `FetchPageResult`, `FetchPageStreamResult`, `FetchStylesheetResult`, and
  `PageSnapshot`.
- **Breaking:** `PageDiagnostics` replaces the old renderer/caller-cookie
  timing fields with semantic-content and stylesheet timing/count diagnostics.
- **Breaking:** `BrowserSession.applyEdits()` is asynchronous because edits can
  change external stylesheet resources; form extraction now exposes semantic
  `FormControl` variants instead of the earlier flat field shape.
- **Breaking:** Remove the exported hand-written cookie parser and cookie-header
  helpers. The browser now persists a public-suffix-aware cookie jar behind
  `HttpSessionAdapter`, which applies response cookies before redirect and
  stylesheet requests.
- Stream HTML bytes through encoding detection by default and pass HTTP charset
  evidence to the parser.
- Keep page-initiated resources and downloads on the public-network policy by
  default while allowing explicit direct navigation to local targets.
- Block page-initiated `file:` stylesheets even when a remote document supplies
  a `file:` base URL; apply the same local-file boundary to remote links, new
  tabs, and forms; keep links and forms from inheriting direct private-network
  access; and enforce the aggregate stylesheet budget before later requests
  start.
- Restrict persisted cookies and browsing state to POSIX `0700` directories and
  `0600` files; bound indexed text, restored tabs, downloads, cookie candidates,
  and serialized state; refuse a symlink state file; validate and read state
  through the same open handle; and leave non-profile custom parent directories
  untouched. Windows uses the current user profile ACL.
- Keep page-initiated stylesheet cookies on the document origin, including
  across redirects, make cross-origin stylesheet requests anonymous, and
  enforce `SameSite` context for page navigation and downloads, including
  Lax-by-default cookies, the `SameSite=None; Secure` requirement, and rejection
  of `Secure` cookies set by insecure responses.
- Avoid the Windows command-shell boundary for external opening, cancel active
  navigation when tabs close, separate cancelable navigation from profile I/O,
  time out stalled download responses, and release failed, discarded, or
  pre-parse streaming resources.
- Bound interactive form projection and replace repeated radio-group, option,
  and label scans with linear work on large documents.
- Validate the Node host on current macOS and Windows runners in addition to
  Linux.
- **Breaking:** Replace the flatten-first renderer with immutable document,
  computed-style, formatting-tree, terminal-fragment, and reader-projection
  stages. `PageSnapshot.document` is now the sole authoritative content model.
- **Breaking:** Expose the document boundary as `WebDocumentSnapshotView` from
  parser-independent factories and Verge-owned parse options; the concrete
  snapshot constructor and HTML-parser option/result types are internal.
- **Breaking:** Remove `PageSnapshot.rendered`, `RenderedPage`,
  `RenderedActionable`, `RenderedLink`, `RenderInput`, `PageRenderer`, renderer
  and width overrides, fixed-width render helpers, and the former flat page,
  pager, search, parser-attachment, and terminal helper modules.
- Preserve unknown/custom element hierarchy and semantic indexes; generate
  boxes from computed `display`; support suppression, contents, anonymous flow
  and table wrappers, lists, structured tables, controls, replaced fallbacks,
  flex/grid contexts, nested terminal fragments, source-aware wrapping, hit
  geometry, focus, scrolling, search, accessibility, and reader projection.
- Give anonymous and generated boxes explicit box-style and semantic ownership,
  exclude blank cells inside wrapped action unions from pointer geometry, and
  fail closed for unknown media types. Preserve semantic and accessibility
  identities for `display: contents` elements without generating a principal
  box.
- Preserve normal prose and links inside forms while replacing only control
  fragments with terminal controls; index explicit form ownership once; and
  model details disclosure as a typed document action.
- Reject page-initiated redirects that cross into local files before committing
  a document or stylesheet, release stream readers on completion and failure,
  and prevent canceled edits from committing after asynchronous resource work.
- Freeze style, fragment, geometry, search, and accessibility values at their
  subsystem boundaries; validate terminal and style environments as typed
  inputs; and represent CSS `max-width: none` and negative margins without
  terminal-unit shortcuts in computed style.
- Drive interactive and one-shot output from the same terminal fragment path,
  and enforce document/style/formatting import boundaries plus deterministic
  structural fuzz and per-stage performance controls.
- Keep template contents inert during style/resource/layout indexing, preserve
  foreign-namespace element casing, index standalone controls and radio groups,
  retain generic/custom-element prose in the separate reader projection, and
  persist scroll positions through durable element/source locators rather than
  snapshot-local node-reference strings.
- **Breaking:** Replace persisted workspace `scrollAnchor.source` strings with
  typed durable `scrollAnchor.target` locators; stale workspace entries using
  the snapshot-local format are rejected instead of guessed or migrated.
- Restore typed text alignment, indentation, automatic margins, flex wrapping
  and alignment, and common visually-clipped content handling; resolve terminal
  overlap by paint order and avoid argument-spread and repeated-reader-scan
  cliffs on large documents; keep document cloning and index propagation
  stack-safe at extreme parser-supported nesting depths.
- Make structural page actions a keyboard-navigable group, reveal offscreen
  control fragments before focusing their terminal-ui controls, retain
  absolute scroll anchors for rows without a source node, and keep Tab/Shift+Tab
  traversal within form controls.

## [0.1.2] - 2026-03-07
- Add the redesigned terminal UI with page-first navigation, help, and shell flows.
- Enforce JSR doc linting and doctest checks in CI and upload rendered HTML docs as artifacts.
- Reduce GitHub workflow token permissions and align release-policy validation with least-privilege job scopes.

## [0.1.1] - 2026-03-04
- Add OIDC `publish.yml` workflow for npm Trusted Publishing and JSR publish on release events.
- Add publish manifest evidence and deterministic tag/version parity checks before publish.

## [0.1.0] - 2026-03-04
- First public release of `@ismail-elkorchi/verge-browser`.
- npm + JSR package metadata, docs surface, and release automation hardened for deterministic publishing.
