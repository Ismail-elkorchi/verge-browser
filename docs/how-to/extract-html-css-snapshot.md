# Extract HTML And Inline CSS Snapshot

## Goal
Capture the fetched HTML snapshot and any inline `<style>` blocks preserved in
that HTML.

## Prerequisites
- `@ismail-elkorchi/verge-browser` installed
- A loader or fixture HTML that includes inline styles

## Copy/paste
```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession({
  loader: async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    html: "<style>.card{color:#0057b8}</style><main><div class='card'>Hello</div></main>",
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
const html = snapshot.sourceHtml ?? "";
const cssBlocks = [...html.matchAll(/<style[^>]*>([\\s\\S]*?)<\\/style>/gi)].map((match) => match[1].trim());

console.log(html.includes("<main>"));
console.log(cssBlocks.length);
console.log(cssBlocks[0]);
```

## Expected output
```txt
true
1
.card{color:#0057b8}
```

## Common failure modes
- `sourceHtml` is missing because the loader returned a non-HTML content type.
- External stylesheets are expected even though this recipe only extracts
  inline `<style>` blocks from `sourceHtml`.
- Snapshot auditing is performed before confirming the fetch result was `ok`.
- Style attributes on elements are expected to appear in `cssBlocks`, even
  though they remain embedded in the HTML snapshot instead.

## Related reference
- [API overview](../reference/api-overview.md)
- [Options](../reference/options.md)
- [Error model](../reference/error-model.md)
