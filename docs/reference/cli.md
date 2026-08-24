# CLI reference

## Usage

```text
verge [initial-target] [--once]
```

- An explicit target opens in a fresh browser workspace.
- Without a target, Verge restores the saved workspace or opens `about:newtab`.
- `about:help` opens the built-in help document.
- `http:`, `https:`, `file:`, and supported `about:` targets are accepted.

The interactive CLI is a Node.js npm distribution. Deno and Bun support applies
to the package’s library primitives.

## Browser keys

| Key | Action |
| --- | --- |
| `Ctrl+L` | Focus address/search |
| `Alt+Left`, `Alt+Right` | Back, forward |
| `Ctrl+R` | Reload |
| `Ctrl+F` | Find in page |
| `F3`, `Shift+F3` | Next, previous match |
| `Ctrl+T`, `Ctrl+W` | New, close tab |
| `Ctrl+Shift+T` | Reopen tab |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Next, previous tab |
| `Ctrl+1`…`Ctrl+9` | Select tab |
| `Tab`, `Shift+Tab` | Move through controls |
| `Enter` | Activate the focused control |
| Arrow/Page/Home/End keys | Scroll |
| `:` | Open action palette |
| `?` | Help |
| `Esc` | Close the current transient UI |
| `q`, `Ctrl+C` | Quit |

## Action palette

Common actions:

```text
links
outline
reader
diagnostics
history
bookmarks
downloads
bookmark add [name]
download [url]
save page <path>
save text <path>
open-external
cookies
cookie clear
close
reopen
```

Navigation and find are also available:

```text
go <url-or-search>
stream <url>
back
forward
reload
find <query>
find next
find prev
recall <query>
```

Low-level HTML patch commands remain available for parser and audit workflows:

```text
patch remove-node <id>
patch replace-text <id> <value>
patch set-attr <id> <name> <value>
patch remove-attr <id> <name>
patch insert-before <id> <html>
patch insert-after <id> <html>
```

## Environment

- `VERGE_SEARCH_URL_TEMPLATE`: search URL containing `{query}`.
- `VERGE_DOWNLOAD_DIR`: download destination directory.

## `--once`

`--once` loads one target, renders the browser’s element tree to plain text, and
exits. It does not enter raw terminal mode or emit terminal control sequences.

## Browser boundary

Verge renders semantic server-provided HTML. It does not execute client-side
JavaScript or implement graphical CSS layout.
