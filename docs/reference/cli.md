# CLI reference

## Usage

```text
verge [initial-target] [--once] [--terminal-cell-presentation=existing|mode-8-reset]
```

- An explicit target opens in a fresh browser workspace.
- Without a target, Verge displays saved-tab placeholders immediately, restores
  the active tab first, then restores background tabs independently; a new
  profile opens `about:newtab`.
- `about:help` opens the built-in help document.
- `http:`, `https:`, `file:`, and supported `about:` targets are accepted.

The interactive CLI is a Node.js npm distribution. Deno and Bun support applies
to the package’s library primitives.

## Terminal presentation

Verge resolves bidirectional text before painting. Interactive startup requires
application-ordered left-to-right physical cells, with matching cursor, pointer
and arrow-key coordinates. Standard mode 8 reports bidirectional processing;
it does **not** establish character direction or the complete presentation
contract. An explicit RTL character path can mirror the entire canvas even
when mode 8 reports reset.

Use one invocation-scoped declaration only after qualifying the actual terminal
configuration and transport:

- `--terminal-cell-presentation=existing` declares that the full contract already
  holds. It does not configure the terminal or override contradictory evidence.
- `--terminal-cell-presentation=mode-8-reset` declares that the full contract holds
  after a verified reset of standard mode 8, including an independently known
  LTR character path. The host requires a known restoration baseline and verifies
  any mode change before rendering.

The qualification applies throughout the host lifetime, including suspend and
resume. External terminal use must preserve its qualified preconditions. A new
mode query refreshes raw mode evidence; it cannot verify an unreported character
path. Terminal names, graphics support, and a successful write do not establish
this guarantee. Unknown presentation fails before a frame is published.

The old `explicit` value is rejected. `--once` produces plain output and does not
acquire terminal state, regardless of a declaration.

### Qualified configurations

Kitty 0.45.0 needs `force_ltr=yes`; its stock behavior changes RTL glyph order.
The option alone does not configure Kitty:

```sh
kitty -o force_ltr=yes verge --terminal-cell-presentation=existing https://example.com
```

Ghostty 1.3.1's tested configuration preserves application cell order but does
not report standard mode 8:

```sh
ghostty -e verge --terminal-cell-presentation=existing https://example.com
```

VTE/Ptyxis and WezTerm also have an independent character-path setting. In a
qualified LTR configuration, use `mode-8-reset` to permit the observed, verified
bidirectional-mode transition. A mode-8 reset reply alone is insufficient; do
not use the declaration to conceal an unknown or inherited RTL direction.

The application does not force SCP LTR and then restore SCP default: default
is not necessarily the inherited state, and these inspected versions expose no
verified exact restoration path. The full-screen session restores the raw modes
it actually owns. See [Unicode text layout](../architecture/unicode-text.md).

Qualification records distinguish native versions, configuration, fonts and
transport. Debian checks of Kitty 0.45.0, Ghostty 1.3.1 and WezTerm
`20260912-133823-2afb8364` are not universal Ubuntu or multiplexer guarantees.
Final-source checks covered missing-declaration rejection, qualified startup,
pointer targeting within Hebrew text, physical Right/Left caret movement, mixed-text
edits, partial redraw and Ctrl-C in these three terminals and Xfce/VTE 0.80.1.
All eight admission cases restored termios exactly. VTE inherited RTL rejection
was also observed visually; no equivalent WezTerm visual-reversal claim is made.
Cooperative suspension/resume is covered by runtime tests, not a native CLI
job-control claim. Full native Ubuntu Ptyxis qualification remains separate.

### Observed graphics redraw limitation

During native qualification on Kitty 0.45.0, a first graphics frame after an idle
interval sometimes showed cleared rectangles until the next redraw. The same
captured output reproduced this in a standalone terminal replay without Verge
running. An empty synchronized redraw revealed the existing images without
retransmitting or replacing them. This isolates a timing-dependent terminal
presentation limitation; it does not establish the exact internal cause.
Native text remained visible. Verge does not add periodic redraws to conceal it.

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
