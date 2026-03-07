# Install And Run The CLI

## Goal
Install the packaged `verge` command on Node.js and open a page in the interactive terminal browser.

## Prerequisites
- Node.js `>=20`
- npm `>=10`
- A terminal session with network access to the page you want to open

## Copy/paste
```sh
npm install --global @ismail-elkorchi/verge-browser
verge about:help
verge https://example.com
```

## Expected output
- `verge about:help` opens a full-screen help view titled `verge-browser help`.
- `verge https://example.com` opens a full-screen page view with the page title, visible text lines, a status line, and a compact footer for the current screen.
- From that page view, `]` or `Tab` focuses the next link or control, `Enter` opens it, `h` goes back, and `g` opens location entry.
- Press `q` to exit the interactive session.
- Line wrapping can vary with terminal width, but the first-use key flow and
  action semantics stay the same.

## Common failure modes
- `deno add jsr:@ismail-elkorchi/verge-browser` is used with the expectation that it installs a global `verge` command. The JSR package is utility-only and does not publish the CLI binary.
- `verge` is run without a target and the user expects a deterministic first page. The CLI reopens the latest history URL when one exists, otherwise it starts at `about:help`.
- `verge <url> --once` is used for manual browsing. `--once` loads the initial target and exits without entering the interactive loop.
- The user expects `:` to open a hidden shell prompt like the old UI. In the redesigned CLI, `:` opens the visible action palette.
- A non-HTTP target with an unsupported protocol is passed as the initial URL.
- The user expects browser JavaScript execution. The CLI renders fetched HTML
  and direct page actions, but it does not execute page scripts.

## Related reference
- [CLI reference](../reference/cli.md)
- [API overview](../reference/api-overview.md)
- [Error model](../reference/error-model.md)
