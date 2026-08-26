# Offline web compatibility corpus

The corpus contains independently authored, MIT-licensed structural fixtures
for articles, documentation, forums, search results, product listings, forms,
dashboards, responsive layouts, multilingual LTR and RTL content,
progressive enhancement, and script-dependent shells. `corpus.json` pins every
fixture by SHA-256. Normal qualification performs no network access.

Run `npm run compat:check` to build Verge, render every fixture through the
native document tree → computed style map → box tree → layout fragment tree →
display list → cell buffer pipeline, write `reports/compatibility.json`, and
enforce the static-corpus gates. The report records visible-text, heading,
landmark, link, form-control, and reading-order metrics plus unsupported CSS,
resource failures, and typed layout or terminal truncation.

`baseline-before.json` records the same corpus against protected main at the
start of this milestone; `baseline-after.json` records the final native gates.
They are evidence, not expected-output snapshots.

## Optional Chromium comparison

`npm run compat:oracle` is development-only. It requires the developer to set
`CHROMIUM_EXECUTABLE` and separately install `playwright-core`; neither is a
Verge dependency. The oracle disables page scripting and records meaningful
text, semantics, logical order, principal rectangles, computed display and
visibility, and stylesheet resources. Passing `--classify-script-required`
also records a separate scripting-enabled observation solely to classify
script-dependent pages. Chromium never enters the native rendering path.
