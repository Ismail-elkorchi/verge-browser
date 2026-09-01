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
- `requestOptions.headers` adds request fields. A managed HTTP session owns the
  `Cookie` field.
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
- Direct library calls may explicitly read `file:` URLs. `BrowserSession` never
  grants that capability to a page-initiated stylesheet.
- HTTP and HTTPS loads use the same redirect, timeout, cancellation, retry, and
  byte-limit behavior as page fetching.

### `PageNetworkClient`
- Reuses connection pools across page, stream, and stylesheet requests.
- Provides `fetchPage()`, `fetchPageStream()`, and `fetchStylesheet()` with the
  same arguments and results as the standalone functions.
- `navigatePage()` and `navigatePageStream()` allow a directly entered local or
  private-network target. Page and stylesheet fetches retain the public-network
  boundary, including after redirects.
- `session` supplies page-navigation credentials and accepts every redirect and
  final response through `HttpSessionAdapter`. Automatic stylesheets use that
  session only while the request remains on the document origin; cross-origin
  stylesheet hops are anonymous and cannot mutate the cookie jar.
- The built-in persistent cookie session treats an omitted `SameSite` attribute
  as `Lax` and rejects `SameSite=None` cookies unless they also specify
  `Secure`; insecure responses cannot set `Secure` cookies.
- Response metadata is retained as ordered `HttpFields`, including repeated
  field lines.
- Call `close()` after normal use or `destroy(error)` to cancel active work.
- Standalone fetch functions create and release an operation-scoped client.

### `BrowserSessionOptions`
- `networkClient` shares an existing `PageNetworkClient`; its owner remains
  responsible for closing it.
- `httpSession` attaches one session adapter to an internally owned network
  client. It cannot be combined with `networkClient`.
- `loader` and `streamLoader` replace the built-in page fetchers.
- `stylesheetLoader` replaces external CSS fetching.
- `stylesheetPolicy` bounds root stylesheet count, per-resource and aggregate
  bytes, recursive import depth and source count, aggregate imported bytes,
  redirects, parsed rules, and dependency edges. Stylesheets load in
  deterministic depth-first cascade order so later requests are not started
  after a relevant budget is exhausted.
- `parseOptions` accepts Verge-owned parse budgets and
  defaults to the package's bounded HTML parse profile. Structure, source
  spans, retained decoded source, disabled scripting, and summary diagnostics
  are fixed invariants of the document boundary rather than parser-specific
  options.
- `defaultParseMode` defaults to `"stream"` so the HTML parser receives the
  response bytes and transport encoding evidence. Use `"text"` only with a
  loader that already decoded the HTML.
- `localFileReader` overrides `file://` reads for tests or custom hosts.
- A session that creates its own network client releases it through `close()`
  or `destroy(error)`.
- Explicitly entered `file:` navigation remains available, and a local document
  may follow local links. HTTP(S) documents cannot manufacture a `file:` link,
  new-tab link, form submission, or private-network request. The default
  transport keeps page-initiated navigation on its public-address policy;
  custom loaders remain responsible for their own boundary.

### `PageRequestOptions`
- `method`: `"GET"` or `"POST"`.
- `headers`: request headers merged into the deterministic defaults.
- A `Cookie` field is rejected when the network client has a session adapter;
  the adapter recalculates cookies for every redirect hop.
- `bodyText`: UTF-8 request body for `POST`; supplying it with `GET` is rejected.
- `signal`: aborts the request, retry wait, and session navigation.

### `PageSnapshot`
- `document` is Verge's immutable `WebDocumentSnapshot`, with opaque node
  references, parent/child structure, retained decoded source, and source
  metadata.
- Browser sessions retain source for buffered and streamed HTML. Document
  construction, dynamic state, and the concrete snapshot implementation are
  internal browser subsystems rather than root package APIs.
- The rendering worker retains style, box, text, layout, display-list, spatial,
  and semantic artifacts by their actual dependency keys. A scroll selects and
  rasterizes a viewport window without rebuilding document analysis. There is
  no pre-rendered, fixed-width field on the snapshot.
- `stylesheets` contains bounded resources with verified parsed syntax and
  dependency metadata attached to the document;
  `styleDiagnostics` contains stylesheet collection/load failures.
- `diagnostics.stylesheetLoadIssueCount` counts those load failures. Cascade
  diagnostics remain part of the browser diagnostics because
  they depend on the active style environment.
- `responseFields` preserves ordered response field lines as `HttpFields`.
- Interactive extraction considers at most 256 forms per page, 2,000 controls
  per form, and 2,000 options per select.

### Browser state storage
- Workspace restoration starts with placeholder tabs, loads the active tab
  first, and restores background tabs with bounded concurrency after the TUI
  shell exists. One failed tab does not abort the workspace.
- Persisted cookies, history, downloads, index data, tabs, and scroll anchors
  share one state file.
- Persisted scroll anchors use durable HTML-id or source locators. Opaque
  document-node references remain scoped to one immutable snapshot and are not
  serialized as cross-session identities.
- The default POSIX profile directory is restricted to `0700`; state and
  replacement files are `0600`, including existing state files when reopened.
- A custom `statePath` always receives `0600` file protection, but its existing
  parent directory is not chmodded unless it is the dedicated
  `verge-browser` profile directory. On POSIX, Verge rejects a caller-owned
  existing parent that grants group or other access; callers own arranging a
  suitable private directory.
- State loading rejects symbolic-link paths and validates and reads through one
  file handle so a path replacement cannot redirect the credential-bearing
  read.
- Indexed page text is capped at 16 KiB for each of at most 250 pages, the
  workspace at 50 tabs, downloads at 200 records, and the persisted cookie jar
  at 1,000 cookies / 4 MiB. State input and replacement files have an 80 MiB
  safety ceiling.
- Windows relies on the current user's profile-directory ACL rather than POSIX
  mode bits.

## Related
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
