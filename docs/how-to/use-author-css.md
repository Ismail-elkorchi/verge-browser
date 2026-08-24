# Use Author CSS

`BrowserSession` loads embedded styles, style attributes, and external
stylesheets alongside the parsed HTML:

```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession();
try {
  const snapshot = await session.open("https://example.com/");
  console.log(snapshot.diagnostics.stylesheetCount);
  console.log(snapshot.diagnostics.styleIssueCount);
} finally {
  await session.close();
}
```

External stylesheets use the public HTTP/HTTPS network boundary, including
across redirects. A remote document cannot trigger a `file:` read through a
link or document base URL. Use `stylesheetLoader` for trusted fixtures or
another transport and `stylesheetPolicy` to lower the resource limits.

The browser evaluates responsive styles at the current terminal width while
retaining stable semantic actions across resize. The current flatten-first
content and layout structures are implementation details rather than root API
contracts.

Verge supports a terminal CSS profile rather than pixel rendering:

- inherited custom properties and `var()` fallbacks;
- `screen` and width media queries, using eight CSS pixels per terminal column;
- visibility, whitespace, colors, text emphasis, decoration, and alignment;
- logical margins and padding mapped to terminal rows and cells;
- simple flow, wrapping row flexbox, and column grids;
- bounded widths, gaps, borders, and the common visually-hidden pattern.

HTML meaning remains available when a rule cannot be represented. Unsupported
selectors, properties, and values are ignored and aggregated in the browser's
diagnostics view; the snapshot exposes their aggregate count.

Reader view ignores author styles. Browser chrome and keyboard-focus
indication are never styled by the page.
