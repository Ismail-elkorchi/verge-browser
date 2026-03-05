# Options

## Rendering options

### `renderDocumentToTerminal(input)`
Key fields on `input`:
- `tree`
- `requestUrl`
- `finalUrl`
- `status`
- `statusText`
- `fetchedAtIso`
- `width`

## Fetch options

### `fetchPage(url, userAgent?, timeoutMs?, requestOptions?, localFileReader?)`
- `timeoutMs` bounds request runtime.
- `requestOptions` controls headers/method details.
- `localFileReader` enables deterministic local file simulation.

### `fetchPageStream(...)`
- Same request controls, but returns stream-first response payload.

## Security options

### `assertAllowedUrl(rawUrl, policy?)`
- Uses protocol and host rules from `DEFAULT_SECURITY_POLICY` unless overridden.

### `assertAllowedProtocol(url, policy?)`
- Verifies protocol allowlists.

## Session options

### `new BrowserSession(options)`
- `pageLoader`
- `pageStreamLoader`
- `pageRenderer`
- `policy`
