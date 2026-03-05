# API Overview

## JSR Surface

JSR exports are defined by [`jsr/mod.ts`](../../jsr/mod.ts).

JSR exports:
- `DEFAULT_SECURITY_POLICY`
- `assertAllowedProtocol(url)`
- `assertAllowedUrl(rawUrl)`
- `isHtmlLikeContentType(contentType)`
- `resolveInputUrl(rawInput, currentUrl?)`
- `resolveHref(href, baseUrl)`
- `SecurityPolicyOptions` (type)

## Node/npm Surface

Node/npm type surface is shipped from `dist/mod.d.ts` (source module: `src/mod.ts`).

Node/npm includes the full browser runtime stack:
- command parsing and formatting
- cookie parsing/merging
- fetch + stream fetch adapters
- session, paging, search, rendering, shortcuts
- runtime hosts (Node/Deno/Bun)
- exported runtime and diagnostics types

## JSR Surface vs Node Surface

- JSR intentionally exposes a small URL/security utility surface for permission-light Deno usage.
- Node/npm exposes the complete interactive/browser runtime API.
- Shared concepts (URL resolution and protocol safety) are behaviorally aligned.

## Related
- [Options](./options.md)
- [Error model](./error-model.md)
