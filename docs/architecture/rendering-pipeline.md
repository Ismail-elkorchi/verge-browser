# Structural rendering pipeline

Verge has one HTML presentation path. Network loading produces an immutable
`WebDocumentSnapshotView`; style resolution produces computed CSS values; box
generation produces a `FormattingTree`; terminal layout produces a nested
`FragmentTree`; and the CLI and interactive UI project the same fragments.

The ownership boundaries are intentionally strict:

- `src/document/` is the only layer that imports the HTML parser. It owns node
  identities, source ranges, document semantics, reusable indexes, document
  state, and typed edits.
- `src/presentation/style/` owns the user-agent stylesheet, author-style
  collection, cascade, computed values, selector state, diagnostics, and style
  work budgets. It is terminal- and transport-independent.
- `src/presentation/formatting/` owns CSS box generation, anonymous wrappers,
  formatting contexts, generated boxes, and source-to-formatting identity.
- `src/presentation/terminal/` owns used-value conversion, terminal-cell
  measurement, layout, fragmentation, clipping, hit geometry, search geometry,
  accessibility projection, and row projection.
- `src/reader/` owns the deliberately flattened reading projection. It is not a
  rendering fallback.
- `src/ui/` owns browser chrome and maps document actions and terminal fragments
  to general terminal-ui controls.

HTTP, redirects, cookies, local-resource policy, downloads, tabs, history,
bookmarks, persistence, and browser chrome remain application responsibilities.

## Invariants

- Document-node references are opaque outside the document layer and remain
  stable for the lifetime of a snapshot.
- Unknown and foreign-namespace elements retain their complete hierarchy.
- Index construction is single-pass or bounded follow-up work and reports typed
  truncation rather than silently performing unbounded scans.
- Computed styles contain CSS-domain values. Terminal rows and cells appear only
  during terminal used-value resolution.
- CSS `display`, not an HTML tag switch, determines box participation and the
  formatting context. HTML semantics enter through the user-agent stylesheet
  and the document model.
- Formatting nodes retain source-node identities and source ranges. No layer
  reconstructs hierarchy from flattened text.
- Fragment identities derive from stable formatting identities; a
  resize changes geometry, not document or formatting identity.
- Terminal rows are a final projection of fragments and are never the source of
  links, forms, outline entries, focus targets, or accessibility semantics.
- Budget, cancellation, unsupported, rejected, and truncated states are typed
  subsystem outcomes. Control flow never depends on diagnostic prose.
