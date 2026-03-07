export type BrowserCommand =
  | { readonly kind: "help" }
  | { readonly kind: "quit" }
  | { readonly kind: "view" }
  | { readonly kind: "reader" }
  | { readonly kind: "links" }
  | { readonly kind: "documents" }
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
  | { readonly kind: "bookmark-open"; readonly index: number }
  | { readonly kind: "cookie-list" }
  | { readonly kind: "cookie-clear" }
  | { readonly kind: "history-list" }
  | { readonly kind: "history-open"; readonly index: number }
  | { readonly kind: "recall"; readonly query: string }
  | { readonly kind: "recall-open"; readonly index: number }
  | { readonly kind: "form-list" }
  | { readonly kind: "form-submit"; readonly index: number; readonly overrides: Readonly<Record<string, string>> }
  | { readonly kind: "close-document" }
  | { readonly kind: "reopen-document" }
  | { readonly kind: "download"; readonly path: string }
  | { readonly kind: "save-text"; readonly path: string }
  | { readonly kind: "save-csv"; readonly path: string }
  | { readonly kind: "open-external" }
  | { readonly kind: "open-link"; readonly index: number }
  | { readonly kind: "go"; readonly target: string }
  | { readonly kind: "go-stream"; readonly target: string }
  | { readonly kind: "patch-remove-node"; readonly target: number }
  | { readonly kind: "patch-replace-text"; readonly target: number; readonly value: string }
  | { readonly kind: "patch-set-attr"; readonly target: number; readonly name: string; readonly value: string }
  | { readonly kind: "patch-remove-attr"; readonly target: number; readonly name: string }
  | { readonly kind: "patch-insert-before"; readonly target: number; readonly html: string }
  | { readonly kind: "patch-insert-after"; readonly target: number; readonly html: string }
  | { readonly kind: "invalid"; readonly reason: string };

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    return null;
  }
  return parsedValue;
}

