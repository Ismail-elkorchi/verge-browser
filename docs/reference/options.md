# Options and API Reference

This page is the primary API surface summary for `@ismail-elkorchi/verge-browser`.

## CLI entrypoint

- Binary: `verge`
- Start command:

```bash
verge https://example.com
```

## Programmatic API

- `parseCommand(input)`
- `formatHelpText()`
- `renderDocumentToTerminal(renderInput)`
- `resolveInputUrl(rawInput, currentUrl?)`
- `resolveHref(href, baseUrl)`
- `assertAllowedUrl(rawUrl)`
- `assertAllowedProtocol(url)`
- `isHtmlLikeContentType(contentType)`

## Security policy options

`DEFAULT_SECURITY_POLICY` includes:

- `allowHttp: true`
- `allowHttps: true`
- `allowFile: true`

Unsupported protocols are rejected by `assertAllowedProtocol`.

## Determinism expectations

- Equal page input and equal render options produce stable terminal line output.
- Command parsing is deterministic for equal command text.
- URL normalization rules are deterministic for equal input + base URL.

## Verify these claims

```bash
npm run check:fast
npm run examples:run
npm run smoke:cli
npm run docs:lint:jsr
npm run docs:test:jsr
```
