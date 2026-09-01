# Browser rendering pipeline

Verge has one retained HTML rendering path. Immutable document work is built in
the rendering worker:

```text
IndexedWebDocumentSnapshot
→ StylesheetProgram
→ ComputedStyleMap
→ FormattingTree
→ InlineItemStreamSet + TextSearchIndex
→ scroll-independent LayoutFragmentTree
→ DocumentDisplayList
→ DisplayListSpatialIndex + DocumentGeometryIndex
```

Each visible frame then follows the shorter viewport path:

```text
ViewportWindow
→ fixed/sticky attachment resolution
→ spatial paint-command query
→ ViewportDisplayList
→ ViewportCellBuffer
→ viewport-local hit, focus, accessibility, and search indexes
```

The immutable indexed document tree is authoritative. Style resolution creates
a total computed style map for its retained elements and pseudo-elements. CSS
box generation creates principal, anonymous, pseudo, table-internal, flex-item,
and grid-item boxes. Layout then resolves used values and creates fixed-point
CSS-pixel layout fragments and line boxes. Terminal painting creates ordered
document-space paint commands; the cell rasterizer alone snaps selected
viewport commands to terminal rows and columns and materializes styled cells.
Scroll position is absent from every immutable artifact dependency key.

Interactive browsing and one-shot output use the same retained artifact engine,
spatial query, and viewport rasterizer. There is no flat renderer, cell-native CSS layout engine,
fallback geometry path, or conversion from layout fragments back into an older
layout model.

## Ownership

- `src/document/` alone imports the HTML parser. It owns node identities,
  source ranges, semantics, indexes, document state, and typed document actions.
- `src/presentation/style/` alone imports the CSS parser. It owns the user-agent
  stylesheet, cascade, media evaluation, computed values, diagnostics, and style
  budgets. `MediaEnvironment` supplies CSS viewport and user preferences.
- `src/presentation/formatting/` owns CSS box generation, anonymous repair,
  formatting-context classification, generated boxes, and formatting-node
  identity. A formatting tree has no dimensions or positions.
- `src/unicode/` owns the pinned Unicode 17.0.0 property tables, UAX #9,
  UAX #14, and UAX #29 primitives, version metadata, and checksum-backed
  generated data. It imports no browser-engine subsystem.
- `src/presentation/text/` builds immutable inline-item streams, applies CSS
  text transformation and white-space processing, and combines generic Unicode
  primitives with document and computed-style identities. It owns no CSS box
  dimensions, search index, or terminal cells.
- `src/presentation/layout/` owns containing blocks, computed-to-used value
  resolution, intrinsic contributions, block and inline formatting contexts,
  line boxes, margin collapse, replaced and control geometry, and the supported
  table, flex, and grid algorithms. It has no terminal dependency.
- `src/presentation/search/` owns the viewport-independent `TextSearchIndex`.
  It consumes inline-item streams and owns no text input needed by layout.
  Logical match IDs map to layout text fragments before terminal rasterization.
- `src/presentation/renderer/` owns artifact dependency keys, cost-bounded
  retention, eviction, stage instrumentation, and viewport orchestration.
- `src/presentation/terminal/display-list.ts` derives the retained
  `DocumentDisplayList` from layout fragments. It does not calculate CSS
  geometry.
- `src/presentation/terminal/spatial-index.ts` indexes document-space commands;
  `viewport-display-list.ts` queries a viewport plus bounded overscan and
  resolves fixed and sticky attachments without rerunning layout.
- `src/presentation/terminal/rasterizer.ts` snaps only viewport CSS-pixel paint
  geometry to cells and resolves paint collisions. `document-geometry.ts`
  retains document anchors and semantic geometry; `viewport-indexes.ts` builds
  only visible hit-test, focus, accessibility, node, and search indexes.
- `src/reader/` owns the deliberately flattened reader document. It is not a
  rendering fallback.
- `src/ui/render-worker/` owns the long-lived Node worker protocol and artifact
  store. The worker has no network or filesystem capability. The main `src/ui/`
  code owns browser chrome, placeholder tabs, render requests, and the last
  committed viewport only.

