import type { BrowserCommand } from "./commands.js";
import type { KeyboardKey } from "./types.js";

export type ShortcutAction =
  | { readonly kind: "quit" }
  | { readonly kind: "prompt" }
  | { readonly kind: "scroll-line-down" }
  | { readonly kind: "scroll-line-up" }
  | { readonly kind: "scroll-page-down" }
  | { readonly kind: "scroll-page-up" }
  | { readonly kind: "scroll-top" }
  | { readonly kind: "scroll-bottom" }
  | { readonly kind: "show-page" }
  | { readonly kind: "search-prompt" }
  | { readonly kind: "search-next" }
  | { readonly kind: "search-prev" }
  | { readonly kind: "run-command"; readonly command: BrowserCommand };

function isShiftedKey(key: KeyboardKey, baseName: string): boolean {
  return key.name === baseName && key.shift === true;
}

export function resolveShortcutAction(character: string, key: KeyboardKey): ShortcutAction | null {
  if (key.ctrl && key.name === "c") {
    return { kind: "quit" };
  }

  if (character === ":") {
    return { kind: "prompt" };
  }

  if (character === "/") {
    return { kind: "search-prompt" };
  }

  if (character === "q") {
    return { kind: "quit" };
  }

  if (character === "n") {
    return { kind: "search-next" };
  }

  if (character === "N" || isShiftedKey(key, "n")) {
    return { kind: "search-prev" };
  }

  if (character === "?") {
    return { kind: "run-command", command: { kind: "help" } };
  }

  if (character === "j" || key.name === "down") {
    return { kind: "scroll-line-down" };
  }

  if (character === "k" || key.name === "up") {
    return { kind: "scroll-line-up" };
  }

  if (character === " " || key.name === "pagedown") {
    return { kind: "scroll-page-down" };
  }

  if (character === "b" || key.name === "pageup") {
    return { kind: "scroll-page-up" };
  }

  if (character === "g" && !key.shift) {
    return { kind: "scroll-top" };
  }

  if (character === "G" || isShiftedKey(key, "g")) {
    return { kind: "scroll-bottom" };
  }

  if (character === "l") {
    return { kind: "run-command", command: { kind: "links" } };
  }

  if (character === "o") {
    return { kind: "run-command", command: { kind: "outline" } };
  }

  if (character === "d") {
    return { kind: "run-command", command: { kind: "diag" } };
  }

  if (character === "h") {
    return { kind: "run-command", command: { kind: "back" } };
  }

  if (character === "f") {
    return { kind: "run-command", command: { kind: "forward" } };
  }

  if (character === "r") {
    return { kind: "run-command", command: { kind: "reload" } };
  }

  if (character === "m") {
    return { kind: "run-command", command: { kind: "bookmark-add" } };
  }

  if (character === "H" || isShiftedKey(key, "h")) {
    return { kind: "run-command", command: { kind: "history-list" } };
  }

  if (key.name === "escape") {
    return { kind: "show-page" };
  }

  return null;
}
