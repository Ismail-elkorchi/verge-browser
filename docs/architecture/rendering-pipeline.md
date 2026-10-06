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

Interactive startup is admitted by terminal-ui before page acquisition or frame
publication. Its automatic policy distinguishes assumptions from observations and
rejects known hazards or contradictory evidence. Browser chrome and page controls
keep the session-owned native text adapter. Graphics capability selection is
independent; failed text admission never selects a raster/ASCII/one-shot fallback.
Page diagnostics read the running TUI context rather than probing the terminal
again. See [Unicode text layout](./unicode-text.md) for presentation and restoration
ownership.

## Ownership

- `src/document/` alone imports the HTML parser. It owns node identities,
  source ranges, semantics, indexes, canonical control state, and typed document
  actions. Parser-produced form associations are translated during indexing;
  absence means no owner, with no ancestor or form-ID fallback.
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
  store. Rendering performs no application network or filesystem operations, and
  the protocol supplies no session, cookie, or file capability. A Node worker is
  not an operating-system sandbox. The main `src/ui/`
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

Device geometry enters layout through the CSS viewport and text measurer:

```text
viewport width  = terminal columns × cell width in CSS pixels
viewport height = terminal rows × row height in CSS pixels
```

`LayoutContext` carries that viewport, the initial containing block, CSS-pixel
text and native-control measurers, and layout budgets. The output adapter measures
controls through the same component factory used to mount them; layout consumes
only CSS-pixel sizes and the measurer's dependency identity. Layout asks the text
measurer for font
metrics (including ascent, descent, baseline, x-height, line gap, and `ch`
advance) after style resolution. The terminal measurer supplies realizable
fixed-cell advances and normal line metrics rather than scaling physical glyphs
with CSS font size. Used `ex` lengths use x-height independently of `ch` advance.
In computed font-size/line-height values and media queries, `ex` and `ch` use the
`0.5em` fallback where selected-font metrics are unavailable. Scalar and math
lengths share these rules. The root
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

`RenderArtifactStore` retains narrow, independently owned phase resources for
computed styles, formatting, inline/bidi analysis, logical search, layout,
display commands, spatial indexes, and semantic geometry. Source and stylesheet
programs belong to the attachment. A `DocumentRenderArtifacts` value is a
short-lived composition for an operation, not a retained cache root. Reuse
returns only the requested phase, so retaining formatting cannot retain an
obsolete layout through a composite analysis.

Canonical logical-text units, bidi items and levels, search segments, layout
cluster selections, and paint descriptors use compact indexed storage. Decoded
records are temporary views rather than retained object copies. Layout clusters
refer to canonical logical source identities; paint descriptors refer to layout
fragments and paint-specific selections. Fixed-size numeric pages are charged
before allocation, including spare capacity and owner metadata, and participate
in cancellation, rollback, and independent retained-cost recounting. This changes
storage, not source offsets, text ordering, or rendering admission limits.

Retention is cost-bounded (512 MiB by default), uses phase-ordered eviction with
least-recently-used eligible resources, and bounds style environments, logical
queries, and layout search
projections. Scroll, search query, active match, and terminal color depth are not
normal-flow analysis dependencies. There is no scroll-keyed complete render
result. Replacing a source, releasing a tab, or disposing the worker releases its
programs, selector sessions, substitution caches, resources, and searches.
Attachments are charged before analysis.

Private allocation roots are registered through weak ownership metadata.
Immutable shared allocations are charged through explicit owner dependencies;
unknown sharing is counted conservatively. Mutable formatting action/paint/semantic
caches and stream bidi caches are separately owned and remeasured after growth,
clear, or rollback, even when their containing wrapper is frozen. The construction
visit ledger uses weak allocation keys; numeric accounting records do not keep
retired object graphs alive. Metadata is charged, string deduplication is scoped
to measurement, and an independent uncached graph recount remains available for
qualification. Verified stylesheet syntax sharing is registered at its actual
ownership boundaries rather than through dense descendant aliases. External
parser sessions expose counts, so their index/validation costs remain estimates.

