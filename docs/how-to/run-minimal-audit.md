# Run A Minimal Audit

Goal: produce a small deterministic audit record from one page snapshot.

```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession({
  loader: async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    html: "<main><a href='/docs'>Docs</a><p>Audit target</p></main>",
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

const audit = {
  status: snapshot.status,
  parseErrorCount: snapshot.diagnostics.parseErrorCount,
  linkCount: snapshot.rendered.links.length,
  triageIds: snapshot.diagnostics.triageIds
};

console.log(audit.status);
console.log(audit.parseErrorCount);
console.log(audit.linkCount);
console.log(audit.triageIds.length > 0);
```

Expected output:
- `200`
- `0`
- `1`
- `true`
