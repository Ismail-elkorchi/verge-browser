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
- A first-use loop that starts with `] or Tab`, `Enter`, `h`, `g`, `/`, and `q`.
- A status line that explains the current focus and next valid action.

Press `q` to exit the help session.

## Step 3: Browse a page

```sh
verge https://example.com
```

Expected output shape:
- A page title line such as `Example Domain (https://example.com/)`.
- Deterministic visible-text lines rendered for the current terminal width.
- A status line confirming the resolved URL and request method.
- If you resize the terminal, line wrapping can change even though the browsing
  model stays the same.

## Step 4: Use the first browse loop that matters

Inside the interactive session:

```txt
] or Tab
Enter
h
g
?
q
```

Expected result:
- `]` or `Tab` focuses the next link or form control without leaving the page view.
- `Enter` opens the focused target.
- `h` returns to the previous page.
- `g` opens the location palette so you can type another URL or relative target.
- `?` opens the built-in help detail.
- `q` exits the browser.

## Step 5: Know the CLI-only boundary

- The supported global CLI distribution is the npm `verge` binary on Node.js.
- The published JSR package is a utility surface for URL and fetch-policy helpers, not a global CLI.
- Bun support in this package is documented for library primitives, not as a separately published `verge` binary.
- The interactive CLI renders fetched HTML in a terminal view. It does not
  execute client-side browser JavaScript.
