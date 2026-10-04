# Retained scroll and control geometry

## Ownership

Layout retains CSS-pixel geometry in 26.6 fixed-point coordinates. The UI retains logical scroll state; offsets are not analysis-cache keys and do not require style, formatting, layout, or display-list reconstruction.

`LayoutFragmentTree` exposes:

- `scrollContainer(fragment)`: the fragment's own scroll owner
- `scrollAncestor(fragment)`: its nearest containing scroll owner, excluding itself
- `scrollOwners`: bounded immutable owner records, including parent, source node, port, reachable content extent, computed axis policies, direction, and offset ranges
- `scrollExtent`: the root's reachable extent, distinct from paint overflow
- `viewportOverflow` and `viewportDirection`: used viewport policy, including HTML body propagation and its containment exception

Scrollable overflow is computed bottom-up. Descendant overflow trapped by an overflow/paint-containment boundary cannot enlarge an ancestor's scroll range. Out-of-flow ownership follows the containing block. Viewport-fixed boxes escape intermediate scroll containers; locally fixed boxes follow their transform or paint-containment containing block.

## Projection and indexing

`ViewportGeometryProjection` is the single translation and clip-owner resolver for paint, pointer hits, focus, accessibility, search, native controls, and scroll targets. A clip moves with its owner, not with an arbitrary descendant. Own overflow/containment clips apply to contents, while own background/border chrome remains outside that content clip.

Spatial indexes retain commands and semantic candidates in scroll-owner-local coordinates. A viewport query visits visible owners, inverse-transforms each content window, and resolves the selected commands through the projection. Scrolling does not scan the entire document or index only the zero-offset clipped commands. Attached descendants use conservative envelopes that include nested sticky/fixed ancestry. Sticky constraints inside a scroll container use its reachable content extent.

The root viewport also carries an inline cell origin. LTR ranges extend toward positive inline coordinates; RTL ranges extend toward negative coordinates. The document-column cap is unchanged.

## Controls

Control allocation comes from layout-owned full border rectangles, independently of text painting or focusability. Empty and disabled controls therefore retain geometry. Every visible control record exposes both its full allocation and its clipped visible intersection. Clipping must not shrink an editor's allocation and thereby change its line wrapping, caret, or retained editor state.

During terminal resize, the previously accepted document keeps its logical canvas width and control allocations until its matching replacement viewport is accepted. The outer viewport supplies the new physical clip; a focused native control remains the same mounted owner, so typing and caret state survive even while it is completely outside that clip. Clipped painting, hit targets and popup visibility do not remove the resolved focused semantic branch. Resize records focus through the existing pending reveal/focus fields; the replacement layout uses shared reveal before restoring the accepted visible focus. No null control slot, hidden replacement editor or input queue is used to bridge the resize.

HTML input `size` and textarea `rows`/`cols` feed intrinsic sizing through font metrics. CSS dimensions, min/max constraints, and box sizing take precedence normally. Textarea fallback lines reuse the existing CSS text and bidi paragraph machinery, with original content offsets, rather than retaining an additional flattened visual representation.

## Scrolling and reveal

Controlled nested offsets use source-node identities and are reconciled, pruned, and clamped against every accepted layout. The accepted frame carries matching geometry and offsets. User deltas target the deepest eligible hit port, consume available movement, and chain the remainder outward. Hidden ports permit semantic scrolling but do not consume user input; clip boxes do not establish scroll owners.

Node, focus, and occurrence-specific search reveal share `revealLayoutRect`. It adjusts owners from inner to outer, then the root viewport. Search selects the requested match's layout span and exact visual-cluster range against the matching accepted search projection. Empty named anchors retain their layout origin. Nearest alignment leaves a target spanning both viewport edges stationary and implements the oversized single-edge cases consistently on both axes.

## CSS policy

Overflow shorthand and longhands use the existing cascade candidate machinery, including importance, layers, rollback, and variable substitution. The supported five-keyword policy computes mixed axes before layout. Visible/clip do not establish a formatting context by themselves; hidden/auto/scroll affect formatting contexts and automatic flex/grid minima.

The implemented containment subset is `none` and `paint`. Paint establishes clipping, formatting, containing-block, and stacking ownership. `content` and `strict` are not treated as aliases for paint-only behavior.

Media lengths reuse the declaration numeric parser and expression evaluator. Absolute units normalize canonically, percentages and invalid dimensions are rejected, and font-relative media units use initial UA metrics rather than authored element font sizes.

## Bounds and verification

Owner metadata is bounded by admitted layout fragments. Command/semantic indexes and projection caches participate in retained-cost accounting. Control geometry uses the document rectangle limit; accessibility admission counts individual rectangles rather than only semantic entries. Scroll requests preserve immutable analysis identities and query only bounded viewport work.

Regressions cover overflow cascade/axis combinations, media math boundaries, root/body containment propagation, nested two-axis/RTL scrolling, clipped full-sized controls, sticky and positioned ancestry, nearest reveal, empty anchors, operation bounds, resize reconciliation, wheel chaining, and retained reuse. Captured Wikipedia replay is an additional acceptance case, not the implementation strategy.

References: [CSS Overflow](https://www.w3.org/TR/css-overflow-3/), [CSS Containment](https://www.w3.org/TR/css-contain-2/), [principal writing mode](https://www.w3.org/TR/css-writing-modes-3/#principal-flow), and [CSSOM View](https://www.w3.org/TR/cssom-view/).
