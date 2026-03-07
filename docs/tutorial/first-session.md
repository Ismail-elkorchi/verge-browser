# First Session

This tutorial shows the fastest supported path to browse a page with the packaged `verge` CLI, then maps that session to the command surface you will use most often.

## Step 1: Install the Node.js CLI

```sh
npm install --global @ismail-elkorchi/verge-browser
```

Expected result:
- The global `verge` command becomes available in your shell.

## Step 2: Start from the built-in help page

```sh
verge about:help
```

Expected output shape:
- A full-screen terminal view titled `verge-browser help`.
- A command list that includes `open <url>`, `links`, `diag`, and `quit`.
- A status line with keyboard shortcuts ending in `q quit`.

Press `q` to exit the help session.

## Step 3: Browse a page

```sh
verge https://example.com
```

Expected output shape:
- A page title line such as `Example Domain (https://example.com/)`.
- Deterministic visible-text lines rendered for the current terminal width.
- A status line confirming the resolved URL and request method.

## Step 4: Use the first commands that matter

Inside the interactive session:

```txt
:links
:diag
q
```

Expected result:
- `:links` shows the numbered links for the current page.
- `:diag` shows parse and network diagnostics for the current page.
- `q` exits the browser.

## Step 5: Know the CLI-only boundary

- The supported global CLI distribution is the npm `verge` binary on Node.js.
- The published JSR package is a utility surface for URL and fetch-policy helpers, not a global CLI.
- Bun support in this package is documented for library primitives, not as a separately published `verge` binary.
