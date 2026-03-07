# Fetch Pages Safely

## Goal
Normalize user input into an allowed URL and then fetch content with predictable
protocol and network behavior.

## Prerequisites
- `@ismail-elkorchi/verge-browser` installed
- A URL you are willing to fetch under the default protocol allow-list

## Copy/paste
```ts
import { assertAllowedUrl, fetchPage, resolveInputUrl } from "@ismail-elkorchi/verge-browser";

const url = resolveInputUrl("example.com");
assertAllowedUrl(url);

const result = await fetchPage(url);
console.log(result.status);
console.log(result.finalUrl);
```

## Expected output
```txt
200
https://example.com/
```

## Common failure modes
- A disallowed scheme such as `javascript:` or `data:` is passed directly to
  `fetchPage()` instead of being rejected early with `assertAllowedUrl()`.
- Relative user input is used without `resolveInputUrl()`, so the wrong base URL
  is applied.
- Callers treat HTTP `4xx` and `5xx` responses as thrown exceptions even though
  `fetchPage()` returns them with `networkOutcome.kind = "http_error"`.
- Callers ignore thrown `NetworkFetchError` cases for DNS, timeout, redirect,
  content-type, or size-limit failures.

## Related reference
- [API overview](../reference/api-overview.md)
- [Options](../reference/options.md)
- [Error model](../reference/error-model.md)
