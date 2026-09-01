import type {
  CheckboxGroupTransition,
  ComboboxCommitEvent,
  ComboboxControlTransition,
  UnscrolledComboboxState,
  CommandInputTransition,
  ContextMenuTransition,
  MenuItem,
  MenuActivateEvent,
  MenuTriggerTransition,
  NumberInputControlTransition,
  SearchPickerAcceptEvent,
  SearchPickerControlTransition,
  TabCloseEvent,
  TabsTransition,
  TextAreaTransition,
  TextInputTransition
} from "@ismail-elkorchi/terminal-ui/components";
import type {
  CommandInputState,
  ContextMenuState,
  MenuTriggerState,
  NumberInputState,
  ScrollState,
  TextAreaState,
  UnscrolledSearchPickerState
} from "@ismail-elkorchi/terminal-ui/behavior";
import type {
  CollectionInteractionIndex,
  CollectionInteractionState,
  ScrollRequest
} from "@ismail-elkorchi/terminal-ui/interaction";
import type { SearchPickerIndex } from "@ismail-elkorchi/terminal-ui/behavior";
import type { TextEditBuffer } from "@ismail-elkorchi/terminal-ui/text";

import type {
  BookmarkEntry,
  DownloadRecord,
  HistoryEntry,
  StoredBrowserDocument,
} from "../app/storage.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import type { DocumentNodeRef, DocumentState } from "../document/index.js";
import type { RenderDocumentSummary, ViewportRenderPayload } from "./render-worker/index.js";

export type PickerKind = "links" | "outline" | "recall";
export type DetailKind = "help" | "diagnostics" | "reader" | "cookies";
export type SidePanelKind = "history" | "bookmarks" | "downloads";

export const formComboboxPageSize = 8;

export const browserMenuItems = [
  { kind: "action", id: "history", label: "History" },
  { kind: "action", id: "bookmarks", label: "Bookmarks" },
  { kind: "action", id: "downloads", label: "Downloads" },
  { kind: "action", id: "reader", label: "Reader view" },
  { kind: "action", id: "diagnostics", label: "Page diagnostics" },
  { kind: "action", id: "cookies", label: "Cookies" },
  { kind: "action", id: "download", label: "Download current resource" },
  { kind: "action", id: "external", label: "Open externally" },
  { kind: "action", id: "help", label: "Help" }
] as const satisfies readonly MenuItem[];

export const linkMenuItems = [
  { kind: "action", id: "open", label: "Open" },
  { kind: "action", id: "newForeground", label: "Open in new tab" },
  { kind: "action", id: "newBackground", label: "Open in background tab" },
  { kind: "action", id: "download", label: "Download link" },
  { kind: "action", id: "external", label: "Open link externally" }
] as const satisfies readonly MenuItem[];

export interface StatusMessage {
  readonly text: string;
  readonly tone: "info" | "error" | "success";
}

export interface DocumentSearchMatch {
  readonly id: string;
  readonly sources: readonly (DocumentNodeRef | null)[];
  readonly anchorRow: number;
}

export interface BrowserDocumentSearch {
  readonly query: string;
  readonly matches: readonly DocumentSearchMatch[];
  readonly activeMatchIndex: number;
  readonly truncated: boolean;
}

