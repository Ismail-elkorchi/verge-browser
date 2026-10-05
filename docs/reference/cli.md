# CLI reference

## Usage

```text
verge [initial-target] [--once] [--terminal-cell-presentation=explicit]
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
When the terminal is independently configured to preserve application-ordered
cells but cannot report standard mode 8, pass
`--terminal-cell-presentation=explicit`. This declares the current state through
the host's existing initial-state contract; it does not change terminal settings
or suppress contradictory observed state. Never use it for an unqualified
terminal or transport.

Kitty 0.45.0 needs `force_ltr=yes` for this configuration:

```sh
kitty -o force_ltr=yes verge --terminal-cell-presentation=explicit https://example.com
```

The upstream 0.45.0 Linux binary was checked directly on Debian 13. Its stock
`force_ltr=no` configuration reorders RTL words and is not qualified. Both
configurations report standard mode 8 as unrecognized. This is not a claim
about every Ubuntu package, font, multiplexer, or remote transport. Terminal
startup errors retain the failed operation's reason and restoration diagnostics.

Ghostty 1.3.1 was also built from its signed source and checked on Debian 13.
Its standard mode 8 query is ignored, while the checked default configuration
preserves cell order. That configuration can use the same declaration:

```sh
ghostty -e verge --terminal-cell-presentation=explicit https://example.com
```

WezTerm `20260912-133823-2afb8364`, built from its unmodified source on Debian 13,
starts without the declaration: standard mode 8 reports explicit presentation.
Its unrecognized alternate-screen query does not negate working set/reset
support. Native startup, mixed-direction editing, interruption and terminal
restoration were checked. Ubuntu 26.04 Ptyxis could not be launched in the test
runtime because of GTK incompatibility and a terminal-helper permission failure.
These checks do not establish support for every Ubuntu package, multiplexer or
remote-session configuration.

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
