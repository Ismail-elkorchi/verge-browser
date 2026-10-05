# CLI reference

## Usage

```text
verge [initial-target] [--once]
```

- An explicit target opens in a fresh browser workspace.
- Without a target, Verge displays saved-tab placeholders immediately, restores
  the active tab first, then restores background tabs independently; a new
  profile opens `about:newtab`.
- `about:help` opens the built-in help document.
- `http:`, `https:`, `file:`, and supported `about:` targets are accepted.

The interactive CLI is a Node.js npm distribution. Deno and Bun support applies
to the package’s library primitives.

Interactive startup requires a terminal host that can establish explicit
visual-cell presentation: Verge orders page and editor text, and the terminal
must preserve that order. Unknown or unsupported state fails startup rather
than guessing from `TERM`. The full-screen session acquires a fresh owned screen
and restores its original known mode on exit. `--once` does not acquire terminal
modes. See [Unicode text layout](../architecture/unicode-text.md) for the host
contract.

Graphics protocol support alone does not satisfy this text-presentation contract.
For example, Kitty 0.48.2 does not establish the required state through the default
mode probe. A custom host can declare explicit cell presentation only after its
terminal configuration has been qualified; the image qualification uses Kitty's
`force_ltr=yes` with the existing host `initialState.cellPresentation` contract.
This does not make an unconfigured Kitty session a supported CLI startup target.

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

Enter in a supported single-line form input attempts HTML implicit submission.
The first associated submit button is the default; a disabled default does not
fall through to a later button. With no submit button, only a form with at most
one blocking input submits. Enter in a textarea remains an editing action.

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

## Environment

- `VERGE_SEARCH_URL_TEMPLATE`: search URL containing `{query}`.
- `VERGE_DOWNLOAD_DIR`: download destination directory.

## `--once`

`--once` loads one target and consumes the same terminal display list and cell
buffer used by the interactive page view. It does not enter raw terminal mode
or emit terminal control sequences.

Both modes derive the same rendering preferences from the terminal environment.
`VERGE_COLOR_SCHEME=light|dark` overrides `COLORFGBG`,
`VERGE_REDUCED_MOTION=reduce` enables reduced-motion media queries,
`VERGE_UNICODE=0` selects ASCII borders, and `VERGE_AMBIGUOUS_WIDTH=2` selects
wide East Asian ambiguous characters. `VERGE_POINTER=none|coarse|fine` and
`VERGE_HOVER=none|hover` set interaction media features. `NO_COLOR`,
`COLORTERM`, and `TERM` determine the terminal color depth used for actual cell
colors.

## Browser boundary

Verge renders semantic server-provided HTML. It does not execute client-side
JavaScript or implement graphical CSS layout.
