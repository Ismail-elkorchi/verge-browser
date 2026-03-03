# Architecture and Tradeoffs

`verge-browser` is a deterministic terminal browser, not a full web engine.

## Pipeline
1. Fetch HTML payload with bounded network policy.
2. Parse with `html-parser`.
3. Render document tree into terminal lines plus indexed links.
4. Persist state (history/bookmarks/cookies/recall) via atomic file replacement.

## Why this design
- Determinism: equal input and options should produce equal output.
- Auditable behavior: diagnostics and eval reports are reproducible artifacts.
- Runtime portability: Node, Deno, and Bun are supported with explicit smoke checks.
- Bounded execution: security policy and parse budgets constrain untrusted input.

## Explicit non-goals
- JavaScript execution and DOM mutation model.
- CSS layout/paint parity with browser engines.
- Browser process model and full platform APIs.

## Tradeoffs
- Text-first rendering is robust and explainable, but intentionally less feature-complete than graphical browsers.
- Strict policy gates improve reliability but raise contributor overhead for changes touching contracts.
- Oracle and field workflows add maintenance cost, but keep regression evidence objective and replayable.
