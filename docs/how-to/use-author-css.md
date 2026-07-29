# Use Author CSS

`BrowserSession` loads embedded styles, style attributes, and external
stylesheets alongside the parsed HTML:

```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const snapshot = await new BrowserSession().open("https://example.com/");

console.log(snapshot.content.stylesheetCount);
console.log(snapshot.content.styleIssues);
```

External stylesheets use the same protocol, redirect, timeout, cancellation,
content-type, and byte-limit rules as page navigation. Use
`stylesheetLoader` for fixtures or another transport and `stylesheetPolicy`
to lower the resource limits.

`PageContent` retains the page's semantic blocks and stable actions.
`layoutPageContent(content, columns)` evaluates responsive styles at the
current terminal width and returns rows, action geometry, page colors, and
style runs.

Verge supports a terminal CSS profile rather than pixel rendering:

- inherited custom properties and `var()` fallbacks;
- `screen` and width media queries, using eight CSS pixels per terminal column;
- visibility, whitespace, colors, text emphasis, decoration, and alignment;
- logical margins and padding mapped to terminal rows and cells;
- simple flow, wrapping row flexbox, and column grids;
- bounded widths, gaps, borders, and the common visually-hidden pattern.

HTML meaning remains available when a rule cannot be represented. Unsupported
selectors, properties, and values are ignored and aggregated in
`styleIssues`; the `occurrences` field records repeats.

Reader view ignores author styles. Browser chrome and keyboard-focus
indication are never styled by the page.
