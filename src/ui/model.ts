import type {
  CommandInputAction,
  NumberInputControlAction,
  SearchPickerAction,
  SelectAction,
  TabAction,
  TextAreaAction,
  TextInputAction
} from "@ismail-elkorchi/terminal-ui/components";
import type {
  CommandInputState,
  NumberInputState,
  SearchPickerState,
  SelectPresentation,
  ScrollState,
  TextAreaState
} from "@ismail-elkorchi/terminal-ui/behavior";
import type { ScrollEvent } from "@ismail-elkorchi/terminal-ui/interaction";
import type { SearchPickerIndex } from "@ismail-elkorchi/terminal-ui/behavior";
import type { TextEditBuffer } from "@ismail-elkorchi/terminal-ui/text";

import type { BookmarkEntry, DownloadRecord, HistoryEntry } from "../app/storage.js";
import type { PageSnapshot } from "../app/types.js";

export type PickerKind = "links" | "outline" | "recall";
export type DetailKind = "help" | "diagnostics" | "reader" | "cookies";
export type SidePanelKind = "history" | "bookmarks" | "downloads";

export interface StatusMessage {
  readonly text: string;
  readonly tone: "info" | "error" | "success";
}

export interface DocumentSearchMatch {
  readonly blockId: string;
  readonly rowIndex: number;
  readonly startCodeUnitIndex: number;
  readonly endCodeUnitIndexExclusive: number;
}

export interface BrowserDocumentSearch {
  readonly query: string;
  readonly matches: readonly DocumentSearchMatch[];
  readonly activeMatchIndex: number;
}

export interface BrowserDocumentState {
  readonly id: string;
  readonly snapshot: PageSnapshot;
  readonly scrollAnchor: {
    readonly blockId: string;
    readonly rowOffset: number;
  };
  readonly search: BrowserDocumentSearch | null;
  readonly formValues: Readonly<Record<string, readonly string[]>>;
  readonly formEditors: Readonly<Record<string,
    | { readonly kind: "text"; readonly state: TextEditBuffer }
    | { readonly kind: "number"; readonly state: NumberInputState }
    | { readonly kind: "textarea"; readonly state: TextAreaState }
    | { readonly kind: "select"; readonly state: SelectPresentation }
  >>;
  readonly savedViews: Readonly<Record<string, {
    readonly scrollAnchor: BrowserDocumentState["scrollAnchor"];
    readonly search: BrowserDocumentSearch | null;
  }>>;
  readonly loading: boolean;
  readonly pendingUrl: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error: string | null;
}