export interface BrowserDocumentState {
  readonly kind: "ready";
  readonly id: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly snapshot: IndexedPageSnapshot;
  readonly documentState: DocumentState;
  readonly rendering: {
    readonly status: "idle" | "rendering" | "ready" | "failed";
    readonly requestedViewportRevision: number;
    readonly committedViewportRevision: number;
    readonly requestKey: string | null;
    readonly pendingSearchQuery: string | null;
    readonly pendingFocus: {
      readonly node: DocumentNodeRef;
      readonly actionId: string;
      readonly formControl: boolean;
    } | null;
    readonly viewport: ViewportRenderPayload | null;
    readonly summary: RenderDocumentSummary | null;
    readonly error: string | null;
  };
  readonly scrollAnchor: {
    readonly source: DocumentNodeRef | null;
    readonly rowOffset: number;
  };
  readonly search: BrowserDocumentSearch | null;
  readonly formEditors: Readonly<Record<string,
    | { readonly kind: "text"; readonly state: TextEditBuffer }
    | { readonly kind: "number"; readonly state: NumberInputState }
    | { readonly kind: "textarea"; readonly state: TextAreaState }
    | {
        readonly kind: "combobox";
        readonly state: UnscrolledComboboxState;
        readonly index: CollectionInteractionIndex;
      }
    | { readonly kind: "checkboxGroup"; readonly state: CollectionInteractionState }
  >>;
  readonly savedViews: Readonly<Record<string, {
    readonly document: IndexedPageSnapshot["document"];
    readonly scrollAnchor: BrowserDocumentState["scrollAnchor"];
    readonly search: BrowserDocumentSearch | null;
  }>>;
  readonly loading: boolean;
  readonly pendingUrl: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error: string | null;
}

export interface BrowserPlaceholderTabState {
  readonly kind: "restoring" | "loading" | "failed";
  readonly id: string;
  readonly requestedUrl: string;
  readonly label: string;
  readonly storedScrollAnchor?: StoredBrowserDocument["scrollAnchor"];
  readonly restoreRevision: number;
  readonly retryCount: number;
  readonly error: string | null;
}

export type BrowserTabState = BrowserDocumentState | BrowserPlaceholderTabState;

export interface PickerValue {
  readonly kind: "link" | "outline" | "recall";
  readonly index: number;
  readonly target?: string;
  readonly node?: DocumentNodeRef;
}

export interface PickerOverlay {
  readonly kind: "picker";
  readonly pickerKind: PickerKind;
  readonly title: string;
  readonly index: SearchPickerIndex<PickerValue>;
  readonly state: UnscrolledSearchPickerState;
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
  readonly state: ContextMenuState;
}

