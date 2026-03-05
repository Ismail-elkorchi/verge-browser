# Fetch Pages Safely

Goal: fetch content with policy constraints and predictable failure modes.

```ts
import { DEFAULT_SECURITY_POLICY, assertAllowedUrl, fetchPage } from "@ismail-elkorchi/verge-browser";

const url = "https://example.com";
assertAllowedUrl(url, DEFAULT_SECURITY_POLICY);

const result = await fetchPage(url);
console.log(result.status, result.finalUrl);
```

Expected output:
- Structured fetch result or a `NetworkFetchError` with deterministic classification.
