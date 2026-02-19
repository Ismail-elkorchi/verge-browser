# Field issue list

Run ids:
- `field-offline`: `6746db01415336106452f98d28a452f1410624f66922b3f511e5c0ab534dc33b`
- `field-oracles`: `c93eb94878758dee9459c335ffb9373e3ac26541f87e9bd948c9a1cb15ca18e7`

Oracle availability:
- lynx: unavailable
- w3m: unavailable
- links2: unavailable

Parse parity on cached corpus:
- `parseBytes` vs `parseStream`: `0` mismatches

Stable issue ids (synthetic reproduction tracking):

1. `FLD-VTXT-001`
   - Pattern: navigation block boundary extraction with dense links.
   - Reproduction: `html-parser` `case-045`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
2. `FLD-VTXT-002`
   - Pattern: figure image-alt emission with figcaption adjacency.
   - Reproduction: `html-parser` `case-046`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
3. `FLD-VTXT-003`
   - Pattern: nested list paragraph separation.
   - Reproduction: `html-parser` `case-047`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
4. `FLD-VTXT-004`
   - Pattern: table cell tab boundaries with line-break-in-cell behavior.
   - Reproduction: `html-parser` `case-048`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
5. `FLD-VTXT-005`
   - Pattern: preformatted block and paragraph adjacency.
   - Reproduction: `html-parser` `case-049`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
6. `FLD-VTXT-006`
   - Pattern: linked image-alt token fusion with surrounding inline text.
   - Reproduction: `html-parser` `case-050`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
7. `FLD-VTXT-007`
   - Pattern: hidden input suppression with visible control values.
   - Reproduction: `html-parser` `case-051`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
8. `FLD-VTXT-008`
   - Pattern: `aria-hidden=\"1\"` subtree suppression.
   - Reproduction: `html-parser` `case-052`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
9. `FLD-VTXT-009`
   - Pattern: details/summary line-break boundaries.
   - Reproduction: `html-parser` `case-053`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
10. `FLD-VTXT-010`
   - Pattern: script exclusion with fallback noscript visibility.
   - Reproduction: `html-parser` `case-054`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
11. `FLD-VTXT-011`
   - Pattern: template subtree exclusion.
   - Reproduction: `html-parser` `case-055`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
12. `FLD-VTXT-012`
   - Pattern: inline SVG + MathML adjacency before block breaks.
   - Reproduction: `html-parser` `case-056`.
   - Classification: coverage gap closed.
   - Status: merged in PR #56.
