# HTML/CSS table layout

Verge implements HTML and CSS tables for `horizontal-tb` writing mode through
one document-owned HTML table model and one layout-owned CSS table slot grid.
These are deliberately distinct: the HTML table model owns author markup,
source-order semantics, and header assignment, while the CSS slot grid owns
generated table boxes and used geometry. One fixed algorithm, one automatic
algorithm, one row-sizing algorithm, and one collapsed-border algorithm consume
those contracts. Table internals are absent from the package root, and terminal
code never builds slots, resolves spans, sizes tracks, or chooses borders.

## Standards profile

HTML slot construction and header assignment follow the WHATWG table model at
commit `778afd942c67b78335a4becc28c1c725a25d1cab`, extended only by the explicit
transitive same-table `th` context required by Verge's accessibility contract.
Fixed layout follows CSS 2.2. Automatic width distribution, base/reference row
sizing, rowspan distribution, and collapsed-border geometry follow the current
CSS Tables algorithm where the focused WPT adaptations pinned at
`ef1cea845d70fb84127ff0e1aff2eeda7064f682` and current browser behavior agree.
The exact upstream paths and terminal adjustments are recorded in
`test/fixtures/wpt-table-provenance.json`. In particular, the selected current
row-sizing profile ignores authored row-group heights; an older tentative WPT
expectation is not retained as an engine rule.

## Ownership

- `src/document/table/` builds an immutable sparse HTML table model containing
  logical row and column slots, cell origins, covered slots, downward-growing
  cells, row and column groups, captions, source order, and typed structural
  errors. It assigns `scope`, explicit and transitive `headers`, header blocks,
  opaque headers, and `abbr` labels. Hostile numeric attributes are normalized
  before they can influence allocation.
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

## HTML table model and CSS slot grid

`HtmlTableMetadata` never depends on computed CSS or rendered geometry. Its
header assignment covers both `td` and `th` targets, restricts explicit IDs to
same-table header cells, expands transitive references with cycle detection,
and preserves stable source-defined order. Directional automatic scans retain
header blocks and make a completed block opaque after an intervening data cell.
Nested tables remain independent. Descendant links and controls inherit their
owning cell's header context without deriving semantics from painted text.

`TableSlotGrid` is immutable. It retains row and column tracks, row and column
groups, cell origins and half-open spans, covered slot intervals,
downward-growing `rowspan=0` cells, anonymous missing-cell intervals,
out-of-flow descendants, structural errors, and source and formatting
identities. Sorted intervals represent occupancy; layout never allocates a
dense matrix from an author-supplied span.

CSS row display order places only the first table-header-group before the other
rows and only the first table-footer-group after them; additional header and
footer groups behave as ordinary row groups. This display sequence drives slot
construction, first-row fixed sizing, row geometry, border adjacency, and
background painting without changing document reading order. HTML spans are
bounded to their HTML limits, `rowspan=0` extends only through its row group,
overlaps remain typed structural errors, and missing cells remain bounded slot
intervals rather than fabricated document semantics.
The layout engine caches this immutable grid once per formatting table for the
duration of a render. Intrinsic queries, nested-table contributions, and final
layout therefore consume the same topology and charge `maxTableRoots` once per
actual table root rather than once per measurement pass.

## Column and row sizing

The automatic algorithm obtains cell minimum and preferred border-box widths
from the shared intrinsic-sizing subsystem. Each column retains originating
`col`, containing `colgroup`, cell, calculated length-percentage, intrinsic
percentage, min/max, border/padding, collapse, and source-order constraints.
A column-group constraint applies to the combined tracks it spans. Spanning
deficits are grouped by span and planned from an unchanged phase snapshot, so
equivalent cells produce source-order-independent measures. Final distribution
uses minimum, percentage, specified, preferred, and excess-width sizing
categories; it does not apply a generic equal share. Cumulative percentages are
resolved in logical column order, including totals above 100 percent and RTL
physical placement. An automatic-width table uses table min-content,
max-content, caption minimum, and shrink-to-fit bounds.

Fixed layout applies only when the table has a definite width. Non-auto column
constraints take precedence, followed by applicable first displayed-row cell
constraints with internal spacing or collapsed-border geometry removed.
Remaining columns divide remaining width; resolved constraints may grow the
grid beyond the declared table width, and only then is excess width distributed.
Later rows cannot change track widths. An indefinite table uses the sole
automatic algorithm—there is no equal-width fallback.

Columns are finalized before rows. Cell content is measured at its final span
width, so wrapping contributes the correct minimum row height. Nonspanning
cells establish mandatory row minimums and baseline ascent/descent. Rowspan
deficits are grouped by increasing span and planned from base/reference row
sizes before any increase is committed. Authored row-group heights are ignored
by the selected current CSS Tables algorithm. A definite table height may add
space after row minimums are known, but never reduces a row below cell content.
Cells are then laid out again against final containing blocks so descendant
percentages, wrapping, overflow, baselines, and vertical alignment are current
rather than rectangle translations around stale descendants.

## Captions, borders, direction, and semantics

Top and bottom captions remain outside the table root border box and inside the
table wrapper. Several captions retain source order and contribute to wrapper
geometry. In RTL horizontal flow, physical columns run from inline-start while
logical reading, search, and accessibility order remain document-based.

Separated borders keep track breadth distinct from horizontal and vertical
border spacing, including spacing at the grid edge. `empty-cells: hide`
suppresses eligible empty-cell background and border painting. Collapsed
borders suppress table-root padding and border spacing before geometry is
calculated. One complete edge graph retains perimeter and missing-slot edges as
well as row, column, group, and span boundaries. Candidates from table, column
group, column, row group, row, and cell boxes resolve `hidden`, `none`, style,
width, origin, logical position, direction, and source-order precedence.
Connected span conflict sets are harmonized before one layout-owned paint
segment is generated per visible section. Half of the winning border contributes
to each adjoining box, with external perimeter halves included by the wrapper.
The display-list builder emits these segments and never recalculates conflicts.

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
