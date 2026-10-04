# Navigation and accepted history

## Ownership

`app/navigation-history.ts` is the renderer-neutral immutable transition core.
`BrowserSession` owns one instance for public imperative callers. `PageAcquisition`
owns only acquisition, parsing, stylesheets and cancellation; it has no current
page or history. The TUI controller uses `PageAcquisition` directly. Each controlled
ready tab owns its sole accepted history value.

An acquisition result carries its checked provenance, source entry, tab identity,
document activation revision and navigation generation. The reducer accepts it
only while these still match. The reducer captures outgoing interaction state at
acceptance, including edits made during the fetch. Persistence, renderer release
and viewport acknowledgment run as effects after terminal-ui accepts the frame.
A rejected host write or effect-admission plan therefore cannot advance external
history, persist the candidate visit or retire the accepted document.

Back and Forward are synchronous immutable transitions. Stop invalidates pending
navigation but keeps the accepted entry. Closing retains a bounded recently-closed
presentation without viewport buffers or renderer attachments; reopening advances
the activation revision and restores the same live controls.

## Entry and live-document identities

Each full acquisition receives a new live-document identity. Each visit receives
an entry identity, even if its URL equals an earlier visit. Entry attachments retain
source-based root scroll, semantic focus and search query/active-match intent.
Live-document attachments retain controls, disclosures, editor caret/selection and
nested scroll offsets keyed by owner node. Active state is the projection; it is
not also stored as an obsolete attachment. Hover, pressed state and open combobox
popups are not restored. Derived search anchors and renderer buffers are not
history attachments.

A no-body ordinary GET to the same URL except for a present fragment makes a
same-document entry and shares live controls. Explicit headers, a body, POST, a
changed query/path/origin/credentials, or a non-fragment same-URL visit acquires a
new document. Repeating the current fragment creates another entry. New-tab
navigation always acquires its own document.

Reload always acquires a new document using safe GET behavior. It replaces only
the current entry; other entries that refer to an earlier live document remain
independent. Reload preserves page-initiated source provenance and cannot broaden
that navigation to direct network or local-file access. Request bodies are not
retained or silently replayed.

The entry URL is authoritative for UI display, URL target, reload, persistence,
default form actions and navigation capability sources. The immutable parsed
document retains its acquisition/base-resolution provenance. Fragment wrappers
reuse acquisition diagnostics and do not fabricate a fetch or parse.

## Rendering across activations

Every accepted activation advances `documentRevision`, including fragment,
Back, and Forward transitions. That revision is a stale-result fence, not the
immutable source identity. The controller compares the current entry's live
`documentId` with the one acknowledged by its tab's worker lifecycle. A same-source
activation updates state and the activation fence through `update-document-state`;
it performs no HTML hydration or stylesheet parsing/compilation. Different sources,
an absent attachment, and worker restart require attachment. Equal URLs alone do
not establish source identity, and the worker keeps only one source family per
tab rather than every history document.

While a same-source projection is pending, the last accepted viewport remains an
explicitly previous display with its original revisions. It is never relabeled as
newly accepted or used to bypass current-result checks. Entry-specific root
position/focus and current live controls/nested offsets retain their existing
owners. Serialized preparation, worker epochs, request generations, and accepted
terminal writes still fence activation and persistence. A genuine cascade no-op
can reuse downstream phases; changed control content or disclosure state cannot.

## Fragment and reveal behavior

The one resolver distinguishes an element, top, and no match. It tries the raw
fragment against the first ID, then an HTML named anchor, before tolerant percent
and UTF-8 decoding and another lookup. Empty fragments and unmatched decoded
ASCII-case-insensitive `top` mean top. Missing and unmatched fragments do not mean
top.

A new resolved target requests semantic block-start reveal. Focus and search use
nearest reveal through the same geometry owner. The accepted layout, including
`:target`, determines nested offsets and the root row. An entry's saved anchor or
valid restored workspace anchor wins over replaying its initial fragment jump.
Explicit later scrolling and newer activation revisions invalidate old reveal
work. Interactive and one-shot rendering pass the same reveal intent.

## Retention policy

Each history has at most 100 entries and a 64 MiB **additional inactive ownership**
budget. Shared live documents are charged once. Entry-owned URL/provenance strings
and lightweight snapshot wrappers are charged separately, including fragment
entries that share the active document. The shallow metadata recount deduplicates
request/final/source strings without rescanning the parsed document. Private
entry-view attachments also count toward retention. Active-page admission remains with
the existing acquisition, parser and renderer budgets; this is not a total-process
or active-document memory bound. Oldest eligible inactive entries are retired
until the inactive budget fits. A document too large to retain as inactive history
is evicted on departure rather than rejecting an otherwise admissible active page.
There are no URL-only tombstones or automatic refetches during traversal.

Forward-branch truncation, replacement and cap retirement prune entry/live
attachments in the same immutable transition. Recently closed tabs are limited to
10. Session close/destroy clears its history. Persisted workspaces store URLs and
durable root anchors, never password/form contents or cross-process live controls.

## Regression coverage

`navigation-history.test.js` covers duplicate URLs, shared fragment forms, caret
and entry scroll, provenance-preserving reload, retention, malformed fragments,
rejected host writes and rejected effect plans. `document-scroll.test.js` covers
nested clamping/chaining and hidden/clip policy. TUI tests exercise accepted frames
for duplicate URLs, fragment targets, editing during acquisition, Stop, late
responses, close/reopen, workspace restoration and background-tab completion.
`render-worker-transport.test.js` and `retained-phase-ownership.test.js` additionally
cover same-source preparation, stale activation fences, worker hydration parity,
phase identity, and failed-admission recovery. Same-source history controls check
that rapid activations and rejected writes never rewrite the previous display.