HTTP, redirects, cookies, local-resource policy, downloads, tabs, history,
bookmarks, persistence, and browser chrome remain application concerns.
The application builds the recursive stylesheet dependency graph and applies
the ordinary page-resource security boundary to every `@import`; style owns CSS
syntax inspection, dependency metadata, cascade layers, `@supports`, and typed
computed values. Neither style nor layout performs network access.

The style subsystem exposes one pure implementation-support evaluator. The
resource loader consults it before scheduling an import, so a false
`supports()` condition performs no request. Every admitted stylesheet source
has required root/dependency order, import ancestry, layer path, media/supports
conditions, predeclared layers, and a verified parsed-rule count. Rule limits
are admission limits: a source that would exceed the remaining rule budget is
not added to the cascade. Default graph limits are 32 external roots, 512 KiB
per source, 2 MiB aggregate stylesheet bytes, depth 16, 64 imported sources,
2 MiB aggregate imported bytes, 5 redirects per request, 100,000 parsed rules,
and 256 import edges.

Style resolution creates one indexed selector-matching session for an author
cascade and reuses it across qualified rules. Selector work is cumulative and
bounded. If that work limit is exhausted, the author candidate set is discarded
as one transaction while the total user-agent baseline remains available for
every retained element; Verge never exposes a source-order-dependent partial
author cascade.

Author cascade layers are paths rather than flat ordinals. Every path segment
has parent-relative order; direct declarations occupy the parent's implicit
final sublayer. Normal declarations order layers forward and put unlayered and
element-attached declarations afterward. Important declarations reverse layer
order, while important element-attached declarations retain their author-origin
precedence. `revert` and `revert-layer` remove the complete relevant cascade
position before the next candidate is selected.

## Geometry and CSS values

Layout uses deterministic 26.6 fixed-point arithmetic: one CSS pixel is 64
integer units. Coordinates, lengths, points, sizes, rectangles, and edges have
distinct internal types. Arithmetic saturates at JavaScript safe-integer bounds,
and non-finite inputs produce typed rejection. Negative margins remain signed.
No layout operation rounds to a terminal cell.

The value stages remain separate:

- style stores specified/cascaded information as computed CSS values;
- layout resolves used values against containing blocks, font metrics, and the
  CSS viewport;
- the cell rasterizer produces actual values after terminal snapping and device
  constraints.

Terminal dimensions enter layout only through the CSS viewport:

```text
viewport width  = terminal columns × cell width in CSS pixels
viewport height = terminal rows × row height in CSS pixels
```

`LayoutContext` carries that viewport, the initial containing block, the
CSS-pixel text measurer, and layout budgets. Layout derives root font metrics
(including ascent, descent, baseline, x-height, line gap, and `ch` advance)
from the computed root-element font size after style resolution. The root
element resolves `rem` in its own `font-size` against the initial font size;
descendants resolve `rem` against that computed root size. One minimal
cancellation contract is passed through style resolution, box generation,
inline-item stream construction, text search indexing, layout, display-list
indexing, spatial queries, cell rasterization, and viewport-index construction.
The worker observes replacement generations through shared atomics, so
cancellation does not wait for its event loop to receive a message.
Terminal rows, columns, color capability, and Unicode capability do not enter
layout. Text metrics, advances, grapheme boundaries, and fixed-point inputs are
validated at their subsystem boundaries; malformed values produce typed
rejection rather than escaping as unsafe geometry.

The UI derives one shared set of media and terminal preferences for interactive
and one-shot rendering. `COLORFGBG` and the `VERGE_COLOR_SCHEME` override select
the preferred color scheme; `VERGE_REDUCED_MOTION` selects reduced motion.
Terminal Unicode, ambiguous-width, and color-depth capabilities remain confined
to `TerminalRenderContext`.

Terminal focus-target lifecycle events update the focused document node before
the next applicable artifact revision. Selector programs are classified by
dynamic state dependency, and unaffected structural match sets remain retained.
A focus change with no applicable focus-dependent selector leaves the computed
style map and later document artifacts intact. The terminal view does not add a
second inverse-video focus style over authored cells.

