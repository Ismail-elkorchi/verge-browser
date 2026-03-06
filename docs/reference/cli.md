# CLI Reference

## Supported install paths

### Node.js global CLI

Install the published CLI command:

```sh
npm install --global @ismail-elkorchi/verge-browser
```

This installs the `verge` binary from the npm package.

### Node.js local package

Install the package as a project dependency when you want the library exports and the packaged CLI in the same workspace:

```sh
npm install @ismail-elkorchi/verge-browser
```

### Deno, JSR, and Bun

- The published JSR surface exposes URL and fetch-policy utilities, not a global `verge` command.
- Bun support in this package is documented for library primitives, not as a separately published global CLI distribution.
- Use the Node.js npm package when you want the supported interactive CLI.

## Binary name

- `verge`

## Startup form

```txt
verge [initial-target] [--once] [--record-corpus]
```

- The first non-flag argument becomes the initial target URL or special page.
- When no initial target is provided, the CLI reopens the latest history URL if one exists.
- If there is no stored history entry, the CLI starts at `about:help`.

## Special targets

- `about:help`: open the built-in help screen.
- `https://...` / `http://...`: open a remote page under the package's fetch policy.
- `file://...`: open a local file through the Node host.

## CLI flags

### `--once`

- Loads the initial target, then exits before entering the interactive browsing loop.
- Useful for smoke runs and startup validation.
- Does not keep the page view rendered on screen for manual browsing.

### `--record-corpus`

- Records fetched HTML and CSS payloads to the realworld corpus cache while the CLI session runs.
- Intended for the package's field-evaluation workflow rather than normal browsing.

## In-session commands

### Navigation and views

- `help`: show the command help screen.
- `view`: re-render the current page view.
- `reader`: show reader-text output for the current page.
- `links`: show the current page's numbered links.
- `diag`: show parse and network diagnostics.
- `outline`: show heading outline entries.
- `open <url>` / `go <url>`: navigate to a URL.
- `open <n>`: open a numbered link from the links view.
- `stream <url>`: navigate with stream parser mode.
- `back`, `forward`, `reload`: navigate through session history.

### Search and paging

- `find <query>`: search the current view.
- `find next`, `find prev`: move between matches.
- `pagedown`, `pageup`, `top`, `bottom`: move the viewport.

### State and extraction

- `bookmark list`, `bookmark add [name]`, `bookmark open <n>`: manage bookmarks.
- `cookie list`, `cookie clear`: inspect or clear persisted cookies.
- `history`, `history open <n>`: inspect or reopen history entries.
- `recall <query>`, `recall open <n>`: search the local content index.
- `form list`, `form submit <n>`: inspect and submit forms.
- `download <path>`: write the current HTML snapshot to disk.

### Patch commands

- `patch remove-node <id>`
- `patch replace-text <id> <value>`
- `patch set-attr <id> <name> <value>`
- `patch remove-attr <id> <name>`
- `patch insert-before <id> <html>`
- `patch insert-after <id> <html>`

### Exit

- `quit`

## Shortcuts

- `j` / `k` or `Up` / `Down`: scroll one line.
- `Space` / `b`: scroll one page forward or backward.
- `g` / `G`: jump to top or bottom.
- `/`, `n`, `N`: search, next match, previous match.
- `h` / `f` / `r`: back, forward, reload.
- `l` / `?`: links view, help view.
- `m` / `H`: add bookmark, show history.
- `:`: open the command prompt.
- `q`: quit.

## Related

- [First session tutorial](../tutorial/first-session.md)
- [Install and run the CLI](../how-to/install-and-run-cli.md)
- [API overview](./api-overview.md)
- [Error model](./error-model.md)
