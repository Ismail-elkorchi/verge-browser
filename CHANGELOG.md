# Changelog

All notable changes are documented in this file.

## Unreleased

- **Breaking:** `parseHtml()` now returns the parser's complete
  `ParsedDocument` instead of only its `DocumentTree`.
- **Breaking:** `PageSnapshot.document` replaces `PageSnapshot.tree` and
  `PageSnapshot.sourceHtml`.
- Use `@ismail-elkorchi/html-parser@0.2.1` from the public npm registry,
  preserve parser resource metadata, bound text extraction, and avoid duplicate
  buffering while parsing streamed responses.
- Require release qualification to start from a clean npm installation whose
  parser identity matches the manifest and lockfile, then install and exercise
  the packed Verge artifact in a clean consumer.
- Replace the duplicated fetch transport with the shared, commit-pinned HTTP
  client; reuse connections across a browser session; and release network
  resources when sessions and the terminal application close.
- **Breaking:** Remove `classifyNetworkFailure()`; fetch failures now come from
  the typed transport as `NetworkFetchError.networkOutcome`.
- **Breaking:** Require `BrowserServices.close()` so terminal hosts can release
  owned network resources.
- **Breaking:** Preserve response metadata as ordered `HttpFields` in
  `FetchPageResult`, `FetchPageStreamResult`, `FetchStylesheetResult`, and
  `PageSnapshot`.
- **Breaking:** Remove the exported hand-written cookie parser and cookie-header
  helpers. The browser now persists a public-suffix-aware cookie jar behind
  `HttpSessionAdapter`, which applies response cookies before redirect and
  stylesheet requests.
- Stream HTML bytes through encoding detection by default and pass HTTP charset
  evidence to the parser.
- Keep page-initiated resources and downloads on the public-network policy by
  default while allowing explicit direct navigation to local targets.

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