## Artifact lifetimes and worker protocol

`RenderArtifactStore` retains one authoritative analysis for each explicit
document, stylesheet-program, media, state, viewport-size, and text-metric
dependency key. It reuses upstream artifacts when only a downstream key changes.
Scroll, search query, active match, and terminal color depth are not document
analysis keys. Retention is cost-bounded (512 MiB by default), uses
least-recently-used analysis eviction, bounds search projections per document,
and releases document-owned programs, selector sessions, substitution caches,
analyses, and searches on navigation replacement, tab release, or worker
disposal. It retains no scroll-keyed complete render result.

The UI attaches decoded HTML source, verified stylesheet syntax, immutable
resource metadata, and document state once per document revision. Subsequent
messages carry document, state, and viewport revisions plus request IDs. The UI
rejects stale completions; viewport generations are latest-request-wins. Heavy
style, box, text, layout, display-list, geometry, and raster artifacts stay in
the worker. Only compact document extent, focus, and anchor summaries plus the
requested viewport rows and visible indexes cross back to the UI.

terminal-ui continues to serialize state transitions and frame commits. Its
effects send requests, await worker results, and dispatch typed completion
messages; neither `updateBrowser()` nor `browserView()` invokes browser
rendering. Worker failure keeps the last committed viewport, exposes an explicit
failed rendering state with a retry action, and never falls back to synchronous
UI-thread rendering. Ordinary scrolling does not implicitly restart a failed
worker.

Workspace restoration creates placeholder tabs before navigation, starts the
TUI shell immediately, loads the active placeholder first, and restores
background tabs with bounded concurrency. Background tabs are not rendered
until selected. Each failure is isolated, and closing a placeholder cancels its
pending navigation before a session can be retained.

### Dependency invalidation

Artifact keys record the document revision, admitted stylesheet fingerprints,
media features actually consumed by the stylesheet program, dynamic selector
state, CSS viewport dimensions actually consumed by style or layout, and the
terminal text-metric profile. Scroll position, search query, active search
match, and terminal color depth are viewport dependencies and never invalidate
normal-flow layout. A width change reuses styles and text processing unless an
inline-size media query changes them; a height change reuses document layout
unless block-size media, viewport units, percentages, fixed geometry, or sticky
constraints consume it. Ambiguous-width changes invalidate text measurement
and layout, while color-depth changes begin at cell rasterization.

Stylesheet resources retain verified parser syntax and dependency-graph
metadata rather than transport bytes. `StylesheetProgram` compiles selectors,
declarations, inline style attributes, layer position, and state dependencies
once. Selector sessions retain structural indexes and unchanged match sets.
Custom properties use persistent parent-linked environments; substituted
component values are materialized as a syntax tree with fresh tree-local parser
identities before validation. Validation is bounded by each program and uses
the css-parser validation session rather than reconstructing declaration
strings.

## Performance qualification

`npm run test:bench` writes `reports/incremental-rendering-bench.json`. Its
independently authored MIT fixture combines a reference-article-sized document,
common type/class/descendant selectors, custom properties, tables, links, and
controls. It separately reports cold navigation and attachment, first viewport,
warm spatial query and viewport rasterization, actual terminal-ui
scroll-to-viewport latency, browser view construction, frame commit, search,
resize, color-depth-only work, event-loop delay, worker heap, superseded work,
and four- and fifty-tab placeholder restoration.

Release controls require scroll-only requests to invoke none of stylesheet,
computed-style, box-tree, inline-stream, logical-search, normal-flow-layout, or
document-display-list construction. Retained rows may not exceed viewport plus
overscan; one hundred replacement scroll requests may commit only their newest
generation; released artifact graphs must be unreachable after forced garbage
collection. Timing gates apply only to the deterministic fixture: warm worker
viewport p95 is bounded at 100 ms, browser-view construction at 33 ms,
input-to-state update at 50 ms, main event-loop delay at 50 ms, and shell
creation at 500 ms. Full terminal frame-commit timing remains reported
separately because terminal output cost depends on the terminal host.

