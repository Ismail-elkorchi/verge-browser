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
- Accepts absolute URLs, relative URLs, bare hosts, `about:help`, and `about:newtab`.
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

### `fetchStylesheet(requestUrl, timeoutMs?, securityPolicy?, requestOptions?, readLocalFileText?)`
- Returns bounded transport bytes so css-parser can apply CSS encoding rules.
- Accepts `text/css` responses and preserves a transport charset when supplied.
- Uses the same redirect, timeout, cancellation, retry, protocol, and byte-limit behavior as page fetching.

### `BrowserSessionOptions`
- `loader` and `streamLoader` replace the built-in page fetchers.
- `contentBuilder` replaces semantic page-content construction.
- `stylesheetLoader` replaces external CSS fetching.
- `stylesheetPolicy` bounds stylesheet count, per-resource bytes, and aggregate bytes.
- `parseOptions` defaults to the package's bounded HTML parse profile.
- `defaultParseMode` defaults to `"text"` and may be set to `"stream"`.
- `localFileReader` overrides `file://` reads for tests or custom hosts.

### `PageRequestOptions`
- `method`: `"GET"` or `"POST"`.
- `headers`: request headers merged into the deterministic defaults.
- `bodyText`: UTF-8 request body for `POST`.
- `signal`: aborts the request, retry wait, and session navigation.

### `PageSnapshot`
- `document` is the parser's identity-bearing result and contains `tree`,
  `metadata`, and the retained decoded HTML in `sourceText`.
- Browser sessions retain source for both buffered and streamed HTML. Raw
  `parseHtml()` calls retain it only when requested with
  `sourceRetention: "text"`.
- `content` contains terminal-independent blocks, links, forms, and stable
  action identities, plus computed block styles and styled text ranges. Use
  `layoutPageContent(content, columns)` when terminal rows, styles, and action
  geometry are needed.
- `content.styleIssues` records recoverable CSS fetch, parse, selector, and
  terminal-profile limitations.
- `applyEdits()` is asynchronous because changed HTML can change linked
  stylesheet resources.

## Related
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
