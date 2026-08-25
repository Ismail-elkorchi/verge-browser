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

`LayoutContext` carries that viewport, the initial containing block, root font
metrics (including ascent, descent, baseline, x-height, line gap, and `ch`
advance), the CSS-pixel text measurer, budgets, and cancellation. Terminal rows,
columns, color capability, and Unicode capability do not enter layout.

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
logical text fragments, and visual-order slots. Verge currently preserves
logical text order and does not claim a Unicode bidi implementation.

Work-budget exhaustion finalizes open ancestors and keeps a connected
source-order layout-fragment prefix. Completed fragments are never cleared.

## Terminal contracts

`TerminalDisplayList` contains ordered text and border paint commands. Commands
retain clipping, source ranges, styles, action and semantic identities, and
formatting/document/layout-fragment identities.

`TerminalCellBuffer` contains final rows, grapheme-owning cells, style spans,
and identity-bearing cell spans. Its colors are actual values quantized to the
terminal color depth. Later paint order wins a cell collision. The
hit-test index and focus map use visible painted cells; accessibility bounds
aggregate visible descendant geometry and every contributing layout fragment
by semantic document node. Logical search
matches are projected through layout text fragments and only then into cell
spans, so match identity survives wrapping, resize, and cell-metric changes.

## Invariants

- CSS `display`, not an HTML-tag switch, determines box participation.
- Formatting nodes and layout fragments retain document identities and source
  ranges; no layer reconstructs semantics from rendered text.
- Computed styles contain no terminal rows or columns.
- Layout fragments contain no terminal cells, ANSI styles, or terminal-ui types.
- Display-list construction consumes layout fragments.
- Cell rasterization consumes terminal paint commands.
- Budget, cancellation, unsupported, rejected, and truncated behavior is typed;
  control flow never matches diagnostic prose.
