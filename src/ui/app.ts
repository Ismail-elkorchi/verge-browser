import {
  applyScrollEvent,
  checkboxGroupReducer,
  commitCombobox,
  comboboxReducer,
  commandInputReducer,
  contextMenuReducer,
  createCommandInputState,
  createNumberInputConfiguration,
  createScrollState,
  createSearchPickerState,
  createTextAreaState,
  menuTriggerReducer,
  prepareCommandSuggestions,
  prepareSearchPickerIndex,
  numberInputReducer,
  searchPickerReducer,
  searchPickerEntryById,
  tabsReducer,
  textAreaReducer,
  textInputReducer
} from "@ismail-elkorchi/terminal-ui/behavior";
import { textDocumentText } from "@ismail-elkorchi/terminal-ui/text";
import { prepareCollectionInteractionIndex } from "@ismail-elkorchi/terminal-ui/interaction";
import {
  defineTui,
  type TuiContext,
  type TuiEffect,
  type TuiEffectContext,
  type TuiInputBinding,
  type TuiUpdateResult
} from "@ismail-elkorchi/terminal-ui/tui";

import { formatHelpText, parseCommand, type BrowserCommand } from "../app/commands.js";
import { NetworkFetchError } from "../app/fetch-page.js";
import type { DownloadRecord } from "../app/storage.js";
import type { PageRequestOptions, PageSnapshot } from "../app/types.js";
import {
  applyDocumentAction,
  createDocumentState,
  type DocumentButtonControl,
  type DocumentForm,
  type DocumentFormControl,
  type DocumentNodeRef
} from "../document/index.js";
import type { BrowserController } from "./browser-controller.js";
import {
  actionById,
  actionId,
  DocumentPresentationCache,
  documentLayout,
  documentScrollRow,
  documentWithScrollRow,
  scrollToSource
} from "./document-layout.js";
import type {
  BrowserDocumentSearch,
  BrowserDocumentState,
  BrowserTuiMessage,
  BrowserTuiState,
  PickerKind,
  StatusMessage
} from "./model.js";
import { browserMenuItems, formComboboxPageSize, linkMenuItems } from "./model.js";
import { browserView } from "./view.js";

const EMPTY_COMMAND_SUGGESTIONS = prepareCommandSuggestions([]);
const MAX_PAGE_SEARCH_MATCHES = 2000;
const MAX_PAGE_SEARCH_QUERY_CODE_UNITS = 1024;

const ACTION_SUGGESTIONS = [
  "links",
  "outline",
  "reader",
  "diagnostics",
  "history",
  "bookmarks",
  "downloads",
  "save page ./page.html",
  "save text ./page.txt",
  "download",
  "open-external",
  "cookies",
  "help"
].map((value) => ({ id: value, value }));

interface ReplacementCommandSuggestion {
  readonly id: string;
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

function replacementCommandSuggestions(
  input: string,
  suggestions: readonly ReplacementCommandSuggestion[]
) {
  return prepareCommandSuggestions(suggestions.map((suggestion) => ({
    id: suggestion.id,
    completion: {
      range: { startOffset: 0, endOffsetExclusive: input.length },
      text: suggestion.value
    },
    ...(suggestion.label === undefined ? {} : { label: suggestion.label }),
    ...(suggestion.description === undefined ? {} : { description: suggestion.description })
  })));
}

function resetCommandInput(
  current: BrowserTuiState["omnibox"],
  value: string,
  suggestions = EMPTY_COMMAND_SUGGESTIONS
): BrowserTuiState["omnibox"] {
  return createCommandInputState({
    value,
    cursor: value.length,
    submissions: current.submissions,
    submissionLimit: current.submissionLimit,
    suggestions,
    editHistoryPolicy: current.editor.editHistory.policy
  });
}

function submittedCommandInput(
  current: BrowserTuiState["omnibox"],
  submission: string,
  value: string
): BrowserTuiState["omnibox"] {
  const recorded = commandInputReducer(current, { kind: "recordSubmission", value: submission });
  const updated = commandInputReducer(recorded, { kind: "setValue", value });
  return commandInputReducer(updated, {
    kind: "setSuggestions",
    suggestions: EMPTY_COMMAND_SUGGESTIONS
  });
}

function activeDocument(state: BrowserTuiState): BrowserDocumentState {
  const document = state.documents[state.activeDocumentIndex];
  if (!document) throw new Error("No browser document is active.");
  return document;
}

function updateDocument(
  state: BrowserTuiState,
  documentId: string,
  update: (document: BrowserDocumentState) => BrowserDocumentState
): BrowserTuiState {
  return {
    ...state,
    documents: state.documents.map((document) => document.id === documentId ? update(document) : document)
  };
}

function status(text: string, tone: StatusMessage["tone"] = "info"): StatusMessage {
  return { text, tone };
}

function result(
  state: BrowserTuiState,
  options: {
    readonly cancelEffects?: readonly string[];
    readonly effects?: readonly TuiEffect<BrowserTuiMessage>[];
    readonly focus?: TuiUpdateResult<BrowserTuiState, BrowserTuiMessage>["focus"];
  } = {}
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  return {
    state,
    ...(options.cancelEffects === undefined ? {} : { cancelEffects: options.cancelEffects }),
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    ...(options.focus === undefined ? {} : { focus: options.focus })
  };
}

function effect(
  id: string,
  run: (context: TuiEffectContext) => Promise<BrowserTuiMessage>,
  concurrency: TuiEffect<BrowserTuiMessage>["concurrency"] = "enqueue",
  documentId?: string
): TuiEffect<BrowserTuiMessage> {
  return {
    id,
    concurrency,
    async run(context) {
      try {
        return { kind: "message", message: await run(context) };
      } catch (error) {
        context.signal.throwIfAborted();
        const downloadTarget = error instanceof NetworkFetchError
          && error.networkOutcome.kind === "content_type_block"
          ? error.networkOutcome.finalUrl
          : undefined;
        return {
          kind: "message",
          message: {
            kind: "operationFailed",
            message: error instanceof Error ? error.message : String(error),
            ...(documentId === undefined ? {} : { documentId }),
            ...(downloadTarget === undefined ? {} : { downloadTarget })
          }
        };
      }
    }
  };
}

function persistEffect(
  controller: BrowserController,
  state: BrowserTuiState
): TuiEffect<BrowserTuiMessage> {
  return {
    id: "workspace",
    concurrency: "replace",
    async run() {
      await controller.saveWorkspace(state);
      return { kind: "none" };
    }
  };
}

function persistSnapshotEffect(
  controller: BrowserController,
  snapshot: PageSnapshot
): TuiEffect<BrowserTuiMessage> {
  return effect("page-persistence", async () => {
    await controller.persistSnapshot(snapshot);
    return { kind: "libraryChanged" };
  }, "enqueue");
}

function contentColumns(state: BrowserTuiState, terminalColumns: number): number {
  const available = state.sidePanel !== null && terminalColumns >= 100
    ? Math.max(1, terminalColumns - 40)
    : Math.max(1, terminalColumns);
  return Math.max(1, available - 1);
}

function pageFromSnapshot(
  document: BrowserDocumentState,
  snapshot: PageSnapshot,
  navigation: { readonly canGoBack: boolean; readonly canGoForward: boolean }
): BrowserDocumentState {
  const savedViews = {
    ...document.savedViews,
    [document.snapshot.finalUrl]: {
      document: document.snapshot.document,
      scrollAnchor: document.scrollAnchor,
      search: document.search
    }
  };
  const candidate = savedViews[snapshot.finalUrl];
  const restored = candidate?.document === snapshot.document ? candidate : undefined;
  return {
    ...document,
    snapshot,
    scrollAnchor: restored?.scrollAnchor
      ?? { source: snapshot.document.body ?? snapshot.document.documentElement, rowOffset: 0 },
    search: restored?.search ?? null,
    documentState: createDocumentState(snapshot.document),
    presentationCache: new DocumentPresentationCache(),
    formEditors: {},
    savedViews,
    loading: false,
    pendingUrl: null,
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    error: null
  };
}

function focusedControlActionId(
  state: BrowserTuiState,
  focusPath: readonly string[] | undefined
): string | null {
  const document = state.documents[state.activeDocumentIndex];
  const target = focusPath?.at(-1);
  if (document === undefined || target === undefined) return null;
  const control = document.snapshot.document.control(target as DocumentNodeRef);
  return control === null ? null : `control:${control.node}`;
}

function pageText(document: BrowserDocumentState, columns: number): string {
  return documentLayout(document, columns).fragments.rows.map((row) => row.text).join("\n");
}

function navigationMessage(
  controller: BrowserController,
  document: BrowserDocumentState,
  snapshot: PageSnapshot,
  label: string
): BrowserTuiMessage {
  return {
    kind: "pageLoaded",
    documentId: document.id,
    snapshot,
    status: label,
    ...controller.navigationAvailability(document)
  };
}

function navigationEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  operation: "back" | "forward" | "reload"
): TuiEffect<BrowserTuiMessage> {
  return effect(`navigation:${document.id}`, async (context) => navigationMessage(
    controller,
    document,
    await controller.traverse(document, operation, context.signal),
    operation === "back" ? "Back" : operation === "forward" ? "Forward" : "Reloaded"
  ), "replace", document.id);
}

function loadEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  target: string,
  options: {
    readonly requestOptions?: PageRequestOptions;
    readonly parseMode?: "text" | "stream";
  } = {}
): TuiEffect<BrowserTuiMessage> {
  return effect(`navigation:${document.id}`, async (context) => navigationMessage(
    controller,
    document,
    await controller.navigate(
      document,
      target,
      { ...(options.requestOptions ?? {}), signal: context.signal },
      options.parseMode
    ),
    `Opened ${target}`
  ), "replace", document.id);
}

function beginNavigation(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  target: string,
  navigation: TuiEffect<BrowserTuiMessage>
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const next = updateDocument(
    { ...state, overlay: null, status: status(`Loading ${target}…`) },
    document.id,
    (current) => ({ ...current, loading: true, pendingUrl: target, error: null })
  );
  return result(next, { effects: [navigation] });
}

function openPicker(
  controller: BrowserController,
  state: BrowserTuiState,
  picker: PickerKind,
  query = ""
): BrowserTuiState {
  const entries = controller.pickerEntries(picker, state.documents, state.activeDocumentIndex, query);
  const index = prepareSearchPickerIndex(entries);
  return {
    ...state,
    overlay: {
      kind: "picker",
      pickerKind: picker,
      title: picker === "recall" ? `Search visited pages: ${query}` : `${picker[0]?.toUpperCase() ?? ""}${picker.slice(1)}`,
      index,
      state: createSearchPickerState({ query: { text: "", mode: "fuzzy" } }, index)
    }
  };
}

function searchDocument(
  document: BrowserDocumentState,
  query: string,
  columns: number
): BrowserDocumentSearch {
  const boundedQuery = query.slice(0, MAX_PAGE_SEARCH_QUERY_CODE_UNITS);
  if (boundedQuery.length === 0) {
    return { query: boundedQuery, matches: [], activeMatchIndex: 0, truncated: false };
  }
  const result = documentLayout(document, columns).fragments.search(boundedQuery);
  const matches = result.ranges.slice(0, MAX_PAGE_SEARCH_MATCHES).map((range) => ({
    rowIndex: range.row,
    startCodeUnitIndex: range.startCodeUnit,
    endCodeUnitIndexExclusive: range.endCodeUnit,
    source: range.source
  }));
  return {
    query: boundedQuery,
    matches,
    activeMatchIndex: 0,
    truncated: result.truncated || result.ranges.length > MAX_PAGE_SEARCH_MATCHES
  };
}

function applySearch(state: BrowserTuiState, query: string, columns: number): BrowserTuiState {
  const document = activeDocument(state);
  const search = searchDocument(document, query, columns);
  const first = search.matches[0];
  const updated = first === undefined
    ? { ...document, search }
    : documentWithScrollRow({ ...document, search }, documentLayout(document, columns).fragments, first.rowIndex);
  return {
    ...updateDocument(state, document.id, () => updated),
    status: search.matches.length === 0
      ? status(`No matches for "${search.query}"`, "error")
      : status(`1/${String(search.matches.length)}${search.truncated ? "+" : ""} matches`, "success")
  };
}

function moveSearch(
  document: BrowserDocumentState,
  direction: "next" | "prev",
  columns: number
): BrowserDocumentState {
  const search = document.search;
  if (!search || search.matches.length === 0) return document;
  const delta = direction === "next" ? 1 : -1;
  const activeMatchIndex = (search.activeMatchIndex + delta + search.matches.length) % search.matches.length;
  const match = search.matches[activeMatchIndex];
  return match === undefined
    ? document
    : documentWithScrollRow(
      { ...document, search: { ...search, activeMatchIndex } },
      documentLayout(document, columns).fragments,
      match.rowIndex
    );
}

function controlById(
  document: BrowserDocumentState,
  controlId: string
): DocumentFormControl | undefined {
  return document.snapshot.document.control(controlId as DocumentNodeRef) ?? undefined;
}

function defaultControlValues(control: DocumentFormControl): readonly string[] {
  if (control.kind === "hidden" || control.kind === "text" || control.kind === "textarea") return [control.defaultValue];
  if ((control.kind === "checkbox" || control.kind === "radio") && control.defaultChecked) return [control.value];
  if (control.kind === "select") {
    return control.options
      .filter((option) => option.defaultSelected && !option.disabled)
      .map((option) => option.value);
  }
  return [];
}

function controlValues(document: BrowserDocumentState, control: DocumentFormControl): readonly string[] {
  return document.documentState.controls.get(control.node)?.values ?? defaultControlValues(control);
}

function controlSelections(
  document: BrowserDocumentState,
  control: Extract<DocumentFormControl, { readonly kind: "select" }>
): readonly DocumentNodeRef[] {
  const explicit = document.documentState.controls.get(control.node)?.selected;
  if (explicit !== undefined) return explicit;
  const defaults = control.options.filter((option) => option.defaultSelected);
  return (control.multiple ? defaults : [defaults.at(-1) ?? control.options[0]])
    .flatMap((option) => option === undefined ? [] : [option.node]);
}

