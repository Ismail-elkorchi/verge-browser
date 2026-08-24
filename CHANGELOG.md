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
- Preserve `PageSnapshot.rendered` and the legacy renderer override while
  keeping flatten-first `PageContent`, `PageBlock`, and `PageLayout` contracts
  out of the stable root snapshot/export surface.

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