function parseOverrides(tokens: readonly string[]): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = token.slice(0, separator).trim();
    const value = token.slice(separator + 1).trim();
    if (key.length === 0) {
      continue;
    }
    overrides[key] = value;
  }
  return overrides;
}/**
 * Parses input deterministically for the `parseCommand` public API.
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
  if (headLower === "view") return { kind: "view" };
  if (headLower === "reader") return { kind: "reader" };
  if (headLower === "links") return { kind: "links" };
  if (headLower === "documents" || headLower === "docs") return { kind: "documents" };
  if (headLower === "diag" || headLower === "status") return { kind: "diag" };
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

  if (headLower === "bookmark" || headLower === "bm") {
    if (tail.length === 0 || tail.toLowerCase() === "list") {
      return { kind: "bookmark-list" };
    }

    const bookmarkParts = tail.split(/\s+/);
    const bookmarkSubcommand = bookmarkParts[0]?.toLowerCase() ?? "";
    const bookmarkRest = bookmarkParts.slice(1).join(" ").trim();
    if (bookmarkSubcommand === "add") {
      return bookmarkRest.length > 0 ? { kind: "bookmark-add", name: bookmarkRest } : { kind: "bookmark-add" };
    }
    if (bookmarkSubcommand === "open") {
      const bookmarkIndex = parsePositiveInteger(bookmarkRest);
      if (bookmarkIndex === null) {
        return { kind: "invalid", reason: "bookmark open requires a positive numeric index" };
      }
      return { kind: "bookmark-open", index: bookmarkIndex };
    }

    return { kind: "invalid", reason: "bookmark supports: list | add [name] | open <index>" };
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

    const historyParts = tail.split(/\s+/);
    const historySubcommand = historyParts[0]?.toLowerCase() ?? "";
    const historyRest = historyParts.slice(1).join(" ").trim();
    if (historySubcommand === "open") {
      const historyIndex = parsePositiveInteger(historyRest);
      if (historyIndex === null) {
        return { kind: "invalid", reason: "history open requires a positive numeric index" };
      }
      return { kind: "history-open", index: historyIndex };
    }

    return { kind: "invalid", reason: "history supports: list | open <index>" };
  }

  if (headLower === "recall") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "recall requires a query, or: recall open <index>" };
    }
    const recallParts = tail.split(/\s+/);
    const recallSubcommand = recallParts[0]?.toLowerCase() ?? "";
    if (recallSubcommand === "open") {
      const recallIndex = parsePositiveInteger(recallParts[1] ?? "");
      if (recallIndex === null) {
        return { kind: "invalid", reason: "recall open requires a positive numeric index" };
      }
      return { kind: "recall-open", index: recallIndex };
    }
    return { kind: "recall", query: tail };
  }

  if (headLower === "form" || headLower === "forms") {
    if (tail.length === 0 || tail.toLowerCase() === "list") {
      return { kind: "form-list" };
    }

    const formParts = tail.split(/\s+/);
    const formSubcommand = formParts[0]?.toLowerCase() ?? "";
    if (formSubcommand === "submit") {
      const indexToken = formParts[1] ?? "";
      const formIndex = parsePositiveInteger(indexToken);
      if (formIndex === null) {
        return { kind: "invalid", reason: "form submit requires a positive form index" };
      }
      const overrides = parseOverrides(formParts.slice(2));
      return { kind: "form-submit", index: formIndex, overrides };
    }

    return { kind: "invalid", reason: "form supports: list | submit <index> [name=value ...]" };
  }

  if (headLower === "download") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "download requires a target path" };
    }
    return { kind: "download", path: tail };
  }

  if (headLower === "save") {
    const saveParts = tail.split(/\s+/).filter((part) => part.length > 0);
    const saveMode = saveParts[0]?.toLowerCase() ?? "";
    const savePath = saveParts.slice(1).join(" ").trim();
    if ((saveMode !== "text" && saveMode !== "csv") || savePath.length === 0) {
      return { kind: "invalid", reason: "save supports: text <path> | csv <path>" };
    }
    return saveMode === "text"
      ? { kind: "save-text", path: savePath }
      : { kind: "save-csv", path: savePath };
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
      return { kind: "invalid", reason: "open requires a link index or URL" };
    }
    const linkIndex = parsePositiveInteger(tail);
    if (linkIndex !== null) {
      return { kind: "open-link", index: linkIndex };
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

  if (headLower === "patch") {
    if (tail.length === 0) {
      return {
        kind: "invalid",
        reason: "patch requires a subcommand: remove-node | replace-text | set-attr | remove-attr | insert-before | insert-after"
      };
    }

    const patchParts = tail.split(/\s+/);
    const patchSubcommand = patchParts[0]?.toLowerCase() ?? "";
    const patchTargetToken = patchParts[1] ?? "";
    const patchTarget = parsePositiveInteger(patchTargetToken);

    if (patchTarget === null) {
      return { kind: "invalid", reason: "patch requires a positive node id as second token" };
    }

    if (patchSubcommand === "remove-node") {
      return { kind: "patch-remove-node", target: patchTarget };
    }

    if (patchSubcommand === "replace-text") {
      const value = patchParts.slice(2).join(" ").trim();
      if (value.length === 0) {
        return { kind: "invalid", reason: "patch replace-text requires a replacement value" };
      }
      return { kind: "patch-replace-text", target: patchTarget, value };
    }

    if (patchSubcommand === "set-attr") {
      const name = patchParts[2]?.trim() ?? "";
      const value = patchParts.slice(3).join(" ").trim();
      if (name.length === 0 || value.length === 0) {
        return { kind: "invalid", reason: "patch set-attr requires: <nodeId> <name> <value>" };
      }
      return { kind: "patch-set-attr", target: patchTarget, name, value };
    }

    if (patchSubcommand === "remove-attr") {
      const name = patchParts[2]?.trim() ?? "";
      if (name.length === 0) {
        return { kind: "invalid", reason: "patch remove-attr requires: <nodeId> <name>" };
      }
      return { kind: "patch-remove-attr", target: patchTarget, name };
    }

    if (patchSubcommand === "insert-before") {
      const html = patchParts.slice(2).join(" ").trim();
      if (html.length === 0) {
        return { kind: "invalid", reason: "patch insert-before requires HTML content" };
      }
      return { kind: "patch-insert-before", target: patchTarget, html };
    }

    if (patchSubcommand === "insert-after") {
      const html = patchParts.slice(2).join(" ").trim();
      if (html.length === 0) {
        return { kind: "invalid", reason: "patch insert-after requires HTML content" };
      }
      return { kind: "patch-insert-after", target: patchTarget, html };
    }

    return {
      kind: "invalid",
      reason: "patch supports: remove-node | replace-text | set-attr | remove-attr | insert-before | insert-after"
    };
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

  const singleNumber = parsePositiveInteger(trimmedInput);
  if (singleNumber !== null) {
    return { kind: "open-link", index: singleNumber };
  }

  return { kind: "go", target: trimmedInput };
}/**
 * Formats or resolves deterministic public output for `formatHelpText`.
 */


export function formatHelpText(): string {
  return [
    "First browse loop:",
    "  1. Start with: verge https://example.com",
    "  2. Press ] or Tab to focus the next link or control",
    "  3. Press Enter to open the focused target",
    "  4. Press h to go back",
    "  5. Press g to enter a new URL",
    "  6. Press / to search in the current page",
    "  7. Press q to quit",
    "",
    "Browse keys:",
    "  Up/Down             Scroll the current screen",
    "  PageUp/PageDown     Move by one page",
    "  Home/End            Jump to top or bottom",
    "  [ / ]               Move to previous or next link/control",
    "  Enter               Open the focused link/control",
    "  h / f / r           Back / forward / reload",
    "  g / :               Location palette / action palette",
    "  / / n / N           Find / next match / previous match",
    "  l / D / H / B / F   Links / documents / history / bookmarks / forms",
    "  o / d               Outline / diagnostics",
    "  m / t / x / u       Bookmark / new document / close / reopen",
    "  Esc                 Back out of search, focus, or transient screens",
    "  q                   Quit",
    "",
    "Action palette examples:",
    "  links               Open the links picker",
    "  documents           Open the documents picker",
    "  history             Open persisted history",
    "  bookmark add [name] Save the current page as a bookmark",
    "  download <path>     Save the current HTML snapshot",
    "  save text <path>    Export the current screen as plain text",
    "  save csv <path>     Export the current picker as CSV",
    "  open-external       Open the current page or focused link outside verge",
    "  form submit <n>     Submit form n, optionally with name=value overrides",
    "  patch ...           Apply a low-level HTML patch to the current page",
    "",
    "CLI flags:",
    "  --record-corpus     Write fetched HTML/CSS payloads to realworld corpus cache",
    "  --once              Load the initial target once, then exit",
    "  --screen-reader     Use the screen-reader-friendly chrome profile"
  ].join("\n");
}
