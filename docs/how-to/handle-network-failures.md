# Handle Network Failures

## Goal
See how deterministic fetch failures surface so callers can branch on structured
network outcomes instead of string-matching raw errors.

## Prerequisites
- `@ismail-elkorchi/verge-browser` installed
- A URL that will fail under local policy or network conditions

## Copy/paste
```ts
import { NetworkFetchError, fetchPage } from "@ismail-elkorchi/verge-browser";

try {
  await fetchPage("https://not-a-real-host.example.invalid");
} catch (error) {
  if (error instanceof NetworkFetchError) {
    console.log(error.networkOutcome.kind);
    console.log(error.networkOutcome.detailCode ?? "none");
  } else {
    throw error;
  }
}
```

## Expected output
```txt
dns
DNS_ERROR
```

The Node fetch client exposes structured detail codes. DNS, TLS, and timeout
failures remain distinct from `kind: "transport"` with
`detailCode: "NETWORK_FAILURE"`. A transport summary may include a recognized
underlying code such as `ECONNREFUSED`; branch on the structured fields rather
than parsing that summary. The original error is retained as `cause`, which may
contain private request data and should not be copied blindly into user-visible
logs.

## Common failure modes
- Code branches on raw exception message text instead of `networkOutcome.kind`.
- `NetworkFetchError` is swallowed and the caller loses the final URL and detail
  code.
- Timeouts, DNS failures, and policy denials are all reported to users as the
  same generic "fetch failed" error.

## Related reference
- [Error model](../reference/error-model.md)
- [API overview](../reference/api-overview.md)