## Layout fragment and line-box contracts

Each layout fragment records its stable fragment ID, formatting node, document
node, pseudo-element identity, content/padding/border/margin rectangles,
overflow and clip rectangles, child fragments, source ranges, used font metrics,
baseline, intrinsic contributions, visual order, paint order, action identity,
and semantic identity. One formatting box may produce several fragments.

Each immutable line box records its CSS rectangle, baseline, ascent, descent,
logical item range, break cause, source-linked text fragments, resolved
embedding levels, bidi runs, and visual runs. Each inline formatting context
owns an immutable inline-item stream across ordinary inline box boundaries;
atomic inline boxes own independent inner streams, so their trailing white-space
state cannot affect the containing context. CSS white-space processing and UAX #29
grapheme boundaries precede UAX #9 paragraph resolution and UAX #14/CSS break
opportunities. Layout selects logical lines from fixed-point advances, applies
the UAX #9 per-line reset and reordering rules, and then creates visual runs and
the corresponding fragment geometry. Display-list construction traverses the
actual layout fragment tree in CSS paint order; it never substitutes identities
from a visual-order list and does not reorder text.

Replaced boxes, form controls, `inline-block`, `inline-table`, `inline-flex`,
and `inline-grid` boxes are atomic inline boxes. Their inner formatting context
is laid out independently and their resulting margin box participates once in
the containing line box. Splittable inline boxes retain per-line continuation
geometry for background and border painting.

Work-budget exhaustion finalizes open ancestors and keeps a connected
source-order layout-fragment prefix. Completed fragments are never cleared.

The horizontal-writing-mode flex formatting algorithm computes flex base and
hypothetical main sizes, automatic minimum sizes, line collection, iterative
grow/shrink freezing, automatic margins, order-modified placement, reverse
directions, cross sizes, baseline alignment, wrapping, wrap reversal, gaps,
and multi-line alignment. Positioned layout resolves positioned containing
blocks, static positions, opposing insets, shrink-to-fit widths, relative
offsets, fixed initial-containing-block geometry, sticky scrollport
constraints, and stacking buckets. Floats are out of normal block flow, shorten
line boxes, honor computed-direction logical sides and clearance, and contribute
to formatting-context overflow.

Horizontal-writing-mode Grid uses one typed property model, one placement
algorithm, and one track-sizing algorithm. Style retains component-tree values
for explicit and implicit track lists, line names, named areas, line/span
placements, auto-repeat, flow, gaps, and alignment. Box generation creates Grid
items only for direct in-flow children and qualifying anonymous text runs;
absolute and fixed descendants stay out of flow. Layout expands the explicit
and implicit grids, resolves placements through a sparse row-interval occupancy
index, calculates shared fixed-point intrinsic contributions, sizes columns and
then rows after wrapping, relayouts stretch-eligible items, and records Grid
paint order in ordinary stacking metadata. The detailed internal contract and
work limits are documented in [CSS Grid layout](./css-grid.md).

Horizontal-writing-mode table layout similarly has one slot model and one
layout engine. The document subsystem indexes HTML spans, groups, captions, and
header relationships; formatting performs CSS table box fixup; layout builds a
bounded sparse slot grid, resolves intrinsic or fixed column widths, sizes rows
after wrapping, distributes rowspan requirements, positions captions, and
resolves separated or collapsed borders. Table paint metadata preserves table,
column-group, column, row-group, row, cell, border, and content phases without
moving sizing or span logic into terminal code. The detailed contract and work
limits are documented in [HTML/CSS table layout](./css-tables.md).

Sticky positioning is currently constrained only against the root terminal
scrollport and the sticky box's containing block. Nested scrolling boxes remain
unsupported; values such as `overflow:auto` and `overflow:scroll` therefore
produce the existing typed unsupported-value diagnostic rather than creating a
second scroll container.

