# @ismail-elkorchi/verge-browser

A keyboard- and pointer-driven web browser for the terminal, plus reusable HTML
fetching, parsing, and semantic rendering APIs.

## Install

The interactive CLI requires Node.js 24 or newer:

```sh
npm install --global @ismail-elkorchi/verge-browser
verge
```

Pass a URL to open it directly:

```sh
verge https://example.com
```

Without a URL, Verge restores the previous tabs and scroll positions. A new
profile starts on the New Tab dashboard.

## Browser controls

```text
Ctrl+L              address or web search
Alt+Left/Right      back or forward
Ctrl+R              reload; the toolbar button becomes Stop while loading
Ctrl+F              find in page
F3 / Shift+F3       next or previous match
Ctrl+T / Ctrl+W     new or close tab
Ctrl+Shift+T        reopen the last closed tab
Ctrl+Tab            next tab
Ctrl+1..9           select a tab
Tab / Shift+Tab     move between browser and page controls
Enter               activate the focused control
: / ? / q           actions / help / quit
```

The address field accepts URLs, relative locations, and search terms. Search
uses DuckDuckGo HTML by default. Set `VERGE_SEARCH_URL_TEMPLATE` to a URL
containing `{query}` to use another engine.

Verge renders links and HTML forms as terminal controls, including password
fields that remain redacted from frames, accessibility snapshots, and
transcripts. It also provides exact find results, bookmarks, history, downloads,
reader output, page diagnostics, cookie inspection, and tab/workspace
persistence. Non-HTML navigation offers to download the resource instead of
replacing the current page.

Author CSS contributes page colors, emphasis, visibility, spacing, borders,
and responsive flow, flex, and grid arrangements. Verge resolves custom
properties and width media queries against terminal columns while retaining
semantic HTML when a browser layout cannot be represented. Reader view ignores
author styling, and page CSS never controls browser chrome or focus indication.

Downloads go to `Downloads` unless `VERGE_DOWNLOAD_DIR` is set. Partial files
are removed after cancellation or failure, and existing files are not
overwritten.

## Plain output

`--once` loads one target, renders the same browser element tree as plain text,
and exits without terminal control sequences:

```sh
verge --once https://example.com
```

## Library

```sh
npm install @ismail-elkorchi/verge-browser
```

```ts
import {
  parseHtml,
  renderDocumentToTerminal,
  resolveInputUrl
} from "@ismail-elkorchi/verge-browser";

const target = resolveInputUrl("example.com");
const document = parseHtml("<main><h1>Example</h1></main>");
const page = renderDocumentToTerminal({
  tree: document.tree,
  requestUrl: target,
  finalUrl: target,
  status: 200,
  statusText: "OK",
  fetchedAtIso: new Date().toISOString(),
  width: 80
});
console.log(page.lines.join("\n"));
```

The npm package contains the full Node CLI and library. The JSR package exposes
the permission-light URL and fetch-policy utilities for Deno. Library smoke
checks also run on Bun.

## Boundaries

Verge is an HTML browser, not a Chromium replacement. It does not execute page
JavaScript or attempt pixel layout. Its CSS profile covers responsive terminal
flow and simple flex and grid arrangements, but not arbitrary positioning,
font metrics, generated content, animation, or raster images. Client-rendered
sites, anti-bot challenges, media, and unsupported form encodings may therefore
be unavailable. Network access remains constrained by the package’s protocol,
redirect, content-type, timeout, and size policies.
Interactive projection is capped at 256 forms per page, 2,000 controls per
form, and 2,000 options per select to keep hostile documents responsive.

On POSIX hosts, persisted cookies, history, and workspace data use a `0700`
default profile directory and `0600` state files. Windows uses the current user
profile directory ACL. Automatic cross-origin stylesheets are anonymous, and
page-initiated stylesheets and downloads never inherit the explicit-local-
navigation capability. Links and forms also retain the public-network boundary
and cannot manufacture `file:` or private-network navigation; local targets
remain available when entered explicitly. Cookie `SameSite` context follows the
initiating page for links, forms, redirects, and downloads; omitted attributes
default to `Lax`, and `SameSite=None` cookies require `Secure`.
`Secure` cookies are accepted only from HTTPS responses.

See the [first-session tutorial](docs/tutorial/first-session.md), [CLI
reference](docs/reference/cli.md), and [API overview](docs/reference/api-overview.md).