function updateFormControl(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  control: DocumentFormControl,
  values: readonly string[],
  editor?: BrowserDocumentState["formEditors"][string],
  selectedOptions?: readonly DocumentNodeRef[]
): BrowserTuiState {
  return updateDocument(state, document.id, (current) => ({
    ...current,
    documentState: control.kind === "checkbox" || control.kind === "radio"
      ? applyDocumentAction(
        current.snapshot.document,
        current.documentState,
        { kind: "set-checked", target: control.node, checked: values.length > 0 }
      )
      : control.kind === "select"
        ? applyDocumentAction(current.snapshot.document, current.documentState, {
          kind: "set-selected-options",
          target: control.node,
          options: selectedOptions ?? control.options.filter((option) => values.includes(option.value)).map((option) => option.node)
        })
        : applyDocumentAction(current.snapshot.document, current.documentState, {
          kind: "set-control-value",
          target: control.node,
          value: values[0] ?? ""
        }),
    ...(editor === undefined
      ? {}
      : { formEditors: { ...current.formEditors, [control.node]: editor } })
  }));
}

function firstMissingRequiredControl(
  controller: BrowserController,
  document: BrowserDocumentState,
  formId: string
): Exclude<DocumentFormControl, { readonly kind: "hidden" }> | undefined {
  const form = controller.form(document, formId);
  if (!form) return undefined;
  const selectedRadioGroups = new Set<string>();
  for (const control of form.controls) {
    if (
      control.kind === "radio"
      && controlValues(document, control).length > 0
    ) {
      selectedRadioGroups.add(control.name.length === 0 ? control.node : control.name);
    }
  }
  for (const control of form.controls) {
    if (control.disabled || !("required" in control) || !control.required) continue;
    if ((control.kind === "text" || control.kind === "textarea") && control.readOnly) continue;
    if (control.kind === "radio") {
      const groupName = control.name.length === 0 ? control.node : control.name;
      if (!selectedRadioGroups.has(groupName)) return control;
      continue;
    }
    const values = controlValues(document, control);
    if ((control.kind === "text" || control.kind === "textarea" || control.kind === "select")
      && !values.some((value) => value.length > 0)) return control;
    if (control.kind === "checkbox" && values.length === 0) return control;
  }
  return undefined;
}

function submitterControl(
  form: DocumentForm,
  submitterId: string | undefined
): (DocumentButtonControl & { readonly kind: "submit" }) | undefined {
  if (submitterId === undefined) return undefined;
  const control = form.controls.find((candidate) => candidate.node === submitterId);
  return control?.kind === "submit"
    ? control as DocumentButtonControl & { readonly kind: "submit" }
    : undefined;
}

function openNewDocumentEffect(
  controller: BrowserController,
  target: string,
  background: boolean,
  replaceCurrent = false,
  sourceDocument?: BrowserDocumentState
): TuiEffect<BrowserTuiMessage> {
  return effect("new-document", async (context) => ({
    kind: "documentOpened",
    document: sourceDocument === undefined
      ? await controller.openNew(target, context.signal)
      : await controller.openNewFromDocument(sourceDocument, target, context.signal),
    background,
    ...(replaceCurrent ? { replaceCurrent: true } : {})
  }), "enqueue");
}

function runCommand(
  controller: BrowserController,
  state: BrowserTuiState,
  command: BrowserCommand,
  columns: number
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const document = activeDocument(state);
  if (command.kind === "invalid") {
    return result({
      ...state,
      overlay: state.overlay?.kind === "actionPalette"
        ? { ...state.overlay, validation: command.reason }
        : state.overlay,
      status: status(command.reason, "error")
    });
  }
  switch (command.kind) {
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "help":
      return updateBrowser(controller, state, { kind: "openDetail", detail: "help" }, { terminalSize: { columns, rows: 24 } });
    case "reader":
    case "diag":
      return updateBrowser(controller, state, {
        kind: "openDetail",
        detail: command.kind === "reader" ? "reader" : "diagnostics"
      }, { terminalSize: { columns, rows: 24 } });
    case "links":
    case "outline":
      return result(openPicker(controller, state, command.kind));
    case "history-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "history" });
    case "download-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "downloads" });
    case "bookmark-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "bookmarks" });
    case "bookmark-add":
      return result(state, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.toggleBookmark(document, command.name)
      }))] });
    case "recall":
      return result(openPicker(controller, state, "recall", command.query));
    case "page-down":
      return updateBrowser(controller, state, { kind: "scroll", rows: 10 }, { terminalSize: { columns, rows: 24 } });
    case "page-up":
      return updateBrowser(controller, state, { kind: "scroll", rows: -10 }, { terminalSize: { columns, rows: 24 } });
    case "page-top":
      return updateBrowser(controller, state, { kind: "scrollTop" }, { terminalSize: { columns, rows: 24 } });
    case "page-bottom":
      return updateBrowser(controller, state, { kind: "scrollBottom" }, { terminalSize: { columns, rows: 24 } });
    case "find":
      return result(applySearch({ ...state, findBar: { input: { text: command.query, cursor: command.query.length } } }, command.query, columns));
    case "find-next":
    case "find-prev":
      return updateBrowser(controller, state, {
        kind: "moveSearch",
        direction: command.kind === "find-next" ? "next" : "prev"
      }, { terminalSize: { columns, rows: 24 } });
    case "back":
    case "forward":
    case "reload":
      return updateBrowser(controller, state, { kind: "navigate", operation: command.kind });
    case "download":
      return updateBrowser(controller, state, {
        kind: "download",
        ...(command.target === undefined ? {} : { target: command.target })
      });
    case "save-page":
      return result({ ...state, overlay: null }, { effects: [effect("save-page", async () => ({
        kind: "operationComplete",
        status: await controller.savePage(document, command.path)
      }))] });
    case "save-text":
      return result({ ...state, overlay: null }, { effects: [effect("save-text", async () => ({
        kind: "operationComplete",
        status: await controller.saveText(command.path, pageText(document, columns))
      }))] });
    case "open-external":
      return updateBrowser(controller, state, { kind: "openExternal" });
    case "go":
    case "go-stream": {
      const target = controller.resolveOmnibox(command.target, document.snapshot.finalUrl);
      return beginNavigation(
        { ...state, overlay: null },
        document,
        target,
        loadEffect(controller, document, target, command.kind === "go-stream" ? { parseMode: "stream" } : {})
      );
    }
    case "cookie-list":
      return updateBrowser(controller, state, { kind: "openDetail", detail: "cookies" });
    case "cookie-clear":
      return result({ ...state, overlay: null }, { effects: [effect("cookie-clear", async () => ({
        kind: "operationComplete",
        status: await controller.clearCookies()
      }))] });
    case "close-document":
      return updateBrowser(controller, state, { kind: "closeDocument" });
    case "reopen-document":
      return updateBrowser(controller, state, { kind: "reopenDocument" });
  }
}

