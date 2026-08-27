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
Linked and embedded roots may recursively import stylesheets. Verge preserves
depth-first cascade order, nested media conditions, import layers, and import
`supports()` conditions while rejecting cycles and bounding import depth,
source count, aggregate imported bytes, redirects, parsed rules, and dependency
edges. Every imported URL uses the same public-resource and cookie boundary as
its root stylesheet.

The browser evaluates responsive styles at the current terminal width while
retaining stable semantic actions across resize. Style resolution produces a
document-keyed internal computed style map; box generation, fixed-point layout,
the terminal display list, and the terminal cell buffer remain internal.

Verge resolves used values in fixed-point CSS pixels before terminal cell
rasterization. The currently supported CSS slice includes:

- inherited custom properties, structural `var()` fallbacks and cycle
  detection, plus `calc()`, `min()`, `max()`, and `clamp()` length-percentage
  values;
- normal and important cascade layers, named and anonymous nested layers,
  unlayered author rules, `revert`, `revert-layer`, and implementation-backed
  `@supports` conditions;
- `screen` and width media queries, using eight CSS pixels per terminal column;
- visibility, whitespace, colors, text emphasis, decoration, font size, line
  height, vertical alignment, text alignment, and text indentation;
- margins (including negative and automatic values), padding, side-specific
  border widths, percentages, viewport units, font-relative units,
  `box-sizing`, and min/max constraints resolved to used CSS-pixel values;
- block flow with adjoining-margin collapse, inline formatting with explicit
  line boxes, flexible-length resolution, automatic flex minimum sizes,
  freezing, order, four directions, wrapping and wrap reversal, automatic
  margins, baseline and multi-line alignment,
  and grids with explicit auto, length, fraction, fixed `repeat()`, and
  `minmax()` tracks;
- relative, absolute, fixed, and sticky positioning, insets, shrink-to-fit
  sizing, z-index stacking, left/right/logical floats, clearing, and line boxes
  shortened around floats;
- bounded widths, heights, gaps, solid borders, functional RGB/HSL colors,
  alpha composition, and overflow clipping.

Grid spanning and auto-placement, table spans and border collapse, vertical
writing modes, multi-column layout, web fonts, raster image decoding, and page
JavaScript remain explicit gaps. Supported positioned clipping retains document
semantics while its actual paint and pointer geometry stays clipped. Sticky
positioning uses the root terminal scrollport; nested scrolling boxes remain
typed unsupported.

HTML meaning remains available when a rule cannot be represented. Unsupported
selectors, properties, and values are ignored and aggregated in the browser's
diagnostics view. `stylesheetLoadIssueCount` covers transport and resource-load
failures; it does not claim to count every cascade diagnostic.

Reader view ignores author styles. Browser chrome and keyboard-focus
indication are never styled by the page.
