import type { KeyboardKey } from "../app/types.js";
import type { BrowseFocusMode, EditorMode, PickerFocusTarget, ScreenKind } from "./types.js";

export interface ShellKeyContext {
  readonly screen: ScreenKind;
  readonly browseFocusMode?: BrowseFocusMode;
  readonly pickerFocusTarget?: PickerFocusTarget;
  readonly editorMode?: EditorMode;
}

export type ShellKeyAction =
  | { readonly kind: "quit" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "show-help" }
  | { readonly kind: "show-diagnostics" }
  | { readonly kind: "show-links" }
  | { readonly kind: "show-documents" }
  | { readonly kind: "show-history" }
  | { readonly kind: "show-bookmarks" }
  | { readonly kind: "show-forms" }
  | { readonly kind: "show-outline" }
  | { readonly kind: "open-location" }
  | { readonly kind: "open-action-palette" }
  | { readonly kind: "open-search" }
  | { readonly kind: "search-next" }
  | { readonly kind: "search-prev" }
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" }
  | { readonly kind: "bookmark-add" }
  | { readonly kind: "next-actionable" }
  | { readonly kind: "prev-actionable" }
  | { readonly kind: "activate" }
  | { readonly kind: "open-focused-new-document" }
  | { readonly kind: "close-document" }
  | { readonly kind: "reopen-document" }
  | { readonly kind: "scroll-line-down" }
  | { readonly kind: "scroll-line-up" }
  | { readonly kind: "scroll-page-down" }
  | { readonly kind: "scroll-page-up" }
  | { readonly kind: "scroll-top" }
  | { readonly kind: "scroll-bottom" }
  | { readonly kind: "picker-down" }
  | { readonly kind: "picker-up" }
  | { readonly kind: "picker-page-down" }
  | { readonly kind: "picker-page-up" }
  | { readonly kind: "picker-top" }
  | { readonly kind: "picker-bottom" }
  | { readonly kind: "picker-toggle-filter" }
  | { readonly kind: "picker-activate" }
  | { readonly kind: "editor-next-field" }
  | { readonly kind: "editor-prev-field" }
  | { readonly kind: "editor-enter-edit" }
  | { readonly kind: "editor-submit" }
  | { readonly kind: "editor-discard" }
  | { readonly kind: "editor-external" }
  | { readonly kind: "editor-cancel" }
  | { readonly kind: "text-backspace" }
  | { readonly kind: "text-cursor-left" }
  | { readonly kind: "text-cursor-right" }
  | { readonly kind: "text-newline" };

function isShiftedKey(key: KeyboardKey, baseName: string): boolean {
  return key.name === baseName && key.shift === true;
}

function browseAction(character: string, key: KeyboardKey): ShellKeyAction | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (character === "q") return { kind: "quit" };
  if (character === "?") return { kind: "show-help" };
  if (character === "d") return { kind: "show-diagnostics" };
  if (character === "l") return { kind: "show-links" };
  if (character === "D" || isShiftedKey(key, "d")) return { kind: "show-documents" };
  if (character === "H" || isShiftedKey(key, "h")) return { kind: "show-history" };
  if (character === "B" || isShiftedKey(key, "b")) return { kind: "show-bookmarks" };
  if (character === "F" || isShiftedKey(key, "f")) return { kind: "show-forms" };
  if (character === "o") return { kind: "show-outline" };
  if (character === "g") return { kind: "open-location" };
  if (character === ":") return { kind: "open-action-palette" };
  if (character === "/") return { kind: "open-search" };
  if (character === "n") return { kind: "search-next" };
  if (character === "N" || isShiftedKey(key, "n")) return { kind: "search-prev" };
  if (character === "h") return { kind: "back" };
  if (character === "f") return { kind: "forward" };
  if (character === "r") return { kind: "reload" };
  if (character === "m") return { kind: "bookmark-add" };
  if (character === "]") return { kind: "next-actionable" };
  if (character === "[") return { kind: "prev-actionable" };
  if (key.name === "tab" && key.shift) return { kind: "prev-actionable" };
  if (key.name === "tab") return { kind: "next-actionable" };
  if (character === "t") return { kind: "open-focused-new-document" };
  if (character === "x") return { kind: "close-document" };
  if (character === "u") return { kind: "reopen-document" };
  if (key.name === "return" || key.name === "enter") return { kind: "activate" };
  if (character === " " || key.name === "pagedown") return { kind: "scroll-page-down" };
  if (key.name === "pageup") return { kind: "scroll-page-up" };
  if (key.name === "home") return { kind: "scroll-top" };
  if (key.name === "end") return { kind: "scroll-bottom" };
  if (key.name === "down") return { kind: "scroll-line-down" };
  if (key.name === "up") return { kind: "scroll-line-up" };
  if (key.name === "escape") return { kind: "dismiss" };
  return null;
}

