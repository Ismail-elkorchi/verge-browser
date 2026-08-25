/**
 * Structured command result returned by {@link parseCommand}.
 *
 * The union models both recognized commands and user-facing parse failures. The
 * parser returns `{ kind: "invalid" }` for unsupported or incomplete input
 * instead of throwing.
 */
export type BrowserCommand =
  | { readonly kind: "help" }
  | { readonly kind: "quit" }
  | { readonly kind: "reader" }
  | { readonly kind: "links" }
  | { readonly kind: "diag" }
  | { readonly kind: "outline" }
  | { readonly kind: "page-down" }
  | { readonly kind: "page-up" }
  | { readonly kind: "page-top" }
  | { readonly kind: "page-bottom" }
  | { readonly kind: "find"; readonly query: string }
  | { readonly kind: "find-next" }
  | { readonly kind: "find-prev" }
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" }
  | { readonly kind: "bookmark-list" }
  | { readonly kind: "bookmark-add"; readonly name?: string }
  | { readonly kind: "cookie-list" }
  | { readonly kind: "cookie-clear" }
  | { readonly kind: "history-list" }
  | { readonly kind: "download-list" }
  | { readonly kind: "recall"; readonly query: string }
  | { readonly kind: "close-document" }
  | { readonly kind: "reopen-document" }
  | { readonly kind: "download"; readonly target?: string }
  | { readonly kind: "save-page"; readonly path: string }
  | { readonly kind: "save-text"; readonly path: string }
  | { readonly kind: "open-external" }
  | { readonly kind: "go"; readonly target: string }
  | { readonly kind: "go-stream"; readonly target: string }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Parses action-palette input into a structured {@link BrowserCommand}.
 *
 * The grammar is whitespace-tolerant and stable for the documented verbs. When
 * input is unsupported or incomplete, the function returns an `invalid`
 * command with a reason instead of throwing.
 *
 * @param rawInput User-entered command text.
 * @returns Structured command object for the recognized grammar, or an
 * `invalid` command with a human-readable reason.
 *
 * @example Basic commands
 * ```ts
 * console.log(parseCommand("bookmark add docs").kind);
 * console.log(parseCommand("save page ./snapshot.html").kind);
 * console.log(parseCommand("bookmark unknown").kind);
 * ```
 */
