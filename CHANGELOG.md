# Changelog

All notable changes are documented in this file.

## Unreleased

- Add an offline, checksum-pinned, MIT-licensed compatibility corpus for
  articles, documentation, forums, search, commerce forms, dashboards,
  responsive pages, multilingual LTR/RTL content, progressive enhancement, and
  script-dependent shells. Record semantic recall, reading order, unsupported
  CSS, resource failures, truncation, and deterministic-rendering metrics; keep
  the optional local Chromium oracle development-only and out of dependencies.
- Build recursive stylesheet dependency graphs with import media, supports and
  layer conditions, cycle detection, depth-first cascade order, the existing
  page-resource security boundary, and explicit depth/source/byte/redirect/rule/
  edge budgets. Skip imports whose implementation-support condition is false,
  make parsed rules a stylesheet-source admission limit, and require complete
  dependency metadata for every internal stylesheet source.
- Implement normal and important cascade layers, unlayered author ordering,
  hierarchical nested and anonymous layers, element-attached declaration
  ordering, `revert`, `revert-layer`, implementation-backed
  `@supports`, and component-tree CSS values for structural `var()` fallback,
  `calc()`, `min()`, `max()`, `clamp()`, current color, and common RGB/HSL forms.
- Replace the initial flex slice with fixed-point flexible-length resolution,
  iterative freezing, automatic minimum sizes and margins, order, wrapping and
  wrap reversal, all four directions, cross-size stretching, baseline and
  multi-line alignment. Add relative, absolute, fixed and sticky positioning,
  positioned containing blocks, shrink-to-fit sizing, z-index paint buckets,
  blockification, out-of-flow flex/grid descendants, bounded flex sizing,
  block-formatting-context float exclusions, line shortening, and clearance in
  the layout subsystem.

- Pin Unicode 17.0.0 property data and conformance fixtures; add internal UAX
  #9 bidi paragraphs and embedding levels, UAX #14 line-break maps, and UAX #29
  extended grapheme clusters with deterministic offline generation checks.
- Move generated Unicode data and generic UAX primitives into the engine-neutral
  `src/unicode/` subsystem so the document tree never imports rendering code.
- Index HTML directionality; compute CSS `direction`, `unicode-bidi`, logical
  alignment, line-breaking, overflow wrapping, manual hyphenation, and inherited
  tab-size values;
  build immutable per-formatting-context inline-item streams across ordinary
  inline boxes before selecting source-linked visual runs and immutable line
  boxes. Search and layout consume the streams independently.
- Cascade physical and logical margin and padding declarations together, then
  map logical sides from computed horizontal `direction`. Preserve actual
  fragment identities and CSS tree paint precedence while bidi layout assigns
  visual geometry to text clusters and atomic inline boxes.
- Make the terminal display list consume visual text clusters with exact logical
  and source ranges. The cell rasterizer no longer segments, line-breaks, or
  reorders text, while logical search IDs remain stable across bidi reordering,
  wrapping, resize, and terminal cell metrics.
- Bound bidi paragraphs, embedding depth, bidi items and runs, grapheme
  clusters, break opportunities, visual runs, and line fragments; keep all
  scans cancellable; and make per-line reordering allocate only for the selected
  line instead of the complete bidi paragraph.

- Use `@ismail-elkorchi/html-parser@0.2.1` from the public npm registry,
  preserve parser resource metadata, bound text extraction, and avoid duplicate
  buffering while parsing streamed responses.
- Require release qualification to start from a clean npm installation whose
  parser identity matches the manifest and lockfile, then install and exercise
  the packed Verge artifact in a clean consumer.
- Replace the duplicated fetch transport with the exact published shared HTTP
  client; reuse connections across a browser session; and release network
  resources when sessions and the terminal application close.
- **Breaking:** Remove `classifyNetworkFailure()`; fetch failures now come from
  the typed transport as `NetworkFetchError.networkOutcome`.
- **Breaking:** Require `BrowserServices.close()` so terminal hosts can release
  owned network resources.
- **Breaking:** Preserve response metadata as ordered `HttpFields` in
  `FetchPageResult`, `FetchPageStreamResult`, `FetchStylesheetResult`, and
  `PageSnapshot`.
- **Breaking:** `PageDiagnostics` replaces the old renderer/caller-cookie
  timing fields with semantic-content and stylesheet timing/count diagnostics.
- Form processing now uses semantic control variants rather than the earlier
  flat field shape.
- **Breaking:** Remove the exported hand-written cookie parser and cookie-header
  helpers. The browser now persists a public-suffix-aware cookie jar behind
  `HttpSessionAdapter`, which applies response cookies before redirect and
  stylesheet requests.
