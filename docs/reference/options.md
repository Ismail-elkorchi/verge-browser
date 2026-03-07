# Options

## JSR options surface (`jsr/mod.ts`)

### `DEFAULT_SECURITY_POLICY`
- Type: `SecurityPolicyOptions`
- Fields:
  - `maxRedirects` default `5`
  - `maxContentBytes` default `2097152` (2 MiB)
  - `maxRequestRetries` default `1`
  - `retryDelayMs` default `75`

### `resolveInputUrl(rawInput, currentUrl?)`
- `rawInput`: user-provided URL input.
- `currentUrl`: optional base URL used for resolving relative input.
- Accepts absolute URLs, relative URLs, bare hosts, and `about:help`.
- Throws when input is empty, invalid, or resolves to an unsupported protocol.

### `resolveHref(href, baseUrl)`
- Resolves link-like href values against an absolute base URL.
- Falls back to returning `href` when resolution fails.

### `assertAllowedUrl(rawUrl)` / `assertAllowedProtocol(url)`
- Enforce allowed protocols (`https:`, `http:`, `file:`, `about:`).
- Throw `Error` for unsupported protocols.

## Node/npm options surface (`src/mod.ts`)

### `fetchPage(requestUrl, timeoutMs?, securityPolicy?, requestOptions?, readLocalFileText?)`
- `timeoutMs` defaults to `15000`.
- `securityPolicy` merges with `DEFAULT_SECURITY_POLICY`.
- `requestOptions.method` defaults to `GET`; `POST` is supported.
- `requestOptions.headers` adds deterministic request headers such as cookies or auth.
- `requestOptions.bodyText` is only used for `POST`.
- Returns a fully buffered HTML payload plus `networkOutcome`.
- Throws `NetworkFetchError` for pre-response failures such as DNS, timeout, TLS, redirect-limit, content-type, and size-limit failures.
- Returns a normal result for HTTP responses, including `4xx` and `5xx`, with `networkOutcome.kind = "http_error"`.

### `fetchPageStream(requestUrl, timeoutMs?, securityPolicy?, requestOptions?, readLocalFileText?)`
- Uses the same timeout, policy, and request option rules as `fetchPage`.
- Returns a streaming body in `stream` instead of buffered `html`.
- Applies `maxContentBytes` while the stream is consumed.

### `BrowserSessionOptions`
- `loader` and `streamLoader` replace the built-in page fetchers.
- `renderer` replaces the terminal renderer.
- `widthProvider` defaults to `() => 100`.
- `parseOptions` defaults to the package's bounded HTML parse profile.
- `defaultParseMode` defaults to `"text"` and may be set to `"stream"`.
- `localFileReader` overrides `file://` reads for tests or custom hosts.

### `PageRequestOptions`
- `method`: `"GET"` or `"POST"`.
- `headers`: request headers merged into the deterministic defaults.
- `bodyText`: UTF-8 request body for `POST`.

### `PageSnapshot`
- `sourceHtml` is present for HTML snapshots opened from buffered HTML input.
- The package does not expose a full external CSS snapshot field.
- If you need CSS alongside the HTML snapshot, extract inline `<style>` blocks from `sourceHtml` and fetch linked stylesheets separately.

## Related
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
