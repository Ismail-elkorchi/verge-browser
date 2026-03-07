import { outline as buildOutline } from "@ismail-elkorchi/html-parser";

import { formatHelpText, parseCommand, type BrowserCommand } from "../app/commands.js";
import { NetworkFetchError } from "../app/fetch-page.js";
import { buildFormSubmissionRequest, extractForms } from "../app/forms.js";
import { activeSearchLineIndex, createSearchState, moveSearchMatch } from "../app/search.js";
import { type BrowserSession } from "../app/session.js";
import type { BrowserStore, IndexSearchResult } from "../app/storage.js";
import type { PageRequestOptions, PageSnapshot, RenderedActionable, RenderedPage } from "../app/types.js";
import { resolveInputUrl } from "../app/url.js";
import { renderShellFrame } from "./frame.js";
import { resolveShellKeyAction, type ShellKeyAction } from "./keymap.js";
import type { ShellServices } from "./services.js";
import type { TerminalAdapter } from "./terminal-adapter.js";
import type {
  BrowseFocusMode,
  DetailKind,
  DetailState,
  DocumentNavigationMemory,
  DocumentViewState,
  EditorFieldState,
  EditorState,
  PaletteMode,
  PaletteSuggestion,
  PickerItem,
  PickerKind,
  PickerState,
  SearchViewState,
  ShellState,
  StatusMessage
} from "./types.js";

const ACTION_SUGGESTIONS: readonly PaletteSuggestion[] = [
  { value: "links", description: "Open the links picker." },
  { value: "documents", description: "Switch between open documents." },
  { value: "diag", description: "Open page diagnostics." },
  { value: "history", description: "Open persisted history." },
  { value: "bookmark add", description: "Save the current page as a bookmark." },
  { value: "bookmarks", description: "Open saved bookmarks." },
  { value: "forms", description: "Open forms on the current page." },
  { value: "outline", description: "Open the heading outline." },
  { value: "save text ./view.txt", description: "Export the current screen to text." },
  { value: "save csv ./view.csv", description: "Export the current picker to CSV." },
  { value: "download ./page.html", description: "Save the current HTML snapshot." },
  { value: "open-external", description: "Open the current page or focused link externally." },
  { value: "close", description: "Close the active document." },
  { value: "reopen", description: "Reopen the most recently closed document." }
];

let nextDocumentIdValue = 1;