Before replacement construction, the store pins reusable requested phases and
retires eligible obsolete layout/display/spatial/geometry resources and
layout-specific search projections. Packed construction reserves each new page
and its metadata before allocation, then exchanges that reservation for committed
phase ownership; it does not reserve a second estimated copy of the old layout.
It preserves reusable upstream work and authoritative state. Reservations and
rollback bookkeeping do not hold retired analyses. Failure may leave derived
phases nonresident for later rebuilding; pins and reservations are released on
every exit. The same pressure path trims optional program caches, including the
selector runtime's computed-style baseline. Viewport composition and summary
extraction share one pinned internal operation.

Admission has no exemption for the newest resource set. If eviction cannot satisfy
the retention budget, it returns a typed `RenderBudgetExceededError`. Pressure
clears optional program caches before resource eviction so they cannot keep an
evicted computed snapshot alive. Cleanup has reserved queue and transfer capacity ahead of ordinary work.
The client separately bounds pending transfer allocations,
delivered viewports, committed viewports, and summaries to 64 MiB. The default
worker working-set budget is 1 GiB, observed as heap plus external allocations at cancellation checkpoints with a
Node worker heap limit as an additional termination boundary. Allocation peaks
and retained heap after forced GC are reported separately. A rejected analysis
preserves the last committed viewport; it does not reduce HTML/CSS support.

The UI keeps one resident worker source family per tab. It attaches decoded HTML,
verified stylesheet syntax, immutable resource metadata, and document state when
the live source changes, is absent, or the worker restarts. A same-source
activation advances the document-revision fence through `update-document-state`
without HTML hydration or stylesheet parsing/compilation. Subsequent messages
carry document, state, and viewport revisions plus request IDs. The UI
rejects stale completions; viewport generations are latest-request-wins. Heavy
style, box, text, layout, display-list, geometry, and raster artifacts stay in
the worker. Only compact document extent, focus, and anchor summaries plus the
requested viewport rows and visible indexes cross back to the UI.

Static image resources use the same accepted-document boundary. Acquisition
discovers metadata without delaying document publication for downloads. One
active-document subscription awaits reliable resource completions; switching
tabs aborts its work and waits for decoder termination before the next tab can
allocate decoder workspace. Decoded pixels remain in accepted UI snapshots;
the render worker receives resource identities, natural dimensions and alpha
presence only, never decoded pixels.
The existing retained-history budget includes image ownership, and a separate
64 MiB UI bound includes decoded storage, live terminal rasters and pending
preparation. One active URL pool admits at most 32 img and CSS artwork resources.
Acquisition waits for the first accepted viewport. Discovery consumes existing
spatially queried paint commands, including pending-mask commands, rather than
rescanning document fragments on scroll. Visible img and artwork alternate
priority when oversubscribed; they displace lower-priority offscreen resources
without creating another loader or pixel cache. URL/order changes advance the
source generation, so stale completions cannot enter a replacement pool even
when its size is unchanged or a URL reenters. Owner-only and readiness changes
do not restart acquisition; current CSS owners replace earlier viewport owners.
Evicted img intrinsic dimensions remain metadata-only evidence keyed by the
immutable document's source URLs, preserving layout and anchors without keeping
evicted pixels or dynamic CSS URL history. The existing document source index
validates owners; admission does not rebuild a second source manifest.

Natural dimensions participate in shared replaced-element sizing. Layout
records whether it consumed them, so fixed-size image metadata updates retain
layout, computed styles and logical search. Canonical image paint operations
produce bounded visible cell clips in normal paint order. UI image slots retain
native-control ordering and pointer ownership. Ready pixels are substituted
only into placements with matching accepted natural dimensions. Raster handles
are prepared at asynchronous resource/viewport completion boundaries; rendering
only looks them up. Transparent and tinted artwork needs an immutable viewport
binding proving its backdrop and protected native-cell coverage. A rejected
candidate cannot replace an accepted binding. Failed uploads or unsupported
terminals retain semantic image alternatives. The pipeline does not implement
CSS subtree masks, partial group opacity or alpha-over-native-text compositing,
and never rasterizes document text.

