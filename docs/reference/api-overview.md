# API Overview

All exported runtime entrypoints from `src/mod.ts`.

## Commands
- `formatHelpText`
- `parseCommand`

## Cookies
- `parseSetCookie`
- `mergeSetCookieHeaders`
- `pruneExpiredCookies`
- `cookieHeaderForUrl`

## Network fetch
- `fetchPage`
- `fetchPageStream`
- `readByteStreamToText`
- `classifyNetworkFailure`
- `NetworkFetchError`

## Forms
- `extractForms`
- `buildGetSubmissionUrl`
- `buildFormSubmissionRequest`

## Paging and search
- `createPager`
- `pagerViewport`
- `pagerTop`
- `pagerBottom`
- `pagerLineDown`
- `pagerLineUp`
- `pagerPageDown`
- `pagerPageUp`
- `pagerJumpToLine`
- `setPagerLines`
- `createSearchState`
- `hasSearchMatches`
- `activeSearchLineIndex`
- `moveSearchMatch`

## Rendering and terminal formatting
- `renderDocumentToTerminal`
- `terminalWidth`
- `terminalHeight`
- `clearTerminal`
- `formatRenderedPage`
- `formatLinkTable`

## Security and URL helpers
- `DEFAULT_SECURITY_POLICY`
- `assertAllowedProtocol`
- `assertAllowedUrl`
- `isHtmlLikeContentType`
- `resolveInputUrl`
- `resolveHref`

## Session and shortcuts
- `BrowserSession`
- `resolveShortcutAction`

## Runtime hosts
- `createNodeHost`
- `createDenoHost`
- `createBunHost`

## Exported types
- `BrowserCommand`
- `CookieEntry`
- `LocalFileReader`
- `FormEntry`
- `FormField`
- `FormSubmissionRequest`
- `PagerState`
- `PagerViewport`
- `SearchState`
- `SecurityPolicyOptions`
- `BrowserSessionOptions`
- `PageLoader`
- `PageStreamLoader`
- `PageRenderer`
- `ShortcutAction`
- `NetworkOutcome`
- `NetworkOutcomeKind`
- `RenderedLink`
- `RenderedPage`
- `FetchPageResult`
- `FetchPageStreamResult`
- `FetchPagePayload`
- `PageRequestOptions`
- `PageDiagnostics`
- `RenderInput`
- `PageSnapshot`
- `KeyboardKey`
- `RuntimeHost`
- `RuntimeName`