Computed display is blockified before box generation for floats, absolute and
fixed positioning, and principal flex/grid items. Absolute and fixed children
remain out-of-flow descendants of flex/grid containers and never enter item
wrapping, gap calculation, or flexible sizing. Flex axes map logical main/cross
starts through horizontal writing mode, computed direction, direction reversal,
and wrap reversal. Cross-axis stretch triggers descendant relayout at the used
cross size. Flexible-length iteration is cancellable and bounded by
`maxFlexSizingWork` (2,000,000 work units by default).

Normal block flow owns one float-exclusion manager per block formatting context.
The manager retains source-ordered float margin rectangles and final containing
block geometry; inline formatting contexts query it for every line. An ordinary
block child keeps its full border-box width while only overlapping line boxes
are shortened.

## Terminal contracts

`DocumentDisplayList` contains ordered background-fill, border-side, and text
paint commands. A box's background and supported border sides precede its
in-flow descendants; later siblings retain source order. Commands retain
clipping, source ranges, styles, action and semantic identities, and
formatting/document/layout-fragment identities. Border sides keep their actual
box-edge coordinates before clipping, so a saturated or far-offscreen side is
never moved onto the retained cell-buffer boundary.

`ViewportCellBuffer` contains the requested viewport rows, bounded overscan,
the complete document row count, its document-row origin, grapheme-owning
cells, style spans, and identity-bearing cell spans. Its retained row count is
bounded by viewport rows plus overscan regardless of document height. Adjacent
graphemes in one text command snap
monotonically and never overwrite one another. A grapheme occupies at least one
actual terminal cell, wide graphemes remain atomic, and larger CSS advances may
produce cell gaps because a terminal cannot resize glyphs. Later paint commands
win collisions. Source-over alpha composition occurs before terminal
color-depth quantization.

Every text paint command carries layout-established grapheme clusters with
their logical content range and document source range. The cell rasterizer does
not segment, line-break, or run the bidi algorithm. Terminal emulators remain
responsible for glyph shaping; correct Arabic bidi order does not imply that
Verge implements an Arabic shaping engine.

The viewport hit-test index uses row buckets and comes from clipped
action-bearing content, padding, and border geometry; every retained region has
a stable routing identity. Visible focus and accessibility rectangles come from
the retained document geometry index without scanning all document entries.
Scroll anchors and logical focus order remain document-wide worker-owned
indexes. Only search cell spans depend on surviving text paint. Logical search
matches are projected through layout text fragments and only then into cell
spans, so match identity survives wrapping, resize, and cell-metric changes.

Terminal work has independent limits for display-list commands, generated paint
units, retained paint cells, cell-buffer rows and columns, hit-test regions,
focus rectangles, accessibility rectangles, document rectangles, scroll
anchors, and search cell spans. Zero is a valid no-work limit; negative,
fractional, and unsafe supplied limits are rejected. Terminal truncation never
changes the layout fragment tree, interactive mode reports the truncated state,
and one-shot mode fails with the exact limits instead of emitting a partial,
unbounded document. Accessibility bounds and scroll anchors retain document
source-order prefixes; paint cells and hit-test regions retain paint-order
prefixes.

## Invariants

- CSS `display`, not an HTML-tag switch, determines box participation.
- Formatting nodes and layout fragments retain document identities and source
  ranges; no layer reconstructs semantics from rendered text.
- Computed styles contain no terminal rows or columns.
- Layout fragments contain no terminal cells, ANSI styles, or terminal-ui types.
- Document display-list construction consumes layout fragments; viewport
  selection consumes only its spatial index.
- Cell rasterization consumes viewport paint commands and never allocates rows
  from zero through document height.
- Search consumes logical text; line placement and painting consume visual
  runs. No reordered search string or row-based search path exists.
- Physical and logical box properties compete in the cascade; horizontal
  logical sides map only after the element's computed `direction` is known.
- Parser component-value trees—not whitespace or function regular expressions—
  drive custom-property substitution, CSS math, length-percentage values,
  colors, Grid grammar, and the supported layout shorthands. Used-value math remains in
  layout.
- Unicode property lookup is pinned to Unicode 17.0.0 and never depends on the
  host ICU or operating-system Unicode version.
- Budget, cancellation, unsupported, rejected, and truncated behavior is typed;
  control flow never matches diagnostic prose.