Every viewport names its required summary identity and layout revision. A
summary contains document extent, scroll anchors, and logical focus order. The
client caches a summary on receipt, even when the UI subsequently rejects that
viewport. Each request acknowledges the summary identity actually held by the
client. The worker sends a summary whenever that identity differs, including a
return to an earlier retained layout. The UI commits only a viewport accompanied
by its matching summary. Height-only changes with independent values reuse the
same layout and summary; document extent does not include an old viewport's
minimum height. Release, reattachment, and worker replacement discard delivery
state, so sending is never treated as acknowledgement.

Logical search results carry document revision, relevant state revision, query,
and search request generation. The client rechecks document attachment and
document/search generations after receiving a response: work completed before
cancellation can still arrive after a replacement request. Logical match IDs
contain no physical row. The bounded logical query cache has a separate
dependency on computed text values
and relevant control/disclosure state. It survives changes confined to fonts or
layout geometry, including viewport-derived fonts and geometry-only focus; anchors are
projected from those matches into the current layout revision. Resize and
geometry-affecting state changes invalidate physical anchors. Next/previous
navigation waits for current anchors. Find closure, query replacement, tab
switching, navigation, and shutdown invalidate pending search generations.
Search failures have their own revision-scoped completion path.

terminal-ui continues to serialize state transitions and frame commits. Its
effects send requests, await worker results, and dispatch typed completion
messages; neither `updateBrowser()` nor `browserView()` invokes browser
rendering. Worker failure keeps the last committed viewport, exposes an explicit
failed rendering state with a retry action, and never falls back to synchronous
UI-thread rendering. Ordinary scrolling does not implicitly restart a failed
worker. One bounded client queue admits at most 128 pending requests, coalesces
queued viewport/search requests, prioritizes cleanup and the selected document,
and posts one job at a time. Scroll replaces viewport work while useful cold
document analysis continues. A tab switch cancels the previous document's
uncommitted job at shared-atomic cancellation checkpoints. Completed artifacts
remain reusable; cancelled partial artifacts cannot enter the retained store.

Attachment and state preparation serialize within each document lifecycle.
Monotonic document/state revisions, lifecycle identity, and a worker epoch are
checked before and after every acknowledgement. A released lifecycle cannot be
resurrected by an older preparation. A request captures its prepared worker, so
an old epoch cannot address a replacement worker. Unexpected exits, including
code zero, settle all pending requests. Synchronous transport failures remove
the pending entry. Close is idempotent under concurrent callers: it first stops
admission, cancels all document/viewport/search generations and queued work,
then requests disposal. A 250 ms graceful deadline is followed by termination;
disposal never waits indefinitely behind cold rendering.

Workspace restoration creates placeholder tabs before navigation, starts the
TUI shell immediately, loads the active placeholder first, and restores
background tabs through one scheduler. Total live capacity is three; a selected
load takes the next available slot. New background loads start only when fewer
than two unselected loads are live. Previously selected loads retain their slots
after a switch, so another selection may wait for cleanup or completion. The
queue is bounded at 256. Selection promotes queued work without adding capacity. Cancelled live loads
remain accounted for until cleanup settles; queued cancellation prevents session
allocation. Background restoration starts after the selected page's first frame
or failure, including rendering failure. Background tabs are not rendered until
selected.

Browser-global actions and asynchronous completion routing precede the
selected-tab readiness gate. Omnibox editing/submission, tab management, quit,
applicable chrome, help, stop, and retry work in restoring/loading/failed states.
Viewport, search, navigation, and restoration completions route by their owning
tab and revisions. Browser-global library/download completions do not require a
document snapshot. Only document-specific operations consult readiness.