export function parseCommand(rawInput: string): BrowserCommand {
  const trimmedInput = rawInput.trim();
  if (trimmedInput.length === 0) {
    return { kind: "invalid", reason: "Command is empty" };
  }

  const [head = "", ...tailParts] = trimmedInput.split(/\s+/);
  const headLower = head.toLowerCase();
  const tail = tailParts.join(" ").trim();

  if (headLower === "help" || headLower === "?") return { kind: "help" };
  if (headLower === "quit" || headLower === "exit" || headLower === "q") return { kind: "quit" };
  if (headLower === "reader") return { kind: "reader" };
  if (headLower === "links") return { kind: "links" };
  if (headLower === "diag" || headLower === "diagnostics" || headLower === "status") return { kind: "diag" };
  if (headLower === "outline") return { kind: "outline" };
  if (headLower === "pagedown" || headLower === "pd") return { kind: "page-down" };
  if (headLower === "pageup" || headLower === "pu") return { kind: "page-up" };
  if (headLower === "top") return { kind: "page-top" };
  if (headLower === "bottom") return { kind: "page-bottom" };
  if (headLower === "next") return { kind: "find-next" };
  if (headLower === "prev" || headLower === "previous") return { kind: "find-prev" };
  if (headLower === "back") return { kind: "back" };
  if (headLower === "forward") return { kind: "forward" };
  if (headLower === "reload") return { kind: "reload" };

  if (headLower === "bookmark" || headLower === "bookmarks" || headLower === "bm") {
    if (tail.length === 0 || tail.toLowerCase() === "list") {
      return { kind: "bookmark-list" };
    }

    const bookmarkParts = tail.split(/\s+/);
    const bookmarkSubcommand = bookmarkParts[0]?.toLowerCase() ?? "";
    const bookmarkRest = bookmarkParts.slice(1).join(" ").trim();
    if (bookmarkSubcommand === "add") {
      return bookmarkRest.length > 0 ? { kind: "bookmark-add", name: bookmarkRest } : { kind: "bookmark-add" };
    }
    return { kind: "invalid", reason: "bookmark supports: list | add [name]" };
  }

  if (headLower === "cookie" || headLower === "cookies") {
    if (tail.length === 0 || tail.toLowerCase() === "list") {
      return { kind: "cookie-list" };
    }
    if (tail.toLowerCase() === "clear") {
      return { kind: "cookie-clear" };
    }
    return { kind: "invalid", reason: "cookie supports: list | clear" };
  }

  if (headLower === "history" || headLower === "hist") {
    if (tail.length === 0 || tail.toLowerCase() === "list") {
      return { kind: "history-list" };
    }

    return { kind: "invalid", reason: "history supports: list" };
  }

  if (headLower === "downloads") return { kind: "download-list" };

  if (headLower === "recall") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "recall requires a query" };
    }
    return { kind: "recall", query: tail };
  }

  if (headLower === "download") {
    return tail.length === 0 ? { kind: "download" } : { kind: "download", target: tail };
  }

  if (headLower === "save") {
    const saveParts = tail.split(/\s+/).filter((part) => part.length > 0);
    const saveMode = saveParts[0]?.toLowerCase() ?? "";
    const savePath = saveParts.slice(1).join(" ").trim();
    if ((saveMode !== "text" && saveMode !== "page") || savePath.length === 0) {
      return { kind: "invalid", reason: "save supports: page <path> | text <path>" };
    }
    return saveMode === "page"
      ? { kind: "save-page", path: savePath }
      : { kind: "save-text", path: savePath };
  }

  if (headLower === "open-external") {
    return { kind: "open-external" };
  }

  if (headLower === "close") {
    return { kind: "close-document" };
  }

  if (headLower === "reopen") {
    return { kind: "reopen-document" };
  }

  if (headLower === "open") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "open requires a URL" };
    }
    return { kind: "go", target: tail };
  }

  if (headLower === "go") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "go requires a URL" };
    }
    return { kind: "go", target: tail };
  }

  if (headLower === "stream" || headLower === "go-stream") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "stream requires a URL" };
    }
    return { kind: "go-stream", target: tail };
  }

  if (headLower === "find" || headLower === "search") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "find requires a query, or use: find next | find prev" };
    }
    const tailLower = tail.toLowerCase();
    if (tailLower === "next") {
      return { kind: "find-next" };
    }
    if (tailLower === "prev" || tailLower === "previous") {
      return { kind: "find-prev" };
    }
    return { kind: "find", query: tail };
  }

  return { kind: "go", target: trimmedInput };
}

/**
 * Returns the built-in help text for the terminal UI.
 *
 * Keep this text aligned with the supported browse keys, action-palette
 * grammar, and CLI flags. Tests and smoke coverage treat it as user-facing
 * reference output.
 *
 * @returns Multi-line help text covering browser controls, action examples,
 * and CLI flags.
 *
 * @example Usage
 * ```ts
 * const help = formatHelpText();
 * console.log(help.includes("Browser controls:"));
 * ```
 */
export function formatHelpText(): string {
  return [
    "Browser controls:",
    "  Ctrl+L              Focus the address and search field",
    "  Alt+Left/Right      Go back or forward",
    "  Ctrl+R              Reload the page",
    "  Ctrl+F              Find in the current page",
    "  F3 / Shift+F3       Next or previous match",
    "  Tab / Shift+Tab     Move between browser and page controls",
    "  Enter               Activate the focused control",
    "",
    "Tabs and page:",
    "  Ctrl+T / Ctrl+W     Open or close a tab",
    "  Ctrl+Shift+T        Reopen the last closed tab",
    "  Ctrl+Tab            Select the next tab",
    "  Ctrl+1..9           Select a tab by number",
    "  Up/Down             Scroll the current screen",
    "  PageUp/PageDown     Move by one page",
    "  Home/End            Jump to top or bottom",
    "  Esc                 Close a dialog, find bar, or page focus",
    "  : / ? / q           Actions / help / quit",
    "",
    "Action palette examples:",
    "  links               Open the links picker",
    "  outline             Open the heading outline",
    "  history             Open persisted history",
    "  bookmark add [name] Save the current page as a bookmark",
    "  download [url]      Download the current resource or a URL",
    "  save page <path>    Save the current HTML source",
    "  save text <path>    Export the readable page text",
    "  open-external       Open the current page outside Verge",
    "",
    "CLI flags:",
    "  --once              Load the initial target once, then exit"
  ].join("\n");
}
