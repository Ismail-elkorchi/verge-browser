# Browser rendering pipeline

Verge has one HTML rendering path:

```text
IndexedWebDocumentSnapshot
→ StyleSnapshot
→ FormattingTree
→ LayoutFragmentTree
→ TerminalDisplayList
→ TerminalCellBuffer
```

The immutable indexed document tree is authoritative. Style resolution creates
a total computed style map for its retained elements and pseudo-elements. CSS
box generation creates principal, anonymous, pseudo, table-internal, flex-item,
and grid-item boxes. Layout then resolves used values and creates fixed-point
CSS-pixel layout fragments and line boxes. Terminal painting creates ordered
paint commands; the cell rasterizer alone snaps those commands to terminal
rows and columns and materializes styled cells.

Interactive browsing and one-shot output consume the same terminal display list
and cell buffer. There is no flat renderer, cell-native CSS layout engine,
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
- `src/presentation/text/` owns the pinned Unicode 17.0.0 property tables,
  extended grapheme clusters, bidi paragraphs, embedding levels, bidi runs,
  line-break maps, CSS text tailoring, logical-to-visual run order, and exact
  source-range mapping. It owns no CSS box dimensions or terminal cells.
- `src/presentation/layout/` owns containing blocks, computed-to-used value
  resolution, intrinsic contributions, block and inline formatting contexts,
  line boxes, margin collapse, replaced and control geometry, and the supported
  table, flex, and grid algorithms. It has no terminal dependency.
- `src/presentation/search/` owns the viewport-independent `TextSearchIndex`.
  Logical match IDs map to layout text fragments before terminal rasterization.
- `src/presentation/terminal/display-list.ts` derives ordered terminal paint
  commands from layout fragments. It does not calculate CSS geometry.
- `src/presentation/terminal/rasterizer.ts` snaps CSS-pixel paint geometry to
  cells, resolves paint collisions, creates the `TerminalCellBuffer`, and builds
  the hit-test index, focus map, scroll anchors, accessibility bounds, and cell
  search spans.
- `src/reader/` owns the deliberately flattened reader document. It is not a
  rendering fallback.
- `src/ui/` owns browser chrome and adapts terminal text measurement to the
  layout-owned CSS-pixel metrics interface.

HTTP, redirects, cookies, local-resource policy, downloads, tabs, history,
bookmarks, persistence, and browser chrome remain application concerns.

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
descendants resolve `rem` against that computed root size. One top-level
cancellation signal is passed through style resolution, box generation, text
search indexing, layout, display-list construction, and cell rasterization.
Terminal rows, columns, color capability, and Unicode capability do not enter
layout. Text metrics, advances, grapheme boundaries, and fixed-point inputs are
validated at their subsystem boundaries; malformed values produce typed
rejection rather than escaping as unsafe geometry.

The UI derives one shared set of media and terminal preferences for interactive
and one-shot rendering. `COLORFGBG` and the `VERGE_COLOR_SCHEME` override select
the preferred color scheme; `VERGE_REDUCED_MOTION` selects reduced motion.
Terminal Unicode, ambiguous-width, and color-depth capabilities remain confined
to `TerminalRenderContext`.

## Layout fragment and line-box contracts

Each layout fragment records its stable fragment ID, formatting node, document
node, pseudo-element identity, content/padding/border/margin rectangles,
overflow and clip rectangles, child fragments, source ranges, used font metrics,
baseline, intrinsic contributions, visual order, paint order, action identity,
and semantic identity. One formatting box may produce several fragments.

Each immutable line box records its CSS rectangle, baseline, ascent, descent,
logical item range, break cause, source-linked text fragments, resolved
embedding levels, bidi runs, and visual runs. One logical inline-item stream is
built across inline box boundaries. CSS white-space processing and UAX #29
grapheme boundaries precede UAX #9 paragraph resolution and UAX #14/CSS break
opportunities. Layout selects logical lines from fixed-point advances, applies
the UAX #9 per-line reset and reordering rules, and then creates visual runs.
The terminal display list consumes those visual runs; it does not reorder text.

Replaced boxes, form controls, `inline-block`, `inline-table`, `inline-flex`,
and `inline-grid` boxes are atomic inline boxes. Their inner formatting context
is laid out independently and their resulting margin box participates once in
the containing line box. Splittable inline boxes retain per-line continuation
geometry for background and border painting.

Work-budget exhaustion finalizes open ancestors and keeps a connected
source-order layout-fragment prefix. Completed fragments are never cleared.

## Terminal contracts

`TerminalDisplayList` contains ordered background-fill, border-side, and text
paint commands. A box's background and supported border sides precede its
in-flow descendants; later siblings retain source order. Commands retain
clipping, source ranges, styles, action and semantic identities, and
formatting/document/layout-fragment identities. Border sides keep their actual
box-edge coordinates before clipping, so a saturated or far-offscreen side is
never moved onto the retained cell-buffer boundary.

`TerminalCellBuffer` contains final rows, grapheme-owning cells, style spans,
and identity-bearing cell spans. Adjacent graphemes in one text command snap
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

The hit-test index comes from clipped action-bearing content, padding, and
border geometry; every retained region has a stable routing identity. The
focus map comes from document semantics and may retain a
focusable target with no current rectangles. Accessibility bounds aggregate
visible layout geometry once per semantic document node and may be empty for an
intentionally clipped node. Scroll anchors use layout positions. Only search
cell spans depend on surviving text paint. Logical search
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
- Display-list construction consumes layout fragments.
- Cell rasterization consumes terminal paint commands.
- Search consumes logical text; line placement and painting consume visual
  runs. No reordered search string or row-based search path exists.
- Unicode property lookup is pinned to Unicode 17.0.0 and never depends on the
  host ICU or operating-system Unicode version.
- Budget, cancellation, unsupported, rejected, and truncated behavior is typed;
  control flow never matches diagnostic prose.
