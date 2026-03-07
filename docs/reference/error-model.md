# Error Model

## `NetworkFetchError`

Represents deterministic failures that happen before a usable HTML response is available, or while enforcing fetch safety limits.

Common kinds include:
- DNS/network resolution failures,
- timeout failures,
- TLS failures,
- redirect-limit failures,
- non-HTML content-type failures,
- response size-limit failures,
- policy-denied URL failures.

`fetchPage()` and `fetchPageStream()` throw `NetworkFetchError` for those cases.

## HTTP error responses are returned, not thrown

Once an HTTP response is received, `fetchPage()` and `fetchPageStream()` return a normal result even for `4xx` and `5xx` statuses.

Check these fields instead of expecting an exception:
- `result.status`
- `result.statusText`
- `result.networkOutcome.kind === "http_error"`
- `result.networkOutcome.detailCode`

## Security-policy rejections

`assertAllowedUrl` and `assertAllowedProtocol` throw on disallowed URLs or protocols.

## Session state errors

`BrowserSession` forwards `NetworkFetchError` from its loaders and also throws plain `Error` for session misuse, such as:
- `reload()` before any page is open,
- `back()` with no backward history entry,
- `forward()` with no forward history entry,
- `openLink()` with a missing link index,
- `applyEdits()` when the current snapshot has no `sourceHtml`.

## Recommended handling

- Treat `NetworkFetchError` as an expected operational outcome.
- Treat `http_error` as a returned response state that may still have useful HTML.
- Log `networkOutcome.kind`, `detailCode`, `detailMessage`, and `finalUrl` for observability.
