# Incremental rendering qualification

This document records current rendering/control qualification and preserves the
PR #136 measurements below as historical evidence. The historical starting
commit was `b271b3989459658c68da7bb1df3aef2ab9c835da`, tree
`98cd786f4fc956d23821c2456964f24358cd0c7f`; its dependencies were
`@ismail-elkorchi/css-parser@0.2.7` and
`@ismail-elkorchi/terminal-ui@0.1.5`. Those measurements do not qualify the current
tree. Direct and worker custom-property syntax-tree regressions remain required.

## Current correctness and captured-page checks

The retained store now owns separate phase resources, with actual semantic
invalidation, environment-specific style freshness, independent reporting
identities, and an audited background-only paint path. Same-source navigation
advances activation fences without rehydrating HTML or recompiling stylesheets.
Replacement construction retires eligible old geometry before building and keeps
reservations, accounting metadata, and mutable side caches separately charged.
Failed/cancelled construction can rebuild retired phases; it cannot rewrite the
last accepted viewport or retain obsolete graphs in rollback state.

Document controls use parser-produced form ownership and one canonical
initialization/edit/reset state. Submission uses one ordered entry list. Typed
generated-content programs and scoped counters preserve visual/source identity,
with semantic alternative text separate from visual search. Font shorthand and
horizontal logical borders use the ordinary ranked cascade and exhaustive
immutable-record comparisons.

The saved Wikipedia CSS article was checked at 80, 120, and 160 columns: all 21
return links at each width, 63 targets in total, retained independently expected
labels, exact destinations, and nonempty paint/hit/focus geometry. This is captured
page evidence, not a claim that CSSOM `content` strings establish painted counter
text. The reduced regression in `test/control/generated-content.test.js` preserves
all 21 target identities and labels at the same three widths.

At those widths, the saved example.com page produces 21 document rows and matches
its font shorthand expanded into modeled longhands. MDN's captured note rail is
present and its geometry matches the corresponding physical-border declarations.
These are bounded capture checks, not broad browser-equivalence claims.

Reproducible repository controls include:

```sh
npm run build
node --expose-gc --test test/control/resource-ownership.test.js \
  test/control/retained-phase-ownership.test.js test/control/retained-rendering.test.js
node --test test/control/generated-content.test.js \
  test/control/immutable-style-records.test.js test/control/style-font-logical-borders.test.js
node --test test/control/document.test.js test/control/forms.test.js \
  test/control/control-style-state.test.js test/control/navigation-history.test.js \
  test/control/render-worker-transport.test.js
npm run compat:check
```

The optional Chromium comparison uses native form owner/value/selectedness APIs,
ordered `FormData`, and CDP accessible-name observations; duplicate HTML IDs do
not alias its document-order identities. See the
[compatibility harness](../../scripts/compat/README.md) for setup and the focused
`form-semantics` oracle command. Independent expected generated labels and painted
geometry remain necessary beyond that DOM/CSSOM oracle.

## Historical PR #136 correctness controls

| Owning defect | Correction and regression |
| --- | --- |
| Media-only computed-style keys and raw declaration dependencies | Track typed computed font inputs after substitution, separately from used-value viewport/containing-size dependencies. Differential vw, vh, clamp, nested/fallback variables, rem, percentage heights, fixed placement, focus variables, and dimension-independent cases assert output and stage counts. |
| Selected-tab readiness gates global behavior and completions | Shared global handlers precede document-only actions. Tab/revision/generation guards route restoration, viewport, search, and navigation results and failures. Unresolved/failed navigation, replacement URL, new tab, help, quit, inactive completion, and unfinished omnibox edit controls cover the lifecycle. |
| Unbounded placeholder promotion | One scheduler accounts for three live loads (selected work has priority; new background work requires fewer than two inactive loads) and a 256-job queue. Fifty-selection and queued/live-close barriers prove capacity and cleanup ownership. |
| Sending a summary treated as client possession | Client caches on receipt; viewport requests acknowledge the identity actually held. Every result requires that exact summary. Obsolete A followed by B, earlier layout return, missing summary, restart, and release controls cover delivery. |
| Logical matches retain physical rows | Matches carry document/state/query/request identities; layout anchors are separate. Resize and geometry-only state changes retain logical indexes through an independent computed-text dependency; anchors are reprojected. Control edits, same-query reopen, obsolete completion, navigation, and inactive-tab controls reject stale anchors. |
| Unordered attachment preparation and obsolete cold work | Serialized document lifecycles validate revisions and worker epochs before and after acknowledgements. A bounded worker queue prioritizes cleanup then the active document. Controlled transport barriers cover release, repeated navigation, cold/warm switches, clean exits, crashes, clone failures, and concurrent close. |
| Disposal queued behind cold work | Close first rejects new work, cancels all generations and queued jobs, then gives graceful cleanup 250 ms before termination. Real pipeline checkpoints cover active compilation, layout, and rasterization; controller transport controls prove settlement and the benchmark measures full disposal. |
| Uncharged owners and oversized active exemption | Weak ownership metadata charges private roots, shared allocations once, opaque parser estimates, partial prefixes, attachments, private immutable control/disclosure state, weak action/paint/semantic/inline-analysis side caches, queries, and client transfers/viewports. Admission rejects oversize results and preserves the committed viewport. Release, reanalysis, resize sharing, many attachments/queries, and forced-GC reachability are controlled. |
| Semantic rectangles lose fragment ownership when zero-area boxes are omitted | Each focus rectangle retains its exact layout fragment through clipping and cell conversion. Wrapped inline rectangles follow their continuations. Fixed empty-link and wrapped-link gap regressions verify painted actions. |
| Paint admission mutates cells before accepting an overlapping glyph | Reserve the complete replacement cost before changing ownership. A rejected wide glyph retains the earlier cells and accurate retained-cell count. |
| Search benchmark times an already computed result | The timed operation executes the logical query and layout projection. An invocation control and nonempty logical/geometry assertions reject a result-read measurement; the 25 ms p95 threshold is unchanged. |
| Accidental rectangle containment determines sticky clipping | Layout owns persistent clip chains. Paint and semantic geometry translate each clip by its owner's attachment. Ancestor/descendant sticky clips, fixed viewport clips, absolute containing-block overflow, explicit ancestor clips, nested positioning, bidi, inline backgrounds, tables, and Grid have retained-versus-new-attachment comparisons. |

