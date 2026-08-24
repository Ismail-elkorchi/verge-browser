# API Overview

This package publishes two documented entrypoints with different scope.

## Entrypoints

| Entrypoint | Intended use | Notes |
| --- | --- | --- |
| `@ismail-elkorchi/verge-browser` | npm/Node library primitives and packaged CLI | Includes the interactive `verge` binary plus the supported fetch, session, rendering, and host adapters |
| `jsr:@ismail-elkorchi/verge-browser` | Utility-only Deno/JSR imports | Exposes safe URL and fetch-policy helpers, not the interactive CLI |

## JSR surface

JSR exports are defined by [`jsr/mod.ts`](../../jsr/mod.ts).

JSR exports:
- `DEFAULT_SECURITY_POLICY`
- `assertAllowedProtocol(url)`
- `assertAllowedUrl(rawUrl)`
- `isHtmlLikeContentType(contentType)`
- `resolveInputUrl(rawInput, currentUrl?)`
- `resolveHref(href, baseUrl)`
- `SecurityPolicyOptions` (type)

## Node/npm surface

Node/npm type surface is shipped from `dist/mod.d.ts` (source module: `src/mod.ts`).

Node/npm includes the supported library primitives and the packaged `verge` CLI binary:
- command parsing and formatting
- page, stream, and stylesheet fetch adapters
- browser sessions, including caller-supplied redirect-aware cookie handling
- CSS-aware session, paging, search, rendering, and terminal helpers
- runtime hosts (Node/Deno/Bun)
- exported runtime and diagnostics types

The root keeps the legacy `renderDocumentToTerminal()` and
`PageSnapshot.rendered` adapters, but does not
export the browser-internal `PageContent`, `PageBlock`, or `PageLayout`
flatten-first contracts. This leaves room for a box-tree and fragment-tree
renderer without expanding the stable surface prematurely.

## Behavioral boundary

- JSR intentionally exposes a small URL/security utility surface for
  permission-light usage.
- Node/npm exposes the supported library API; the CLI’s workspace controller,
  persistent store, and view model remain implementation details.
- Shared concepts such as URL resolution and protocol safety are behaviorally
  aligned across both entrypoints.
- CLI-specific views, command help, browser sessions, and Node platform services
  are npm/Node concerns, not part of the published JSR API.

## Related
- [Options](./options.md)
- [Error model](./error-model.md)
