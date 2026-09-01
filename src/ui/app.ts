import {
  applyScrollRequest,
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
  createCommandSuggestions,
  createSearchPickerIndex,
  numberInputReducer,
  searchPickerReducer,
  searchPickerEntryById,
  tabsReducer,
  textAreaReducer,
  textInputReducer
} from "@ismail-elkorchi/terminal-ui/behavior";
import { textDocumentText } from "@ismail-elkorchi/terminal-ui/text";
import { createCollectionInteractionIndex } from "@ismail-elkorchi/terminal-ui/interaction";
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
import type { PageRequestOptions, IndexedPageSnapshot } from "../app/types.js";
import { measured, type RenderInstrumentation } from "../presentation/renderer/index.js";
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
  browserRenderPreferences,
  documentContentColumns,
  documentScrollRow,
  documentWithScrollRow,
  scrollToSource
} from "./document-layout.js";
import type {
  BrowserDocumentSearch,
  BrowserDocumentState,
  BrowserPlaceholderTabState,
  BrowserTabState,
  BrowserTuiMessage,
  BrowserTuiState,
  PickerKind,
  StatusMessage
} from "./model.js";
import { browserMenuItems, formComboboxPageSize, linkMenuItems } from "./model.js";
import { browserView } from "./view.js";
import type { ViewportRequestParameters } from "./render-worker/index.js";

