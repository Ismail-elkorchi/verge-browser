# First session

Install the Node.js CLI and start it:

```sh
npm install --global @ismail-elkorchi/verge-browser
verge
```

The first run opens a New Tab dashboard. Press `Ctrl+L`, type a URL or search,
and press `Enter`.

Once a page loads:

- `Tab` and `Shift+Tab` move through the toolbar, links, and form controls.
- `Enter` activates the focused control.
- `Alt+Left` and `Alt+Right` traverse page history.
- `Ctrl+F` opens exact in-page search; `F3` advances through matches.
- `Ctrl+T`, `Ctrl+W`, and `Ctrl+Shift+T` open, close, and reopen tabs.
- The Library button opens history, bookmarks, and downloads.
- `:` opens less frequent actions such as reader output, diagnostics, saving
  page source, and opening a page externally.
- `q` exits when a text control is not consuming input.

Verge restores open tabs, scroll positions, the selected tab, and the library
panel on the next normal startup. Supplying an explicit target starts with that
target instead.

Verge renders server-provided HTML. It does not execute page JavaScript or
provide graphical CSS layout.
