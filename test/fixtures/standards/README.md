# Standards-derived rendering fixtures

The focused cases in `document.test.js`, `style.test.js`, `formatting.test.js`,
and `terminal-presentation.test.js` are original compact fixtures derived from
the normative behavior covered by these pinned Web Platform Test areas:

- CSS Display: `css/css-display/display-*` and `run-in/*` concepts at
  web-platform-tests/wpt commit `88fc35189f7f51ef5a21f523aa29da72d839ed67`;
- CSS tables: `css/css-tables/anonymous-boxes-*` at the same commit;
- CSS cascade and selectors: `css/css-cascade/` and `css/selectors/` at the
  same commit;
- HTML default rendering, lists, tables, and forms under `html/rendering/` at
  the same commit.

No WPT source or expected output is copied. The fixtures are maintained under
this repository's MIT license and record the upstream commit solely for
provenance and repeatability.

The sibling `pages/` directory contains original, recorded local fixtures for
common article/form and dashboard/table structures. They have no external
runtime dependency and are maintained under this repository's MIT license.