const EMPTY_COMMAND_SUGGESTIONS = createCommandSuggestions([]);
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
  return createCommandSuggestions(suggestions.map((suggestion) => ({
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

function activeTab(state: BrowserTuiState): BrowserTabState {
  const tab = state.documents[state.activeDocumentIndex];
  if (!tab) throw new Error("No browser tab is active.");
  return tab;
}

function activeDocument(state: BrowserTuiState): BrowserDocumentState {
  const tab = activeTab(state);
  if (tab.kind !== "ready") throw new Error("The active browser tab is not ready.");
  return tab;
}

function tabUrl(tab: BrowserTabState): string {
  return tab.kind === "ready" ? tab.snapshot.finalUrl : tab.requestedUrl;
}

function tabLabel(tab: BrowserTabState): string {
  return tab.kind === "ready" ? tab.snapshot.document.title : tab.label;
}

function updateDocument(
  state: BrowserTuiState,
  documentId: string,
  update: (document: BrowserDocumentState) => BrowserDocumentState
): BrowserTuiState {
  return {
    ...state,
    documents: state.documents.map((document) => {
      if (document.id !== documentId) return document;
      if (document.kind !== "ready") return document;
      const updated = update(document);
      if (updated.documentState === document.documentState) return updated;
      const requiresViewport = documentStateRequiresViewport(document, updated.documentState);
      return {
        ...updated,
        stateRevision: requiresViewport ? document.stateRevision + 1 : document.stateRevision,
        ...(requiresViewport ? {
          rendering: { ...updated.rendering, requestKey: null },
        } : {}),
      };
    })
  };
}

function documentStateRequiresViewport(
  document: BrowserDocumentState,
  next: BrowserDocumentState["documentState"],
): boolean {
  const previous = document.documentState;
  if (previous.controls !== next.controls || previous.open !== next.open) return true;
  const dependencies = document.rendering.summary?.authorStateDependencies;
  if (dependencies === undefined) return true;
  const has = (value: typeof dependencies[number]): boolean => dependencies.includes(value);
  if (previous.hover !== next.hover && has("hover")) return true;
  if (previous.active !== next.active && has("active")) return true;
  if (previous.urlTarget !== next.urlTarget && has("target")) return true;
  if (previous.focus !== next.focus) {
    return has("focus");
  }
  return false;
}

function documentWithFocus(
  document: BrowserDocumentState,
  target: DocumentNodeRef | null
): BrowserDocumentState {
  if (document.documentState.focus === target) return document;
  return {
    ...document,
    documentState: applyDocumentAction(
      document.snapshot.document,
      document.documentState,
      { kind: "focus", target }
    )
  };
}

function updateDocumentFocus(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  target: DocumentNodeRef | null
): BrowserTuiState {
  return updateDocument(state, document.id, (current) =>
    documentWithFocus(current, target)
  );
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
  snapshot: IndexedPageSnapshot
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

function viewportParameters(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  terminalSize: Pick<TuiContext, "terminalSize">["terminalSize"],
): ViewportRequestParameters {
  const columns = documentContentColumns(contentColumns(state, terminalSize.columns));
  const rows = Math.max(1, terminalSize.rows - (state.findBar === null ? 3 : 4));
  return Object.freeze({
    columns,
    rows,
    scrollRow: documentScrollRow(document),
    overscanBefore: Math.min(6, rows),
    overscanAfter: Math.min(12, rows),
    preferences: browserRenderPreferences(),
    searchQuery: document.search?.query ?? null,
  });
}

function viewportRequestKey(
  document: BrowserDocumentState,
  parameters: ViewportRequestParameters,
): string {
  return [
    document.id,
    document.documentRevision,
    parameters.columns,
    parameters.rows,
    parameters.scrollRow,
    parameters.overscanBefore,
    parameters.overscanAfter,
    JSON.stringify(parameters.preferences),
    parameters.searchQuery ?? "",
  ].join(":");
}

function viewportEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  viewportRevision: number,
  parameters: ViewportRequestParameters,
): TuiEffect<BrowserTuiMessage> {
  return effect(`render:${document.id}`, async (context) => {
    const cancel = (): void => { controller.cancelViewport(document.id); };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const payload = await controller.renderViewport(document, viewportRevision, parameters);
      return {
        kind: "viewportReady",
        payload,
      };
    } catch (error) {
      return {
        kind: "viewportFailed",
        documentId: document.id,
        documentRevision: document.documentRevision,
        viewportRevision,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
  }, "replace", document.id);
}

function searchEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  query: string,
  parameters: ViewportRequestParameters,
): TuiEffect<BrowserTuiMessage> {
  return effect(`search:${document.id}`, async () => {
    const result = await controller.searchDocument(document, query, parameters);
    return {
      kind: "searchReady",
      documentId: document.id,
      documentRevision: document.documentRevision,
      query: result.query,
      matches: result.matches.slice(0, MAX_PAGE_SEARCH_MATCHES).map((match) => ({
        id: match.id,
        sources: match.sources,
        anchorRow: match.anchorRow,
      })),
      truncated: result.truncated || result.matches.length > MAX_PAGE_SEARCH_MATCHES,
    };
  }, "replace", document.id);
}

const MAX_BACKGROUND_TAB_RESTORATIONS = 2;

function scheduleTabRestorations(
  controller: BrowserController,
  state: BrowserTuiState,
): {
  readonly state: BrowserTuiState;
  readonly effects: readonly TuiEffect<BrowserTuiMessage>[];
} {
  const documents = [...state.documents];
  const effects: TuiEffect<BrowserTuiMessage>[] = [];
  const begin = (index: number): void => {
    const candidate = documents[index];
    if (candidate === undefined || candidate.kind !== "restoring") return;
    const loading = { ...candidate, kind: "loading" as const };
    documents[index] = loading;
    effects.push(restoreTabEffect(controller, loading));
  };
  const active = documents[state.activeDocumentIndex];
  if (active?.kind === "restoring") {
    begin(state.activeDocumentIndex);
  } else if (active?.kind === "failed"
    || (active?.kind === "ready" && active.rendering.status === "ready")) {
    let capacity = MAX_BACKGROUND_TAB_RESTORATIONS
      - documents.filter((entry) => entry.kind === "loading").length;
    for (let index = 0; index < documents.length && capacity > 0; index += 1) {
      if (documents[index]?.kind !== "restoring") continue;
      begin(index);
      capacity -= 1;
    }
  }
  return effects.length === 0
    ? { state, effects }
    : { state: { ...state, documents }, effects: Object.freeze(effects) };
}

function pageFromSnapshot(
  document: BrowserDocumentState,
  snapshot: IndexedPageSnapshot,
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
    documentRevision: document.documentRevision + 1,
    stateRevision: document.stateRevision + 1,
    snapshot,
    scrollAnchor: restored?.scrollAnchor
      ?? { source: snapshot.document.body ?? snapshot.document.documentElement, rowOffset: 0 },
    search: restored?.search ?? null,
    documentState: createDocumentState(snapshot.document),
    rendering: {
      status: "idle",
      requestedViewportRevision: 0,
      committedViewportRevision: 0,
      requestKey: null,
      pendingSearchQuery: null,
      pendingFocus: null,
      viewport: null,
      summary: null,
      error: null
    },
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
  if (document === undefined || document.kind !== "ready" || target === undefined) return null;
  const control = document.snapshot.document.control(target as DocumentNodeRef);
  return control === null ? null : `control:${control.node}`;
}

function pageText(document: BrowserDocumentState, columns: number): string {
  void columns;
  return document.snapshot.document.text(document.snapshot.document.root);
}

function navigationMessage(
  controller: BrowserController,
  document: BrowserDocumentState,
  snapshot: IndexedPageSnapshot,
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
  const entries = controller.pickerEntries(picker, [activeDocument(state)], 0, query);
  const index = createSearchPickerIndex(entries);
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

function moveSearch(
  document: BrowserDocumentState,
  direction: "next" | "prev",
): BrowserDocumentState {
  const search = document.search;
  if (!search || search.matches.length === 0) return document;
  const delta = direction === "next" ? 1 : -1;
  const activeMatchIndex = (search.activeMatchIndex + delta + search.matches.length) % search.matches.length;
  const match = search.matches[activeMatchIndex];
  if (match === undefined) return document;
  const updated = { ...document, search: { ...search, activeMatchIndex } };
  return documentWithScrollRow(updated, match.anchorRow);
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
  return updateDocument(state, document.id, (current) => {
    const focused = documentWithFocus(current, control.node);
    return {
      ...focused,
      documentState: control.kind === "checkbox" || control.kind === "radio"
      ? applyDocumentAction(
        focused.snapshot.document,
        focused.documentState,
        { kind: "set-checked", target: control.node, checked: values.length > 0 }
      )
      : control.kind === "select"
        ? applyDocumentAction(focused.snapshot.document, focused.documentState, {
          kind: "set-selected-options",
          target: control.node,
          options: selectedOptions ?? control.options.filter((option) => values.includes(option.value)).map((option) => option.node)
        })
        : applyDocumentAction(focused.snapshot.document, focused.documentState, {
          kind: "set-control-value",
          target: control.node,
          value: values[0] ?? ""
        }),
      ...(editor === undefined
        ? {}
        : { formEditors: { ...focused.formEditors, [control.node]: editor } })
    };
  });
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

function restoreTabEffect(
  controller: BrowserController,
  tab: BrowserPlaceholderTabState,
): TuiEffect<BrowserTuiMessage> {
  return {
    id: `restore:${tab.id}`,
    concurrency: "replace",
    async run(context) {
      try {
        const document = await controller.restorePlaceholder(tab, context.signal);
        return {
          kind: "message",
          message: {
            kind: "tabRestored",
            document,
            restoreRevision: tab.restoreRevision,
          },
        };
      } catch (error) {
        context.signal.throwIfAborted();
        return {
          kind: "message",
          message: {
            kind: "tabRestoreFailed",
            documentId: tab.id,
            restoreRevision: tab.restoreRevision,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

function runCommand(
  controller: BrowserController,
  state: BrowserTuiState,
  command: BrowserCommand,
  context: Pick<TuiContext, "terminalSize">,
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const document = activeDocument(state);
  const columns = contentColumns(state, context.terminalSize.columns);
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
      return updateBrowser(controller, state, { kind: "openDetail", detail: "help" }, context);
    case "reader":
    case "diag":
      return updateBrowser(controller, state, {
        kind: "openDetail",
        detail: command.kind === "reader" ? "reader" : "diagnostics"
      }, context);
    case "links":
    case "outline":
      return result(openPicker(controller, state, command.kind));
    case "history-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "history" }, context);
    case "download-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "downloads" }, context);
    case "bookmark-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "bookmarks" }, context);
    case "bookmark-add":
      return result(state, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.toggleBookmark(document, command.name)
      }))] });
    case "recall":
      return result(openPicker(controller, state, "recall", command.query));
    case "page-down":
      return updateBrowser(controller, state, { kind: "scroll", rows: 10 }, context);
    case "page-up":
      return updateBrowser(controller, state, { kind: "scroll", rows: -10 }, context);
    case "page-top":
      return updateBrowser(controller, state, { kind: "scrollTop" }, context);
    case "page-bottom":
      return updateBrowser(controller, state, { kind: "scrollBottom" }, context);
    case "find":
      return result({ ...state, findBar: { input: { text: command.query, cursor: command.query.length } } });
    case "find-next":
    case "find-prev":
      return updateBrowser(controller, state, {
        kind: "moveSearch",
        direction: command.kind === "find-next" ? "next" : "prev"
      }, context);
    case "back":
    case "forward":
    case "reload":
      return updateBrowser(controller, state, { kind: "navigate", operation: command.kind }, context);
    case "download":
      return updateBrowser(controller, state, {
        kind: "download",
        ...(command.target === undefined ? {} : { target: command.target })
      }, context);
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
      return updateBrowser(controller, state, { kind: "openExternal" }, context);
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
      return updateBrowser(controller, state, { kind: "openDetail", detail: "cookies" }, context);
    case "cookie-clear":
      return result({ ...state, overlay: null }, { effects: [effect("cookie-clear", async () => ({
        kind: "operationComplete",
        status: await controller.clearCookies()
      }))] });
    case "close-document":
      return updateBrowser(controller, state, { kind: "closeDocument" }, context);
    case "reopen-document":
      return updateBrowser(controller, state, { kind: "reopenDocument" }, context);
  }
}

function reduceBrowser(
  controller: BrowserController,
  state: BrowserTuiState,
  message: BrowserTuiMessage,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 100, rows: 24 } }
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  if (message.kind === "tabRestored") {
    const current = state.documents.find((entry) => entry.id === message.document.id);
    if (current === undefined || current.kind !== "loading"
      || current.restoreRevision !== message.restoreRevision) return result(state);
    const next = {
      ...state,
      documents: state.documents.map((entry) => entry.id === current.id ? message.document : entry),
      ...(state.activeDocumentIndex === state.documents.indexOf(current)
        ? { omnibox: resetCommandInput(state.omnibox, message.document.snapshot.finalUrl) }
        : {}),
      status: status(`Opened ${message.document.snapshot.finalUrl}`, "success"),
    };
    const restoredActive = state.activeDocumentIndex === state.documents.indexOf(current);
    return result(next, {
      effects: restoredActive ? [] : [
        ...(activeTab(state).kind === "ready" && activeDocument(state).rendering.status === "ready"
          ? [persistSnapshotEffect(controller, message.document.snapshot)]
          : []),
        persistEffect(controller, next),
      ],
    });
  }
  if (message.kind === "tabRestoreFailed") {
    const current = state.documents.find((entry) => entry.id === message.documentId);
    if (current === undefined || current.kind !== "loading"
      || current.restoreRevision !== message.restoreRevision) return result(state);
    const next = {
      ...state,
      documents: state.documents.map((entry) => entry.id === current.id
        ? { ...current, kind: "failed" as const, error: message.message }
        : entry),
      status: status(message.message, "error"),
    };
    return result(next, { effects: [persistEffect(controller, next)] });
  }
  if (message.kind === "restoreTab") {
    const current = state.documents.find((entry) => entry.id === message.documentId);
    if (current === undefined || current.kind === "ready" || current.kind === "loading") return result(state);
    return result({
      ...state,
      documents: state.documents.map((entry) => entry.id === current.id
        ? {
            ...current,
            kind: "restoring" as const,
            restoreRevision: current.restoreRevision + 1,
            retryCount: current.retryCount + 1,
            error: null,
          }
        : entry),
    });
  }
  const selectedTab = activeTab(state);
  if (selectedTab.kind !== "ready") {
    switch (message.kind) {
      case "quit": return { state, exit: { reason: "quit" } };
      case "dismiss": return result({ ...state, overlay: null });
      case "requestActiveViewport":
      case "viewportReady":
      case "viewportFailed":
      case "searchReady": return result(state);
      case "selectDocument": {
        const selected = state.documents[message.index];
        if (selected === undefined) return result(state);
        const next = {
          ...state,
          activeDocumentIndex: message.index,
          omnibox: resetCommandInput(state.omnibox, tabUrl(selected)),
        };
        return result(next, { effects: [persistEffect(controller, next)] });
      }
      case "tabsTransition": {
        const tabState = tabsReducer(
          { activeId: selectedTab.id, selectedId: selectedTab.id },
          message.transition,
          { tabs: state.documents, activation: "automatic" },
        );
        const index = state.documents.findIndex((entry) => entry.id === tabState.selectedId);
        return index < 0 ? result(state) : reduceBrowser(
          controller,
          state,
          { kind: "selectDocument", index },
          context,
        );
      }
      case "tabsClose": {
        const index = state.documents.findIndex((entry) => entry.id === message.event.id);
        return index < 0 ? result(state) : reduceBrowser(
          controller,
          { ...state, activeDocumentIndex: index },
          { kind: "closeDocument" },
          context,
        );
      }
      case "closeDocument": {
        if (state.documents.length === 1) {
          const replacement = controller.placeholder("about:newtab");
          const next = {
            ...state,
            documents: [replacement],
            activeDocumentIndex: 0,
            recentlyClosed: [selectedTab, ...state.recentlyClosed].slice(0, 10),
            omnibox: resetCommandInput(state.omnibox, replacement.requestedUrl),
            status: status(`Closed ${tabLabel(selectedTab)}.`, "success"),
          };
          return result(next, {
            cancelEffects: [`restore:${selectedTab.id}`],
            effects: [persistEffect(controller, next)],
          });
        }
        const documents = state.documents.filter((_, index) => index !== state.activeDocumentIndex);
        const activeDocumentIndex = Math.min(state.activeDocumentIndex, documents.length - 1);
        const nextDocument = documents[activeDocumentIndex];
        if (nextDocument === undefined) return result(state);
        const next = {
          ...state,
          documents,
          activeDocumentIndex,
          recentlyClosed: [selectedTab, ...state.recentlyClosed].slice(0, 10),
          omnibox: resetCommandInput(state.omnibox, tabUrl(nextDocument)),
          status: status(`Closed ${tabLabel(selectedTab)}.`, "success"),
        };
        return result(next, {
          cancelEffects: [`restore:${selectedTab.id}`],
          effects: [persistEffect(controller, next)],
        });
      }
      case "reopenDocument": {
        const closed = state.recentlyClosed[0];
        if (closed === undefined) return result(state);
        const restored = closed.kind === "ready"
          ? controller.restoreDocument(closed)
          : { ...closed, kind: "restoring" as const, restoreRevision: closed.restoreRevision + 1 };
        const next = {
          ...state,
          documents: [...state.documents, restored],
          recentlyClosed: state.recentlyClosed.slice(1),
          activeDocumentIndex: state.documents.length,
          omnibox: resetCommandInput(state.omnibox, tabUrl(restored)),
        };
        return result(next, { effects: [persistEffect(controller, next)] });
      }
      default: return result(state);
    }
  }
  const document = selectedTab;
  const viewportRows = Math.max(1, context.terminalSize.rows - (state.findBar === null ? 3 : 4));
  switch (message.kind) {
    case "terminalResized":
      return result(state);
    case "requestActiveViewport":
      return document.rendering.status === "failed"
        ? result(updateDocument(state, document.id, (entry) => ({
            ...entry,
            rendering: { ...entry.rendering, status: "idle", requestKey: null, error: null },
          })))
        : result(state);
    case "viewportReady": {
      const payload = message.payload;
      const current = state.documents.find((entry) => entry.id === payload.documentId);
      if (current === undefined || current.kind !== "ready"
        || current.documentRevision !== payload.documentRevision
        || current.stateRevision !== payload.stateRevision
        || current.rendering.requestedViewportRevision !== payload.viewportRevision) return result(state);
      const pendingFocus = current.rendering.pendingFocus;
      const focusVisible = pendingFocus !== null
        && payload.focusTargets.some((target) => target.node === pendingFocus.node);
      const updated = updateDocument(state, current.id, (entry) => ({
        ...entry,
        rendering: {
          ...entry.rendering,
          status: "ready",
          committedViewportRevision: payload.viewportRevision,
          viewport: payload,
          summary: payload.summary ?? entry.rendering.summary,
          pendingFocus: focusVisible ? null : entry.rendering.pendingFocus,
          error: null
        }
      }));
      const firstCommittedViewport = current.rendering.committedViewportRevision === 0;
      return result(updated, {
        ...(focusVisible ? {
          focus: pendingFocus.formControl
            ? { kind: "element", elementId: pendingFocus.node }
            : {
                kind: "elementTarget",
                elementId: `browser-${current.id}`,
                targetId: pendingFocus.actionId,
              },
        } : {}),
        ...(firstCommittedViewport
          ? {
              effects: [
                persistSnapshotEffect(controller, current.snapshot),
                persistEffect(controller, updated),
              ],
            }
          : {}),
      });
    }
    case "viewportFailed": {
      const current = state.documents.find((entry) => entry.id === message.documentId);
      if (current === undefined || current.kind !== "ready"
        || current.documentRevision !== message.documentRevision
        || current.rendering.requestedViewportRevision !== message.viewportRevision) return result(state);
      return result(updateDocument(state, current.id, (entry) => ({
        ...entry,
        rendering: { ...entry.rendering, status: "failed", error: message.message }
      })));
    }
    case "searchReady": {
      const current = state.documents.find((entry) => entry.id === message.documentId);
      if (current === undefined || current.kind !== "ready"
        || current.documentRevision !== message.documentRevision
        || state.findBar?.input.text !== message.query) return result(state);
      const search: BrowserDocumentSearch = {
        query: message.query,
        matches: message.matches,
        activeMatchIndex: 0,
        truncated: message.truncated
      };
      const first = search.matches[0];
      const withSearch = {
        ...current,
        search,
        rendering: { ...current.rendering, pendingSearchQuery: null }
      };
      const updated = first === undefined
        ? withSearch
        : documentWithScrollRow(withSearch, first.anchorRow, viewportRows);
      return result({
        ...updateDocument(state, current.id, () => updated),
        status: first === undefined
          ? status(`No matches for "${search.query}"`, "error")
          : status(`1/${String(search.matches.length)}${search.truncated ? "+" : ""} matches`, "success")
      });
    }
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "dismiss":
      return result({ ...state, overlay: null });
    case "focusDocumentNode":
      return result(updateDocumentFocus(state, document, message.target));
    case "scroll":
      if (state.overlay?.kind === "detail") {
        return result({ ...state, overlay: { ...state.overlay, scrollRow: Math.max(0, state.overlay.scrollRow + message.rows) } });
      }
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, documentScrollRow(current) + message.rows, viewportRows)
      ));
    case "scrollTo":
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, message.row, viewportRows)
      ));
    case "scrollTop":
      return result(updateDocument(state, document.id, (current) => documentWithScrollRow(current, 0, viewportRows)));
    case "scrollBottom":
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, current.rendering.summary?.documentRowCount ?? 1, viewportRows)
      ));
    case "movePageFocus": {
      const targets = document.rendering.summary?.focusOrder ?? [];
      if (targets.length === 0) return result(state);
      const currentIndex = targets.findIndex((target) =>
        target.actionId === message.currentActionId
      );
      const nextIndex = message.direction === "next"
        ? (currentIndex + 1 + targets.length) % targets.length
        : (currentIndex - 1 + targets.length) % targets.length;
      const target = targets[nextIndex];
      if (target === undefined) return result(state);
      const top = target.topRow;
      const bottom = target.bottomRow;
      const currentRow = documentScrollRow(document);
      const revealedRow = top < currentRow
        ? top
        : bottom > currentRow + viewportRows
          ? bottom - viewportRows
          : currentRow;
      let updated = documentWithFocus(
        documentWithScrollRow(document, revealedRow, viewportRows),
        target.node
      );
      const visible = document.rendering.viewport?.focusTargets.some((entry) => entry.node === target.node) === true;
      if (!visible) {
        updated = {
          ...updated,
          rendering: {
            ...updated.rendering,
            pendingFocus: {
              node: target.node,
              actionId: target.actionId,
              formControl: target.actionKind === "form-control",
            },
          },
        };
      }
      return result(updateDocument(state, document.id, () => updated), visible ? {
        focus: target.actionKind === "form-control"
          ? { kind: "element", elementId: target.node }
          : {
            kind: "elementTarget",
            elementId: `browser-${document.id}`,
            targetId: target.actionId,
          }
      } : {});
    }
    case "moveSearch": {
      if (!document.search) return result({ ...state, status: status("No active find query.", "error") });
      const updated = moveSearch(document, message.direction);
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
      const focusedState = updateDocumentFocus(state, document, action.node);
      const focusedDocument = activeDocument(focusedState);
      if (action.kind === "form-control") {
        return result(focusedState, { focus: { kind: "element", elementId: action.node } });
      }
      if (action.kind === "disclosure") {
        return result(updateDocument(focusedState, document.id, (current) => ({
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
        return result(focusedState, {
          effects: [openNewDocumentEffect(
            controller,
            action.destination,
            disposition === "newBackground",
            false,
            focusedDocument
          )]
        });
      }
      return beginNavigation(focusedState, focusedDocument, action.destination, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          controller,
          focusedDocument,
          await controller.openLink(focusedDocument, action.index, effectContext.signal),
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
        ...updateDocumentFocus(state, document, action.node),
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
        sidePanelScroll: applyScrollRequest(state.sidePanelScroll, message.request)
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
          omnibox: resetCommandInput(state.omnibox, selected === undefined ? "" : tabUrl(selected)),
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
      const restored = closed.kind === "ready"
        ? controller.restoreDocument(closed)
        : { ...closed, kind: "restoring" as const, restoreRevision: closed.restoreRevision + 1 };
      const next = {
        ...state,
        documents: [...state.documents, restored],
        activeDocumentIndex: state.documents.length,
        recentlyClosed: state.recentlyClosed.slice(1),
        omnibox: resetCommandInput(state.omnibox, tabUrl(restored)),
        status: status(`Reopened ${tabLabel(restored)}.`, "success")
      };
      return result(next, {
        effects: [
          ...(restored.kind === "ready" ? [persistSnapshotEffect(controller, restored.snapshot)] : []),
          persistEffect(controller, next)
        ]
      });
    }
    case "selectDocument": {
      const selected = state.documents[message.index];
      if (!selected) return result(state);
      const next = {
        ...state,
        activeDocumentIndex: message.index,
        omnibox: resetCommandInput(state.omnibox, tabUrl(selected))
      };
      return result(next, { effects: [persistEffect(controller, next)] });
    }
    case "tabsTransition": {
      const selected = state.documents[state.activeDocumentIndex];
      if (!selected) return result(state);
      const tabState = tabsReducer(
        { activeId: selected.id, selectedId: selected.id },
        message.transition,
        { tabs: state.documents, activation: "automatic" }
      );
      const nextIndex = state.documents.findIndex((entry) => entry.id === tabState.selectedId);
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
        : runCommand(controller, state, parseCommand(message.value), context);
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
      const reducedInput = textInputReducer(state.findBar.input, message.transition);
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
      return result({ ...state, findBar: { input } });
    }
    case "findSubmit":
      return state.findBar === null
        ? result(state)
        : result(state);
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
      const next = textInputReducer(editor, message.transition);
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
      const next = numberInputReducer(editor, message.transition);
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
      const next = textAreaReducer(editor, message.transition);
      return result(updateFormControl(
        state,
        document,
        control,
        [textDocumentText(next.state.document)],
        { kind: "textarea", state: next.state }
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
        : createCollectionInteractionIndex(
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
      const next = checkboxGroupReducer(interaction, message.transition, options);
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
        return result(updateDocument(state, document.id, (current) => {
          const focused = documentWithFocus(current, control.node);
          return {
            ...focused,
            documentState: [...groupNodes].reduce(
              (next, node) => applyDocumentAction(
                focused.snapshot.document,
                next,
                { kind: "set-checked", target: node, checked: node === control.node && message.values.length > 0 }
              ),
              focused.documentState
            )
          };
        }));
      }
      return result(updateFormControl(state, document, control, message.values));
    }
    case "activateButton": {
      const control = controlById(document, message.controlId);
      if (control?.kind !== "button" || control.disabled) return result(state);
      return result({
        ...updateDocumentFocus(state, document, control.node),
        status: status("This button has no native HTML action.")
      });
    }
    case "resetForm": {
      const form = controller.form(document, message.formId);
      if (!form) return result(state);
      const nodes = new Set(form.controls.map((control) => control.node));
      const resetter = message.resetterId === undefined
        ? null
        : document.snapshot.document.control(message.resetterId as DocumentNodeRef);
      const focusedState = resetter?.kind === "reset"
        ? updateDocumentFocus(state, document, resetter.node)
        : state;
      return result(updateDocument(focusedState, document.id, (current) => ({
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
      const focusedState = submitter === undefined
        ? state
        : updateDocumentFocus(state, document, submitter.node);
      const focusedDocument = activeDocument(focusedState);
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
          ...updateDocumentFocus(focusedState, focusedDocument, missing.node),
          status: status(`${missing.label} is required.`, "error")
        }, { focus });
      }
      return beginNavigation(focusedState, focusedDocument, submitter?.formAction ?? form.action, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          controller,
          focusedDocument,
          await controller.submitForm(
            focusedDocument,
            form,
            focusedDocument.documentState,
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
      if (!current || current.kind !== "ready") return result(state);
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

/** Reduces browser state synchronously, then schedules only dependency-relevant worker work. */
export function updateBrowser(
  controller: BrowserController,
  state: BrowserTuiState,
  message: BrowserTuiMessage,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 100, rows: 24 } },
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const reduced = reduceBrowser(controller, state, message, context);
  if (reduced.exit !== undefined || reduced.state.documents.length === 0) return reduced;
  const restoration = scheduleTabRestorations(controller, reduced.state);
  let nextState = restoration.state;
  const selected = activeTab(nextState);
  const restorationEffects = [...restoration.effects];
  if (selected.kind !== "ready") {
    const effects = [...(reduced.effects ?? []), ...restorationEffects];
    return {
      ...reduced,
      state: nextState,
      ...(effects.length === 0 ? {} : { effects: Object.freeze(effects) }),
    };
  }
  let active = activeDocument(nextState);
  const addedEffects = [...(reduced.effects ?? []), ...restorationEffects];
  if (active.rendering.status === "failed") {
    return {
      ...reduced,
      state: nextState,
      ...(addedEffects.length === 0 ? {} : { effects: Object.freeze(addedEffects) }),
    };
  }
  const query = nextState.findBar?.input.text.slice(0, MAX_PAGE_SEARCH_QUERY_CODE_UNITS) ?? null;
  if (query !== null && query !== active.search?.query
    && query !== active.rendering.pendingSearchQuery
    && message.kind !== "viewportFailed") {
    const parameters = viewportParameters(nextState, active, context.terminalSize);
    addedEffects.push(searchEffect(controller, active, query, parameters));
    nextState = updateDocument(nextState, active.id, (document) => ({
      ...document,
      rendering: { ...document.rendering, pendingSearchQuery: query }
    }));
    active = activeDocument(nextState);
  }
  const parameters = viewportParameters(nextState, active, context.terminalSize);
  const key = viewportRequestKey(active, parameters);
  if (active.rendering.requestKey !== key && message.kind !== "viewportFailed") {
    const viewportRevision = active.rendering.requestedViewportRevision + 1;
    const requested = {
      ...active,
      rendering: {
        ...active.rendering,
        status: "rendering" as const,
        requestedViewportRevision: viewportRevision,
        requestKey: key,
        error: null
      }
    };
    nextState = updateDocument(nextState, active.id, () => requested);
    addedEffects.push(viewportEffect(controller, requested, viewportRevision, parameters));
  }
  return {
    ...reduced,
    state: nextState,
    ...(addedEffects.length === 0 ? {} : { effects: Object.freeze(addedEffects) })
  };
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
  controller: BrowserController,
  instrumentation?: RenderInstrumentation,
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
    init: (context) => {
      const initialized = updateBrowser(controller, initialState, { kind: "requestActiveViewport" }, context);
      return {
        state: initialized.state,
        ...(initialized.effects === undefined ? {} : { effects: initialized.effects }),
      };
    },
    update: (state, message, context) => updateBrowser(controller, state, message, context),
    view: (state, context) => measured(
      instrumentation,
      "terminal-ui-element-tree-construction",
      () => browserView(state, context),
    ),
    resizeMessage: () => ({ kind: "terminalResized" }),
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
          return state.overlay === null && current?.kind === "ready"
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
          return state.overlay === null && current?.kind === "ready"
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
  documents: readonly BrowserTabState[],
  activeDocumentIndex: number,
  controller: BrowserController,
  sidePanel: BrowserTuiState["sidePanel"] = null
): BrowserTuiState {
  const activeIndex = Math.max(0, Math.min(documents.length - 1, activeDocumentIndex));
  const active = documents[activeIndex];
  if (!active) throw new Error("The browser requires at least one document.");
  const activeUrl = tabUrl(active);
  return {
    documents,
    activeDocumentIndex: activeIndex,
    recentlyClosed: [],
    omnibox: createCommandInputState({
      value: activeUrl,
      cursor: activeUrl.length,
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
    status: active.kind === "ready"
      ? status(`Opened ${activeUrl}`, "success")
      : status(`Restoring ${activeUrl}`)
  };
}