function nextDocumentId(): string {
  const documentId = `doc-${String(nextDocumentIdValue)}`;
  nextDocumentIdValue += 1;
  return documentId;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLineForExcerpt(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function composeExcerpt(lines: readonly string[]): string {
  return lines
    .slice(0, 8)
    .map((line) => normalizeLineForExcerpt(line))
    .filter((line) => line.length > 0)
    .join(" ")
    .slice(0, 220)
    .trim();
}

function statusMessage(text: string, tone: StatusMessage["tone"] = "info"): StatusMessage {
  return {
    text,
    tone
  };
}

function navigationMemoryKey(snapshot: PageSnapshot): string {
  return snapshot.finalUrl;
}

function createDocumentState(session: BrowserSession): DocumentViewState {
  return {
    id: nextDocumentId(),
    title: "Untitled document",
    session,
    snapshot: null,
    rendered: null,
    scrollOffset: 0,
    focusMode: "reading",
    linkControlFocus: null,
    search: null,
    navigationMemory: {}
  };
}

function restoreSearchViewState(lines: readonly string[], memory: DocumentNavigationMemory | undefined): SearchViewState | null {
  if (!memory?.searchQuery) {
    return null;
  }

  const nextState = createSearchState(lines, memory.searchQuery);
  if (nextState.matchLineIndices.length === 0) {
    return {
      state: nextState,
      preservedScrollOffset: memory.scrollOffset
    };
  }

  const activeMatchIndex = memory.searchMatchIndex === null
    ? nextState.activeMatchIndex
    : Math.max(0, Math.min(memory.searchMatchIndex, nextState.matchLineIndices.length - 1));

  return {
    state: {
      ...nextState,
      activeMatchIndex
    },
    preservedScrollOffset: memory.scrollOffset
  };
}

function actionableByFocus(rendered: RenderedPage | null, actionableIndex: number | null): RenderedActionable | null {
  if (!rendered || actionableIndex === null || actionableIndex < 0) {
    return null;
  }
  return rendered.actionables[actionableIndex] ?? null;
}

function formatNetworkError(error: unknown): string {
  if (error instanceof NetworkFetchError) {
    const outcome = error.networkOutcome;
    const statusText = outcome.status === null
      ? ""
      : ` status=${String(outcome.status)}${outcome.statusText ? ` ${outcome.statusText}` : ""}`;
    return `Navigation failed (${outcome.kind}${statusText}): ${outcome.detailMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isPrintableCharacter(character: string, keySequence: string): boolean {
  return character.length === 1 && keySequence.length === 1 && keySequence >= " ";
}

function createSearchViewState(lines: readonly string[], query: string, preservedScrollOffset: number): SearchViewState {
  return {
    state: createSearchState(lines, query),
    preservedScrollOffset
  };
}

function detailState(kind: DetailKind, title: string, lines: readonly string[]): DetailState {
  return {
    kind,
    title,
    lines,
    scrollOffset: 0
  };
}

function formatReaderLines(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }
  const readerLines = snapshot.rendered.lines
    .filter((line) => !/^Links:$/i.test(line.trim()))
    .filter((line) => !/^Forms:$/i.test(line.trim()))
    .filter((line) => !/^\s+\[\d+\]\s/.test(line))
    .filter((line) => !/^\s+\[form \d+\]\s/i.test(line))
    .filter((line) => !/^Parser reported \d+ recoverable issue\(s\)\.?$/i.test(line.trim()))
    .map((line) => line.replace(/\s+\[\d+\]/g, ""))
    .map((line) => line.trimEnd());

  const compact = readerLines.filter((line, index, lines) => {
    if (line.length > 0) {
      return true;
    }
    return lines[index - 1] !== "";
  });
  return compact.length > 0 ? compact : ["No readable content."];
}

function formatDiagnosticsLines(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }

  return [
    "Diagnostics",
    "",
    `URL: ${snapshot.finalUrl}`,
    `Status: ${String(snapshot.status)} ${snapshot.statusText}`,
    `Parse mode: ${snapshot.diagnostics.parseMode}`,
    `Request method: ${snapshot.diagnostics.requestMethod}`,
    `Used cookies: ${snapshot.diagnostics.usedCookies ? "yes" : "no"}`,
    `Network outcome: ${snapshot.diagnostics.networkOutcome.kind}`,
    `Network detail: ${snapshot.diagnostics.networkOutcome.detailMessage}`,
    `Source bytes: ${snapshot.diagnostics.sourceBytes === null ? "unavailable" : String(snapshot.diagnostics.sourceBytes)}`,
    `Parse errors: ${String(snapshot.diagnostics.parseErrorCount)}`,
    `Triage IDs: ${snapshot.diagnostics.triageIds.length === 0 ? "(none)" : snapshot.diagnostics.triageIds.join(", ")}`,
    `Trace events: ${String(snapshot.diagnostics.traceEventCount)}`,
    `Trace kinds: ${snapshot.diagnostics.traceKinds.length === 0 ? "(none)" : snapshot.diagnostics.traceKinds.join(", ")}`,
    `Fetch ms: ${String(snapshot.diagnostics.fetchDurationMs)}`,
    `Parse ms: ${String(snapshot.diagnostics.parseDurationMs)}`,
    `Render ms: ${String(snapshot.diagnostics.renderDurationMs)}`,
    `Total ms: ${String(snapshot.diagnostics.totalDurationMs)}`
  ];
}

function formatCookieLines(store: BrowserStore): readonly string[] {
  const cookies = store.listCookies();
  if (cookies.length === 0) {
    return ["No cookies stored."];
  }

  const lines = ["Cookies", ""];
  for (const cookie of cookies) {
    const scope = `${cookie.domain}${cookie.path}`;
    const expires = cookie.expiresAtIso ?? "session";
    const flags = [
      cookie.hostOnly ? "hostOnly" : "domain",
      cookie.secure ? "secure" : "plain",
      cookie.httpOnly ? "httpOnly" : "scriptVisible",
      cookie.sameSite ? `sameSite=${cookie.sameSite}` : "sameSite=unset"
    ];
    lines.push(`${cookie.name}=${cookie.value}`);
    lines.push(`  scope: ${scope}`);
    lines.push(`  flags: ${flags.join(", ")}`);
    lines.push(`  expires: ${expires}`);
    lines.push("");
  }
  return lines;
}

function lineIndexForOutlineText(rendered: RenderedPage, text: string): number {
  const normalizedText = text.trim().toLowerCase();
  if (normalizedText.length === 0) {
    return 0;
  }

  const lineIndex = rendered.lines.findIndex((line) => line.toLowerCase().includes(normalizedText));
  return lineIndex >= 0 ? lineIndex : 0;
}

export interface BrowserShellOptions {
  readonly adapter: TerminalAdapter;
  readonly store: BrowserStore;
  readonly services: ShellServices;
  readonly createSession: () => BrowserSession;
  readonly onSnapshot?: (snapshot: PageSnapshot) => Promise<void>;
  readonly screenReaderMode?: boolean;
}

export class BrowserShell {
  private readonly adapter: TerminalAdapter;
  private readonly store: BrowserStore;
  private readonly services: ShellServices;
  private readonly createSession: () => BrowserSession;
  private readonly onSnapshot: ((snapshot: PageSnapshot) => Promise<void>) | undefined;
  private readonly exitPromise: Promise<void>;
  private inputQueue: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;
  private keypressCleanup: (() => void) | null = null;
  private resizeCleanup: (() => void) | null = null;
  private lastRecallResults: readonly IndexSearchResult[] = [];
  private state: ShellState;

  public constructor(options: BrowserShellOptions) {
    this.adapter = options.adapter;
    this.store = options.store;
    this.services = options.services;
    this.createSession = options.createSession;
    this.onSnapshot = options.onSnapshot;
    this.state = {
      screen: "browse",
      documents: [],
      activeDocumentIndex: 0,
      recentlyClosedDocuments: [],
      picker: null,
      palette: null,
      editor: null,
      detail: null,
      status: null,
      screenReaderMode: options.screenReaderMode === true,
      shouldExit: false
    };
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  public getState(): ShellState {
    return this.state;
  }

  public async run(initialTarget: string): Promise<void> {
    await this.openInitialTarget(initialTarget);
    this.render();

    this.adapter.setRawMode(true);
    this.keypressCleanup = this.adapter.onKeypress((character, key) => {
      this.enqueue(async () => {
        await this.handleKeypress(character, key);
      });
    });
    this.resizeCleanup = this.adapter.onResize(() => {
      this.render();
    });

    await this.exitPromise;
    await this.inputQueue;
    this.cleanup();
  }

  public async runOnce(initialTarget: string): Promise<void> {
    await this.openInitialTarget(initialTarget);
    this.render();
  }

  private cleanup(): void {
    this.keypressCleanup?.();
    this.resizeCleanup?.();
    this.keypressCleanup = null;
    this.resizeCleanup = null;
    this.adapter.dispose();
  }

  private render(): void {
    const frame = renderShellFrame(this.state, this.adapter.getSize());
    this.adapter.clearScreen();
    this.adapter.write(frame.text);
    if (frame.cursor) {
      this.adapter.showCursor();
      this.adapter.moveCursor(frame.cursor);
      return;
    }
    this.adapter.hideCursor();
  }

  private enqueue(task: () => Promise<void>): void {
    this.inputQueue = this.inputQueue.then(async () => {
      if (this.state.shouldExit) {
        return;
      }
      try {
        await task();
      } catch (error: unknown) {
        this.setStatus(formatNetworkError(error), "error");
      }
      this.render();
    });
  }

  private setStatus(text: string, tone: StatusMessage["tone"] = "info"): void {
    this.state = {
      ...this.state,
      status: statusMessage(text, tone)
    };
  }

  private clearStatus(): void {
    this.state = {
      ...this.state,
      status: null
    };
  }

  private activeDocument(): DocumentViewState | null {
    return this.state.documents[this.state.activeDocumentIndex] ?? null;
  }

  private updateActiveDocument(updater: (documentState: DocumentViewState) => DocumentViewState): void {
    const activeDocument = this.activeDocument();
    if (!activeDocument) {
      return;
    }

    const nextDocuments = [...this.state.documents];
    nextDocuments[this.state.activeDocumentIndex] = updater(activeDocument);
    this.state = {
      ...this.state,
      documents: nextDocuments
    };
  }

  private updateDocumentAt(documentIndex: number, updater: (documentState: DocumentViewState) => DocumentViewState): void {
    const targetDocument = this.state.documents[documentIndex];
    if (!targetDocument) {
      return;
    }
    const nextDocuments = [...this.state.documents];
    nextDocuments[documentIndex] = updater(targetDocument);
    this.state = {
      ...this.state,
      documents: nextDocuments
    };
  }

  private rememberDocumentView(documentIndex: number): void {
    this.updateDocumentAt(documentIndex, (documentState) => {
      if (!documentState.snapshot) {
        return documentState;
      }

      const searchState = documentState.search?.state ?? null;
      const memory: DocumentNavigationMemory = {
        scrollOffset: documentState.scrollOffset,
        focusMode: documentState.focusMode,
        actionableIndex: documentState.linkControlFocus?.actionableIndex ?? null,
        searchQuery: searchState?.query ?? null,
        searchMatchIndex: searchState?.matchLineIndices.length ? searchState.activeMatchIndex : null
      };

      return {
        ...documentState,
        navigationMemory: {
          ...documentState.navigationMemory,
          [navigationMemoryKey(documentState.snapshot)]: memory
        }
      };
    });
  }

  private applySnapshotToDocument(documentIndex: number, snapshot: PageSnapshot): void {
    this.updateDocumentAt(documentIndex, (documentState) => {
      const memory = documentState.navigationMemory[navigationMemoryKey(snapshot)];
      const search = restoreSearchViewState(snapshot.rendered.lines, memory);
      const linkControlFocus = memory?.actionableIndex === null || memory?.actionableIndex === undefined
        ? null
        : snapshot.rendered.actionables[memory.actionableIndex]
          ? { actionableIndex: memory.actionableIndex }
          : null;
      const focusMode: BrowseFocusMode = linkControlFocus ? (memory?.focusMode ?? "reading") : "reading";

      return {
        ...documentState,
        title: snapshot.rendered.title,
        snapshot,
        rendered: snapshot.rendered,
        scrollOffset: memory?.scrollOffset ?? 0,
        focusMode,
        linkControlFocus,
        search
      };
    });
  }

  private openHelpDetail(): void {
    this.state = {
      ...this.state,
      screen: "detail",
      detail: detailState("help", "Help", formatHelpText().split("\n")),
      picker: null,
      palette: null,
      editor: null
    };
  }

  private openDiagnosticsDetail(): void {
    const snapshot = this.activeDocument()?.snapshot ?? null;
    this.state = {
      ...this.state,
      screen: "detail",
      detail: detailState("diagnostics", "Diagnostics", formatDiagnosticsLines(snapshot)),
      picker: null,
      palette: null,
      editor: null
    };
  }

  private openReaderDetail(): void {
    const snapshot = this.activeDocument()?.snapshot ?? null;
    this.state = {
      ...this.state,
      screen: "detail",
      detail: detailState("reader", "Reader", formatReaderLines(snapshot)),
      picker: null,
      palette: null,
      editor: null
    };
  }

  private openCookiesDetail(): void {
    this.state = {
      ...this.state,
      screen: "detail",
      detail: detailState("cookies", "Cookies", formatCookieLines(this.store)),
      picker: null,
      palette: null,
      editor: null
    };
  }

  private closeTransientScreens(): void {
    this.state = {
      ...this.state,
      screen: "browse",
      picker: null,
      palette: null,
      editor: null,
      detail: null
    };
  }

  private attachCookieHeader(targetUrl: string, requestOptions: PageRequestOptions): PageRequestOptions {
    const mergedHeaders: Record<string, string> = {
      ...(requestOptions.headers ?? {})
    };
    const hasCookieHeader = Object.keys(mergedHeaders).some((name) => name.toLowerCase() === "cookie");
    if (!hasCookieHeader) {
      const cookieHeader = this.store.cookieHeaderForUrl(targetUrl);
      if (cookieHeader) {
        mergedHeaders.cookie = cookieHeader;
      }
    }
    return {
      ...requestOptions,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {})
    };
  }

  private async persistSnapshot(snapshot: PageSnapshot): Promise<void> {
    if (snapshot.setCookieHeaders.length > 0) {
      await this.store.applySetCookieHeaders(snapshot.finalUrl, snapshot.setCookieHeaders);
    }
    const excerpt = composeExcerpt(snapshot.rendered.lines);
    await this.store.recordHistory(snapshot.finalUrl, snapshot.rendered.title, excerpt);
    await this.store.recordIndexDocument(snapshot.finalUrl, snapshot.rendered.title, snapshot.rendered.lines.join("\n"));
    if (this.onSnapshot) {
      await this.onSnapshot(snapshot);
    }
  }

  private async navigateDocument(
    documentIndex: number,
    rawTarget: string,
    parseMode: "text" | "stream" = "text",
    requestOptions: PageRequestOptions = {}
  ): Promise<void> {
    const documentState = this.state.documents[documentIndex];
    if (!documentState) {
      throw new Error("No document is active");
    }

    this.rememberDocumentView(documentIndex);

    const currentUrl = documentState.snapshot?.finalUrl;
    const resolvedTarget = resolveInputUrl(rawTarget, currentUrl);
    const nextRequestOptions = this.attachCookieHeader(resolvedTarget, requestOptions);
    const snapshot = await documentState.session.openWithRequest(resolvedTarget, nextRequestOptions, parseMode);
    await this.persistSnapshot(snapshot);
    this.applySnapshotToDocument(documentIndex, snapshot);
    this.state = {
      ...this.state,
      activeDocumentIndex: documentIndex,
      screen: "browse",
      picker: null,
      palette: null,
      editor: null,
      detail: null,
      status: statusMessage(`Opened ${snapshot.finalUrl}${parseMode === "stream" ? " (stream)" : ""}`, "success")
    };
  }

  private async openLinkOnDocument(documentIndex: number, linkIndex: number): Promise<void> {
    const documentState = this.state.documents[documentIndex];
    if (!documentState) {
      throw new Error("No document is active");
    }
    this.rememberDocumentView(documentIndex);
    const snapshot = await documentState.session.openLink(linkIndex);
    await this.persistSnapshot(snapshot);
    this.applySnapshotToDocument(documentIndex, snapshot);
    this.state = {
      ...this.state,
      activeDocumentIndex: documentIndex,
      screen: "browse",
      picker: null,
      palette: null,
      editor: null,
      detail: null,
      status: statusMessage(`Opened link [${String(linkIndex)}]`, "success")
    };
  }

  private async openInitialTarget(initialTarget: string): Promise<void> {
    if (this.state.documents.length === 0) {
      this.state = {
        ...this.state,
        documents: [createDocumentState(this.createSession())],
        activeDocumentIndex: 0
      };
    }

    try {
      await this.navigateDocument(0, initialTarget);
    } catch (error: unknown) {
      this.state = {
        ...this.state,
        status: statusMessage(formatNetworkError(error), "error")
      };
      this.openHelpDetail();
    }
  }

  private activeActionable(): RenderedActionable | null {
    const documentState = this.activeDocument();
    return actionableByFocus(documentState?.rendered ?? null, documentState?.linkControlFocus?.actionableIndex ?? null);
  }

  private moveActionableFocus(direction: "next" | "prev"): void {
    this.updateActiveDocument((documentState) => {
      const rendered = documentState.rendered;
      if (!rendered || rendered.actionables.length === 0) {
        this.setStatus("No links or controls are available on this page.", "error");
        return documentState;
      }

      const currentIndex = documentState.linkControlFocus?.actionableIndex ?? -1;
      const nextIndex = direction === "next"
        ? Math.min(rendered.actionables.length - 1, currentIndex + 1)
        : currentIndex === -1
          ? rendered.actionables.length - 1
          : Math.max(0, currentIndex - 1);

      if (nextIndex === currentIndex) {
        this.setStatus(direction === "next" ? "Already on the last page action." : "Already on the first page action.");
        return documentState;
      }

      const nextActionable = rendered.actionables[nextIndex];
      if (!nextActionable) {
        return documentState;
      }
      this.clearStatus();
      return {
        ...documentState,
        focusMode: "link-control",
        linkControlFocus: {
          actionableIndex: nextIndex
        },
        scrollOffset: nextActionable.lineIndex
      };
    });
  }

  private scrollActiveDocument(delta: number): void {
    this.updateActiveDocument((documentState) => ({
      ...documentState,
      scrollOffset: Math.max(0, documentState.scrollOffset + delta)
    }));
  }

  private pageSize(): number {
    return Math.max(1, this.adapter.getSize().rows - 4);
  }

  private jumpActiveDocument(position: "top" | "bottom"): void {
    this.updateActiveDocument((documentState) => ({
      ...documentState,
      scrollOffset: position === "top"
        ? 0
        : Math.max(0, (documentState.rendered?.lines.length ?? 0) - this.pageSize())
    }));
  }

  private openPicker(kind: PickerKind, queryText: string | null = null): void {
    const picker = this.buildPickerState(kind, queryText, "", "", "list", 0);
    this.state = {
      ...this.state,
      screen: "picker",
      picker,
      palette: null,
      editor: null,
      detail: null
    };
  }

  private buildPickerState(
    kind: PickerKind,
    queryText: string | null,
    filterText: string,
    jumpText: string,
    focusTarget: "list" | "filter",
    selectedIndex: number
  ): PickerState {
    const activeDocument = this.activeDocument();
    const snapshot = activeDocument?.snapshot ?? null;
    let items: readonly PickerItem[] = [];
    let title = kind[0]?.toUpperCase() ? `${kind[0].toUpperCase()}${kind.slice(1)}` : kind;

    switch (kind) {
      case "documents":
        items = this.state.documents.map((documentState, index) => ({
          index: index + 1,
          label: documentState.title,
          detail: documentState.snapshot?.finalUrl ?? "unloaded",
          payload: {
            kind: "document",
            documentIndex: index
          }
        }));
        title = "Documents";
        break;
      case "links":
        items = (snapshot?.rendered.links ?? []).map((link, index) => ({
          index: index + 1,
          label: link.label,
          detail: link.resolvedHref,
          payload: {
            kind: "link",
            actionableIndex: snapshot?.rendered.actionables.findIndex(
              (actionable) => actionable.kind === "link" && actionable.index === link.index
            ) ?? index,
            linkIndex: link.index
          }
        }));
        title = "Links";
        break;
      case "history":
        items = this.store.listHistory().map((entry, index) => ({
          index: index + 1,
          label: entry.title,
          detail: entry.url,
          payload: {
            kind: "history",
            historyIndex: index
          }
        }));
        title = "History";
        break;
      case "bookmarks":
        items = this.store.listBookmarks().map((entry, index) => ({
          index: index + 1,
          label: entry.name,
          detail: entry.url,
          payload: {
            kind: "bookmark",
            bookmarkIndex: index
          }
        }));
        title = "Bookmarks";
        break;
      case "forms":
        items = snapshot
          ? extractForms(snapshot.tree, snapshot.finalUrl).map((form, index) => ({
            index: index + 1,
            label: `${form.method.toUpperCase()} ${form.actionUrl}`,
            detail: form.fields.length === 0 ? "no named fields" : `${String(form.fields.length)} fields`,
            payload: {
              kind: "form",
              formIndex: form.index
            }
          }))
          : [];
        title = "Forms";
        break;
      case "outline":
        items = snapshot
          ? buildOutline(snapshot.tree).entries.map((entry, index) => ({
            index: index + 1,
            label: entry.text,
            detail: `<${entry.tagName}> depth ${String(entry.depth)}`,
            payload: {
              kind: "outline",
              lineIndex: lineIndexForOutlineText(snapshot.rendered, entry.text)
            }
          }))
          : [];
        title = "Outline";
        break;
      case "recall":
        this.lastRecallResults = queryText ? this.store.searchIndex(queryText, 20) : [];
        items = this.lastRecallResults.map((result, index) => ({
          index: index + 1,
          label: result.title,
          detail: `${result.url} | score=${String(result.score)}`,
          payload: {
            kind: "recall",
            recallIndex: index
          }
        }));
        title = queryText ? `Recall: ${queryText}` : "Recall";
        break;
    }

    const normalizedFilter = filterText.trim().toLowerCase();
    if (normalizedFilter.length > 0) {
      items = items.filter((item) =>
        `${item.label}\n${item.detail ?? ""}`.toLowerCase().includes(normalizedFilter)
      );
    }

    const nextSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));

    return {
      kind,
      title,
      items,
      queryText,
      selectedIndex: nextSelectedIndex,
      filterText,
      jumpText,
      focusTarget
    };
  }

  private pickerSelectedItem(): PickerItem | null {
    const picker = this.state.picker;
    if (!picker) {
      return null;
    }
    return picker.items[picker.selectedIndex] ?? null;
  }

  private async activatePickerItem(item: PickerItem | null): Promise<void> {
    if (!item) {
      this.setStatus("No item is selected.", "error");
      return;
    }

    switch (item.payload.kind) {
      case "document":
        this.state = {
          ...this.state,
          activeDocumentIndex: item.payload.documentIndex,
          screen: "browse",
          picker: null
        };
        this.setStatus(`Switched to document ${String(item.payload.documentIndex + 1)}.`, "success");
        return;
      case "link":
        this.state = {
          ...this.state,
          screen: "browse",
          picker: null
        };
        await this.openLinkOnDocument(this.state.activeDocumentIndex, item.payload.linkIndex);
        return;
      case "history": {
        const entry = this.store.listHistory()[item.payload.historyIndex];
        if (!entry) {
          this.setStatus("That history entry is no longer available.", "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, entry.url);
        return;
      }
      case "bookmark": {
        const entry = this.store.listBookmarks()[item.payload.bookmarkIndex];
        if (!entry) {
          this.setStatus("That bookmark is no longer available.", "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, entry.url);
        return;
      }
      case "form":
        this.openEditor(item.payload.formIndex);
        return;
      case "outline":
        this.updateActiveDocument((documentState) => ({
          ...documentState,
          scrollOffset: (item.payload.kind === "outline" ? item.payload.lineIndex : documentState.scrollOffset)
        }));
        this.state = {
          ...this.state,
          screen: "browse",
          picker: null
        };
        this.setStatus("Moved to the selected outline entry.", "success");
        return;
      case "recall": {
        const result = this.lastRecallResults[item.payload.recallIndex];
        if (!result) {
          this.setStatus("That recall result is no longer available.", "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, result.url);
        return;
      }
    }
  }

  private openPalette(mode: PaletteMode, inputText = ""): void {
    this.state = {
      ...this.state,
      screen: "palette",
      palette: {
        mode,
        inputText,
        suggestions: this.paletteSuggestions(mode, inputText),
        selectedSuggestionIndex: 0,
        repairText: null
      },
      picker: null,
      editor: null,
      detail: null
    };
  }

  private paletteSuggestions(mode: PaletteMode, inputText: string): readonly PaletteSuggestion[] {
    const normalizedInput = inputText.trim().toLowerCase();
    if (mode === "action") {
      if (normalizedInput.length === 0) {
        return ACTION_SUGGESTIONS;
      }
      return ACTION_SUGGESTIONS.filter((suggestion) => suggestion.value.toLowerCase().includes(normalizedInput));
    }

    if (mode === "location") {
      const suggestions: PaletteSuggestion[] = [];
      const activeDocument = this.activeDocument();
      if (activeDocument?.snapshot) {
        suggestions.push({
          value: activeDocument.snapshot.finalUrl,
          description: "Current page"
        });
      }
      const focusedActionable = this.activeActionable();
      if (focusedActionable?.kind === "link") {
        suggestions.push({
          value: focusedActionable.resolvedHref,
          description: "Focused link"
        });
      }
      return normalizedInput.length === 0
        ? suggestions
        : suggestions.filter((suggestion) => suggestion.value.toLowerCase().includes(normalizedInput));
    }

    return [];
  }

  private paletteInputValue(): string {
    const palette = this.state.palette;
    if (!palette) {
      return "";
    }
    if (palette.inputText.trim().length > 0) {
      return palette.inputText;
    }
    return palette.suggestions[palette.selectedSuggestionIndex]?.value ?? "";
  }

  private async activatePalette(): Promise<void> {
    const palette = this.state.palette;
    if (!palette) {
      return;
    }

    const value = this.paletteInputValue().trim();
    if (value.length === 0) {
      this.state = {
        ...this.state,
        palette: {
          ...palette,
          repairText: palette.mode === "search" ? "Type a query before pressing Enter." : "Type input before pressing Enter."
        }
      };
      return;
    }

    if (palette.mode === "location") {
      await this.navigateDocument(this.state.activeDocumentIndex, value);
      return;
    }

    if (palette.mode === "search") {
      this.applySearchQuery(value);
      return;
    }

    await this.executeCommand(parseCommand(value));
  }

  private applySearchQuery(query: string): void {
    this.updateActiveDocument((documentState) => {
      if (!documentState.rendered) {
        return documentState;
      }
      const search = createSearchViewState(documentState.rendered.lines, query, documentState.scrollOffset);
      const activeLineIndex = activeSearchLineIndex(search.state);
      return {
        ...documentState,
        search,
        scrollOffset: activeLineIndex ?? documentState.scrollOffset,
        focusMode: "reading",
        linkControlFocus: null
      };
    });

    this.closeTransientScreens();
    const searchState = this.activeDocument()?.search?.state;
    if (!searchState || searchState.matchLineIndices.length === 0) {
      this.setStatus(`No matches for "${query}"`, "error");
      return;
    }
    this.setStatus(
      `find ${String(searchState.activeMatchIndex + 1)}/${String(searchState.matchLineIndices.length)} "${searchState.query}"`,
      "success"
    );
  }

  private moveSearch(direction: "next" | "prev"): void {
    this.updateActiveDocument((documentState) => {
      if (!documentState.search) {
        this.setStatus("No active search. Press / to start a find query.", "error");
        return documentState;
      }
      const nextSearchState = moveSearchMatch(documentState.search.state, direction);
      const lineIndex = activeSearchLineIndex(nextSearchState);
      if (lineIndex === null) {
        this.setStatus(`No matches for "${nextSearchState.query}"`, "error");
        return {
          ...documentState,
          search: {
            ...documentState.search,
            state: nextSearchState
          }
        };
      }

      this.setStatus(
        `find ${String(nextSearchState.activeMatchIndex + 1)}/${String(nextSearchState.matchLineIndices.length)} "${nextSearchState.query}"`,
        "success"
      );
      return {
        ...documentState,
        search: {
          ...documentState.search,
          state: nextSearchState
        },
        scrollOffset: lineIndex
      };
    });
  }

  private clearSearch(): void {
    this.updateActiveDocument((documentState) => {
      if (!documentState.search) {
        return documentState;
      }
      return {
        ...documentState,
        search: null,
        scrollOffset: documentState.search.preservedScrollOffset
      };
    });
    this.setStatus("Search cleared.", "success");
  }

  private openEditor(formIndex: number): void {
    const documentState = this.activeDocument();
    const snapshot = documentState?.snapshot;
    if (!documentState || !snapshot) {
      this.setStatus("No page is loaded.", "error");
      return;
    }

    const form = extractForms(snapshot.tree, snapshot.finalUrl)[formIndex - 1];
    if (!form) {
      this.setStatus(`No form exists at index ${String(formIndex)}.`, "error");
      return;
    }

    const fields: readonly EditorFieldState[] = form.fields.map((field) => ({
      name: field.name,
      label: field.name,
      value: field.value,
      multiline: field.type === "textarea"
    }));

    this.state = {
      ...this.state,
      screen: "editor",
      editor: {
        title: `Form ${String(form.index)}`,
        form,
        fields,
        selectedFieldIndex: 0,
        mode: "select",
        cursorOffset: fields[0]?.value.length ?? 0,
        dirty: false,
        documentId: documentState.id
      },
      picker: null,
      palette: null,
      detail: null
    };
  }

  private updateEditor(updater: (editor: EditorState) => EditorState): void {
    if (!this.state.editor) {
      return;
    }
    this.state = {
      ...this.state,
      editor: updater(this.state.editor)
    };
  }

  private insertEditorText(text: string): void {
    this.updateEditor((editor) => {
      if (editor.mode !== "edit") {
        return editor;
      }
      const currentField = editor.fields[editor.selectedFieldIndex];
      if (!currentField) {
        return editor;
      }
      const nextValue = `${currentField.value.slice(0, editor.cursorOffset)}${text}${currentField.value.slice(editor.cursorOffset)}`;
      const nextFields = [...editor.fields];
      nextFields[editor.selectedFieldIndex] = {
        ...currentField,
        value: nextValue
      };
      return {
        ...editor,
        fields: nextFields,
        cursorOffset: editor.cursorOffset + text.length,
        dirty: true
      };
    });
  }

  private backspaceEditorText(): void {
    this.updateEditor((editor) => {
      if (editor.mode !== "edit" || editor.cursorOffset === 0) {
        return editor;
      }
      const currentField = editor.fields[editor.selectedFieldIndex];
      if (!currentField) {
        return editor;
      }
      const nextValue = `${currentField.value.slice(0, editor.cursorOffset - 1)}${currentField.value.slice(editor.cursorOffset)}`;
      const nextFields = [...editor.fields];
      nextFields[editor.selectedFieldIndex] = {
        ...currentField,
        value: nextValue
      };
      return {
        ...editor,
        fields: nextFields,
        cursorOffset: editor.cursorOffset - 1,
        dirty: true
      };
    });
  }

  private moveEditorCursor(direction: "left" | "right"): void {
    this.updateEditor((editor) => {
      if (editor.mode !== "edit") {
        return editor;
      }
      const currentField = editor.fields[editor.selectedFieldIndex];
      if (!currentField) {
        return editor;
      }
      return {
        ...editor,
        cursorOffset: direction === "left"
          ? Math.max(0, editor.cursorOffset - 1)
          : Math.min(currentField.value.length, editor.cursorOffset + 1)
      };
    });
  }

  private async submitEditor(): Promise<void> {
    const editor = this.state.editor;
    if (!editor) {
      return;
    }
    const overrides: Record<string, string> = {};
    for (const field of editor.fields) {
      overrides[field.name] = field.value;
    }
    const submission = buildFormSubmissionRequest(editor.form, overrides);
    this.state = {
      ...this.state,
      editor: null,
      screen: "browse"
    };
    await this.navigateDocument(this.state.activeDocumentIndex, submission.url, "text", submission.requestOptions);
  }

  private async openExternalEditor(): Promise<void> {
    const editor = this.state.editor;
    if (!editor) {
      return;
    }
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field) {
      return;
    }
    this.adapter.showCursor();
    this.adapter.setRawMode(false);
    try {
      const nextValue = await this.services.editTextExternally(field.value, field.label);
      this.updateEditor((currentEditor) => {
        const nextFields = [...currentEditor.fields];
        nextFields[currentEditor.selectedFieldIndex] = {
          ...field,
          value: nextValue
        };
        return {
          ...currentEditor,
          fields: nextFields,
          cursorOffset: nextValue.length,
          dirty: true,
          mode: "edit"
        };
      });
      this.setStatus(`Updated ${field.label} in the external editor.`, "success");
    } finally {
      this.adapter.setRawMode(true);
    }
  }

  private closeActiveDocument(): void {
    if (this.state.documents.length <= 1) {
      this.setStatus("At least one document must remain open.", "error");
      return;
    }

    const activeDocument = this.activeDocument();
    if (!activeDocument) {
      return;
    }
    const nextDocuments = [...this.state.documents];
    nextDocuments.splice(this.state.activeDocumentIndex, 1);
    this.state = {
      ...this.state,
      documents: nextDocuments,
      activeDocumentIndex: Math.max(0, this.state.activeDocumentIndex - 1),
      recentlyClosedDocuments: [
        {
          document: activeDocument,
          closedAtIso: nowIso()
        },
        ...this.state.recentlyClosedDocuments
      ].slice(0, 10),
      screen: "browse",
      picker: null,
      palette: null,
      editor: null,
      detail: null,
      status: statusMessage(`Closed ${activeDocument.title}.`, "success")
    };
  }

  private reopenClosedDocument(): void {
    const recentlyClosedDocument = this.state.recentlyClosedDocuments[0];
    if (!recentlyClosedDocument) {
      this.setStatus("No recently closed document is available.", "error");
      return;
    }

    this.state = {
      ...this.state,
      documents: [...this.state.documents, recentlyClosedDocument.document],
      activeDocumentIndex: this.state.documents.length,
      recentlyClosedDocuments: this.state.recentlyClosedDocuments.slice(1),
      screen: "browse",
      picker: null,
      palette: null,
      editor: null,
      detail: null,
      status: statusMessage(`Reopened ${recentlyClosedDocument.document.title}.`, "success")
    };
  }

  private async openFocusedTargetInNewDocument(): Promise<void> {
    const actionable = this.activeActionable();
    if (!actionable) {
      this.setStatus("Focus a link before opening a new document.", "error");
      return;
    }

    if (actionable.kind !== "link") {
      this.setStatus("Only links can be opened in a new document.", "error");
      return;
    }

    const session = this.createSession();
    const documentState = createDocumentState(session);
    this.state = {
      ...this.state,
      documents: [...this.state.documents, documentState],
      activeDocumentIndex: this.state.documents.length
    };
    await this.navigateDocument(this.state.activeDocumentIndex, actionable.resolvedHref);
  }

  private pickerCsvRows(): readonly (readonly string[])[] {
    const picker = this.state.picker;
    if (!picker) {
      return [];
    }

    switch (picker.kind) {
      case "documents":
        return [["index", "title", "url"], ...picker.items.map((item) => [String(item.index), item.label, item.detail ?? ""])];
      case "links":
        return [["index", "label", "url"], ...picker.items.map((item) => [String(item.index), item.label, item.detail ?? ""])];
      case "history":
      case "bookmarks":
      case "recall":
        return [["index", "label", "detail"], ...picker.items.map((item) => [String(item.index), item.label, item.detail ?? ""])];
      case "forms":
        return [["index", "method_action", "detail"], ...picker.items.map((item) => [String(item.index), item.label, item.detail ?? ""])];
      case "outline":
        return [["index", "heading", "detail"], ...picker.items.map((item) => [String(item.index), item.label, item.detail ?? ""])];
    }
  }

  private currentTextExport(): string {
    return renderShellFrame(this.state, this.adapter.getSize()).text;
  }

  private async saveTextExport(path: string): Promise<void> {
    await this.services.writeTextFile(path, `${this.currentTextExport()}\n`);
    this.setStatus(`Saved text export to ${path}.`, "success");
  }

  private async saveCsvExport(path: string): Promise<void> {
    const rows = this.pickerCsvRows();
    if (rows.length === 0) {
      this.setStatus("CSV export is only available from a picker screen.", "error");
      return;
    }
    await this.services.writeCsvFile(path, rows);
    this.setStatus(`Saved CSV export to ${path}.`, "success");
  }

  private async downloadSnapshot(path: string): Promise<void> {
    const snapshot = this.activeDocument()?.snapshot;
    if (!snapshot?.sourceHtml) {
      this.setStatus("No HTML snapshot is available to download.", "error");
      return;
    }
    await this.services.writeTextFile(path, snapshot.sourceHtml);
    this.setStatus(`Saved HTML snapshot to ${path}.`, "success");
  }

  private async openExternalTarget(): Promise<void> {
    const actionable = this.activeActionable();
    const target = actionable?.kind === "link"
      ? actionable.resolvedHref
      : this.activeDocument()?.snapshot?.finalUrl;

    if (!target) {
      this.setStatus("No target is available to open externally.", "error");
      return;
    }

    await this.services.openExternal(target);
    this.setStatus(`Opened ${target} externally.`, "success");
  }

  private stop(): void {
    this.state = {
      ...this.state,
      shouldExit: true
    };
    this.resolveExit?.();
  }

  private async executeCommand(command: BrowserCommand): Promise<void> {
    if (command.kind === "invalid") {
      const nextRepair = command.reason.includes("requires")
        ? `${command.reason}. Press ? for help, or press g to enter a URL.`
        : `${command.reason}. Press ? for help.`;
      this.state = {
        ...this.state,
        palette: this.state.palette
          ? {
            ...this.state.palette,
            repairText: nextRepair
          }
          : this.state.palette
      };
      this.setStatus(`Unknown action. ${nextRepair}`, "error");
      return;
    }

    switch (command.kind) {
      case "quit":
        this.stop();
        return;
      case "help":
        this.openHelpDetail();
        return;
      case "view":
        this.closeTransientScreens();
        this.setStatus("Browse screen.", "success");
        return;
      case "reader":
        this.openReaderDetail();
        return;
      case "links":
        this.openPicker("links");
        return;
      case "documents":
        this.openPicker("documents");
        return;
      case "diag":
        this.openDiagnosticsDetail();
        return;
      case "outline":
        this.openPicker("outline");
        return;
      case "page-down":
        this.scrollActiveDocument(this.pageSize());
        return;
      case "page-up":
        this.scrollActiveDocument(-this.pageSize());
        return;
      case "page-top":
        this.jumpActiveDocument("top");
        return;
      case "page-bottom":
        this.jumpActiveDocument("bottom");
        return;
      case "find":
        this.applySearchQuery(command.query);
        return;
      case "find-next":
        this.moveSearch("next");
        return;
      case "find-prev":
        this.moveSearch("prev");
        return;
      case "back": {
        const activeDocument = this.activeDocument();
        if (!activeDocument) {
          return;
        }
        this.rememberDocumentView(this.state.activeDocumentIndex);
        const snapshot = await activeDocument.session.back();
        await this.persistSnapshot(snapshot);
        this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
        this.closeTransientScreens();
        this.setStatus(`Back -> ${snapshot.finalUrl}`, "success");
        return;
      }
      case "forward": {
        const activeDocument = this.activeDocument();
        if (!activeDocument) {
          return;
        }
        this.rememberDocumentView(this.state.activeDocumentIndex);
        const snapshot = await activeDocument.session.forward();
        await this.persistSnapshot(snapshot);
        this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
        this.closeTransientScreens();
        this.setStatus(`Forward -> ${snapshot.finalUrl}`, "success");
        return;
      }
      case "reload": {
        const activeDocument = this.activeDocument();
        if (!activeDocument) {
          return;
        }
        this.rememberDocumentView(this.state.activeDocumentIndex);
        const snapshot = await activeDocument.session.reload();
        await this.persistSnapshot(snapshot);
        this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
        this.closeTransientScreens();
        this.setStatus(`Reloaded ${snapshot.finalUrl}`, "success");
        return;
      }
      case "bookmark-list":
        this.openPicker("bookmarks");
        return;
      case "bookmark-add": {
        const snapshot = this.activeDocument()?.snapshot;
        if (!snapshot) {
          this.setStatus("Cannot bookmark without a loaded page.", "error");
          return;
        }
        const bookmark = await this.store.addBookmark(snapshot.finalUrl, command.name ?? snapshot.rendered.title);
        this.setStatus(`Saved bookmark: ${bookmark.name}`, "success");
        return;
      }
      case "bookmark-open": {
        const bookmark = this.store.listBookmarks()[command.index - 1];
        if (!bookmark) {
          this.setStatus(`No bookmark exists at index ${String(command.index)}.`, "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, bookmark.url);
        return;
      }
      case "cookie-list":
        this.openCookiesDetail();
        return;
      case "cookie-clear":
        await this.store.clearCookies();
        this.setStatus("Cookie store cleared.", "success");
        return;
      case "history-list":
        this.openPicker("history");
        return;
      case "history-open": {
        const entry = this.store.listHistory()[command.index - 1];
        if (!entry) {
          this.setStatus(`No history entry exists at index ${String(command.index)}.`, "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, entry.url);
        return;
      }
      case "recall":
        this.openPicker("recall", command.query);
        return;
      case "recall-open": {
        const result = this.lastRecallResults[command.index - 1];
        if (!result) {
          this.setStatus(`No recall result exists at index ${String(command.index)}.`, "error");
          return;
        }
        await this.navigateDocument(this.state.activeDocumentIndex, result.url);
        return;
      }
      case "form-list":
        this.openPicker("forms");
        return;
      case "form-submit": {
        const snapshot = this.activeDocument()?.snapshot;
        if (!snapshot) {
          this.setStatus("No page is loaded.", "error");
          return;
        }
        const form = extractForms(snapshot.tree, snapshot.finalUrl)[command.index - 1];
        if (!form) {
          this.setStatus(`No form exists at index ${String(command.index)}.`, "error");
          return;
        }
        const submission = buildFormSubmissionRequest(form, command.overrides);
        await this.navigateDocument(this.state.activeDocumentIndex, submission.url, "text", submission.requestOptions);
        return;
      }
      case "close-document":
        this.closeActiveDocument();
        return;
      case "reopen-document":
        this.reopenClosedDocument();
        return;
      case "download":
        await this.downloadSnapshot(command.path);
        return;
      case "save-text":
        await this.saveTextExport(command.path);
        return;
      case "save-csv":
        await this.saveCsvExport(command.path);
        return;
      case "open-external":
        await this.openExternalTarget();
        return;
      case "open-link":
        await this.openLinkOnDocument(this.state.activeDocumentIndex, command.index);
        return;
      case "go":
        await this.navigateDocument(this.state.activeDocumentIndex, command.target);
        return;
      case "go-stream":
        await this.navigateDocument(this.state.activeDocumentIndex, command.target, "stream");
        return;
      case "patch-remove-node": {
        const snapshot = this.activeDocument()?.session.applyEdits([{ kind: "removeNode", target: command.target }]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: removed node ${String(command.target)}.`, "success");
        }
        return;
      }
      case "patch-replace-text": {
        const snapshot = this.activeDocument()?.session.applyEdits([
          { kind: "replaceText", target: command.target, value: command.value }
        ]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: replaced text on node ${String(command.target)}.`, "success");
        }
        return;
      }
      case "patch-set-attr": {
        const snapshot = this.activeDocument()?.session.applyEdits([
          { kind: "setAttr", target: command.target, name: command.name, value: command.value }
        ]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: set ${command.name} on node ${String(command.target)}.`, "success");
        }
        return;
      }
      case "patch-remove-attr": {
        const snapshot = this.activeDocument()?.session.applyEdits([
          { kind: "removeAttr", target: command.target, name: command.name }
        ]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: removed ${command.name} from node ${String(command.target)}.`, "success");
        }
        return;
      }
      case "patch-insert-before": {
        const snapshot = this.activeDocument()?.session.applyEdits([
          { kind: "insertHtmlBefore", target: command.target, html: command.html }
        ]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: inserted before node ${String(command.target)}.`, "success");
        }
        return;
      }
      case "patch-insert-after": {
        const snapshot = this.activeDocument()?.session.applyEdits([
          { kind: "insertHtmlAfter", target: command.target, html: command.html }
        ]);
        if (snapshot) {
          this.applySnapshotToDocument(this.state.activeDocumentIndex, snapshot);
          this.setStatus(`Patched page: inserted after node ${String(command.target)}.`, "success");
        }
        return;
      }
    }
  }

  private async handleKeypress(character: string, key: { readonly sequence: string; readonly name?: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly meta?: boolean }): Promise<void> {
    const activeDocument = this.activeDocument();
    const context = {
      screen: this.state.screen,
      ...(activeDocument ? { browseFocusMode: activeDocument.focusMode } : {}),
      ...(this.state.picker ? { pickerFocusTarget: this.state.picker.focusTarget } : {}),
      ...(this.state.editor ? { editorMode: this.state.editor.mode } : {})
    };
    const action = resolveShellKeyAction(character, key, context);

    if (action) {
      await this.handleShellKeyAction(action);
      return;
    }

    this.handleTextInput(character, key.sequence);
  }

  private async handleShellKeyAction(action: ShellKeyAction): Promise<void> {
    switch (action.kind) {
      case "quit":
        this.stop();
        return;
      case "dismiss":
        this.dismiss();
        return;
      case "show-help":
        this.openHelpDetail();
        return;
      case "show-diagnostics":
        this.openDiagnosticsDetail();
        return;
      case "show-links":
        this.openPicker("links");
        return;
      case "show-documents":
        this.openPicker("documents");
        return;
      case "show-history":
        this.openPicker("history");
        return;
      case "show-bookmarks":
        this.openPicker("bookmarks");
        return;
      case "show-forms":
        this.openPicker("forms");
        return;
      case "show-outline":
        this.openPicker("outline");
        return;
      case "open-location":
        this.openPalette("location");
        return;
      case "open-action-palette":
        this.openPalette("action");
        return;
      case "open-search":
        this.openPalette("search", this.activeDocument()?.search?.state.query ?? "");
        return;
      case "search-next":
        this.moveSearch("next");
        return;
      case "search-prev":
        this.moveSearch("prev");
        return;
      case "back":
        await this.executeCommand({ kind: "back" });
        return;
      case "forward":
        await this.executeCommand({ kind: "forward" });
        return;
      case "reload":
        await this.executeCommand({ kind: "reload" });
        return;
      case "bookmark-add":
        await this.executeCommand({ kind: "bookmark-add" });
        return;
      case "next-actionable":
        this.moveActionableFocus("next");
        return;
      case "prev-actionable":
        this.moveActionableFocus("prev");
        return;
      case "activate":
        await this.activateCurrentContext();
        return;
      case "open-focused-new-document":
        await this.openFocusedTargetInNewDocument();
        return;
      case "close-document":
        this.closeActiveDocument();
        return;
      case "reopen-document":
        this.reopenClosedDocument();
        return;
      case "scroll-line-down":
        this.scrollScreen(1);
        return;
      case "scroll-line-up":
        this.scrollScreen(-1);
        return;
      case "scroll-page-down":
        this.scrollScreen(this.pageSize());
        return;
      case "scroll-page-up":
        this.scrollScreen(-this.pageSize());
        return;
      case "scroll-top":
        this.jumpScreen("top");
        return;
      case "scroll-bottom":
        this.jumpScreen("bottom");
        return;
      case "picker-down":
        this.movePickerSelection(1);
        return;
      case "picker-up":
        this.movePickerSelection(-1);
        return;
      case "picker-page-down":
        this.movePickerSelection(this.pageSize());
        return;
      case "picker-page-up":
        this.movePickerSelection(-this.pageSize());
        return;
      case "picker-top":
        this.jumpPicker("top");
        return;
      case "picker-bottom":
        this.jumpPicker("bottom");
        return;
      case "picker-toggle-filter":
        this.togglePickerFilter();
        return;
      case "picker-activate":
        await this.activatePickerItem(this.pickerSelectedItem());
        return;
      case "editor-next-field":
        this.moveEditorField(1);
        return;
      case "editor-prev-field":
        this.moveEditorField(-1);
        return;
      case "editor-enter-edit":
        this.enterEditorField();
        return;
      case "editor-submit":
        await this.submitEditor();
        return;
      case "editor-discard":
        this.discardEditorChanges();
        return;
      case "editor-external":
        await this.openExternalEditor();
        return;
      case "editor-cancel":
        this.cancelEditorInteraction();
        return;
      case "text-backspace":
        this.handleBackspace();
        return;
      case "text-cursor-left":
        this.moveTextCursor("left");
        return;
      case "text-cursor-right":
        this.moveTextCursor("right");
        return;
      case "text-newline":
        this.insertNewline();
        return;
    }
  }

  private scrollScreen(delta: number): void {
    switch (this.state.screen) {
      case "browse":
        this.scrollActiveDocument(delta);
        return;
      case "detail":
        if (!this.state.detail) return;
        this.state = {
          ...this.state,
          detail: {
            ...this.state.detail,
            scrollOffset: Math.max(0, this.state.detail.scrollOffset + delta)
          }
        };
        return;
      case "picker":
        this.movePickerSelection(delta);
        return;
      case "palette":
        this.movePaletteSuggestion(delta);
        return;
      case "editor":
        this.moveEditorField(delta > 0 ? 1 : -1);
        return;
    }
  }

  private jumpScreen(position: "top" | "bottom"): void {
    switch (this.state.screen) {
      case "browse":
        this.jumpActiveDocument(position);
        return;
      case "detail":
        if (!this.state.detail) return;
        this.state = {
          ...this.state,
          detail: {
            ...this.state.detail,
            scrollOffset: position === "top" ? 0 : Math.max(0, this.state.detail.lines.length - this.pageSize())
          }
        };
        return;
      case "picker":
        this.jumpPicker(position);
        return;
      default:
        return;
    }
  }

  private movePickerSelection(delta: number): void {
    if (this.state.screen === "palette") {
      this.movePaletteSuggestion(delta);
      return;
    }

    const picker = this.state.picker;
    if (!picker) {
      return;
    }
    const nextIndex = Math.max(0, Math.min(picker.items.length - 1, picker.selectedIndex + delta));
    this.state = {
      ...this.state,
      picker: {
        ...picker,
        selectedIndex: nextIndex
      }
    };
  }

  private movePaletteSuggestion(delta: number): void {
    const palette = this.state.palette;
    if (!palette || palette.suggestions.length === 0) {
      return;
    }
    const nextIndex = Math.max(0, Math.min(palette.suggestions.length - 1, palette.selectedSuggestionIndex + delta));
    this.state = {
      ...this.state,
      palette: {
        ...palette,
        selectedSuggestionIndex: nextIndex
      }
    };
  }

  private jumpPicker(position: "top" | "bottom"): void {
    const picker = this.state.picker;
    if (!picker) {
      return;
    }
    this.state = {
      ...this.state,
      picker: {
        ...picker,
        selectedIndex: position === "top" ? 0 : Math.max(0, picker.items.length - 1)
      }
    };
  }

  private togglePickerFilter(): void {
    const picker = this.state.picker;
    if (!picker) {
      return;
    }
    this.state = {
      ...this.state,
      picker: {
        ...picker,
        focusTarget: picker.focusTarget === "list" ? "filter" : "list"
      }
    };
  }

  private moveEditorField(delta: number): void {
    this.updateEditor((editor) => {
      const nextIndex = Math.max(0, Math.min(editor.fields.length - 1, editor.selectedFieldIndex + delta));
      return {
        ...editor,
        selectedFieldIndex: nextIndex,
        cursorOffset: editor.fields[nextIndex]?.value.length ?? 0,
        mode: editor.mode === "confirm-exit" ? "select" : editor.mode
      };
    });
  }

  private enterEditorField(): void {
    this.updateEditor((editor) => ({
      ...editor,
      mode: "edit",
      cursorOffset: editor.fields[editor.selectedFieldIndex]?.value.length ?? 0
    }));
  }

  private discardEditorChanges(): void {
    const editor = this.state.editor;
    if (!editor) {
      return;
    }
    if (editor.mode !== "confirm-exit") {
      this.setStatus("Press Esc first to confirm discarding editor changes.", "error");
      return;
    }
    this.state = {
      ...this.state,
      screen: "browse",
      editor: null
    };
    this.setStatus("Discarded unsaved form changes.", "success");
  }

  private cancelEditorInteraction(): void {
    const editor = this.state.editor;
    if (!editor) {
      return;
    }
    if (editor.mode === "edit") {
      this.updateEditor((currentEditor) => ({
        ...currentEditor,
        mode: "select"
      }));
      return;
    }
    if (editor.dirty && editor.mode !== "confirm-exit") {
      this.updateEditor((currentEditor) => ({
        ...currentEditor,
        mode: "confirm-exit"
      }));
      this.setStatus("Unsaved changes. Press s to submit, d to discard, or Esc to keep editing.", "error");
      return;
    }
    if (editor.mode === "confirm-exit") {
      this.updateEditor((currentEditor) => ({
        ...currentEditor,
        mode: "select"
      }));
      this.setStatus("Returned to the form editor.", "success");
      return;
    }
    this.state = {
      ...this.state,
      screen: "browse",
      editor: null
    };
  }

  private dismiss(): void {
    switch (this.state.screen) {
      case "palette":
        this.closeTransientScreens();
        return;
      case "picker": {
        const picker = this.state.picker;
        if (!picker) return;
        if (picker.jumpText.length > 0) {
          this.state = {
            ...this.state,
            picker: {
              ...picker,
              jumpText: ""
            }
          };
          return;
        }
        if (picker.filterText.length > 0) {
          this.state = {
            ...this.state,
            picker: this.buildPickerState(picker.kind, picker.queryText, "", "", picker.focusTarget, 0)
          };
          return;
        }
        if (picker.focusTarget === "filter") {
          this.state = {
            ...this.state,
            picker: {
              ...picker,
              focusTarget: "list"
            }
          };
          return;
        }
        this.closeTransientScreens();
        return;
      }
      case "editor":
        this.cancelEditorInteraction();
        return;
      case "detail":
        this.closeTransientScreens();
        return;
      case "browse": {
        const activeDocument = this.activeDocument();
        if (!activeDocument) {
          return;
        }
        if (activeDocument.search) {
          this.clearSearch();
          return;
        }
        if (activeDocument.focusMode === "link-control") {
          this.updateActiveDocument((documentState) => ({
            ...documentState,
            focusMode: "reading",
            linkControlFocus: null
          }));
          this.setStatus("Returned to reading focus.", "success");
          return;
        }
        this.setStatus("Press h for history back, or ? for help.");
        return;
      }
    }
  }

  private async activateCurrentContext(): Promise<void> {
    switch (this.state.screen) {
      case "browse": {
        const activeDocument = this.activeDocument();
        const actionable = this.activeActionable();
        if (!activeDocument?.rendered) {
          this.setStatus("Open a page first with g.", "error");
          return;
        }
        if (!actionable) {
          this.setStatus("Press ] to focus the next link or control.", "info");
          return;
        }
        if (actionable.kind === "link") {
          await this.openLinkOnDocument(this.state.activeDocumentIndex, actionable.index);
          return;
        }
        this.openEditor(actionable.index);
        return;
      }
      case "picker":
        await this.activatePickerItem(this.pickerSelectedItem());
        return;
      case "palette":
        await this.activatePalette();
        return;
      case "editor":
        this.enterEditorField();
        return;
      case "detail":
        return;
    }
  }

  private handleBackspace(): void {
    if (this.state.screen === "palette" && this.state.palette) {
      const nextInputText = this.state.palette.inputText.slice(0, -1);
      this.state = {
        ...this.state,
        palette: {
          ...this.state.palette,
          inputText: nextInputText,
          suggestions: this.paletteSuggestions(this.state.palette.mode, nextInputText),
          selectedSuggestionIndex: 0,
          repairText: null
        }
      };
      return;
    }

    if (this.state.screen === "picker" && this.state.picker) {
      if (this.state.picker.focusTarget === "filter") {
        const nextFilterText = this.state.picker.filterText.slice(0, -1);
        this.state = {
          ...this.state,
          picker: this.buildPickerState(
            this.state.picker.kind,
            this.state.picker.queryText,
            nextFilterText,
            "",
            "filter",
            0
          )
        };
        return;
      }
      if (this.state.picker.jumpText.length > 0) {
        this.state = {
          ...this.state,
          picker: {
            ...this.state.picker,
            jumpText: this.state.picker.jumpText.slice(0, -1)
          }
        };
      }
      return;
    }

    if (this.state.screen === "editor") {
      this.backspaceEditorText();
    }
  }

  private moveTextCursor(direction: "left" | "right"): void {
    if (this.state.screen !== "editor") {
      return;
    }
    this.moveEditorCursor(direction);
  }

  private insertNewline(): void {
    const editor = this.state.editor;
    if (!editor || editor.mode !== "edit") {
      return;
    }
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field) {
      return;
    }
    if (!field.multiline) {
      this.updateEditor((currentEditor) => ({
        ...currentEditor,
        mode: "select"
      }));
      return;
    }
    this.insertEditorText("\n");
  }

  private handleTextInput(character: string, keySequence: string): void {
    if (!isPrintableCharacter(character, keySequence)) {
      return;
    }

    if (this.state.screen === "palette" && this.state.palette) {
      const nextInputText = `${this.state.palette.inputText}${character}`;
      this.state = {
        ...this.state,
        palette: {
          ...this.state.palette,
          inputText: nextInputText,
          suggestions: this.paletteSuggestions(this.state.palette.mode, nextInputText),
          selectedSuggestionIndex: 0,
          repairText: null
        }
      };
      return;
    }

    if (this.state.screen === "picker" && this.state.picker) {
      if (this.state.picker.focusTarget === "filter") {
        const nextFilterText = `${this.state.picker.filterText}${character}`;
        this.state = {
          ...this.state,
          picker: this.buildPickerState(
            this.state.picker.kind,
            this.state.picker.queryText,
            nextFilterText,
            "",
            "filter",
            0
          )
        };
        return;
      }

      if (/^\d$/.test(character)) {
        const nextJumpText = `${this.state.picker.jumpText}${character}`;
        const jumpIndex = Number.parseInt(nextJumpText, 10);
        this.state = {
          ...this.state,
          picker: {
            ...this.state.picker,
            jumpText: nextJumpText,
            selectedIndex: Number.isSafeInteger(jumpIndex) && jumpIndex >= 1
              ? Math.max(0, Math.min(this.state.picker.items.length - 1, jumpIndex - 1))
              : this.state.picker.selectedIndex
          }
        };
      }
      return;
    }

    if (this.state.screen === "editor") {
      const editor = this.state.editor;
      if (editor?.mode === "edit") {
        this.insertEditorText(character);
      }
    }
  }
}