- Stream HTML bytes through encoding detection by default and pass HTTP charset
  evidence to the parser.
- Keep page-initiated resources and downloads on the public-network policy by
  default while allowing explicit direct navigation to local targets.
- Block page-initiated `file:` stylesheets even when a remote document supplies
  a `file:` base URL; apply the same local-file boundary to remote links, new
  tabs, and forms; keep links and forms from inheriting direct private-network
  access; and enforce the aggregate stylesheet budget before later requests
  start.
- Restrict persisted cookies and browsing state to POSIX `0700` directories and
  `0600` files; bound indexed text, restored tabs, downloads, cookie candidates,
  and serialized state; refuse a symlink state file; validate and read state
  through the same open handle; and leave non-profile custom parent directories
  untouched. Windows uses the current user profile ACL.
- Keep page-initiated stylesheet cookies on the document origin, including
  across redirects, make cross-origin stylesheet requests anonymous, and
  enforce `SameSite` context for page navigation and downloads, including
  Lax-by-default cookies, the `SameSite=None; Secure` requirement, and rejection
  of `Secure` cookies set by insecure responses.
- Avoid the Windows command-shell boundary for external opening, cancel active
  navigation when tabs close, separate cancelable navigation from profile I/O,
  time out stalled download responses, and release failed, discarded, or
  pre-parse streaming resources.
- Bound interactive form indexing and replace repeated radio-group, option,
  and label scans with linear work on large documents.
- Validate the Node host on current macOS and Windows runners in addition to
  Linux.
- **Breaking:** Replace the flatten-first renderer with immutable document,
  computed-style-map, box-tree, fixed-point layout-fragment-tree, terminal
  display-list, terminal cell-buffer, and reader-document stages.
  `PageSnapshot.document` is now the sole authoritative content model.
- **Breaking:** Expose only the read-only `WebDocumentSnapshot` structure through
  navigation results. Document factories, dynamic state/actions, semantic
  indexes, and the concrete snapshot implementation remain internal.
- **Breaking:** Remove the root document-construction, document-state, source-
  editing, and standalone form-submission helpers; browser orchestration owns
  those operations.
- **Breaking:** Remove `PageSnapshot.rendered`, `RenderedPage`,
  `RenderedActionable`, `RenderedLink`, `RenderInput`, `PageRenderer`, renderer
  and width overrides, fixed-width render helpers, and the former flat page,
  pager, search, parser-attachment, and terminal helper modules.
- Preserve unknown/custom element hierarchy and build browser-internal semantic
  indexes; generate
  boxes from computed `display`; support suppression, contents, anonymous flow
  and table wrappers, lists, structured tables, controls, replaced fallbacks,
  flex/grid formatting contexts, layout fragments, source-aware line boxes, hit
  geometry, focus, scrolling, search, accessibility bounds, and reader documents.
- Give anonymous and generated boxes explicit box-style and semantic ownership,
  exclude blank cells inside wrapped action unions from pointer geometry, and
  fail closed for unknown media types. Preserve semantic and accessibility
  identities for `display: contents` elements without generating a principal
  box.
- Keep baseline user-agent, initial, and inherited styles total for every
  retained element when author selector work is truncated; formatting no longer
  suppresses content because author-style work ran out.
- Preserve connected source-order layout-fragment prefixes when layout budgets
  truncate a page, and preserve completed cells and indexes when paint budgets
  truncate terminal rasterization.
- Generate contiguous anonymous text items for flex/grid, discard collapsed
  whitespace-only item runs, split inline continuations around block children,
  and preserve source order through anonymous table repair.
- Reserve open box-tree ancestors before descending, retain connected
  source-order prefixes across formatting-node and anonymous-wrapper budget
  exhaustion, keep UTF-16 text budgets Unicode-scalar-safe, and aggregate one
  document-semantic geometry entry across split inline and `display: contents`
  boxes.
- Build a viewport-independent `TextSearchIndex` from the box tree, map stable
  logical matches onto layout text fragments, and map those spans to cells only
  during terminal rasterization.
- Remove browser source-editing APIs and the retained parser graph; the indexed
  Verge document tree is the sole authoritative document structure.
- Preserve normal prose and links inside forms while replacing only control
  fragments with terminal controls; index explicit form ownership once; and
  model details disclosure as a typed document action.
- Reject page-initiated redirects that cross into local files before committing
  a document or stylesheet and release stream readers on completion and failure.
- Freeze style, layout-fragment, display-list, cell-buffer, search, and
  accessibility values at their
  subsystem boundaries; validate terminal and style environments as typed
  inputs; and represent CSS `max-width: none` and negative margins without
  terminal-unit shortcuts in computed style.
