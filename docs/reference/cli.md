# CLI Reference

## Supported install paths

### Node.js global CLI

```sh
npm install --global @ismail-elkorchi/verge-browser
```

This installs the supported `verge` binary from npm.

### Node.js project dependency

```sh
npm install @ismail-elkorchi/verge-browser
```

Use this when you want the library exports and the packaged CLI in the same workspace.

### Deno, JSR, and Bun

- The published JSR surface exposes URL and fetch-policy utilities, not a global `verge` command.
- Bun support in this package is documented for library primitives, not as a separately published global CLI distribution.
- Use the Node.js npm package when you want the supported interactive CLI.

## Startup form

```txt
verge [initial-target] [--once] [--record-corpus] [--screen-reader]
```

- The first non-flag argument becomes the initial target URL or special page.
- When no initial target is provided, the CLI reopens the latest history URL if one exists.
- If there is no stored history entry, the CLI starts at `about:help`.

## Special targets

- `about:help`: open the built-in help page.
- `https://...` / `http://...`: open a remote page under the package's fetch policy.
- `file://...`: open a local file through the Node host.

## First-use browse loop

Once the page is open:

- `]` or `Tab`: focus the next link or control from the page view.
- `[` or `Shift+Tab`: focus the previous link or control.
- `Enter`: open the focused link or control.
- `h`, `f`, `r`: back, forward, reload.
- `g`: open the location palette for URL entry.
- `/`: open in-page search.
- `n`, `N`: move to the next or previous search match.
- `Esc`: back out of search, link/control focus, or transient screens.
- `q`: quit.

The page view is the primary browse surface. Users should not need to type a freeform command just to follow links.

## Screens

### Browse screen

- shows the rendered page
- keeps reading focus and link/control focus explicit
- supports direct page-to-page browsing

### Picker screen

Used for:

- links
- documents
- history
- bookmarks
- forms
- outline
- recall results

Picker keys:

- `Up` / `Down`: move selection
- `Home` / `End`: jump to the first or last item
- `Enter`: activate the selected item
- digits: fill the visible jump field
- `/`: focus the filter input
- `Tab`: move between the filter input and the list
- `Esc`: clear jump, then clear filter, then leave the picker

### Location or action palette

- `g` opens location mode
- `:` opens action mode
- `Enter` runs the current input
- `Up` / `Down` move through visible suggestions
- `Esc` closes the palette without navigating

### Detail screen

Used for help, diagnostics, reader output, and cookies.

### Editor screen

Used for form editing.

- `Enter` starts editing the selected field
- `Tab` moves to the next field
- `s` submits the form
- `x` opens the external editor for the selected field
- `Esc` stops editing or starts the explicit discard flow

## Action palette grammar

The action palette uses one documented command grammar.

Common actions:

- `links`
- `documents`
- `history`
- `bookmark add [name]`
- `bookmarks`
- `forms`
- `outline`
- `diag`
- `download <path>`
- `save text <path>`
- `save csv <path>`
- `open-external`
- `close`
- `reopen`

Navigation and search actions:

- `go <url>`
- `stream <url>`
- `find <query>`
- `find next`
- `find prev`

Collection and submission actions:

- `bookmark open <n>`
- `history open <n>`
- `recall <query>`
- `recall open <n>`
- `form submit <n> [name=value ...]`

Low-level patch actions:

- `patch remove-node <id>`
- `patch replace-text <id> <value>`
- `patch set-attr <id> <name> <value>`
- `patch remove-attr <id> <name>`
- `patch insert-before <id> <html>`
- `patch insert-after <id> <html>`

## Flags

### `--once`

- Loads the initial target, renders it once, then exits before entering the interactive loop.
- Useful for smoke runs and startup validation.

### `--record-corpus`

- Records fetched HTML and CSS payloads to the realworld corpus cache while the CLI session runs.
- Intended for field-evaluation workflows rather than normal browsing.

### `--screen-reader`

- Uses the screen-reader-friendly chrome profile.
- Keeps the footer and status lines explicit while avoiding decorative separators.

## Related

- [First session tutorial](../tutorial/first-session.md)
- [Install and run the CLI](../how-to/install-and-run-cli.md)
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
