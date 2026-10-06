# CLI reference

## Usage

```text
verge [initial-target] [--once]
verge --remember-terminal-setting=kitty-force-ltr|konsole-bidi-disabled
verge --forget-terminal-setting=kitty-force-ltr|konsole-bidi-disabled
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

Verge resolves bidirectional text before painting and keeps text native. Normal
`verge` startup automatically asks the terminal-ui host to admit the session.
The session requires application-ordered left-to-right physical cells and matching
cursor, pointer and arrow-key coordinates. Graphics support is a separate decision.

The default support policy admits conventional VT presentation under explicitly
reported assumptions. A terminal name, successful write or mode-8 reply is never
proof of the complete presentation contract. Page diagnostics expose the policy,
evidence and decision from the running TUI context, including assumptions.
These are the capability snapshot before session acquisition: an observed mode-8
`set` and `reset-required` decision describe the input to the verified transition,
not a claim that the running session still has implicit bidirectional processing.
Known configuration hazards, conflicting replies and unsafe mode transitions block
startup before page acquisition or a published frame. The error describes the
actual blocker and remedy. Verge does not switch to ASCII text, rasterized text or
`--once` when admission fails.

The host is the only probe and input-stream owner. Standard mode 8 reports
bidirectional processing, not character direction. Any supported mode change needs
an observed restoration baseline and verification before rendering. An explicit
RTL character path can mirror the canvas even with mode 8 reset. Startup and
resume re-evaluate evidence; contradictory observations cannot be overridden by a
saved setting. Restoration changes only state the session owns and never guesses
that a terminal's default matches its inherited state.

### Remembering an unqueryable setting

Two narrow, optional commands record settings the terminal cannot report. First
configure the terminal itself, then run the matching command there once:

- Kitty: consistently set `force_ltr=yes` across the scope below, then run
  `verge --remember-terminal-setting=kitty-force-ltr`
- Konsole: disable bidirectional rendering in every profile within that scope, then run
  `verge --remember-terminal-setting=konsole-bidi-disabled`

These commands assert an existing setting; they do not change terminal
configuration. Each command exits without opening a page. Later launches use
ordinary `verge`, without flags. A setting can only be remembered when the TUI
recognizes the matching condition and an unambiguous terminal/transport context.
SSH and shared multiplexer contexts cannot safely reuse these exceptions.
A setting for another recorded terminal identity or transport is ignored.

The scope is all direct sessions sharing the host-recorded `TERM`, terminal-program
and reported-version fields. It includes other windows and pre-existing profiles
with those same fields; it does not identify an individual window, profile or
configuration file. Remember a setting only when it is consistently enabled across
that entire scope. A temporary `kitty -o force_ltr=yes` launch is not sufficient.
The assertion is a user-maintained assumption, not a measured or verified setting.
If profiles within that scope need different settings, do not remember an assertion.
If the terminal setting changes, revoke its saved assertion. This works from any
terminal or non-TTY context and removes that condition's record regardless of its
recorded terminal context. Revocation does not need to read the assertion or
ordinary browser state, so malformed records do not prevent their removal:

```sh
verge --forget-terminal-setting=kitty-force-ltr
verge --forget-terminal-setting=konsole-bidi-disabled
```

BrowserStore owns one bounded private atomic file per condition, separate from
ordinary browsing-state writes. At most two assertions are retained, one current
context per condition; remembering a different context replaces that condition's
previous record. Only explicit setting commands change these files, so a stale
running browser cannot recreate a revoked assertion. Concurrent explicit commands
take effect in their atomic replace or unlink order for that condition. They are
never saved automatically after a successful run. They
cannot override an observed contradiction, unknown restoration baseline or a
failed verification. No general trust override or terminal-profile framework is
provided. The former `--terminal-cell-presentation` options, including `existing`,
`mode-8-reset` and `explicit`, and the former plural `--forget-terminal-settings`
option are rejected without aliases.

`--once` deliberately produces plain output and does not acquire terminal state.
Setting-management commands cannot be combined with a target or `--once`.

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
