# HTML/CSS table layout

Verge implements HTML and CSS tables for `horizontal-tb` writing mode through
one internal slot model and one table layout engine. Table internals are not
exported from the package root, and terminal code never builds slots, resolves
spans, sizes tracks, or chooses collapsed borders.

## Ownership

- `src/document/table/` indexes HTML-only `colspan`, `rowspan`, `col` and
  `colgroup` spans; row and column group ownership; captions; `scope`,
  `headers`, `abbr`, and ID-based header relationships. Hostile numeric
  attributes are normalized before they can influence allocation.
- `src/presentation/style/table/` parses the computed table-layout,
  border-collapse, border-spacing, caption-side, empty-cells, side-specific
  border, and applicable visibility values. The implementation-support
  evaluator calls the same parsers used by the cascade.
- `src/presentation/formatting/table/` applies CSS table box fixup and creates
  table wrappers, roots, captions, column groups, columns, row groups, rows,
  cells, and required anonymous internal boxes. A CSS-created table cell keeps
  spans of one and never acquires HTML header semantics.
- `src/presentation/layout/table/` owns the sparse slot grid, intrinsic column
  measures, automatic and fixed width distribution, row and rowspan sizing,
  captions, separated-border geometry, collapsed-border conflict resolution,
  positioned descendants, final overflow, and table paint metadata.

## Slot grid and spans

`TableSlotGrid` is immutable. It retains row and column tracks, row and column
groups, cell origins and half-open spans, covered slot intervals,
downward-growing `rowspan=0` cells, anonymous missing-cell intervals,
out-of-flow descendants, structural errors, and source and formatting
identities. Sorted intervals represent occupancy; layout never allocates a
dense matrix from an author-supplied span.

Cells are inserted in source order. HTML spans are bounded to their HTML
limits, `rowspan=0` extends only through its row group, overlaps remain typed
structural errors, and spans may introduce columns. Missing cells are retained
as bounded slot intervals rather than fabricated document semantics.

## Column and row sizing

The automatic algorithm obtains min-content and max-content border-box
contributions from the shared intrinsic-sizing subsystem. Span-one cells,
columns, column groups, percentage constraints, and min/max constraints
establish column measures. Spanning deficits are grouped by span and planned
before they are committed, so equivalent cells produce source-order-independent
measures. An automatic-width table uses its min-content and max-content bounds
to shrink to fit the available inline size.

Fixed layout applies only when the table has a definite width. Column and
column-group widths and applicable first-row cell widths constrain tracks;
later rows cannot change them. Remaining width is distributed after those
constraints. An indefinite table uses automatic layout—there is no equal-width
fallback.

Columns are finalized before rows. Cell content is measured at its final span
width, so wrapping contributes the correct minimum row height. Nonspanning
cells establish row minimums; rowspan deficits are distributed by increasing
span. Definite table and row-group heights are then distributed, and cells are
laid out against the final containing blocks so descendant percentages,
wrapping, overflow, baselines, and vertical alignment are current rather than
rectangle mutations around stale descendants.

## Captions, borders, direction, and semantics

Top and bottom captions remain outside the table root border box and inside the
table wrapper. Several captions retain source order and contribute to wrapper
geometry. In RTL horizontal flow, physical columns run from inline-start while
logical reading, search, and accessibility order remain document-based.

Separated borders keep track breadth distinct from horizontal and vertical
border spacing, including spacing at the grid edge. `empty-cells: hide`
suppresses eligible empty-cell background and border painting. Collapsed
borders use one edge grid. Candidates from table, column group, column, row
group, row, and cell boxes resolve `hidden`, `none`, style, width, origin, and
source-order precedence into one used segment; mismatched spans split shared
edges without duplicate paint commands. The result affects intrinsic measures,
cell containing blocks, final geometry, and paint.

Document-owned semantics retain table, rowgroup, row, cell, columnheader,
rowheader, and caption-derived naming. Explicit `headers`, all supported
`scope` values, and applicable implicit associations map document identities,
not painted text. Links and controls inside cells retain their ordinary action,
focus, hit-test, search, and accessibility geometry.

## Work limits and boundaries

Default limits are 1,024 table roots; 25,000 row groups and column groups;
100,000 rows and cells; 4,096 columns; 250,000 slot and anonymous-missing-cell
intervals; 1,000,000 colspan, rowspan, and header-association work units;
2,000,000 intrinsic, column-distribution, row-distribution, and
collapsed-border-candidate work units; and 500,000 retained collapsed-border
segments. Every repeated scan checks cancellation. Exhaustion reports the exact
table-owned budget while preserving finalized unrelated layout fragments.
HTML table metadata additionally admits only complete table records within a
250,000-unit document-owned slot-work limit and a 1,000,000-unit
header-association-work limit; an incomplete current table is discarded while
metadata for earlier tables remains coherent and reachable.

The current boundary excludes vertical writing modes, pagination and
fragmentation, raster image decoding, web fonts, and complete graphical-browser
paint fidelity. Supported terminal borders are `none`, `hidden`, and `solid`;
other border styles remain typed unsupported rather than approximated.
