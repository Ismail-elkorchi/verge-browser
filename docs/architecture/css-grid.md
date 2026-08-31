# CSS Grid layout

Verge implements CSS Grid for `horizontal-tb` writing mode through internal
style, box-tree, intrinsic-sizing, and layout contracts. These contracts are
not exported from the package root. There is no former simple allocator or
terminal-cell Grid path.

## Property contracts

`src/presentation/style/grid/` consumes CSS-parser component trees and stores
typed computed values for:

- explicit row and column track lists, including line-name groups, fixed
  `repeat()`, `auto-fill`, and `auto-fit`;
- fixed lengths and percentages, `auto`, `min-content`, `max-content`, `fr`,
  `minmax()`, and `fit-content()` track sizing functions;
- rectangular `grid-template-areas` and their generated `-start`/`-end` lines;
- auto, positive/negative integer, named, integer-span, and named-span
  placements;
- implicit track sequences, row/column sparse or dense flow, gaps, item
  alignment, and content alignment.

The `grid-template`, `grid-column`, `grid-row`, `grid-area`, `place-items`,
`place-self`, `place-content`, and `gap` shorthands share their longhand
parsers. The separate `grid` shorthand remains unsupported because its complete
grammar is not implemented. Invalid rectangles, zero lines, non-positive spans,
flexible `minmax()` minima, invalid auto-repeat forms, `subgrid`, and masonry are
rejected rather than changed to auto placement. The style-owned
implementation-support evaluator calls these same parsers for `@supports`.

## Explicit and implicit grids

An `ExpandedGridAxis` contains the explicit track sizing functions, every line
name at its structural line, a name-to-lines index, and auto-fit candidates.
Named areas contribute generated line names. Definite placements, spans, and
auto-placement may extend before or after that explicit axis. A
`GridTrackSequence` inserts the repeating `grid-auto-columns` or
`grid-auto-rows` sizing sequence around the explicit tracks and records the
explicit-track offset. Empty auto-fit tracks collapse only after placement has
identified which explicit tracks are occupied.

Expansion is checked before allocating large arrays. Definite available inline
size and gaps determine automatic repeat counts; an indefinite size produces
one bounded repetition.

## Placement

Placement consumes Grid items in order-modified document order with source
order as the stable tie breaker. It commits both-axis definite items first,
then major-axis definite items, then cursor-positioned items. Row and column
flow each support sparse and dense packing. Sparse locked-row/locked-column
placement retains one frontier per definite row/column, including spans; dense
placement restarts at the earliest implicit-grid line. Definite overlaps remain
overlaps.

One placement normalization contract handles longhands, shorthands, ordinary
Grid items, and absolutely positioned Grid descendants before line lookup. It
swaps reversed resolved lines, removes an equal end line, discards an end-side
span when both sides are spans, and converts a remaining named-only span to an
unnamed span of one only when it has no definite line from which to search.

Occupancy is stored as sorted, merged column intervals keyed by row. Vacancy
queries and interval insertion consume placement work and check cancellation;
the engine never allocates a dense row-by-column matrix. Resolved placements
retain formatting-node identity, source order, `order`, and half-open row and
column line ranges.

## Intrinsic contributions and track sizing

`src/presentation/layout/intrinsic/` provides cycle-aware, bounded cached
content-box and border-box min-content/max-content inline contributions,
minimum/maximum block contributions, automatic minimum sizes, and percentage
dependence. Text uses the existing grapheme, line-break, white-space, and
CSS-pixel text-metrics contracts. Controls, replaced boxes, block, flex, Grid,
and the currently supported table slice contribute without invoking terminal
painting. Nested Grid can therefore size a parent Grid directly.

For each axis, track sizing retains finite or infinite growth limits and
initializes fixed and intrinsic sizing functions separately. It resolves all
span-one contributions before increasing-span groups. Every spanning phase
computes item-incurred increases from the pre-phase track state, distributes to
affected and then eligible non-affected tracks, applies beyond-limit priorities,
and commits only the maximum planned increase after every item in the group has
been examined. The temporary infinitely-growable state is scoped to the
intrinsic-maximum and following max-content-maximum phases. Items crossing
flexible tracks are processed together.

Maximization freezes tracks at finite growth limits. Flexible sizing uses the
normative repeated-freezing `fr` calculation for definite and indefinite space,
including factors below one; there is no remainder-filling allocator. Stretch
then expands only eligible non-collapsed auto tracks. Each boundary stores
whether its gutter is active, so either adjacent collapsed auto-fit track
collapses that gutter for sizing, alignment, area geometry, and positioned
containing blocks. Column tracks are resolved before row intrinsic
contributions so text wrapping at the used column width affects row sizing.

All geometry is deterministic 26.6 fixed-point CSS pixels. Definite and
indefinite percentage bases remain distinct; no terminal row or column enters
track sizing.

## Item layout, positioning, and painting

Each in-flow Grid item receives the content box of its resolved grid area as a
containing block. Width/height, min/max constraints, box sizing, margins,
automatic margins, `justify-self`, `align-self`, container defaults, stretch,
and the supported baseline cases resolve there. Stretch performs descendant
relayout, including text wrapping and percentage-dependent descendants.
Container content alignment distributes surplus space independently on the row
and column axes. Alignment values retain their overflow mode: explicit `safe`
falls back to start on overflow, while explicit `unsafe` preserves negative end
or center offsets. Automatic margins resolve before self-alignment, and stretch
is limited to stretch-eligible subjects.

`src/presentation/layout/grid/container-layout.ts` owns complete Grid
formatting-context orchestration. Grid intrinsic orchestration is adjacent in
`intrinsic-layout.ts`; the generic layout builder supplies only a narrow host
for child layout, intrinsic queries, used-value resolution, fragment
translation, positioned layout, cancellation, and budgets.

An absolute Grid descendant does not enter placement occupancy or track sizing.
When both applicable lines resolve, its Grid area establishes its positioned
containing block; an auto or unresolved axis falls back to the container
padding box. Fixed descendants keep the initial-containing-block rules.

Grid item children are stored in order-modified paint order. Static Grid items
with integer `z-index`, positioned descendants, overlaps, negative/auto/positive
stack levels, actions, semantics, focus rectangles, accessibility bounds, and
search spans all use the existing layout-owned stacking metadata. Display-list
and terminal code do not inspect Grid properties.

## Work limits and unsupported boundaries

Default Grid limits are 100,000 items, 2,048 explicit tracks, 4,096 implicit
tracks per axis, 250,000 retained occupancy intervals, 2,000,000 placement
steps, 250,000 named-line resolutions, 2,048 auto-repeat tracks, and 2,000,000
track-sizing work units. Every scan checks cancellation. A Grid whose placement
or sizing cannot be committed produces the exact typed layout truncation while
already finalized unrelated page fragments remain reachable.

The current boundary excludes subgrid, masonry, vertical writing modes,
fragmentation, and complete graphical-browser paint fidelity. Complete table
intrinsic sizing, cell spans, captions, row-height distribution, and collapsed
borders remain the recommended next layout milestone.
