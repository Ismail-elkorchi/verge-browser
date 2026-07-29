# Use Author CSS

`BrowserSession` applies embedded styles, style attributes, and external
stylesheets before constructing terminal-independent page content:

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

Verge computes the CSS properties terminals can represent: visibility and
flow, whitespace, colors, text emphasis and decoration, alignment, list
markers, and bounded cell-based spacing. Unsupported selectors, values, and
layout systems are ignored and reported in `styleIssues`; they do not prevent
the HTML page from rendering.

Reader view ignores author styles. Browser chrome and keyboard-focus
indication are never styled by the page.