export function updateBrowser(
  controller: BrowserController,
  state: BrowserTuiState,
  message: BrowserTuiMessage,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 100, rows: 24 } }
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const document = activeDocument(state);
  const columns = contentColumns(state, context.terminalSize.columns);
  const viewportRows = Math.max(1, context.terminalSize.rows - (state.findBar === null ? 3 : 4));
  const layout = documentLayout(document, columns, viewportRows).fragments;
  switch (message.kind) {
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "dismiss":
      return result({ ...state, overlay: null });
    case "scroll":
      if (state.overlay?.kind === "detail") {
        return result({ ...state, overlay: { ...state.overlay, scrollRow: Math.max(0, state.overlay.scrollRow + message.rows) } });
      }
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, layout, documentScrollRow(current, layout) + message.rows, viewportRows)
      ));
    case "scrollTo":
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, layout, message.row, viewportRows)
      ));
    case "scrollTop":
      return result(updateDocument(state, document.id, (current) => documentWithScrollRow(current, layout, 0, viewportRows)));
    case "scrollBottom":
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, layout, layout.rows.length, viewportRows)
      ));
    case "movePageFocus": {
      const targets = layout.focusTargets.filter((target) => target.rects.length > 0);
      if (targets.length === 0) return result(state);
      const currentIndex = targets.findIndex((target) =>
        actionId(target.action) === message.currentActionId
      );
      const nextIndex = message.direction === "next"
        ? (currentIndex + 1 + targets.length) % targets.length
        : (currentIndex - 1 + targets.length) % targets.length;
      const target = targets[nextIndex];
      if (target === undefined) return result(state);
      const top = Math.min(...target.rects.map((rect) => rect.row));
      const bottom = Math.max(...target.rects.map((rect) => rect.row + rect.height));
      const currentRow = documentScrollRow(document, layout);
      const revealedRow = top < currentRow
        ? top
        : bottom > currentRow + viewportRows
          ? bottom - viewportRows
          : currentRow;
      const updated = documentWithScrollRow(document, layout, revealedRow, viewportRows);
      return result(updateDocument(state, document.id, () => updated), {
        focus: target.action.kind === "form-control"
          ? { kind: "element", elementId: target.action.node }
          : {
            kind: "elementTarget",
            elementId: `browser-${document.id}`,
            targetId: actionId(target.action)
          }
      });
    }
    case "moveSearch": {
      if (!document.search) return result({ ...state, status: status("No active find query.", "error") });
      const updated = moveSearch(document, message.direction, columns);
      const search = updated.search;
      return result({
        ...updateDocument(state, document.id, () => updated),
        status: search === null || search.matches.length === 0
          ? status("No matches.", "error")
          : status(
            `${String(search.activeMatchIndex + 1)}/${String(search.matches.length)}${search.truncated ? "+" : ""} matches`,
            "success"
          )
      });
    }
    case "activateActionAt": {
      const action = actionById(document, message.actionId);
      if (!action) return result({ ...state, status: status("Focus a link or form first.", "error") });
      if (action.kind === "form-control") {
        return result(state, { focus: { kind: "element", elementId: action.node } });
      }
      if (action.kind === "disclosure") {
        return result(updateDocument(state, document.id, (current) => ({
          ...current,
          documentState: applyDocumentAction(
            current.snapshot.document,
            current.documentState,
            { kind: "set-open", target: action.node, open: !action.open }
          )
        })));
      }
      const disposition = message.disposition ?? "current";
      if (disposition === "newForeground" || disposition === "newBackground") {
        return result(state, {
          effects: [openNewDocumentEffect(
            controller,
            action.destination,
            disposition === "newBackground",
            false,
            document
          )]
        });
      }
      return beginNavigation(state, document, action.destination, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          controller,
          document,
          await controller.openLink(document, action.index, effectContext.signal),
          `Opened ${action.label}`
        ),
        "replace",
        document.id
      ));
    }
    case "openLinkMenu": {
      const action = actionById(document, message.actionId);
      if (action?.kind !== "link") {
        return result({ ...state, status: status("The selected item is not a link.", "error") });
      }
      const menu = contextMenuReducer(
        { kind: "closed" },
        {
          kind: "open",
          anchor: { kind: "cursor", row: message.row, column: message.column }
        },
        linkMenuItems
      );
      return result({
        ...state,
        overlay: { kind: "linkMenu", actionId: action.id, state: menu }
      });
    }
    case "linkMenuTransition": {
      if (state.overlay?.kind !== "linkMenu") return result(state);
      const menu = contextMenuReducer(state.overlay.state, message.transition, linkMenuItems);
      return result({
        ...state,
        overlay: menu.kind === "closed"
          ? null
          : { ...state.overlay, state: menu }
      });
    }
    case "linkMenuActivate": {
      if (state.overlay?.kind !== "linkMenu") return result(state);
      const link = actionById(document, state.overlay.actionId);
      if (link?.kind !== "link") {
        return result({ ...state, overlay: null, status: status("The selected link is no longer available.", "error") });
      }
      const id = message.event.id;
      const next: BrowserTuiMessage | undefined = id === "open"
        ? { kind: "activateActionAt", actionId: link.id, disposition: "current" }
        : id === "newForeground"
          ? { kind: "activateActionAt", actionId: link.id, disposition: "newForeground" }
          : id === "newBackground"
            ? { kind: "activateActionAt", actionId: link.id, disposition: "newBackground" }
            : id === "download"
              ? { kind: "download", target: link.destination }
              : id === "external"
                ? { kind: "openExternal", target: link.destination }
                : undefined;
      return next === undefined
        ? result({ ...state, overlay: null })
        : updateBrowser(controller, { ...state, overlay: null }, next, context);
    }
    case "navigate":
      if (message.operation === "stop") {
        return result(updateDocument(state, document.id, (current) =>
          controller.restoreDocument(current)
        ), { cancelEffects: [`navigation:${document.id}`] });
      }
      if (message.operation === "back" && !document.canGoBack) return result(state);
      if (message.operation === "forward" && !document.canGoForward) return result(state);
      return beginNavigation(
        state,
        document,
        message.operation,
        navigationEffect(controller, document, message.operation)
      );
    case "omniboxTransition": {
      let omnibox = commandInputReducer(state.omnibox, message.transition);
      const value = omnibox.editor.input.text;
      omnibox = commandInputReducer(omnibox, {
        kind: "setSuggestions",
        suggestions: message.transition.kind === "acceptSuggestion"
          ? EMPTY_COMMAND_SUGGESTIONS
          : replacementCommandSuggestions(
              value,
              controller.omniboxSuggestions(value, document)
            )
      });
      return result({
        ...state,
        omnibox,
        omniboxDirty: true
      });
    }
    case "focusOmnibox":
      return result({
        ...state,
        omnibox: resetCommandInput(
          state.omnibox,
          document.snapshot.finalUrl,
          replacementCommandSuggestions(
            document.snapshot.finalUrl,
            controller.omniboxSuggestions("", document)
          )
        ),
        omniboxDirty: false
      }, { focus: { kind: "element", elementId: "browser-omnibox" } });
    case "cancelOmnibox":
      return result({
        ...state,
        omnibox: resetCommandInput(state.omnibox, document.snapshot.finalUrl),
        omniboxDirty: false
      });
    case "omniboxSubmit": {
      const target = controller.resolveOmnibox(message.value, document.snapshot.finalUrl);
      return beginNavigation({
        ...state,
        omnibox: submittedCommandInput(state.omnibox, message.value, target),
        omniboxDirty: false
      }, document, target, loadEffect(controller, document, target));
    }
    case "openActionPalette":
      return result({
        ...state,
        overlay: {
          kind: "actionPalette",
          state: createCommandInputState({
            suggestions: replacementCommandSuggestions("", ACTION_SUGGESTIONS)
          })
        }
      }, { focus: { kind: "element", elementId: "browser-action-input" } });
    case "browserMenuTransition": {
      const current = state.overlay?.kind === "browserMenu"
        ? state.overlay.state
        : { kind: "closed" as const };
      const menu = menuTriggerReducer(current, message.transition, browserMenuItems);
      return result({
        ...state,
        overlay: menu.kind === "closed" ? null : { kind: "browserMenu", state: menu }
      });
    }
    case "browserMenuActivate": {
      const id = message.event.id;
      const next: BrowserTuiMessage | undefined = id === "history"
        ? { kind: "toggleSidePanel", panel: "history" }
        : id === "bookmarks"
          ? { kind: "toggleSidePanel", panel: "bookmarks" }
          : id === "downloads"
            ? { kind: "toggleSidePanel", panel: "downloads" }
            : id === "reader" || id === "diagnostics" || id === "cookies" || id === "help"
              ? { kind: "openDetail", detail: id }
              : id === "download"
                ? { kind: "download" }
                : id === "external"
                  ? { kind: "openExternal" }
                  : undefined;
      return next === undefined
        ? result({ ...state, overlay: null })
        : updateBrowser(controller, { ...state, overlay: null }, next, context);
    }
    case "openPicker":
      return result(openPicker(controller, state, message.picker, message.query));
    case "openDetail":
      return result({
        ...state,
        overlay: {
          kind: "detail",
          detailKind: message.detail,
          title: `${message.detail.charAt(0).toUpperCase()}${message.detail.slice(1)}`,
          lines: message.detail === "help" ? formatHelpText().split("\n") : controller.detail(message.detail, document),
          scrollRow: 0
        }
      });
    case "toggleSidePanel": {
      const next = {
        ...state,
        overlay: null,
        sidePanel: state.sidePanel === message.panel ? null : message.panel,
        sidePanelScroll: createScrollState(),
        ...controller.library()
      };
      return result(next, { effects: [persistEffect(controller, next)] });
    }
    case "sidePanelScroll":
      return result({
        ...state,
        sidePanelScroll: applyScrollEvent(state.sidePanelScroll, message.event)
      });
    case "toggleBookmark":
      return result(state, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.toggleBookmark(document)
      }))] });
    case "openExternal":
      return result({ ...state, overlay: null }, { effects: [effect("open-external", async () => ({
        kind: "operationComplete",
        status: await controller.openExternal(
          document.snapshot.finalUrl,
          message.target ?? document.snapshot.finalUrl,
          message.target === undefined ? "direct" : "page-initiated"
        )
      }))] });
    case "newDocument": {
      const target = message.target ?? "about:newtab";
      return result(state, {
        effects: [openNewDocumentEffect(controller, target, message.background ?? false)]
      });
    }
    case "closeDocument":
      if (state.documents.length === 1) {
        return result(state, {
          cancelEffects: [`navigation:${document.id}`],
          effects: [openNewDocumentEffect(controller, "about:newtab", false, true)]
        });
      } else {
        const nextDocuments = state.documents.filter((_, index) => index !== state.activeDocumentIndex);
        const nextIndex = Math.min(state.activeDocumentIndex, nextDocuments.length - 1);
        const selected = nextDocuments[nextIndex];
        const next = {
          ...state,
          documents: nextDocuments,
          activeDocumentIndex: nextIndex,
          recentlyClosed: [document, ...state.recentlyClosed].slice(0, 10),
          overlay: null,
          omnibox: resetCommandInput(state.omnibox, selected?.snapshot.finalUrl ?? ""),
          status: status(`Closed ${document.snapshot.document.title}.`, "success")
        };
        return result(next, {
          cancelEffects: [`navigation:${document.id}`],
          effects: [persistEffect(controller, next)]
        });
      }
    case "reopenDocument": {
      const closed = state.recentlyClosed[0];
      if (!closed) return result({ ...state, status: status("No recently closed tab.", "error") });
      const restored = controller.restoreDocument(closed);
      const next = {
        ...state,
        documents: [...state.documents, restored],
        activeDocumentIndex: state.documents.length,
        recentlyClosed: state.recentlyClosed.slice(1),
        omnibox: resetCommandInput(state.omnibox, restored.snapshot.finalUrl),
        status: status(`Reopened ${restored.snapshot.document.title}.`, "success")
      };
      return result(next, {
        effects: [persistSnapshotEffect(controller, restored.snapshot), persistEffect(controller, next)]
      });
    }
    case "selectDocument": {
      const selected = state.documents[message.index];
      if (!selected) return result(state);
      const next = {
        ...state,
        activeDocumentIndex: message.index,
        omnibox: resetCommandInput(state.omnibox, selected.snapshot.finalUrl)
      };
      return result(next, { effects: [persistEffect(controller, next)] });
    }
    case "tabsTransition": {
      const selected = state.documents[state.activeDocumentIndex];
      if (!selected) return result(state);
      const presentation = tabsReducer(
        { activeId: selected.id, selectedId: selected.id },
        message.transition,
        { tabs: state.documents, activation: "automatic" }
      );
      const nextIndex = state.documents.findIndex((entry) => entry.id === presentation.selectedId);
      return nextIndex < 0
        ? result(state)
        : updateBrowser(controller, state, { kind: "selectDocument", index: nextIndex }, context);
    }
    case "tabsClose": {
      const index = state.documents.findIndex((entry) => entry.id === message.event.id);
      return index < 0
        ? result(state)
        : updateBrowser(
          controller,
          { ...state, activeDocumentIndex: index },
          { kind: "closeDocument" },
          context
        );
    }
    case "actionPaletteTransition": {
      if (state.overlay?.kind !== "actionPalette") return result(state);
      let palette = commandInputReducer(state.overlay.state, message.transition);
      if (message.transition.kind !== "acceptSuggestion") {
        palette = commandInputReducer(palette, {
          kind: "setSuggestions",
          suggestions: replacementCommandSuggestions(
            palette.editor.input.text,
            ACTION_SUGGESTIONS
          )
        });
      }
      return result({
        ...state,
        overlay: {
          ...state.overlay,
          state: palette
        }
      });
    }
    case "actionPaletteSubmit":
      return state.overlay?.kind !== "actionPalette"
        ? result(state)
        : runCommand(controller, state, parseCommand(message.value), columns);
    case "pickerTransition":
      return state.overlay?.kind !== "picker"
        ? result(state)
        : result({
          ...state,
          overlay: {
            ...state.overlay,
            state: searchPickerReducer(
              state.overlay.state,
              message.transition,
              { searchPickerIndex: state.overlay.index }
            )
          }
        });
    case "pickerAccept": {
      if (state.overlay?.kind !== "picker") return result(state);
      const entry = searchPickerEntryById(state.overlay.index, message.event.id);
      return updateBrowser(
        controller,
        state,
        {
          kind: "pickerSelect",
          ...(entry === undefined ? {} : { value: entry.value })
        },
        context
      );
    }
    case "pickerSelect": {
      const value = message.value;
      if (!value) return result({ ...state, status: status("No item is selected.", "error") });
      if (value.kind === "outline") {
        return result({ ...updateDocument(state, document.id, (current) => scrollToSource(current, value.node)), overlay: null });
      }
      if (value.kind === "link") {
        const link = document.snapshot.document.links.find((entry) => entry.index === value.index);
        return link === undefined
          ? result(state)
          : updateBrowser(controller, state, { kind: "activateActionAt", actionId: `link:${link.node}` }, context);
      }
      const target = value.target ?? "";
      return beginNavigation(state, document, target, loadEffect(controller, document, target));
    }
    case "openFind": {
      const value = document.search?.query ?? "";
      return result({
        ...state,
        findBar: { input: { text: value, cursor: value.length } }
      }, { focus: { kind: "element", elementId: "browser-find-input" } });
    }
    case "findAction": {
      if (state.findBar === null) return result(state);
      const reducedInput = textInputReducer(state.findBar.input, message.action);
      const input = reducedInput.text.length <= MAX_PAGE_SEARCH_QUERY_CODE_UNITS
        ? reducedInput
        : {
          ...reducedInput,
          text: reducedInput.text.slice(0, MAX_PAGE_SEARCH_QUERY_CODE_UNITS),
          cursor: Math.min(
            reducedInput.cursor,
            MAX_PAGE_SEARCH_QUERY_CODE_UNITS
          )
        };
      return result(applySearch({ ...state, findBar: { input } }, input.text, columns));
    }
    case "findSubmit":
      return state.findBar === null
        ? result(state)
        : result(applySearch(state, state.findBar.input.text, columns));
    case "closeFind":
      return result({
        ...state,
        findBar: null,
        documents: state.documents.map((entry) => ({ ...entry, search: null }))
      });
    case "formText": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType === "number") return result(state);
      const current = document.formEditors[control.node];
      const editor = current?.kind === "text"
        ? current.state
        : { text: controlValues(document, control)[0] ?? "", cursor: (controlValues(document, control)[0] ?? "").length };
      const next = textInputReducer(editor, message.action);
      return result(updateFormControl(state, document, control, [next.text], { kind: "text", state: next }));
    }
    case "formNumber": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType !== "number") return result(state);
      const value = controlValues(document, control)[0] ?? "";
      const current = document.formEditors[control.node];
      const editor = current?.kind === "number"
        ? current.state
        : {
          input: { text: value, cursor: value.length },
          configuration: createNumberInputConfiguration({
            ...(control.min === null ? {} : { min: control.min }),
            ...(control.max === null ? {} : { max: control.max }),
            ...(control.step === null ? {} : { step: control.step })
          })
        };
      const next = numberInputReducer(editor, message.action);
      return result(updateFormControl(
        state,
        document,
        control,
        [next.input.text],
        { kind: "number", state: next }
      ));
    }
    case "formArea": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "textarea") return result(state);
      const current = document.formEditors[control.node];
      const editor = current?.kind === "textarea"
        ? current.state
        : createTextAreaState({
          value: controlValues(document, control)[0] ?? "",
          scroll: createScrollState()
        });
      const next = textAreaReducer(editor, message.action);
      return result(updateFormControl(
        state,
        document,
        control,
        [textDocumentText(next.document)],
        { kind: "textarea", state: next }
      ));
    }
    case "formComboboxTransition": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "select" || control.multiple) return result(state);
      const options = control.options.map((option, index) => ({
        id: `${control.node}:${String(index)}`,
        label: option.label,
        value: option.value,
        disabled: option.disabled
      }));
      const values = controlValues(document, control);
      const selected = new Set(controlSelections(document, control));
      const selectedIndex = control.options.findIndex((option) => selected.has(option.node));
      const current = document.formEditors[control.node];
      const selectedId = selectedIndex < 0 ? undefined : `${control.node}:${String(selectedIndex)}`;
      const editor = current?.kind === "combobox"
        ? current.state
        : {
          kind: "select" as const,
          open: false,
          interaction: {
            ...(selectedId === undefined ? {} : { activeId: selectedId }),
            selection: {
              mode: "single" as const,
              ...(selectedId === undefined ? {} : { selectedId })
            }
          }
        };
      const index = current?.kind === "combobox"
        ? current.index
        : prepareCollectionInteractionIndex(
          options.filter((option) => !option.disabled).map((option) => option.id)
        );
      const next = comboboxReducer(editor, message.transition, {
        index,
        pageSize: formComboboxPageSize
      });
      return result(updateFormControl(
        state,
        document,
        control,
        values,
        { kind: "combobox", state: next, index }
      ));
    }
    case "formComboboxCommit": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "select" || control.multiple) return result(state);
      const option = control.options.find(
        (_, index) => `${control.node}:${String(index)}` === message.event.id
      );
      if (option === undefined || option.disabled) return result(state);
      const current = document.formEditors[control.node];
      if (current?.kind !== "combobox") return result(state);
      const next = commitCombobox(current.state, message.event, {
        index: current.index,
        pageSize: formComboboxPageSize
      });
      return result(updateFormControl(
        state,
        document,
        control,
        [option.value],
        { kind: "combobox", state: next, index: current.index },
        [option.node]
      ));
    }
    case "formCheckboxGroup": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "select" || !control.multiple) return result(state);
      const options = control.options.map((option, index) => ({
        id: `${control.node}:${String(index)}`,
        label: option.label,
        value: option.value,
        disabled: option.disabled
      }));
      const selectedIds = control.options.flatMap((option, index) =>
        controlSelections(document, control).includes(option.node)
          ? [`${control.node}:${String(index)}`]
          : []
      );
      const current = document.formEditors[control.node];
      const interaction = current?.kind === "checkboxGroup"
        ? current.state
        : {
          ...(selectedIds[0] === undefined ? {} : { activeId: selectedIds[0] }),
          selection: { mode: "multiple" as const, selectedIds }
        };
      const next = checkboxGroupReducer(interaction, message.action, options);
      const nextIds = next.selection.mode === "multiple" ? next.selection.selectedIds : [];
      const nextValues = nextIds.flatMap((id) => {
        const option = options.find((candidate) => candidate.id === id);
        return option === undefined ? [] : [option.value];
      });
      const nextOptions = nextIds.flatMap((id) => {
        const index = Number.parseInt(id.slice(id.lastIndexOf(":") + 1), 10);
        const option = control.options[index];
        return option === undefined ? [] : [option.node];
      });
      return result(updateFormControl(
        state,
        document,
        control,
        nextValues,
        { kind: "checkboxGroup", state: next },
        nextOptions
      ));
    }
    case "formValues": {
      const control = controlById(document, message.controlId);
      if (control === undefined) return result(state);
      if (control.kind === "radio") {
        const groupNodes = new Set(
          document.snapshot.document.radioGroup(control.node).map((entry) => entry.node)
        );
        return result(updateDocument(state, document.id, (current) => ({
          ...current,
          documentState: [...groupNodes].reduce(
            (next, node) => applyDocumentAction(
              current.snapshot.document,
              next,
              { kind: "set-checked", target: node, checked: node === control.node && message.values.length > 0 }
            ),
            current.documentState
          )
        })));
      }
      return result(updateFormControl(state, document, control, message.values));
    }
    case "resetForm": {
      const form = controller.form(document, message.formId);
      if (!form) return result(state);
      const nodes = new Set(form.controls.map((control) => control.node));
      return result(updateDocument(state, document.id, (current) => ({
        ...current,
        documentState: applyDocumentAction(current.snapshot.document, current.documentState, {
          kind: "reset-form",
          target: form.node
        }),
        formEditors: Object.fromEntries(Object.entries(current.formEditors).filter(([id]) => !nodes.has(id as DocumentNodeRef)))
      })));
    }
    case "submitForm": {
      const form = controller.form(document, message.formId);
      if (!form) return result({ ...state, status: status("The form no longer exists.", "error") });
      const submitter = submitterControl(form, message.submitterId);
      const missing = form.noValidate || submitter?.formNoValidate === true
        ? undefined
        : firstMissingRequiredControl(controller, document, form.node);
      if (missing !== undefined) {
        const focus = missing.kind === "radio"
          ? {
            kind: "elementTarget" as const,
            elementId: `${form.node}:radio:${missing.name.length === 0 ? missing.node : missing.name}`,
            targetId: missing.node
          }
          : { kind: "element" as const, elementId: missing.node };
        return result({
          ...state,
          status: status(`${missing.label} is required.`, "error")
        }, { focus });
      }
      return beginNavigation(state, document, submitter?.formAction ?? form.action, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          controller,
          document,
          await controller.submitForm(
            document,
            form,
            document.documentState,
            message.submitterId as DocumentNodeRef | undefined,
            effectContext.signal
          ),
          "Submitted form"
        ),
        "replace",
        document.id
      ));
    }
    case "pageLoaded": {
      const loadedIndex = state.documents.findIndex((entry) => entry.id === message.documentId);
      const current = state.documents[loadedIndex];
      if (!current) return result(state);
      const loaded = pageFromSnapshot(current, message.snapshot, message);
      const next = {
        ...updateDocument(state, message.documentId, () => loaded),
        overlay: null,
        ...(loadedIndex === state.activeDocumentIndex
          ? {
            omnibox: resetCommandInput(state.omnibox, message.snapshot.finalUrl),
            omniboxDirty: false
          }
          : {}),
        ...controller.library(),
        status: status(`${message.status}: ${message.snapshot.finalUrl}`, "success")
      };
      return result(next, {
        effects: [persistSnapshotEffect(controller, message.snapshot), persistEffect(controller, next)]
      });
    }
    case "documentOpened": {
      const replaced = message.replaceCurrent === true;
      const documents = replaced
        ? state.documents.map((entry, index) => index === state.activeDocumentIndex ? message.document : entry)
        : [...state.documents, message.document];
      const nextIndex = message.background
        ? state.activeDocumentIndex
        : replaced ? state.activeDocumentIndex : documents.length - 1;
      const next = {
        ...state,
        documents,
        activeDocumentIndex: nextIndex,
        recentlyClosed: replaced ? [document, ...state.recentlyClosed].slice(0, 10) : state.recentlyClosed,
        overlay: null,
        ...(message.background
          ? {}
          : {
            omnibox: resetCommandInput(state.omnibox, message.document.snapshot.finalUrl)
          }),
        status: status(`Opened ${message.document.snapshot.finalUrl}`, "success")
      };
      return result(next, {
        effects: [persistSnapshotEffect(controller, message.document.snapshot), persistEffect(controller, next)],
        ...(message.background
          ? {}
          : { focus: { kind: "element" as const, elementId: message.document.snapshot.finalUrl === "about:newtab" ? "browser-omnibox" : `browser-${message.document.id}` } })
      });
    }
    case "download": {
      let target: string;
      try {
        const parsedTarget = new URL(
          message.target ?? document.snapshot.finalUrl,
          document.snapshot.finalUrl
        );
        if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
          return result({
            ...state,
            status: status("Downloads require an HTTP or HTTPS URL.", "error")
          });
        }
        target = parsedTarget.toString();
      } catch {
        return result({ ...state, status: status("The download URL is invalid.", "error") });
      }
      const id = `download:${document.id}:${globalThis.crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const pending: DownloadRecord = {
        id,
        url: target,
        fileName: new URL(target).pathname.split("/").filter(Boolean).at(-1) ?? "download",
        destinationPath: null,
        status: "downloading",
        receivedBytes: 0,
        totalBytes: null,
        error: null,
        startedAtIso: now,
        updatedAtIso: now
      };
      return result({
        ...state,
        overlay: null,
        downloads: [pending, ...state.downloads.filter((entry) => entry.id !== id)],
        sidePanel: "downloads",
        status: status(`Downloading ${target}…`)
      }, {
        effects: [{
          id: `download:${id}`,
          concurrency: "keep-first",
          async run(effectContext) {
            try {
              const download = await controller.download(
                target,
                id,
                document.snapshot.finalUrl,
                effectContext.signal
              );
              return { kind: "message", message: { kind: "downloadComplete", download } };
            } catch (error) {
              effectContext.signal.throwIfAborted();
              const failed = (error as { readonly download?: DownloadRecord }).download;
              return failed === undefined
                ? { kind: "message", message: { kind: "operationFailed", message: error instanceof Error ? error.message : String(error) } }
                : { kind: "message", message: { kind: "downloadFailed", download: failed } };
            }
          }
        }]
      });
    }
    case "downloadComplete":
    case "downloadFailed": {
      const next = {
        ...state,
        downloads: [message.download, ...state.downloads.filter((entry) => entry.id !== message.download.id)],
        status: message.kind === "downloadComplete"
          ? status(`Downloaded ${message.download.fileName}.`, "success")
          : status(message.download.error ?? "Download failed.", "error")
      };
      return result(next);
    }
    case "libraryChanged":
      return result({ ...state, ...controller.library() });
    case "cancelDownload": {
      const entry = state.downloads.find((download) => download.id === message.id);
      if (!entry || entry.status !== "downloading") return result(state);
      const interrupted = {
        ...entry,
        status: "interrupted" as const,
        error: "Cancelled by the user.",
        updatedAtIso: new Date().toISOString()
      };
      return result({
        ...state,
        downloads: [interrupted, ...state.downloads.filter((download) => download.id !== message.id)]
      }, { cancelEffects: [`download:${message.id}`] });
    }
    case "retryDownload": {
      const entry = state.downloads.find((download) => download.id === message.id);
      return entry === undefined ? result(state) : updateBrowser(controller, state, { kind: "download", target: entry.url }, context);
    }
    case "removeDownload":
      return result(state, { effects: [effect(`remove-download:${message.id}`, async () => ({
        kind: "downloadsChanged",
        downloads: (await controller.removeDownload(message.id), controller.library().downloads),
        status: "Download removed from the list."
      }))] });
    case "openDownload":
      return result(state, { effects: [effect(`open-download:${message.id}`, async () => ({
        kind: "operationComplete",
        status: await controller.openDownload(message.id, message.location)
      }))] });
    case "downloadsChanged":
      return result({ ...state, downloads: message.downloads, status: status(message.status, "success") });
    case "operationComplete":
      return result({ ...state, ...controller.library(), status: status(message.status, "success") });
    case "operationFailed": {
      const failedState = message.documentId === undefined
        ? state
        : updateDocument(state, message.documentId, (entry) => ({
          ...entry,
          loading: false,
          pendingUrl: null,
          error: message.downloadTarget === undefined ? message.message : null
        }));
      return result({
        ...failedState,
        overlay: message.downloadTarget === undefined
          ? failedState.overlay
          : { kind: "downloadPrompt", target: message.downloadTarget },
        status: status(message.message, "error")
      });
    }
  }
}

function textBinding(id: string, text: string, message: BrowserTuiMessage) {
  return {
    id,
    phase: "afterFocus" as const,
    triggers: [{ kind: "text" as const, text }],
    enabled: ({ state }: { readonly state: BrowserTuiState }) => state.overlay === null,
    message
  };
}

export function createBrowserApp(
  initialState: BrowserTuiState,
  controller: BrowserController
) {
  const tabNumberBindings: readonly TuiInputBinding<BrowserTuiState, BrowserTuiMessage>[] = (
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const
  ).map((key, index) => ({
    id: `tab-${String(index + 1)}`,
    phase: "beforeFocus" as const,
    triggers: [{ kind: "key" as const, key, modifiers: { ctrl: true } }],
    enabled: ({ state }: { readonly state: BrowserTuiState }) => state.documents.length > index,
    message: { kind: "selectDocument" as const, index }
  }));
  return defineTui<BrowserTuiState, BrowserTuiMessage>({
    id: "verge-browser",
    init: () => ({ state: initialState }),
    update: (state, message, context) => updateBrowser(controller, state, message, context),
    view: browserView,
    inputBindings: [
      { id: "quit-control", phase: "beforeFocus", triggers: [{ kind: "key", key: "c", modifiers: { ctrl: true } }], message: { kind: "quit" } },
      { id: "new-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "t", modifiers: { ctrl: true } }], message: { kind: "newDocument" } },
      { id: "close-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "w", modifiers: { ctrl: true } }], message: { kind: "closeDocument" } },
      { id: "reopen-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "t", modifiers: { ctrl: true, shift: true } }], message: { kind: "reopenDocument" } },
      { id: "next-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "tab", modifiers: { ctrl: true } }], message: { kind: "tabsTransition", transition: { kind: "moveActive", delta: 1 } } },
      { id: "previous-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "tab", modifiers: { ctrl: true, shift: true } }], message: { kind: "tabsTransition", transition: { kind: "moveActive", delta: -1 } } },
      { id: "back", phase: "beforeFocus", triggers: [{ kind: "key", key: "arrowLeft", modifiers: { alt: true } }], message: { kind: "navigate", operation: "back" } },
      { id: "forward", phase: "beforeFocus", triggers: [{ kind: "key", key: "arrowRight", modifiers: { alt: true } }], message: { kind: "navigate", operation: "forward" } },
      { id: "reload", phase: "beforeFocus", triggers: [{ kind: "key", key: "r", modifiers: { ctrl: true } }], message: { kind: "navigate", operation: "reload" } },
      { id: "focus-location", phase: "beforeFocus", triggers: [{ kind: "key", key: "l", modifiers: { ctrl: true } }], message: { kind: "focusOmnibox" } },
      { id: "find", phase: "beforeFocus", triggers: [{ kind: "key", key: "f", modifiers: { ctrl: true } }], message: { kind: "openFind" } },
      { id: "find-next", phase: "beforeFocus", triggers: [{ kind: "key", key: "f3" }], message: { kind: "moveSearch", direction: "next" } },
      { id: "find-previous", phase: "beforeFocus", triggers: [{ kind: "key", key: "f3", modifiers: { shift: true } }], message: { kind: "moveSearch", direction: "prev" } },
      ...tabNumberBindings,
      textBinding("quit", "q", { kind: "quit" }),
      textBinding("actions", ":", { kind: "openActionPalette" }),
      textBinding("help", "?", { kind: "openDetail", detail: "help" }),
      {
        id: "activate",
        phase: "afterFocus",
        triggers: [{ kind: "key", key: "enter" }],
        enabled: ({ state, focusPath }) => {
          const current = state.documents[state.activeDocumentIndex];
          return state.overlay === null
            && current !== undefined
            && focusPath?.includes(`browser-${current.id}`) === true;
        },
        toMessage: ({ focusPath }) => ({
          kind: "activateActionAt",
          actionId: focusPath?.at(-1) ?? ""
        })
      },
      {
        id: "page-focus-next",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "arrowDown" }],
        enabled: ({ state, focusPath }) => {
          const current = state.documents[state.activeDocumentIndex];
          const target = focusPath?.at(-1);
          return state.overlay === null && current !== undefined
            && target !== undefined && actionById(current, target) !== undefined;
        },
        toMessage: ({ focusPath }) => ({
          kind: "movePageFocus",
          direction: "next",
          currentActionId: focusPath?.at(-1) ?? ""
        })
      },
      {
        id: "page-focus-previous",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "arrowUp" }],
        enabled: ({ state, focusPath }) => {
          const current = state.documents[state.activeDocumentIndex];
          const target = focusPath?.at(-1);
          return state.overlay === null && current !== undefined
            && target !== undefined && actionById(current, target) !== undefined;
        },
        toMessage: ({ focusPath }) => ({
          kind: "movePageFocus",
          direction: "prev",
          currentActionId: focusPath?.at(-1) ?? ""
        })
      },
      {
        id: "page-control-focus-next",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "tab" }],
        enabled: ({ state, focusPath }) => state.overlay === null
          && focusedControlActionId(state, focusPath) !== null,
        toMessage: ({ state, focusPath }) => ({
          kind: "movePageFocus",
          direction: "next",
          currentActionId: focusedControlActionId(state, focusPath) ?? ""
        })
      },
      {
        id: "page-control-focus-previous",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "tab", modifiers: { shift: true } }],
        enabled: ({ state, focusPath }) => state.overlay === null
          && focusedControlActionId(state, focusPath) !== null,
        toMessage: ({ state, focusPath }) => ({
          kind: "movePageFocus",
          direction: "prev",
          currentActionId: focusedControlActionId(state, focusPath) ?? ""
        })
      },
      { id: "scroll-down", phase: "afterFocus", triggers: [{ kind: "key", key: "arrowDown" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: 1 } },
      { id: "scroll-up", phase: "afterFocus", triggers: [{ kind: "key", key: "arrowUp" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: -1 } },
      { id: "page-down", triggers: [{ kind: "key", key: "pageDown" }, { kind: "text", text: " " }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: 10 } },
      { id: "page-up", triggers: [{ kind: "key", key: "pageUp" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: -10 } },
      { id: "scroll-top", triggers: [{ kind: "key", key: "home" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scrollTop" } },
      { id: "scroll-bottom", triggers: [{ kind: "key", key: "end" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scrollBottom" } },
      { id: "dismiss", triggers: [{ kind: "key", key: "escape" }], enabled: ({ state }) => state.overlay !== null, message: { kind: "dismiss" } },
      {
        id: "cancel-omnibox",
        phase: "afterFocus",
        triggers: [{ kind: "key", key: "escape" }],
        enabled: ({ state, focusPath }) =>
          state.overlay === null && focusPath?.includes("browser-omnibox") === true,
        message: { kind: "cancelOmnibox" }
      },
      { id: "close-find", triggers: [{ kind: "key", key: "escape" }], enabled: ({ state }) => state.overlay === null && state.findBar !== null, message: { kind: "closeFind" } }
    ],
    nonTty: { mode: "last_frame" }
  });
}

export function createBrowserInitialState(
  documents: readonly BrowserDocumentState[],
  activeDocumentIndex: number,
  controller: BrowserController,
  sidePanel: BrowserTuiState["sidePanel"] = null
): BrowserTuiState {
  const activeIndex = Math.max(0, Math.min(documents.length - 1, activeDocumentIndex));
  const active = documents[activeIndex];
  if (!active) throw new Error("The browser requires at least one document.");
  return {
    documents,
    activeDocumentIndex: activeIndex,
    recentlyClosed: [],
    omnibox: createCommandInputState({
      value: active.snapshot.finalUrl,
      cursor: active.snapshot.finalUrl.length,
      submissions: [],
      submissionLimit: 50,
      suggestions: EMPTY_COMMAND_SUGGESTIONS
    }),
    omniboxDirty: false,
    findBar: null,
    sidePanel,
    sidePanelScroll: createScrollState(),
    ...controller.library(),
    overlay: null,
    status: status(`Opened ${active.snapshot.finalUrl}`, "success")
  };
}
