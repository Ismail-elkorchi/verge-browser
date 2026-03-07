# First Session

## Goal
Open a page in a deterministic local session without relying on live network
conditions.

## Prerequisites
- `@ismail-elkorchi/verge-browser` installed
- A local loader function or fixture HTML

## Copy/paste
```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession({
  widthProvider: () => 72,
  loader: async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    html: "<main><h1>Local Session</h1><p>Ready.</p></main>",
    responseHeaders: {},
    setCookieHeaders: [],
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: null,
      detailMessage: "local-loader"
    }
  })
});

const snapshot = await session.open("https://example.test/");
console.log(snapshot.status);
console.log(snapshot.rendered.lines.length > 0);
console.log(snapshot.diagnostics.parseErrorCount);
```

## Expected output
```txt
200
true
0
```

## Common failure modes
- The loader omits required fields such as `networkOutcome`, so the session
  cannot classify the fetch.
- Input URLs are not normalized before session use, which produces confusing
  relative-resolution behavior.
- Tests depend on live `fetch()` instead of a deterministic loader fixture.

## Related reference
- [API overview](../reference/api-overview.md)
- [Options](../reference/options.md)
- [Error model](../reference/error-model.md)
