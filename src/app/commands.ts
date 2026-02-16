export type BrowserCommand =
  | { readonly kind: "help" }
  | { readonly kind: "quit" }
  | { readonly kind: "view" }
  | { readonly kind: "links" }
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" }
  | { readonly kind: "open-link"; readonly index: number }
  | { readonly kind: "go"; readonly target: string }
  | { readonly kind: "invalid"; readonly reason: string };

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsedValue = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

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
  if (headLower === "links") return { kind: "links" };
  if (headLower === "back") return { kind: "back" };
  if (headLower === "forward") return { kind: "forward" };
  if (headLower === "reload") return { kind: "reload" };

  if (headLower === "open") {
    if (tail.length === 0) {
      return { kind: "invalid", reason: "open requires a link index or URL" };
    }
    const linkIndex = parseInteger(tail);
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

  const singleNumber = parseInteger(trimmedInput);
  if (singleNumber !== null) {
    return { kind: "open-link", index: singleNumber };
  }

  return { kind: "go", target: trimmedInput };
}

export function formatHelpText(): string {
  return [
    "Commands:",
    "  help                Show command help",
    "  view                Re-render current page",
    "  links               Show link table for current page",
    "  open <n>            Open numbered link",
    "  open <url>          Navigate to URL",
    "  go <url>            Navigate to URL",
    "  back                Navigate backward in history",
    "  forward             Navigate forward in history",
    "  reload              Reload current page",
    "  quit                Exit verge-browser"
  ].join("\n");
}
