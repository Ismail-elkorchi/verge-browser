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
- `verge https://example.com` opens a full-screen page view with the page title, visible text lines, a status line, and shortcut hints.
- Press `q` to exit the interactive session.

## Common failure modes
- `deno add jsr:@ismail-elkorchi/verge-browser` is used with the expectation that it installs a global `verge` command. The JSR package is utility-only and does not publish the CLI binary.
- `verge` is run without a target and the user expects a deterministic first page. The CLI reopens the latest history URL when one exists, otherwise it starts at `about:help`.
- `verge <url> --once` is used for manual browsing. `--once` loads the initial target and exits without entering the interactive loop.
- A non-HTTP target with an unsupported protocol is passed as the initial URL.

## Related reference
- [CLI reference](../reference/cli.md)
- [API overview](../reference/api-overview.md)
- [Error model](../reference/error-model.md)