export interface PickerValue {
  readonly kind: "link" | "outline" | "recall";
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

export interface ActionPaletteOverlay {
  readonly kind: "actionPalette";
  readonly state: CommandInputState;
  readonly validation?: string;
}

export interface DetailOverlay {
  readonly kind: "detail";
  readonly detailKind: DetailKind;
  readonly title: string;
  readonly lines: readonly string[];
  readonly scrollRow: number;
}

export interface LinkMenuOverlay {
  readonly kind: "linkMenu";
  readonly actionId: string;
}

export interface BrowserMenuOverlay {
  readonly kind: "browserMenu";
}

export interface DownloadPromptOverlay {
  readonly kind: "downloadPrompt";
  readonly target: string;
}

export type BrowserOverlay =
  | PickerOverlay
  | ActionPaletteOverlay
  | DetailOverlay
  | LinkMenuOverlay
  | BrowserMenuOverlay
  | DownloadPromptOverlay;

export interface FindBarState {
  readonly input: {
    readonly text: string;
    readonly cursor: number;
  };
}

export interface BrowserTuiState {
  readonly documents: readonly BrowserDocumentState[];
  readonly activeDocumentIndex: number;
  readonly recentlyClosed: readonly BrowserDocumentState[];
  readonly omnibox: CommandInputState;
  readonly omniboxDirty: boolean;
  readonly findBar: FindBarState | null;
  readonly sidePanel: SidePanelKind | null;
  readonly sidePanelScroll: ScrollState;
  readonly history: readonly HistoryEntry[];
  readonly bookmarks: readonly BookmarkEntry[];
  readonly downloads: readonly DownloadRecord[];
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
  | {
      readonly kind: "activateActionAt";
      readonly actionId: string;
      readonly disposition?: "current" | "newForeground" | "newBackground" | "context";
    }
  | { readonly kind: "navigate"; readonly operation: "back" | "forward" | "reload" | "stop" }
  | { readonly kind: "omniboxAction"; readonly action: CommandInputAction }
  | { readonly kind: "omniboxSubmit"; readonly value: string }
  | { readonly kind: "focusOmnibox" }
  | { readonly kind: "cancelOmnibox" }
  | { readonly kind: "openActionPalette" }
  | { readonly kind: "openBrowserMenu" }
  | { readonly kind: "openPicker"; readonly picker: PickerKind; readonly query?: string }
  | { readonly kind: "openDetail"; readonly detail: DetailKind }
  | { readonly kind: "toggleSidePanel"; readonly panel: SidePanelKind }
  | { readonly kind: "sidePanelScroll"; readonly event: ScrollEvent }
  | { readonly kind: "toggleBookmark" }
  | { readonly kind: "openExternal"; readonly target?: string }
  | { readonly kind: "newDocument"; readonly target?: string; readonly background?: boolean }
  | { readonly kind: "closeDocument" }
  | { readonly kind: "reopenDocument" }
  | { readonly kind: "selectDocument"; readonly index: number }
  | { readonly kind: "tabs"; readonly action: TabAction }
  | { readonly kind: "actionPaletteAction"; readonly action: CommandInputAction }
  | { readonly kind: "actionPaletteSubmit"; readonly value: string }
  | { readonly kind: "pickerAction"; readonly action: SearchPickerAction }
  | { readonly kind: "pickerSelect"; readonly value?: PickerValue }
  | { readonly kind: "openFind" }
  | { readonly kind: "findAction"; readonly action: TextInputAction }
  | { readonly kind: "findSubmit" }
  | { readonly kind: "closeFind" }
  | { readonly kind: "formText"; readonly controlId: string; readonly action: TextInputAction }
  | { readonly kind: "formNumber"; readonly controlId: string; readonly action: NumberInputControlAction }
  | { readonly kind: "formArea"; readonly controlId: string; readonly action: TextAreaAction }
  | { readonly kind: "formSelect"; readonly controlId: string; readonly action: SelectAction }
  | { readonly kind: "formValues"; readonly controlId: string; readonly values: readonly string[] }
  | { readonly kind: "resetForm"; readonly formId: string }
  | { readonly kind: "submitForm"; readonly formId: string; readonly submitterId?: string }
  | {
      readonly kind: "pageLoaded";
      readonly documentId: string;
      readonly snapshot: PageSnapshot;
      readonly status: string;
      readonly canGoBack: boolean;
      readonly canGoForward: boolean;
    }
  | {
      readonly kind: "documentOpened";
      readonly document: BrowserDocumentState;
      readonly background: boolean;
      readonly replaceCurrent?: boolean;
    }
  | { readonly kind: "download"; readonly target?: string }
  | { readonly kind: "downloadComplete"; readonly download: DownloadRecord }
  | { readonly kind: "downloadFailed"; readonly download: DownloadRecord }
  | { readonly kind: "cancelDownload"; readonly id: string }
  | { readonly kind: "retryDownload"; readonly id: string }
  | { readonly kind: "removeDownload"; readonly id: string }
  | { readonly kind: "openDownload"; readonly id: string; readonly location: "file" | "directory" }
  | { readonly kind: "downloadsChanged"; readonly downloads: readonly DownloadRecord[]; readonly status: string }
  | { readonly kind: "operationComplete"; readonly status: string }
  | {
      readonly kind: "operationFailed";
      readonly message: string;
      readonly documentId?: string;
      readonly downloadTarget?: string;
    };
