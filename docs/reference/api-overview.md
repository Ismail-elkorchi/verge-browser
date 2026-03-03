# API Overview

`verge-browser` exposes a library surface from `src/mod.ts` for deterministic terminal browsing workflows.

JSR dry-run surface currently exports a reduced subset from `jsr/mod.ts`:
- `resolveInputUrl`, `resolveHref`
- `DEFAULT_SECURITY_POLICY`, `assertAllowedProtocol`, `assertAllowedUrl`, `isHtmlLikeContentType`

## Session and rendering
- `BrowserSession`
- `renderDocumentToTerminal(input)`

## Input normalization and command parsing
- `resolveInputUrl(rawInput, currentUrl?)`
- `resolveHref(href, baseUrl)`
- `parseCommand(rawInput)`
- `formatHelpText()`

## Form and cookie helpers
- `extractForms(tree, baseUrl)`
- `buildGetSubmissionUrl(form, overrides?)`
- `buildFormSubmissionRequest(form, overrides?)`
- `parseSetCookie(raw, requestUrl, nowMs?)`
- `mergeSetCookieHeaders(...)`
- `pruneExpiredCookies(cookies, nowMs?)`
- `cookieHeaderForUrl(cookies, requestUrl, nowMs?)`

## Search and paging
- `createSearchState(lines, query)`
- `hasSearchMatches(state)`
- `activeSearchLineIndex(state)`
- `moveSearchMatch(state, direction)`
- `createPager(lines, pageSize)`
- `setPagerLines(pager, lines, pageSize)`
- `pagerViewport(pager)`

## Security and fetch boundary
- `DEFAULT_SECURITY_POLICY`
- `assertAllowedProtocol(url)`
- `assertAllowedUrl(rawUrl)`
- `isHtmlLikeContentType(contentType)`
- `NetworkFetchError`
- `classifyNetworkFailure(error, finalUrl)`
- `readByteStreamToText(stream)`
- `fetchPage(url, userAgent?, timeoutMs?, requestOptions?, localFileReader?)`
- `fetchPageStream(url, userAgent?, timeoutMs?, requestOptions?, localFileReader?)`

## Runtime host adapters
- `createNodeHost()`
- `createDenoHost()`
- `createBunHost()`

## Types
- `PageSnapshot`, `RenderedPage`, `RenderedLink`, `PageDiagnostics`
- `NetworkOutcome`, `NetworkOutcomeKind`, `PageRequestOptions`
- `FormEntry`, `FormField`, `FormSubmissionRequest`
- `RuntimeHost`, `RuntimeName`
