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
- nested style rules, `&`, stylesheet-local namespaces, and document-mode-aware
  selector matching;
- `screen`, width and height media queries, including grouped `and`, `or` and
  `not` conditions, using eight CSS pixels per column and sixteen per row;
- visibility, whitespace, colors, text emphasis, decoration, font size, line
  height, vertical alignment, text alignment, and text indentation;
- the modeled `font` shorthand: size, optional line height, style and weight,
  with normal cascade competition and resets of omitted modeled values;
- generated `::before`, `::after`, and `::marker` content using decoded strings,
  `attr(name)`, `counter()` and `counters()`, plus optional `/` alternative text;
  `counter-reset`, `counter-increment`, and `counter-set` share HTML list
  `start`, `reversed`, and item `value` numbering;
- `list-style-type`, `list-style-position: inside|outside`, and the supported
  `list-style` shorthand; inside markers join inline flow, while outside markers
  align with the first content baseline without widening the item's content;
- margins (including negative and automatic values), padding, side-specific
  border widths, horizontal LTR/RTL logical block/inline borders and their
  width/style/color longhands, percentages, viewport units, `em`, `rem`, `ex`,
  and `ch`,
  `box-sizing`, and min/max constraints resolved to used CSS-pixel values;
- block flow with adjoining-margin collapse, inline formatting with explicit
  line boxes, flexible-length resolution, automatic flex minimum sizes,
  freezing, order, four directions, wrapping and wrap reversal, automatic
  margins, baseline and multi-line alignment,
  and horizontal-writing-mode Grid with explicit and implicit tracks, line
  names, named areas, positive and negative lines, spans, sparse/dense row and
  column auto-placement, fixed/intrinsic/flexible sizing, `minmax()`,
  `fit-content()`, fixed and automatic `repeat()`, item alignment, content
  alignment, automatic margins, overlap, and Grid-aware positioned descendants;
- horizontal-writing-mode tables with CSS table box fixup, HTML `colspan` and
  `rowspan`, automatic and fixed column layout, column and row groups, row-height
  distribution, top and bottom captions, separated borders, collapsed-border
  edge-graph conflict resolution, empty-cell painting, RTL geometry,
  source-owned header associations, and positioned descendants that remain
  outside table sizing;
- relative, absolute, fixed, and sticky positioning, insets, shrink-to-fit
  sizing, z-index stacking, left/right/logical floats, clearing, and line boxes
  shortened around floats;
- `translate()`, `translateX()` and `translateY()` with length-percentage values,
  shared paint/interaction geometry, and transformed containing blocks;
- bounded widths, heights, gaps, solid borders, CSS named colors and functional
  RGB/HSL colors, HTML `bgcolor` presentational hints, alpha composition, and
  overflow clipping and nested scrolling geometry.

The current root background, or an eligible body background under a transparent
HTML root, paints the canvas beyond the element's box. Body propagation is
suppressed by `display:none` or paint containment on the root or body. Canvas
painting does not enlarge the body or create a pointer target.

Generated counters support decimal, decimal-leading-zero, lower/upper-alpha
(and lower/upper-latin aliases), disc, circle, square, and none. Generated
alternative text affects semantic names under DOM/ARIA precedence but is not
painted or included in visual search. Custom counter styles, counter images,
and quote-depth handling remain unsupported.

The `font` shorthand validates its required family syntax without selecting a
terminal font. System-font keywords, font variants/stretch, angled oblique, and
font-family selection remain outside the modeled subset. Logical borders map to
physical sides before cascade winner selection; they do not add vertical writing.

The terminal text measurer uses its actual fixed-size glyph advances and normal
line metrics. Computed CSS font sizes and font-relative lengths remain distinct;
used `ex` resolves against x-height and `ch` against the character advance.
Computed font-size/line-height values and media queries use a `0.5em` fallback
for these units where selected-font metrics are unavailable. The rasterizer
does not simulate smaller glyphs by overwriting adjacent text or
larger glyphs by inserting spaces. Explicit compact line heights can still
create authored overlap.

The `grid` shorthand, subgrid, masonry, vertical writing modes, table
fragmentation, multi-column layout, rotated/scaled/3D transforms, web fonts,
raster image decoding, and page
JavaScript remain explicit gaps. The implemented `grid-template` shorthand
does not imply support for the separate `grid` shorthand. Supported positioned clipping retains document
semantics while its actual paint and pointer geometry stays clipped. Sticky
positioning uses the relevant scroll owner, including supported nested scrolling
boxes.

HTML meaning remains available when a rule cannot be represented. Unsupported
selectors, properties, and values are ignored and aggregated in the browser's
diagnostics view. `stylesheetLoadIssueCount` covers transport and resource-load
failures; it does not claim to count every cascade diagnostic.

Reader view ignores author styles. Browser chrome is never styled by the page.
Keyboard focus on document nodes participates in `:focus` and `:focus-visible`
selector matching, with the default indicator supplied by the user-agent
stylesheet rather than a terminal inverse-video overlay.
