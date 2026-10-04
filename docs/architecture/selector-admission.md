# Selector admission and retained results

Selector matching uses css-parser's immutable tree index and actual cumulative
work meter. Verge does not implement a second selector matcher or impose a
query-count cutoff. A stylesheet containing thousands of cheap indexed misses
can be cheaper than one expensive filtered sibling query.

## Independent bounds

- Whole-index construction: `maxSelectorConstructionSteps`, 4,000,000 actual
  steps. Construction also bounds node count and depth by the already-adopted document node count.
  Exhaustion throws a typed `StyleSelectorConstructionError`, rejecting the
  render. No user-agent cascade is promised when the index cannot be built.
- User-agent evaluation: a fixed-program allowance of 4,096 + 128 × document
  nodes. The constant accounts for indexed misses and selector planning even on
  tiny documents. This is independent of author evaluation admission.
- Author evaluation: `maxSelectorSteps`, 5,000,000 actual cumulative steps per
  evaluation. Cache hits perform no matcher work and incur no fictional replay
  charge. Exhaustion discards all author candidates, inline declarations, and
  presentational hints, returning the complete user-agent-only cascade.
- Selector results: `maxSelectorCacheBytes`, 16 MiB of conservative owned-entry
  descriptors and references. This excludes the small fixed cache container and
  the shared DOM objects themselves. Total artifact admission still accounts
  for the complete retained graph, including the fixed container and DOM.

A single session holds the immutable index. The compiler always emits the
built-in source first. Each evaluation starts a user-agent lifetime, then starts
an independent author lifetime at the first author source. Focus/hover changes
invalidate relevant result entries without rebuilding the tree. Changes to the
open attribute recreate the index because its attribute snapshot is immutable.

Stylesheet source/byte limits, compilation limits, diagnostics, and the overall
512 MiB retained-render limit remain separate and unchanged.

## Transactional caching

The cache uses bounded FIFO eviction. Entry charges include keys, result and
usage records, arrays, dependency descriptors, unknown records/reasons/source
spans, and references. Insertion never traverses referenced DOM subtrees.

New author entries are staged within the unused portion of the same byte ceiling.
A full cache may decline retention; recomputation still consumes actual work.
Only a successful complete style resolution commits staged entries. Author
exhaustion or cancellation discards them. Existing valid entries and completed
user-agent entries survive. Dynamic invalidation removes stale entries even if
the following evaluation fails; stale entries are never restored. The reusable
computed snapshot is invalidated before evaluation state advances and installed
only after full resolution succeeds, preventing a cancelled transition from
mixing styles from different states. Matcher callbacks capture the current
program owner, not an initial request, signal or instrumentation object.

Repeated failed cold evaluations cannot accumulate author prefixes and gradually
circumvent admission. Previously completed evaluations can legitimately reduce
later actual work, so admission is intentionally not independent of cache
history. Cache capacity does not select an arbitrary prefix of author styles.

## Calibration

Offline captured GitHub, English Wikipedia, and Arabic Wikipedia pages were
replayed with the corrected upstream meter. Measurements used actual source
modules and unchanged production defaults, with no raised-limit shim for the
acceptance runs. The following cold costs motivated the separate bounds:

| Capture | Construction steps | Author steps | UA steps | Owned cache bytes |
| --- | ---: | ---: | ---: | ---: |
| GitHub | 596,867 | 830,617 | 125,431 | 12,757,880 |
| English Wikipedia | 1,496,662 | 1,993,066 | 375,895 | 8,032,756 |
| Arabic Wikipedia | 2,529,124 | 3,696,420 | 663,087 | 10,126,076 |

All three complete cold author evaluation and perform no selector queries on a
warm identical replay. GitHub still independently reports omitted resource
stylesheets. These are style admission measurements, not a claim that a complete
Arabic viewport fits total retained-render admission or a performance promise.

The upstream sibling-rank map is charged conservatively at an additional 320
bytes per element within the private-session ownership estimate. Keeping one
index instead of separate user-agent/author copies reduces real retained
ownership as well as duplicate construction work.
