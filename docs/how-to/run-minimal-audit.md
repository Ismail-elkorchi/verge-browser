# Run A Minimal Audit

## Goal
Produce a small deterministic audit record from a single page snapshot.

## Prerequisites
- `@ismail-elkorchi/verge-browser` installed
- A loader or saved HTML fixture

## Copy/paste
```ts
import { HttpFields } from "@ismail-elkorchi/http-client";
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession({
  loader: async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    html: "<title>Audit target</title><main><a href='/docs'>Docs</a><p>Audit target</p></main>",
    responseFields: new HttpFields([
      { name: "content-type", value: "text/html; charset=utf-8" }
    ]),
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: null,
      detailMessage: "local-loader"
    }
  }),
  defaultParseMode: "text"
});

try {
  const snapshot = await session.open("https://example.test/");

  const audit = {
    status: snapshot.status,
    parseErrorCount: snapshot.diagnostics.parseErrorCount,
    title: snapshot.document.title,
    triageIds: snapshot.diagnostics.triageIds
  };

  console.log(audit.status);
  console.log(audit.parseErrorCount);
  console.log(audit.title);
  console.log(audit.triageIds.length > 0);
} finally {
  await session.close();
}
```

## Expected output
```txt
200
0
Audit target
true
```

## Common failure modes
- The loader returns non-HTML content so the page content and diagnostics are
  not comparable to normal page audits.
- Audit consumers treat `triageIds` as stable policy verdicts instead of
  deterministic hints for review.
- A consumer expects internal semantic indexes to be part of the root API;
  use the browser UI for link/form interaction and the read-only document tree
  only for deliberate structural inspection.

## Related reference
- [API overview](../reference/api-overview.md)
- [Error model](../reference/error-model.md)
