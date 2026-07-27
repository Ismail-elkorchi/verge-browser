import type {
  CommandInputAction,
  SearchPickerAction,
  TabAction,
  TextAreaAction,
  TextInputAction
} from "@ismail-elkorchi/terminal-ui/components";
import type {
  CommandInputState,
  SearchPickerState,
  TextAreaState
} from "@ismail-elkorchi/terminal-ui/behavior";
import type { SearchPickerIndex } from "@ismail-elkorchi/terminal-ui/behavior";

import type { FormEntry } from "../app/forms.js";
import type { PageSnapshot } from "../app/types.js";

export type PickerKind =
  | "documents"
  | "links"
  | "history"
  | "bookmarks"
  | "forms"
  | "outline"
  | "recall";

export type DetailKind = "help" | "diagnostics" | "reader" | "cookies";
export type PaletteMode = "location" | "action" | "search";

export interface StatusMessage {
  readonly text: string;
  readonly tone: "info" | "error" | "success";
}

export interface BrowserDocumentState {
  readonly id: string;
  readonly snapshot: PageSnapshot;
  readonly scrollAnchor: {
    readonly blockId: string;
    readonly rowOffset: number;
  };
  readonly focusedActionId: string | null;
  readonly search: {
    readonly query: string;
    readonly blockIds: readonly string[];
    readonly activeMatchIndex: number;
  } | null;
  readonly savedViews: Readonly<Record<string, {
    readonly scrollAnchor: BrowserDocumentState["scrollAnchor"];
    readonly focusedActionId: string | null;
    readonly search: BrowserDocumentState["search"];
  }>>;
  readonly loading: boolean;
}

export interface PickerValue {
  readonly kind: "document" | "link" | "history" | "bookmark" | "form" | "outline" | "recall";
  readonly index: number;
  readonly target?: string;
  readonly blockId?: string;
}

export interface PickerOverlay {
  readonly kind: "picker";
  readonly pickerKind: PickerKind;
  readonly title: string;
  readonly index: SearchPickerIndex<PickerValue>;
  readonly state: SearchPickerState;
}

export interface PaletteOverlay {
  readonly kind: "palette";
  readonly mode: PaletteMode;
  readonly state: CommandInputState;
  readonly validation?: string;
}

export interface FormFieldState {
  readonly name: string;
  readonly label: string;
  readonly multiline: boolean;
  readonly input: { readonly kind: "singleLine"; readonly state: { readonly text: string; readonly cursor: number } }
    | { readonly kind: "multiline"; readonly state: TextAreaState };
}

export interface FormOverlay {
  readonly kind: "form";
  readonly form: FormEntry;
  readonly fields: readonly FormFieldState[];
  readonly focusedField: number;
}

export interface DetailOverlay {
  readonly kind: "detail";
  readonly detailKind: DetailKind;
  readonly title: string;
  readonly lines: readonly string[];
  readonly scrollRow: number;
}

export type BrowserOverlay = PickerOverlay | PaletteOverlay | FormOverlay | DetailOverlay;

export interface BrowserTuiState {
  readonly documents: readonly BrowserDocumentState[];
  readonly activeDocumentIndex: number;
  readonly recentlyClosed: readonly BrowserDocumentState[];
  readonly overlay: BrowserOverlay | null;
  readonly status: StatusMessage | null;
}

export type BrowserTuiMessage =
  | { readonly kind: "quit" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "scroll"; readonly rows: number }
  | { readonly kind: "scrollTop" }
  | { readonly kind: "scrollBottom" }
  | { readonly kind: "moveSearch"; readonly direction: "next" | "prev" }
  | { readonly kind: "clearBrowseState" }
  | { readonly kind: "moveAction"; readonly delta: 1 | -1 }
  | { readonly kind: "activateAction" }
  | { readonly kind: "activateActionAt"; readonly actionId: string }
  | { readonly kind: "navigate"; readonly operation: "back" | "forward" | "reload" }
  | { readonly kind: "openPalette"; readonly mode: PaletteMode }
  | { readonly kind: "openPicker"; readonly picker: PickerKind; readonly query?: string }
  | { readonly kind: "openDetail"; readonly detail: DetailKind }
  | { readonly kind: "bookmark" }
  | { readonly kind: "newDocument" }
  | { readonly kind: "closeDocument" }
  | { readonly kind: "reopenDocument" }
  | { readonly kind: "tabs"; readonly action: TabAction }
  | { readonly kind: "paletteAction"; readonly action: CommandInputAction }
  | { readonly kind: "paletteSubmit"; readonly value: string }
  | { readonly kind: "pickerAction"; readonly action: SearchPickerAction }
  | { readonly kind: "pickerSelect"; readonly value?: PickerValue }
  | {
      readonly kind: "formField";
      readonly fieldIndex: number;
      readonly control: "singleLine";
      readonly action: TextInputAction;
    }
  | {
      readonly kind: "formField";
      readonly fieldIndex: number;
      readonly control: "multiline";
      readonly action: TextAreaAction;
    }
  | { readonly kind: "focusFormField"; readonly fieldIndex: number }
  | { readonly kind: "editFormFieldExternal"; readonly fieldIndex: number }
  | { readonly kind: "formFieldReplaced"; readonly fieldIndex: number; readonly value: string }
  | { readonly kind: "submitForm" }
  | { readonly kind: "discardForm" }
  | { readonly kind: "pageLoaded"; readonly documentId: string; readonly snapshot: PageSnapshot; readonly status: string }
  | { readonly kind: "documentOpened"; readonly document: BrowserDocumentState }
  | { readonly kind: "operationComplete"; readonly status: string }
  | { readonly kind: "operationFailed"; readonly message: string };