### Dependency invalidation

Document/state revisions fence requests; reusable phase identities record actual
semantic dependencies. Cascade evaluation compares effective element/pseudo
styles and private custom-property environments separately from diagnostics and
truncation. A true no-op advances the selector-state baseline and evaluation
freshness without rebuilding formatting, inline text, logical search, layout,
display/spatial indexes, or semantic geometry. Freshness is tracked per retained
media/viewport environment; evaluating one width cannot validate another.
Reporting-only changes receive a new summary identity without new geometry.
Control content, selectedness, and disclosure state independently invalidate
formatting even if CSS is unchanged.

Dependencies include admitted stylesheet fingerprints, consumed media features,
CSS viewport dimensions actually consumed by style or layout, and the terminal
text-metric profile. Scroll position, search query, active search
match, and terminal color depth are viewport dependencies and never invalidate
normal-flow layout. Media-query dependencies belong to the stylesheet program.
Computed-value dependencies are recorded from evaluated typed values, after
nested `var()` substitution and fallback resolution. Viewport-derived font sizes,
inherited computed values, and root-relative fonts therefore invalidate computed
snapshots in the consumed dimension. A width change still reuses CSS syntax,
selector compilation, and inline-style programs.

Used-value dependencies are separate: containing sizes, viewport units, fixed
positioning, and sticky constraints belong to layout. Unresolved containing-block
percentage dependence is conservative. A height change reuses immutable layout
when neither computed nor used values depend on it. Dynamic selectors that change
custom properties are reevaluated before semantic phase invalidation.
Ambiguous-width changes invalidate text measurement and layout, while color-depth
changes begin at cell rasterization.

An audited background-color-only change preserves formatting, logical text,
layout, and semantic geometry while rebuilding display/spatial paint data from
current computed styles through the shared paint resolver. Layout-specific search
projections depend on logical-text and layout identities, not paint identity.
Visibility, generated content, font metrics, border width/style, structural changes,
and unaudited dependencies (including `empty-cells:hide`) take the canonical
invalidation path.

Stylesheet resources retain verified parser syntax and dependency-graph
metadata rather than transport bytes. `StylesheetProgram` compiles selectors,
declarations, inline style attributes, layer position, and state dependencies
once. Selector sessions retain structural indexes and unchanged match sets.
Custom properties use persistent parent-linked environments; substituted
component values are materialized as a syntax tree with fresh tree-local parser
identities before validation. Validation is bounded by each program and uses
the css-parser validation session rather than reconstructing declaration
strings. Winning content/counter, font, and border candidates retain validated
component values through evaluation; unsupported literals and invalid substituted
winners keep their distinct cascade behavior.

Complete immutable computed box/text and resolved paint records are shared within
bounded construction transactions using typed field comparisons. Trusted unchanged
subrecords survive without cloning. The lookup is discarded afterward; there is
no permanent intern pool, whole-model JSON comparison, or shared mutable
node-specific counter state.

## Controls, generated content, and supported CSS values

Initialization, editing, reset, `:checked`, formatting, and submission consume one
document-domain control state. Authored defaults remain separate; select state
stores option identities rather than duplicated values. Default selection follows
display size and enabled options, and option-derived values collapse only ASCII
whitespace. Supported input sanitization is shared across initialization, edits,
and reset. Accessible names, visible captions, and submitted values are distinct;
a bounded text-equivalent implementation supplies supported labels, image alt,
and ARIA references. Worker hydration reproduces the same form associations and
control identities.

`app/forms.ts` constructs one ordered successful-entry list from those owners,
canonical state, and the selected submitter. Eligibility, duplicate names, empty
values, `_charset_`, and supported `dirname` behavior are handled there; UTF-8
URL-encoding and CR/LF normalization occur at serialization. Unsupported
contributing controls and incomplete indexing reject submission rather than
silently sending partial data. File/multipart submission remains unsupported.

