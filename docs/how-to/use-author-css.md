# Use Author CSS

`BrowserSession` loads embedded styles, style attributes, and external
stylesheets alongside the parsed HTML:

```ts
import { BrowserSession } from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession();
try {
  const snapshot = await session.open("https://example.com/");
  console.log(snapshot.diagnostics.stylesheetCount);
  console.log(snapshot.diagnostics.stylesheetLoadIssueCount);
} finally {
  await session.close();
}
```

External stylesheets use the public HTTP/HTTPS network boundary, including
across redirects. A remote document cannot trigger a `file:` read through a
link or document base URL. Use `stylesheetLoader` for trusted fixtures or
another transport and `stylesheetPolicy` to lower the resource limits.

The browser evaluates responsive styles at the current terminal width while
retaining stable semantic actions across resize. Style resolution produces a
document-keyed internal computed style map; box generation, fixed-point layout,
the terminal display list, and the terminal cell buffer remain internal.

Verge resolves used values in fixed-point CSS pixels before terminal cell
rasterization. The currently supported CSS slice includes:

- inherited custom properties and `var()` fallbacks;
- `screen` and width media queries, using eight CSS pixels per terminal column;
- visibility, whitespace, colors, text emphasis, decoration, font size, line
  height, vertical alignment, text alignment, and text indentation;
- margins (including negative and automatic values), padding, side-specific
  border widths, percentages, viewport units, font-relative units,
  `box-sizing`, and min/max constraints resolved to used CSS-pixel values;
- block flow with adjoining-margin collapse, inline formatting with explicit
  line boxes, four flex directions, wrapping, main/cross-axis alignment,
  and grids with explicit auto, length, fraction, fixed `repeat()`, and
  `minmax()` tracks;
- bounded widths, heights, gaps, solid borders, and overflow clipping.

Flex and grid support is intentionally an initial formatting slice. Flex grow,
shrink, ordering, complete intrinsic sizing, grid spanning, auto-repeated
tracks, and the full CSS sizing algorithms are not implemented yet. Verge also
recognizes the common absolutely positioned, one-pixel, overflow-hidden
`clip`/`clip-path` pattern as visually clipped content while retaining its
accessibility semantic.

HTML meaning remains available when a rule cannot be represented. Unsupported
selectors, properties, and values are ignored and aggregated in the browser's
diagnostics view. `stylesheetLoadIssueCount` covers transport and resource-load
failures; it does not claim to count every cascade diagnostic.

Reader view ignores author styles. Browser chrome and keyboard-focus
indication are never styled by the page.