function pickerAction(character: string, key: KeyboardKey, focusTarget: PickerFocusTarget): ShellKeyAction | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (character === "q") return { kind: "quit" };
  if (key.name === "down") return { kind: "picker-down" };
  if (key.name === "up") return { kind: "picker-up" };
  if (key.name === "pagedown") return { kind: "picker-page-down" };
  if (key.name === "pageup") return { kind: "picker-page-up" };
  if (key.name === "home") return { kind: "picker-top" };
  if (key.name === "end") return { kind: "picker-bottom" };
  if (character === "/") return { kind: "picker-toggle-filter" };
  if (key.name === "tab") return { kind: "picker-toggle-filter" };
  if ((key.name === "return" || key.name === "enter") && focusTarget === "list") return { kind: "picker-activate" };
  if (key.name === "backspace" || key.sequence === "\u007f") return { kind: "text-backspace" };
  if (key.name === "escape") return { kind: "dismiss" };
  return null;
}

function paletteAction(character: string, key: KeyboardKey): ShellKeyAction | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (character === "q" && key.ctrl !== true) return null;
  if (key.name === "return" || key.name === "enter") return { kind: "activate" };
  if (key.name === "backspace" || key.sequence === "\u007f") return { kind: "text-backspace" };
  if (key.name === "left") return { kind: "text-cursor-left" };
  if (key.name === "right") return { kind: "text-cursor-right" };
  if (key.name === "down") return { kind: "picker-down" };
  if (key.name === "up") return { kind: "picker-up" };
  if (key.name === "escape") return { kind: "dismiss" };
  return null;
}

function detailAction(character: string, key: KeyboardKey): ShellKeyAction | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (character === "q") return { kind: "quit" };
  if (key.name === "down") return { kind: "scroll-line-down" };
  if (key.name === "up") return { kind: "scroll-line-up" };
  if (character === " " || key.name === "pagedown") return { kind: "scroll-page-down" };
  if (key.name === "pageup") return { kind: "scroll-page-up" };
  if (key.name === "home") return { kind: "scroll-top" };
  if (key.name === "end") return { kind: "scroll-bottom" };
  if (key.name === "escape") return { kind: "dismiss" };
  return null;
}

function editorAction(character: string, key: KeyboardKey, mode: EditorMode): ShellKeyAction | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (mode === "edit") {
    if (key.name === "escape") return { kind: "editor-cancel" };
    if (key.name === "backspace" || key.sequence === "\u007f") return { kind: "text-backspace" };
    if (key.name === "left") return { kind: "text-cursor-left" };
    if (key.name === "right") return { kind: "text-cursor-right" };
    if (key.name === "return" || key.name === "enter") return { kind: "text-newline" };
    if (key.name === "tab" && key.shift) return { kind: "editor-prev-field" };
    if (key.name === "tab") return { kind: "editor-next-field" };
    return null;
  }

  if (character === "s") return { kind: "editor-submit" };
  if (character === "d") return { kind: "editor-discard" };
  if (character === "x") return { kind: "editor-external" };
  if (key.name === "return" || key.name === "enter") return { kind: "editor-enter-edit" };
  if (key.name === "tab" && key.shift) return { kind: "editor-prev-field" };
  if (key.name === "tab" || key.name === "down") return { kind: "editor-next-field" };
  if (key.name === "up") return { kind: "editor-prev-field" };
  if (key.name === "escape") return { kind: "editor-cancel" };
  return null;
}

export function resolveShellKeyAction(
  character: string,
  key: KeyboardKey,
  context: ShellKeyContext
): ShellKeyAction | null {
  switch (context.screen) {
    case "browse":
      return browseAction(character, key);
    case "picker":
      return pickerAction(character, key, context.pickerFocusTarget ?? "list");
    case "palette":
      return paletteAction(character, key);
    case "editor":
      return editorAction(character, key, context.editorMode ?? "select");
    case "detail":
      return detailAction(character, key);
  }
}