Enter in a supported single-line input resolves implicit submission from the
same indexed form owner. The first submit button in document order is the default,
including externally associated controls; a disabled default is not skipped.
Without a submit button, submission requires at most one input that blocks
implicit submission. An unsupported default image submitter or incomplete
indexing is reported rather than replaced with another submitter. Textareas keep
Enter for editing.

Generated content is an immutable program distinguishing `normal`, `none`, empty
text, ordered visual items, and optional alternative text. The supported items
are decoded strings, `attr(name)`, `counter(name[, style])`, and
`counters(name, separator[, style])`. Visual items enter ordinary formatting,
logical search, layout, and painting with source/pseudo provenance. Alternative
text contributes to semantic names under DOM/ARIA precedence, without entering
visual search or painting.

One construction-local scoped counter owner handles `counter-reset`,
`counter-increment`, and `counter-set` in source/pseudo order. HTML list `start`,
`reversed`, and item `value` feed that owner. Absent and suppressed boxes/pseudos
and `display:contents` follow the supported participation rules; no full counter
map is retained per element. Work, live counter state, output size, and cancellation
are bounded. The suffix-free formatter supports decimal, decimal-leading-zero,
lower/upper-alpha (including Latin aliases), disc, circle, square, and none;
zero/negative alpha falls back to decimal and signed padding is explicit. Custom
counter styles, counter images, and quote-depth handling remain unsupported.

`list-style-position` belongs to the originating list item. Inside markers enter
its leading inline flow and intrinsic contributions; outside markers own a
separate text stream and do not enlarge the principal content width or height.
After content layout, an outside marker aligns with the first content baseline
at the LTR/RTL inline start, with a line-strut fallback for an empty item. The
supported `list-style` shorthand resets both type and position; unsupported image
or extra tokens reject the declaration. Built-in markers own their suffix, while
custom `::marker` content receives none.

The `font` shorthand competes with longhands through the ordinary cascade,
resets omitted modeled weight/style/line-height values, and resolves size before
dependent line height. Family syntax is validated but cannot select terminal
fonts; system-font keywords, variant/stretch effects, and angled oblique are
outside this subset. Logical block/inline border shorthands and width/style/color
longhands join physical-side ranked candidates after horizontal LTR/RTL direction
mapping and before winner selection. Vertical writing remains unsupported.

## Performance qualification

`npm run test:bench` writes `reports/incremental-rendering-bench.json`.
The [qualification report](./incremental-rendering-qualification.md) records the
corrected contracts, regression coverage, budget rationale, and separate visible
interaction and retained-memory measurements. Its
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
input-to-state update at 50 ms, main event-loop delay p95 at 16 ms, and shell
creation at 500 ms. The historical PR #136 measurement of the full 2,000-section
latency fixture used explicit 1 GiB retention and 2 GiB working-set bounds and
found about 569 MB retained after GC, exceeding the default 512 MiB admission
budget. The default rejection is tested separately;
no timing threshold or content limit is relaxed. Qualification also reports
input-to-visible-frame, tab-switch-to-usable-frame, and quit-to-complete-disposal
(the latter has a 1,000 ms gate). Full terminal frame-commit timing remains reported
separately because terminal output cost depends on the terminal host.

## Layout fragment and line-box contracts

Intrinsic sizing consumes canonical CSS-processed text across inline boundaries,
using the same grapheme, white-space, tab, and line-break rules as line layout.
Block, flex, Grid, and table contributions compose those runs with atomic boxes
and their own edges. The cache distinguishes ordinary constrained contributions
from flex content bases, which ignore the item's own preferred/min/max inline
size. Eligible width-independent text analysis survives resize; width-dependent
edges, atomic contributions, and changed text metrics require fresh analysis.

