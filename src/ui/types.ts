import type { BrowserSession } from "../app/session.js";
import type { FormEntry } from "../app/forms.js";
import type { SearchState } from "../app/search.js";
import type { RenderedPage } from "../app/types.js";

export type ScreenKind = "browse" | "picker" | "palette" | "editor" | "detail";

export type PickerKind = "documents" | "links" | "history" | "bookmarks" | "forms" | "outline" | "recall";

export type DetailKind = "help" | "diagnostics";

export type PaletteMode = "location" | "action";

export type BrowseFocusMode = "reading" | "link-control";

export interface StatusMessage {
  readonly text: string;
  readonly tone: "info" | "error" | "success";
}

export interface SearchViewState {
  readonly state: SearchState;
}

export interface LinkControlFocus {
  readonly actionIndex: number;
}

export interface DocumentViewState {
  readonly id: string;
  readonly title: string;
  readonly session: BrowserSession;
  readonly rendered: RenderedPage | null;
  readonly scrollOffset: number;
  readonly focusMode: BrowseFocusMode;
  readonly linkControlFocus: LinkControlFocus | null;
  readonly search: SearchViewState | null;
}

export interface PickerItem {
  readonly index: number;
  readonly label: string;
  readonly detail?: string;
}

export interface PickerState {
  readonly kind: PickerKind;
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly selectedIndex: number;
  readonly filterText: string;
  readonly jumpText: string;
  readonly inputFocused: boolean;
}

export interface PaletteState {
  readonly mode: PaletteMode;
  readonly inputText: string;
  readonly suggestions: readonly string[];
}

export interface EditorFieldState {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly multiline: boolean;
}

export interface EditorState {
  readonly title: string;
  readonly form: FormEntry;
  readonly fields: readonly EditorFieldState[];
  readonly selectedFieldIndex: number;
  readonly dirty: boolean;
}

export interface DetailState {
  readonly kind: DetailKind;
  readonly title: string;
  readonly lines: readonly string[];
  readonly scrollOffset: number;
}

export interface ShellState {
  readonly screen: ScreenKind;
  readonly documents: readonly DocumentViewState[];
  readonly activeDocumentIndex: number;
  readonly closedDocumentIds: readonly string[];
  readonly picker: PickerState | null;
  readonly palette: PaletteState | null;
  readonly editor: EditorState | null;
  readonly detail: DetailState | null;
  readonly status: StatusMessage | null;
}
