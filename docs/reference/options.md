# Options

## JSR options surface (`jsr/mod.ts`)

### `DEFAULT_SECURITY_POLICY`
- Type: `SecurityPolicyOptions`
- Fields:
  - `allowHttp`
  - `allowHttps`
  - `allowFile`

### `resolveInputUrl(rawInput, currentUrl?)`
- `rawInput`: user-provided URL input.
- `currentUrl`: optional base URL used for resolving relative input.
- Throws when input is empty, invalid, or resolves to unsupported protocol.

### `resolveHref(href, baseUrl)`
- Resolves link-like href values against an absolute base URL.
- Falls back to returning `href` when resolution fails.

### `assertAllowedUrl(rawUrl)` / `assertAllowedProtocol(url)`
- Enforce allowed protocols (`https:`, `http:`, `file:`).
- Throw `Error` for unsupported protocols.

## Node/npm options surface (`src/mod.ts`)

Node/npm exposes additional option-rich APIs not present in JSR, including:
- fetch options (`fetchPage`, `fetchPageStream`)
- renderer input options (`renderDocumentToTerminal`)
- session options (`BrowserSession` constructor options)

Use the Node/npm API reference for full runtime option contracts.

## Related
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