The original checkout failed 13 of 14 selected dependency, admission, clipping,
and placeholder reproductions; the dimension-independent vh-font width case
already behaved correctly and remains a regression. Differential comparisons use
the same engine with new attachments, including full computed values, fragment
geometry, cells, source ranges, actions, anchors, focus, and accessibility.
No reference renderer or compatibility route is retained.

A controlled transport also holds a completed search response until a newer
query is requested. The client checks attachment and document/search generations
at delivery, rejecting the obsolete result even when worker computation finished
before cancellation. This reproduces the real-worker race caught during hosted
qualification without depending on thread timing.

## Historical PR #136 offline measurements

Historical clean hosted measurement on 2026-09-07, Node 24, Linux, at
`2a66a64c5184ff126384a5d4606eb2fd1187971e`:
[CI and downloadable reports](https://github.com/Ismail-elkorchi/verge-browser/actions/runs/34120657341).
These samples include the final runtime owner audit. The subsequent correction
changes the legacy search benchmark's measurement boundary, not rendering.
`npm run test:bench` regenerates the reports during clean release qualification.
The independently authored MIT fixture has 2,000 sections; distributions use
21 samples and a separate small offline new-tab page. Existing timing thresholds
are unchanged; every incremental-rendering gate passed on this runner.
A local diagnostic measured a 72,757.81 ms first usable frame and 184.29 ms
shutdown, exceeding the unchanged 30-second first-frame wait. That local run
did not qualify. The clean hosted qualification
HEAD, downloadable reports, and final measurements are recorded in
[PR #136](https://github.com/Ismail-elkorchi/verge-browser/pull/136).

| Interaction | p50 or single measurement (ms) | p95 (ms) |
| --- | ---: | ---: |
| Worker first viewport | 14472.29 | — |
| Warm worker scroll | 55.77 | 69.35 |
| Unchanged worker viewport | 55.59 | 61.40 |
| Color-depth viewport | 10.17 | 58.05 |
| First shell | 92.74 | — |
| First usable page after shell | 15470.10 | — |
| Input to visible scroll frame | 136.50 | 164.98 |
| Input to state during rendering | 0.01 | 0.10 |
| Chrome input to committed frame | 54.38 | 92.63 |
| Tab switch to usable frame | 26.89 | 34.99 |
| Quit to runtime/controller disposal | 21.19 | — |
| Search with layout anchors | 4134.42 | — |
| Resize | 16410.81 | — |

Input-to-state, request-to-result, and input-to-committed-frame measure different
completion boundaries. The UI benchmark waits for the requested viewport to be
committed, and quit timing includes both runtime and controller disposal. Tab
switches include the article and the small new-tab page. The single large worker
retains at most 58 cell rows; 100 replacement viewport requests yield one final
result and 99 cancellations. Scroll-only controls assert zero immutable analysis
or normal-flow layout invocations and spatial work bounded by intersections.

## Memory and admission

The default retention budget remains 512 MiB; the worker working-set budget is
1 GiB, and client viewports, summaries, and pending transfers share a separate
64 MiB budget. Worker checkpoints observe heap plus external allocations, with
a Node heap limit as an additional termination boundary. Peaks are sampled
allocation peaks, not an exact continuous heap profile. Retained allocation costs
are estimates, not source-byte counts presented as heap measurements.

The historical PR #136 large latency fixture used explicit 1 GiB retention and
2 GiB working-set budgets. Its separate cold-only measurement found 568,583,288 heap
bytes retained after GC, a sampled 1,013,362,784-byte heap peak, and a
652,603,960-byte retained-cost estimate. That result exceeded the default
512 MiB budget; default admission rejection is independently tested.

That historical hosted worker run admitted one resize layout after evicting two
variants while retaining shared upstream artifacts. Its retained-cost estimate
included the weak side-cache owners:

| Memory measure | Bytes |
| --- | ---: |
| Retained allocation estimate | 885,763,164 |
| Worker heap after forced GC | 774,623,136 |
| Sampled allocation peak heap | 1,559,517,040 |
| Sampled peak working set (heap plus external) | 1,563,779,100 |
| Client retained viewport/summary estimate | 8,331,902 |
| Worker heap after release and forced GC | 18,736,344 |
| Retained artifact estimate after release | 0 |

Release controls separately test weak reachability, truncated prefixes, many small
attachments, state growth, query limits, sharing, eviction, and reattachment.
Released worker heap includes the worker/module baseline; it is not all live
artifact memory. Estimates account for program-owned caches even without an
analysis. No active analysis is exempt from admission or cleanup.

## Current captured replacement-memory measurement

Matched real-worker runs used the saved Arabic page and default budgets for
120→160→80→120-column replacement, without forced GC during replacement. Baseline
peak worker heap plus external allocations was 974,017,886 bytes (974.02 MB).
Two updated runs peaked at 754,938,857 and 798,015,734 bytes (754.94/798.02 MB),
22.5% and 18.1% lower. The retained cap stays 536,870,912 bytes (512 MiB) and the
working-set cap stays 1,073,741,824 bytes (1 GiB).

The baseline completed all four widths, then rejected the following search/focus
work at a retained estimate of 579,728,332 bytes. The updated sequence completed
replacement followed by logical search, focus, and rendering at a retained
estimate of 528,619,400 bytes. Release left zero retained accounting, pins, and
reservations.

These measurements are deliberately separate:

| Updated real-worker measure | Bytes |
| --- | ---: |
| Retained allocation estimate after the extended sequence | 528,619,400 |
| First updated run: heap after diagnostic post-run GC | 350,011,712 |
| First updated run: heap after release and diagnostic GC | 28,926,920 |

Post-run collection is diagnostic only; no collection was forced during the
replacement or focus sequence. Stage checkpoints sample worker heap plus external
allocations, not continuous peaks, total RSS, or client/transfer ownership.
Independent graph recount remains a separate accounting check; an in-process
probe that recounts between replacements also allocates diagnostic traversal
scratch and does not enforce the real worker's working-set cap.

The matched runs establish a lower overall candidate replacement peak for this
capture. They do not establish a general latency improvement or a statistically
robust marginal peak benefit from the weak accounting ledger alone: an otherwise
matched prior-ledger run peaked at 773,285,558 bytes, within the updated-run range.
The ledger's removal of strong retained roots is covered independently by the
resource-ownership reachability and nested/cancelled traversal regressions.
`npm run test:bench` remains the repository timing benchmark; capture memory
measurements do not replace final clean release qualification.

## Qualification and remaining work

The release gate is `npm run release:check` from a clean checkout/install of the
exact reviewed HEAD. It includes lint, strict TypeScript, Unicode and all
unit/control/CSS conformance tests, CLI/interactive tests, compatibility corpus,
528 deterministic release-fuzz cases, Node/Deno/Bun parity, docs/JSR, examples,
benchmarks, audit, packed-consumer worker verification, and npm/JSR dry-runs.
Hosted CI checks out the exact PR HEAD and runs Node 24/26 on
Linux/macOS/Windows, dependency review, and both CodeQL suites. Release
qualification uploads its HEAD/tree record and benchmark reports. The PR records
the exact qualified commit and hosted results; earlier successful checks do not qualify a later commit.

Cold selector resolution, full resize layout, graph-cost traversal at admission,
and logical match projection remain measurable costs owned by style, layout,
retention accounting, and search respectively. Terminal frame construction and
serialized terminal output contribute to visible interaction latency. These
costs remain reported separately; a fast reducer does not establish a responsive
visible frame. Historical timings and current capture checks cannot substitute
for measurements of the exact final qualified tree.

The rendering worker is an ordinary Node worker, not an operating-system
sandbox. Rendering performs no application network or filesystem operations;
no session, cookie, or file capability is supplied through its protocol.
