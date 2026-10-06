# Unicode text layout

Verge pins Unicode 17.0.0 for UAX #9 bidirectional layout, UAX #14 line-break
opportunities, and UAX #29 extended grapheme clusters. Unicode 18 was still a
draft when this milestone began, so no draft data is consumed.

The internal text path is:

```text
HTML directionality
→ CSS direction and unicode-bidi computed values
→ logical inline-item stream
→ extended grapheme clusters
→ bidi paragraphs and embedding levels
→ Unicode and CSS break opportunities
→ logical line selection
→ per-line visual runs
→ line boxes
→ terminal display-list text commands
→ terminal cell buffer
```

`src/unicode/` owns the generated property tables and engine-neutral UAX #9,
UAX #14, and UAX #29 primitives. `src/document/` indexes HTML `dir` behavior,
including inherited direction,
Unicode first-strong `dir=auto`, default `bdi` isolation, `bdo` override intent,
telephone controls, and rendered attribute text. `src/presentation/style/`
owns the computed `direction`, `unicode-bidi`, logical `text-align`,
`line-break`, `word-break`, `overflow-wrap`, `hyphens`, and `tab-size` values.
`src/presentation/text/` owns CSS-transformed `InlineItemStreamSet`
construction. Layout consumes those streams directly for line selection and
visual-run geometry; `TextSearchIndex` independently consumes the same streams.
Terminal code only paints and snaps the already resolved visual clusters.
Logical units, bidi items/levels, search segments, and visual cluster selections
use compact indexed storage. Source offsets remain canonical; decoding a record
does not create a second retained text model.

HTML `dir=auto` is recalculated from current input and textarea values during
style resolution. `pre[dir=auto]`, text controls, and textareas use
`unicode-bidi: plaintext`, so each bidi paragraph selects its own base
direction. Preserved tabs remain logical text units; line selection resolves
their used advances against inherited CSS `tab-size` before line boxes are
constructed.

Browser chrome and mounted native controls use one session-owned
`TextPresentation` adapter backed by the same pinned Unicode resolver. It resolves
the full logical paragraph with automatic base direction, then maps the supplied
grapheme range for each wrapped line. Logical offsets remain authoritative for
editing, selection, and copied text, including zero-width directional controls.
Mirrored glyph substitution preserves the active width profile: a mirror with a
different cell width keeps the original glyph rather than changing editor geometry.
This adapter does not receive arbitrary CSS `direction` or `unicode-bidi`
overrides; document layout's CSS direction support is not a claim that native
editors implement those overrides.

Interactive startup and resume require application-ordered physical LTR cells
and matching input coordinates, paired with that text adapter. Raw ECMA-48 mode 8
and the full presentation guarantee are separate: explicit bidirectional mode
can still have an RTL character path. Mode observations and restoration baselines
do not supply full presentation qualification.

The host accepts a caller declaration of a qualified existing presentation, or
one established after an observed and verified mode-8 reset. This is declared
assurance, not an observed proof of character direction. The caller must preserve
the qualified configuration and transport throughout the host lifetime, including
external use during suspension. Contradictory observations invalidate the
qualification; inconclusive refreshes cannot resurrect it. `TERM` names do not
establish this capability. The CLI exposes the same contract through its
[terminal presentation option](../reference/cli.md#terminal-presentation).

After successful acquisition, the full-screen TUI clears its owned surface once
at startup or resume so old paragraph attributes do not survive. Clearing does
not independently establish LTR character direction. Ordinary partial updates
remain incremental. Session release restores the known raw modes it actually
changed, including failure, cancellation and suspension; it never substitutes a
guessed default for an unknown original character path. One-shot plain output
uses the same text adapter without acquiring terminal modes. These contracts do
not imply native qualification across all terminals, fonts or transports.

The Unicode generator is `scripts/unicode/generate-unicode-data.mjs`.
`npm run unicode:generate` downloads only the versioned official sources,
verifies every SHA-256 digest, generates compact sorted lookup tables, and
stores the exact offline inputs. `npm run unicode:check` performs the same
generation from the offline fixtures and fails if the checked-in table or
source manifest differs. Runtime code performs no network access and does not
consult host ICU segmentation.

Official `BidiTest.txt`, `BidiCharacterTest.txt`, `LineBreakTest.txt`, and
`GraphemeBreakTest.txt` are retained under `test/fixtures/unicode/17.0.0/` with
the Unicode license and source manifest. Focused WPT adaptations are recorded
in `test/fixtures/wpt-text-provenance.json`; they copy no WPT source.

Logical document order remains authoritative for search, accessibility text,
copying, form values, and diagnostics. Visual order is used for line placement,
terminal cells, and the geometry and text content of visual fragments. The
display list retains CSS tree paint order and never substitutes layout-fragment
identities. Each painted grapheme retains its logical content range and
document source range, so highlighting can cross inline boxes, bidi runs, and
wrapped lines without reordering the search string.

Text work is bounded independently by code points per bidi paragraph, bidi
items, embedding depth, bidi runs, grapheme clusters, break opportunities,
visual runs, and retained line fragments. Cancellation is checked during each
linear scan. A budget outcome retains only complete bidi paragraphs or complete
line-box prefixes; layout never exposes unmatched embedding/isolate state or a
provisional line box.

Verge deliberately does not claim vertical writing modes, dictionary-based
word segmentation or automatic hyphenation, or a font-shaping engine. The
terminal emulator remains responsible for glyph shaping.
