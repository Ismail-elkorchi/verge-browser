# API Overview

This package publishes two documented entrypoints with different scope.

## Entrypoints

| Entrypoint | Intended use | Notes |
| --- | --- | --- |
| `@ismail-elkorchi/verge-browser` | Full npm/Node library and packaged CLI | Includes the interactive `verge` binary and the full browser/session runtime surface |
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

Node/npm includes the full browser runtime stack and the packaged `verge` CLI binary:
- command parsing and formatting
- cookie parsing/merging
- fetch + stream fetch adapters
- session, paging, search, rendering, terminal helpers
- runtime hosts (Node/Deno/Bun)
- exported runtime and diagnostics types

## Behavioral boundary

- JSR intentionally exposes a small URL/security utility surface for
  permission-light usage.
- Node/npm exposes the complete interactive/browser runtime API.
- Shared concepts such as URL resolution and protocol safety are behaviorally
  aligned across both entrypoints.
- CLI-specific screens, command help, browser sessions, and terminal adapters
  are npm/Node concerns, not part of the published JSR API.

## Related
- [Options](./options.md)
- [Error model](./error-model.md)
