# Error Model

## `NetworkFetchError`

Represents deterministic failures that happen before a usable HTML response is available, or while enforcing fetch safety limits.

Common kinds include:
- DNS resolution failures,
- transport failures such as refused or reset connections,
- timeout failures,
- TLS failures,
- redirect-limit failures,
- non-HTML content-type failures,
- response size-limit failures,
- policy-denied URL failures.

`fetchPage()` and `fetchPageStream()` throw `NetworkFetchError` for those cases.

Branch on `networkOutcome.kind` and `detailCode`, not the error's display text.
The HTTP client's `NETWORK_FAILURE` maps to `kind: "transport"`; recognized DNS,
TLS, and timeout failures keep their separate classifications. A transport
summary may include a bounded, allowlisted underlying code such as
`ECONNREFUSED`, without exposing arbitrary cause messages. The original error
remains available as `cause` for controlled diagnostics and can contain private
request details. Display messages are sanitized and bounded; the structured
outcome is retained unchanged by that display formatting and by the browser UI.

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

## Recommended handling

- Treat `NetworkFetchError` as an expected operational outcome.
- Treat `http_error` as a returned response state that may still have useful HTML.
- Log `networkOutcome.kind`, `detailCode`, `detailMessage`, and `finalUrl` for observability.
