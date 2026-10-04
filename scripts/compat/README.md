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

## Complete painted-text evidence

Paint recall requires every meaningful grapheme of one complete occurrence of
an expected phrase to survive in the cell buffer. The assertion joins all
viewport windows and verifies formatting-node identity, document-node identity,
logical content intervals, decoded-source intervals, and the actual row text.
It does not accept one surviving highlight, combine partial occurrences, or
count a same-looking glyph owned by another source. Unicode grapheme sequences
and odd-level bidi mirroring are checked without relying on visual reading
order. Reports include each missing grapheme and its source interval.

`font-size:0` is a separate suppression measurement: its logical source is not
a missing-visible-text failure, but any painted glyph from that source fails.
The reduced terminal fixtures exercise positive 1/8/14/16/24/32px sizes,
line breaks, short viewport windows, inline boundaries, wide/combining/emoji
text, links, and zero-sized parents with restored children. Controlled exact
line-text assertions detect invented spaces as well as missing letters.
Paired split/unsplit fixtures must retain identical painted rows, cell styles,
and action destinations. Explicit compact line-height remains an intentional
overlap fixture rather than being silently reclassified as text loss.

Some original fixtures deliberately occlude or place text beyond the horizontal
viewport. Only those authored cases have `expected.paintExceptions` (or
`paintExceptionsByVariant`), each with a reason and mandatory visible fragments.
A visible fragment can specify `{ "text": "...", "within": "element-id" }` to
require the surviving source to belong to that exact subtree. Logical recall
still requires the full original phrase. These declarations are reported, not
a global allowance for incomplete phrases.

## Differential oracle checks

The existing Chromium oracle uses the same narrow/medium/wide variants (including
fixture overrides), CSS viewport size, screen/light environment, and HTTP page
URL as the native harness. HTML and all declared stylesheet bytes are
checksum-verified and fulfilled offline at their real fixture URLs; undeclared
requests are blocked. Redirect and transport-encoding evidence is retained.
Text collection walks text nodes, including mixed text before/after inline
children, and preserves adjacency across split inline elements.

The report compares Chromium's layout-visible DOM text with complete native
painted-source evidence. This is not a pixel-occlusion oracle. Explicit
`oracle.styles` assertions compare controlled computed values;
`oracle.geometry` compares declared rectangle properties with a specified
CSS-pixel tolerance. Normal text geometry is intentionally not compared because
terminal cell metrics differ from Chromium font metrics. No pixel equality is
claimed. JavaScript-enabled inspection remains separate classification evidence.

Use `node scripts/compat/chromium-oracle.mjs --check` after building to reject
comparison failures. `--fixture=terminal-font-metrics` selects one fixture and
`--report=/path/to/report.json` chooses the report. If `playwright-core` is
installed outside this checkout, `PLAYWRIGHT_CORE_PATH` can identify its module
entry point. `CHROMIUM_EXECUTABLE` is still required; no browser or Playwright
package is added to production dependencies. A report without `--check` records
failures without changing the exit code.

Focused harness tests run with:

```sh
node --test test/control/compatibility-*.test.js
```

### Native form and accessible-name observations

The `form-semantics` fixture opts into `oracle.formSemantics` and
`oracle.accessibleNames`. Form observations include hidden inputs, parser-repaired
owners, explicit missing/non-form targets, forward references, option identities
and selectedness, sanitized input values, and ordered native `FormData` entries
for each form and eligible submitter. Nodes are keyed by document-order element
position, so duplicate authored HTML IDs never alias observations. Entries are
compared before URL-encoded CR/LF conversion; exact request bytes are covered by
form unit tests.

`data-oracle-name` marks controlled accessible-name targets. Chromium names come
from CDP `Accessibility.getFullAXTree`, joined to `DOM.getDocument` backend node
IDs. No handwritten JavaScript accessible-name algorithm supplies expected names.
A missing CDP observation fails opted-in checks rather than silently passing.
The existing hosted release-qualification job installs the isolated browser and
runs these checks; browser packages remain outside runtime dependencies.

With the optional browser dependencies configured above, run the focused check
against a current build:

```sh
node scripts/compat/chromium-oracle.mjs --fixture=form-semantics --check
```

Browser form observations read native DOM properties and `FormData`; they do not
reuse Verge's ownership, selection, sanitization, or request-entry algorithms.
Generated counters need separate evidence: CSSOM `content` strings do not prove
painted labels. `test/control/generated-content.test.js` checks independently
expected labels and exact destinations for all 21 captured Wikipedia return-link
identities at 80/120/160 columns, including source/pseudo and nonempty paint,
hit, and focus geometry.
