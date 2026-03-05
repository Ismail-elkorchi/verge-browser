# First Session

Goal: open a page in a deterministic local session without network access.

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
```

Expected output:
- `200`
- `true`
