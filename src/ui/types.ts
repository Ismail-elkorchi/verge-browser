import type { FormEntry } from "../app/forms.js";
import type { SearchState } from "../app/search.js";
import type { BrowserSession } from "../app/session.js";
import type { PageSnapshot, RenderedPage } from "../app/types.js";

export type ScreenKind = "browse" | "picker" | "palette" | "editor" | "detail";

export type PickerKind = "documents" | "links" | "history" | "bookmarks" | "forms" | "outline" | "recall";

export type DetailKind = "help" | "diagnostics" | "reader" | "cookies";

export type PaletteMode = "location" | "action" | "search";

export type BrowseFocusMode = "reading" | "link-control";

export type PickerFocusTarget = "list" | "filter";

export type EditorMode = "select" | "edit" | "confirm-exit";

export interface StatusMessage {
  readonly text: string;
  readonly tone: "info" | "error" | "success";
}

export interface SearchViewState {
  readonly state: SearchState;
  readonly preservedScrollOffset: number;
}

export interface LinkControlFocus {
  readonly actionableIndex: number;
}

export interface DocumentNavigationMemory {
  readonly scrollOffset: number;
  readonly focusMode: BrowseFocusMode;
  readonly actionableIndex: number | null;
  readonly searchQuery: string | null;
  readonly searchMatchIndex: number | null;
}

export interface DocumentViewState {
  readonly id: string;
  readonly title: string;
  readonly session: BrowserSession;
  readonly snapshot: PageSnapshot | null;
  readonly rendered: RenderedPage | null;
  readonly scrollOffset: number;
  readonly focusMode: BrowseFocusMode;
  readonly linkControlFocus: LinkControlFocus | null;
  readonly search: SearchViewState | null;
  readonly navigationMemory: Readonly<Record<string, DocumentNavigationMemory>>;
}

export interface ClosedDocumentState {
  readonly document: DocumentViewState;
  readonly closedAtIso: string;
}

export type PickerPayload =
  | { readonly kind: "document"; readonly documentIndex: number }
  | { readonly kind: "link"; readonly actionableIndex: number; readonly linkIndex: number }
  | { readonly kind: "history"; readonly historyIndex: number }
  | { readonly kind: "bookmark"; readonly bookmarkIndex: number }
  | { readonly kind: "form"; readonly formIndex: number }
  | { readonly kind: "outline"; readonly lineIndex: number }
  | { readonly kind: "recall"; readonly recallIndex: number };

export interface PickerItem {
  readonly index: number;
  readonly label: string;
  readonly detail?: string;
  readonly payload: PickerPayload;
}

export interface PickerState {
  readonly kind: PickerKind;
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly queryText: string | null;
  readonly selectedIndex: number;
  readonly filterText: string;
  readonly jumpText: string;
  readonly focusTarget: PickerFocusTarget;
}

export interface PaletteSuggestion {
  readonly value: string;
  readonly description?: string;
}

export interface PaletteState {
  readonly mode: PaletteMode;
  readonly inputText: string;
  readonly suggestions: readonly PaletteSuggestion[];
  readonly selectedSuggestionIndex: number;
  readonly repairText: string | null;
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
  readonly mode: EditorMode;
  readonly cursorOffset: number;
  readonly dirty: boolean;
  readonly documentId: string;
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
  readonly recentlyClosedDocuments: readonly ClosedDocumentState[];
  readonly picker: PickerState | null;
  readonly palette: PaletteState | null;
  readonly editor: EditorState | null;
  readonly detail: DetailState | null;
  readonly status: StatusMessage | null;
  readonly screenReaderMode: boolean;
  readonly shouldExit: boolean;
}
