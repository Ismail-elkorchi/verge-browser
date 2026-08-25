# API Overview

This package publishes two documented entrypoints with different scope.

## Entrypoints

| Entrypoint | Intended use | Notes |
| --- | --- | --- |
| `@ismail-elkorchi/verge-browser` | npm/Node library primitives and packaged CLI | Includes the interactive `verge` binary plus document, fetch, session, and host contracts |
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
- immutable `WebDocumentSnapshot` values returned by browser navigation
- CSS-aware browser sessions whose render pipeline remains browser-internal
- runtime hosts (Node/Deno/Bun)
- exported runtime and diagnostics types

`PageSnapshot.document` is the one authoritative document snapshot. The
package root deliberately does not expose fixed-width rendered snapshots or
the internal computed style map, box tree, fragment tree, and terminal rows.
Interactive and one-shot CLI output both use those same internal
structural stages.

The package root exposes one read-only `WebDocumentSnapshot` interface through
navigation results. Document factories, indexed semantic contracts, dynamic
state, the concrete implementation, and HTML-parser result types are internal.

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