- Drive interactive and one-shot output from the same terminal display list and
  cell rasterizer,
  and enforce document/style/formatting import boundaries plus deterministic
  structural fuzz and per-stage performance controls, including retained heap,
  peak RSS, 100,000-node documents, large attributes, repeated tab lifecycle,
  and post-close garbage collection.
- Keep template contents inert during style/resource/layout indexing, preserve
  foreign-namespace element casing, index standalone controls and radio groups,
  retain generic/custom-element prose in the separate reader document, and
  persist scroll positions through durable element/source locators rather than
  snapshot-local node-reference strings.
- **Breaking:** Replace persisted workspace `scrollAnchor.source` strings with
  typed durable `scrollAnchor.target` locators; stale workspace entries using
  the snapshot-local format are rejected instead of guessed or migrated.
- Restore typed text alignment, indentation, automatic margins, flex wrapping
  and alignment, and common visually-clipped content handling; resolve terminal
  overlap by paint order and avoid argument-spread and repeated-reader-scan
  cliffs on large documents; keep document cloning and index propagation
  stack-safe at extreme parser-supported nesting depths.
- Make structural page actions a keyboard-navigable group, reveal offscreen
  control layout fragments before focusing their terminal-ui controls, retain
  absolute scroll anchors for rows without a source node, and keep Tab/Shift+Tab
  traversal within form controls.
- Add deterministic 26.6 fixed-point CSS-pixel geometry, separate media, layout,
  and terminal render contexts, layout-owned font metrics, content/padding/
  border/margin rectangles, definite percentage sizing, `box-sizing`,
  `max-height`, side-specific border widths, font size, line height, and vertical
  alignment.
- Move normal block flow, margin collapse, explicit line-box construction,
  controls and replaced boxes, and the supported table, flex, and grid geometry
  out of the terminal subsystem. Delete the former cell-native layout engine.
- Derive a `TerminalDisplayList` from layout fragments and make its cell
  rasterizer the sole source of terminal text, borders, paint-order collision
  handling, hit testing, focus geometry, accessibility bounds, scroll anchors,
  and search highlights.
- Pin focused CSS layout tests to WPT commit
  `ef1cea845d70fb84127ff0e1aff2eeda7064f682` with source paths, behavioral
  adaptation notes, terminal-user-agent adjustments, and license provenance.
- Keep every pre-existing performance threshold unchanged and add measured,
  independently reported controls for computed-to-used resolution, block
  layout, line boxes, complete CSS layout, display-list construction, cell
  rasterization, resize, focused stress workloads, fragment heap release, and
  repeated-resize retention.
- Bound terminal display-list commands, incremental paint units, retained cells,
  cell-buffer rows and columns, hit-test regions, focus rectangles,
  accessibility rectangles, document geometry, scroll anchors, and search cell
  spans with exact typed truncation causes. Zero is a valid no-work terminal
  budget and malformed caller limits are rejected.
- Saturate fixed-point addition, subtraction, multiplication, division,
  rectangle edges, intersections, and iterative unions before unsafe integer
  intermediates can occur; preserve zero-area clipping and bounded work at both
  safe-integer limits.
- Preserve every extended grapheme during terminal snapping, keep wide clusters
  atomic, make adjacent graphemes monotonic within one text command, and resolve
  only cross-command collisions by paint order.
- Treat replaced content, controls, `inline-block`, `inline-table`,
  `inline-flex`, and `inline-grid` as atomic inline boxes; retain per-line
  decoration geometry for splittable inline boxes; and remove forced-block
  handling for inline formatting contexts.
- Derive root font metrics from the computed root-element style and use the same
  root value for descendant `rem` used values while applying the initial-font
  rule to the root element's own `font-size`.
- Add background-fill and side-specific border paint commands, explicit paint
  phases, source-over alpha composition before terminal color quantization, and
  separate box-derived pointer, focus, accessibility, scroll, document, and
  text-search geometry contracts. Keep clipped border sides at their true box
  edges, give split hit regions stable identities, retain source-order index
  prefixes, and reject malformed CSS or terminal text metrics through typed
  outcomes.

## [0.1.2] - 2026-03-07
- Add the redesigned terminal UI with page-first navigation, help, and shell flows.
- Enforce JSR doc linting and doctest checks in CI and upload rendered HTML docs as artifacts.
- Reduce GitHub workflow token permissions and align release-policy validation with least-privilege job scopes.

## [0.1.1] - 2026-03-04
- Add OIDC `publish.yml` workflow for npm Trusted Publishing and JSR publish on release events.
- Add publish manifest evidence and deterministic tag/version parity checks before publish.

## [0.1.0] - 2026-03-04
- First public release of `@ismail-elkorchi/verge-browser`.
- npm + JSR package metadata, docs surface, and release automation hardened for deterministic publishing.