Each layout fragment records its stable fragment ID, formatting node, document
node, pseudo-element identity, content/padding/border/margin rectangles,
overflow and clip rectangles, child fragments, source ranges, used font metrics,
baseline, visual order, paint order, action identity,
and semantic identity. One formatting box may produce several fragments.

Each immutable line box records its CSS rectangle, baseline, ascent, descent,
logical item range, break cause, fragment identities, visual order, and visual
runs. Canonical text analysis owns bidi items and embedding levels; source,
action, and semantic identities remain on the referenced fragments rather than
being copied onto every line. Each inline formatting context
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

Sticky positioning uses its containing scroll owner and the sticky box's
containing block. Nested `overflow:auto`, `scroll`, and `hidden` boxes retain
independent scroll ownership; paint, controls, hit testing, and reveal use the
shared [scroll geometry projection](./scroll-geometry.md).

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
paint commands as packed references to canonical fragments, continuations, and
current paint styles. Spatial indexes retain numeric command IDs and decode
selected viewport commands; they do not retain a second command graph. A box's
background and supported border sides precede its in-flow descendants; later
siblings retain source order. Decoded commands expose clipping, source ranges,
styles, action and semantic identities, and formatting/document/layout-fragment
identities. Border sides keep their actual
box-edge coordinates before clipping, so a saturated or far-offscreen side is
never moved onto the retained cell-buffer boundary.

Canvas background selection uses current root styles, or the eligible HTML
body background when the root is transparent. `display:none` and paint
containment on the root or body prevent body propagation. The selected color fills the viewport
window independently of element geometry, scrolling, and hit testing; its source
element does not paint that background a second time. Canvas paint consumes the
ordinary command budget and refreshes during background-only style transitions
without stretching the body or rebuilding layout.

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
not segment, line-break, or run the bidi algorithm. A session-owned
`TextPresentation` adapter uses the same Unicode resolver for browser chrome and
native control text, retaining logical editor offsets while mapping visual cells.
Interactive startup and resume require qualified application-ordered LTR cells
and matching input coordinates. Mode-8 state does not prove character direction.
The TUI establishes a fresh owned screen after admission and restores the known
raw modes it changed on release; unknown state is not guessed from `TERM`. See the
[Unicode text contract](./unicode-text.md) for the host boundary and control
direction limits. Terminal emulators remain responsible for glyph shaping;
correct Arabic bidi order does not imply that Verge implements an Arabic
shaping engine.

Viewport paint admission checks replacement cost before removing earlier cell
owners, preserving the painted prefix when a new unit exceeds its budget.

Weak action-identity, paint-style, semantic-ancestor, and inline-analysis caches
register independent, revisioned mutable roots associated with their formatting
tree or inline stream. Growth and clear refresh costs; shared immutable
allocations are charged once through their owners.

Layout retains linked clip-owner chains. Clip translation follows the owning
fragment's attachment rather than rectangle containment; ancestor clips remain
independent of sticky descendants. Paint, focus, hit testing, and accessibility
resolve the same clip ownership against the current viewport. Each semantic
rectangle keeps its own layout fragment, including after other rectangles are
clipped out. Wrapped inline rectangles follow the individual continuations. Overflow clips
follow the positioned containing block; fixed boxes own a viewport clip. Explicit
CSS clips retain their ancestor ownership across these attachment boundaries.
This follows the [CSS overflow containing-block rule](https://www.w3.org/TR/CSS2/visufx.html#overflow).

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
  logical sides map after computed `direction` is known and before physical
  winner selection.
- Parser component-value trees—not whitespace or function regular expressions—
  drive custom-property substitution, CSS math, length-percentage values,
  colors, generated content/counters, Grid grammar, font/border values, and the
  supported layout shorthands. Used-value math remains in layout.
- Unicode property lookup is pinned to Unicode 17.0.0 and never depends on the
  host ICU or operating-system Unicode version.
- Budget, cancellation, unsupported, rejected, and truncated behavior is typed;
  control flow never matches diagnostic prose.
