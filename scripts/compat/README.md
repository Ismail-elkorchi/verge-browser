# Offline web compatibility corpus

The corpus contains independently authored, MIT-licensed structural fixtures
for articles, documentation, forums, search results, product listings, forms,
dashboards, responsive layouts, multilingual LTR and RTL content,
progressive enhancement, and script-dependent shells. `corpus.json` pins every
fixture and stylesheet source by SHA-256. The original twelve seed fixtures are
regressions, not evidence of broad web compatibility by themselves. Resource
fixtures add linked and embedded stylesheets, nested imports, redirects, cycles,
encoding evidence, base URLs, media/supports conditions, layers, and resource
budget rejection. Sixteen independently authored Grid fixtures cover responsive
product cards, named-area documentation, dashboard spans, sidebar placement,
RTL flow, overlap and z-index, auto-repeat reflow, positioned descendants,
nested grids, dense packing, staged intrinsic spanning contributions, sparse
locked-axis frontiers, placement conflict normalization, invalid grammar,
collapsed auto-fit gutters, and overflow alignment. Normal qualification
performs no network access. Nineteen independently authored table fixtures add
grouped financial headers, row and column spans, percentage and fixed columns,
automatic intrinsic columns, captions, separated and collapsed borders, RTL,
nested tables, tables inside Grid and Flex, actions, and collapsed tracks.
The five table-correction fixtures additionally cover transitive and opaque
header assignment, CSS header/footer display order, calculated column
constraints, order-independent rowspan planning, and complete collapsed-border
edge graphs.

Run `npm run compat:check` to build Verge, load every fixture through the same
`BrowserSession` resource path as the CLI, and render it through the
native document tree → computed style map → box tree → layout fragment tree →
display list → cell buffer pipeline. Each applicable fixture runs at narrow,
medium, and wide terminal widths; positioned-resource fixtures also run at a
nonzero scroll position. The report separately records logical meaningful-text
recall and source-linked painted-cell recall, semantic and action recall,
reading order, request contracts, unsupported CSS, resource failures,
determinism, Grid and table row/column/containment/span relationships, table
header associations, collapsed-border segment identity and uniqueness, and
every typed layout/display-list/cell-buffer truncation.

`compat:check` rejects any diagnostic not allowed by that individual fixture.
There is no global unsupported-feature allowlist.

`baseline-before.json` records the original seed-corpus measurement against
protected main and explicitly identifies the metrics that old harness did not
measure. `baseline-grid-before.json` pins the protected-main result immediately
before the Grid milestone; `baseline-after.json` records the 30-fixture,
88-variant native matrix after it. `baseline-table-before.json` measures that
protected main against the original 44-fixture, 130-case table corpus;
`baseline-table-after.json` records the corrected engine against the expanded
49-fixture, 145-case corpus. They are evidence,
not expected-output snapshots.

## Optional Chromium comparison

`npm run compat:oracle` is development-only. It requires the developer to set
`CHROMIUM_EXECUTABLE` and separately install `playwright-core`; neither is a
Verge dependency. The oracle disables page scripting and records meaningful
text, semantics, logical order, principal rectangles, computed display and
visibility, and stylesheet resources. Passing `--classify-script-required`
also records a separate scripting-enabled observation solely to classify
script-dependent pages. Chromium never enters the native rendering path.