export interface BrowserMenuOverlay {
  readonly kind: "browserMenu";
  readonly state: MenuTriggerState;
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
  readonly documents: readonly BrowserTabState[];
  readonly activeDocumentIndex: number;
  readonly recentlyClosed: readonly BrowserTabState[];
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
  | { readonly kind: "terminalResized" }
  | { readonly kind: "requestActiveViewport" }
  | { readonly kind: "restoreTab"; readonly documentId: string }
  | { readonly kind: "tabRestored"; readonly document: BrowserDocumentState; readonly restoreRevision: number }
  | {
      readonly kind: "tabRestoreFailed";
      readonly documentId: string;
      readonly restoreRevision: number;
      readonly message: string;
    }
  | { readonly kind: "viewportReady"; readonly payload: ViewportRenderPayload }
  | {
      readonly kind: "viewportFailed";
      readonly documentId: string;
      readonly documentRevision: number;
      readonly viewportRevision: number;
      readonly message: string;
    }
  | {
      readonly kind: "searchReady";
      readonly documentId: string;
      readonly documentRevision: number;
      readonly query: string;
      readonly matches: readonly DocumentSearchMatch[];
      readonly truncated: boolean;
    }
  | { readonly kind: "dismiss" }
  | { readonly kind: "scroll"; readonly rows: number }
  | { readonly kind: "scrollTo"; readonly row: number }
  | { readonly kind: "scrollTop" }
  | { readonly kind: "scrollBottom" }
  | { readonly kind: "moveSearch"; readonly direction: "next" | "prev" }
  | { readonly kind: "focusDocumentNode"; readonly target: DocumentNodeRef | null }
  | {
      readonly kind: "movePageFocus";
      readonly direction: "next" | "prev";
      readonly currentActionId: string;
    }
  | {
      readonly kind: "activateActionAt";
      readonly actionId: string;
      readonly disposition?: "current" | "newForeground" | "newBackground";
    }
  | {
      readonly kind: "openLinkMenu";
      readonly actionId: string;
      readonly row: number;
      readonly column: number;
    }
  | { readonly kind: "linkMenuTransition"; readonly transition: ContextMenuTransition }
  | { readonly kind: "linkMenuActivate"; readonly event: MenuActivateEvent }
  | { readonly kind: "navigate"; readonly operation: "back" | "forward" | "reload" | "stop" }
  | { readonly kind: "omniboxTransition"; readonly transition: CommandInputTransition }
  | { readonly kind: "omniboxSubmit"; readonly value: string }
  | { readonly kind: "focusOmnibox" }
  | { readonly kind: "cancelOmnibox" }
  | { readonly kind: "openActionPalette" }
  | { readonly kind: "browserMenuTransition"; readonly transition: MenuTriggerTransition }
  | { readonly kind: "browserMenuActivate"; readonly event: MenuActivateEvent }
  | { readonly kind: "openPicker"; readonly picker: PickerKind; readonly query?: string }
  | { readonly kind: "openDetail"; readonly detail: DetailKind }
  | { readonly kind: "toggleSidePanel"; readonly panel: SidePanelKind }
  | { readonly kind: "sidePanelScroll"; readonly request: ScrollRequest }
  | { readonly kind: "toggleBookmark" }
  | { readonly kind: "openExternal"; readonly target?: string }
  | { readonly kind: "newDocument"; readonly target?: string; readonly background?: boolean }
  | { readonly kind: "closeDocument" }
  | { readonly kind: "reopenDocument" }
  | { readonly kind: "selectDocument"; readonly index: number }
  | { readonly kind: "tabsTransition"; readonly transition: TabsTransition }
  | { readonly kind: "tabsClose"; readonly event: TabCloseEvent }
  | { readonly kind: "actionPaletteTransition"; readonly transition: CommandInputTransition }
  | { readonly kind: "actionPaletteSubmit"; readonly value: string }
  | { readonly kind: "pickerTransition"; readonly transition: SearchPickerControlTransition }
  | { readonly kind: "pickerAccept"; readonly event: SearchPickerAcceptEvent }
  | { readonly kind: "pickerSelect"; readonly value?: PickerValue }
  | { readonly kind: "openFind" }
  | { readonly kind: "findAction"; readonly transition: TextInputTransition }
  | { readonly kind: "findSubmit" }
  | { readonly kind: "closeFind" }
  | { readonly kind: "formText"; readonly controlId: string; readonly transition: TextInputTransition }
  | { readonly kind: "formNumber"; readonly controlId: string; readonly transition: NumberInputControlTransition }
  | { readonly kind: "formArea"; readonly controlId: string; readonly transition: TextAreaTransition }
  | { readonly kind: "formComboboxTransition"; readonly controlId: string; readonly transition: ComboboxControlTransition }
  | { readonly kind: "formComboboxCommit"; readonly controlId: string; readonly event: ComboboxCommitEvent }
  | { readonly kind: "formCheckboxGroup"; readonly controlId: string; readonly transition: CheckboxGroupTransition }
  | { readonly kind: "formValues"; readonly controlId: string; readonly values: readonly string[] }
  | { readonly kind: "activateButton"; readonly controlId: string }
  | { readonly kind: "resetForm"; readonly formId: string; readonly resetterId?: string }
  | { readonly kind: "submitForm"; readonly formId: string; readonly submitterId?: string }
  | {
      readonly kind: "pageLoaded";
      readonly documentId: string;
      readonly snapshot: IndexedPageSnapshot;
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
  | { readonly kind: "libraryChanged" }
  | { readonly kind: "operationComplete"; readonly status: string }
  | {
      readonly kind: "operationFailed";
      readonly message: string;
      readonly documentId?: string;
      readonly downloadTarget?: string;
    };
