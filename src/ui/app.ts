import { scrollDocument } from "./document-scroll.js";
import { assertPageInitiatedNavigation } from "../app/security.js";
import { currentEntry, traverseHistory, isSameDocumentNavigation, fragmentSnapshot, type NavigationProvenance } from "../app/navigation-history.js";
import { acceptNavigation, activateHistory, resumeDocument } from "./navigation-state.js";
import type { AcquiredNavigation } from "./browser-controller.js";
import { controlValues, controlSelections, controlOptions, textEditor, numberEditor, areaEditor, selectEditor, multiSelectEditor } from "./form-editors.js";
import {
  applyScrollRequest,
  checkboxGroupReducer,
  commitCombobox,
  comboboxReducer,
  commandInputReducer,
  contextMenuReducer,
  createCommandInputState,
  createScrollState,
  createSearchPickerState,
  menuTriggerReducer,
  createCommandSuggestions,
  createSearchPickerIndex,
  prepareSearchPickerQuery,
  type SearchPickerIndex,
  searchPickerQueryPosition,
  numberInputReducer,
  searchPickerReducer,
  searchPickerEntryById,
  tabsReducer,
  textAreaReducer,
  textInputReducer
} from "@ismail-elkorchi/terminal-ui/behavior";
import type { CollectionQuery } from "@ismail-elkorchi/terminal-ui/text";
import { textDocumentText } from "@ismail-elkorchi/terminal-ui/text";
import {
  defineTui,
  createTuiPreparedQuery,
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
  type DocumentButtonControl,
  type DocumentForm,
  type DocumentFormControl,
  type DocumentNodeRef
} from "../document/index.js";
import type { BrowserController } from "./browser-controller.js";
import {
  actionById,
  browserRenderPreferences,
  browserPageSize,
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
  PickerValue,
  StatusMessage
} from "./model.js";
import { browserMenuItems, formComboboxPageSize, linkMenuItems } from "./model.js";
import { browserView } from "./view.js";
import type { ViewportRequestParameters } from "./render-worker/index.js";

const pickerQuery = createTuiPreparedQuery({
  id: "browser-picker-query",
  prepare: (input: { readonly index: SearchPickerIndex<PickerValue>; readonly query: CollectionQuery }, context) =>
    prepareSearchPickerQuery(input.index, input.query, {
      signal: context.signal,
      yield: async () => { await context.clock.sleep(0, context.signal); }
    }),
  toMessage: (message): BrowserTuiMessage => ({ kind: "pickerQuery", message })
});

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

function actionCommandSuggestions(input: string) {
  const query = input.trim().toLowerCase();
  return replacementCommandSuggestions(input, ACTION_SUGGESTIONS.filter((suggestion) =>
    suggestion.value.toLowerCase().includes(query)));
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
          search: updated.search === null ? null : { ...updated.search, anchors: new Map(), layoutRevision: null },
          rendering: { ...updated.rendering, requestKey: null, pendingSearch: null,
            searchRequestGeneration: updated.rendering.searchRequestGeneration + 1 },
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
    readonly cancel?: TuiUpdateResult<BrowserTuiState, BrowserTuiMessage>["cancel"];
    readonly effects?: readonly TuiEffect<BrowserTuiMessage>[];
    readonly focus?: TuiUpdateResult<BrowserTuiState, BrowserTuiMessage>["focus"];
  } = {}
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  return {
    state,
    ...(options.cancel === undefined ? {} : { cancel: options.cancel }),
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    ...(options.focus === undefined ? {} : { focus: options.focus })
  };
}

function effect(
  id: string,
  run: (context: TuiEffectContext) => Promise<BrowserTuiMessage>,
  concurrency: TuiEffect<BrowserTuiMessage>["concurrency"] = "enqueue",
  navigation?: BrowserDocumentState
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
            ...(navigation === undefined ? { kind: "operationFailed" as const } : {
              kind: "navigationFailed" as const, documentId: navigation.id,
              documentRevision: navigation.documentRevision, navigationGeneration: navigation.navigationGeneration + 1,
            }),
            message: error instanceof Error ? error.message : String(error),
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

function viewportParameters(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  terminalSize: Pick<TuiContext, "terminalSize">["terminalSize"],
): ViewportRequestParameters {
  const { columns, rows } = browserPageSize(state, terminalSize);
  return Object.freeze({
    columns,
    rows,
    scrollRow: documentScrollRow(document),
    scrollColumn: document.scrollColumn ?? 0,
    scrollOffsets: document.scrollOffsets,
    ...(document.rendering.pendingReveal === null ? {} : { reveal: document.rendering.pendingReveal }),
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
    parameters.scrollColumn,
    parameters.overscanBefore,
    parameters.overscanAfter,
    JSON.stringify(parameters.preferences),
    parameters.searchQuery ?? "",
    JSON.stringify(parameters.scrollOffsets),
    JSON.stringify(parameters.reveal ?? null),
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
  }, "replace");
}

function searchEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  query: string,
  parameters: ViewportRequestParameters,
): TuiEffect<BrowserTuiMessage> {
  return effect(`search:${document.id}`, async (context) => {
    const cancel = (): void => { controller.cancelSearch(document.id); };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await controller.searchDocument(document, query, parameters, document.rendering.searchRequestGeneration);
      return {
        kind: "searchReady", documentId: document.id,
        documentRevision: result.documentRevision, stateRevision: result.stateRevision,
        requestGeneration: result.requestGeneration, layoutRevision: result.layoutRevision,
        anchors: result.anchors, query: result.query,
        matches: result.matches.slice(0, MAX_PAGE_SEARCH_MATCHES),
        truncated: result.truncated || result.matches.length > MAX_PAGE_SEARCH_MATCHES,
      };
    } catch (error) {
      context.signal.throwIfAborted();
      return { kind: "searchFailed", documentId: document.id, documentRevision: document.documentRevision,
        stateRevision: document.stateRevision, requestGeneration: document.rendering.searchRequestGeneration,
        message: error instanceof Error ? error.message : String(error) };
    } finally { context.signal.removeEventListener("abort", cancel); }
  }, "replace");
}

function scheduleTabRestorations(
  controller: BrowserController,
  state: BrowserTuiState,
  previous: BrowserTabState,
  initialize: boolean,
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
  if (active !== undefined && (initialize || active.id !== previous.id || active.kind !== previous.kind
    || (active.kind === "ready" && previous.kind === "ready" && active.rendering.status !== previous.rendering.status))) effects.push({ id: "restoration-priority", concurrency: "replace", run() {
    controller.configureRestoration(active); return Promise.resolve({ kind: "none" });
  } });
  begin(state.activeDocumentIndex);
  for (let index = 0; index < documents.length; index += 1) begin(index);
  return effects.length === 0
    ? { state, effects }
    : { state: { ...state, documents }, effects: Object.freeze(effects) };
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

function pageText(document: BrowserDocumentState): string {
  return document.snapshot.document.text(document.snapshot.document.root);
}

function navigationMessage(
  document: BrowserDocumentState,
  acquired: AcquiredNavigation,
  label: string
): BrowserTuiMessage {
  return {
    kind: "pageLoaded",
    navigationGeneration: document.navigationGeneration + 1,
    documentRevision: document.documentRevision,
    documentId: document.id,
    ...acquired,
    sourceEntryId: currentEntry(document.navigation)?.id ?? "",
    status: label
  };
}

function navigationEffect(
  controller: BrowserController,
  document: BrowserDocumentState
): TuiEffect<BrowserTuiMessage> {
  return effect(`navigation:${document.id}`, async (context) => navigationMessage(
    document,
    await controller.reload(document, context.signal),
    "Reloaded"
  ), "replace", document);
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
    document,
    await controller.navigate(
      document,
      target,
      { ...(options.requestOptions ?? {}), signal: context.signal },
      options.parseMode
    ),
    `Opened ${target}`
  ), "replace", document);
}

function beginNavigation(
  controller: BrowserController,
  state: BrowserTuiState,
  document: BrowserDocumentState,
  target: string,
  navigation: TuiEffect<BrowserTuiMessage>,
  provenance: NavigationProvenance | null = { kind: "direct" },
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  if (provenance !== null && target.includes(":")) {
    try {
      if (provenance.kind === "page-initiated") assertPageInitiatedNavigation(provenance.sourceUrl, target);
      if (isSameDocumentNavigation(document.snapshot.finalUrl, target)) {
        const entry = currentEntry(document.navigation);
        if (entry === undefined) throw new Error("Active navigation entry is missing.");
        const loaded = acceptNavigation(document, fragmentSnapshot(document.snapshot, target), "push", provenance, entry.documentId);
        const next = { ...updateDocument(state, document.id, () => ({ ...loaded, navigationGeneration: document.navigationGeneration + 1 })),
          overlay: null, omnibox: resetCommandInput(state.omnibox, target), omniboxDirty: false, status: status(`Opened ${target}`, "success") };
        return result(next, { cancel: [{ kind: "effect", id: `navigation:${document.id}` }], effects: [persistEffect(controller, next)] });
      }
    } catch (error) { return result({ ...state, status: status(error instanceof Error ? error.message : String(error), "error") }); }
  }
  const next = updateDocument(
    { ...state, overlay: null, status: status(`Loading ${target}…`) },
    document.id,
    (current) => ({ ...current, navigationGeneration: current.navigationGeneration + 1, loading: true, pendingUrl: target, error: null })
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
      state: createSearchPickerState({ query: { text: "", mode: "fuzzy" }, queryResult: null }, index)
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
  return { ...updated, rendering: { ...updated.rendering,
    pendingReveal: { query: search.query, match: match.id, align: "nearest" }, pendingFocus: null } };
}

function controlById(
  document: BrowserDocumentState,
  controlId: string
): DocumentFormControl | undefined {
  return document.snapshot.document.control(controlId as DocumentNodeRef) ?? undefined;
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
  sourceDocument: BrowserDocumentState
): TuiEffect<BrowserTuiMessage> {
  return effect("new-document", async (context) => ({
    kind: "documentOpened",
    document: await controller.openNewFromDocument(sourceDocument, target, context.signal),
    background,
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
    case "history-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "history" }, context);
    case "download-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "downloads" }, context);
    case "bookmark-list":
      return updateBrowser(controller, state, { kind: "toggleSidePanel", panel: "bookmarks" }, context);
    case "back":
    case "forward":
    case "reload":
      return updateBrowser(controller, state, { kind: "navigate", operation: command.kind }, context);
    case "cookie-clear":
      return result({ ...state, overlay: null }, { effects: [effect("cookie-clear", async () => ({
        kind: "operationComplete",
        status: await controller.clearCookies()
      }))] });
    case "close-document":
      return updateBrowser(controller, state, { kind: "closeDocument" }, context);
    case "reopen-document":
      return updateBrowser(controller, state, { kind: "reopenDocument" }, context);
    default: break;
  }
  if (activeTab(state).kind !== "ready") return result(state);
  const document = activeDocument(state);
  switch (command.kind) {
    case "reader":
    case "diag":
      return updateBrowser(controller, state, {
        kind: "openDetail",
        detail: command.kind === "reader" ? "reader" : "diagnostics"
      }, context);
    case "links":
    case "outline":
      return result(openPicker(controller, state, command.kind));
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
        status: await controller.saveText(command.path, pageText(document))
      }))] });
    case "open-external":
      return updateBrowser(controller, state, { kind: "openExternal" }, context);
    case "go":
    case "go-stream": {
      const target = controller.resolveOmnibox(command.target, document.snapshot.finalUrl);
      return beginNavigation(controller,
        { ...state, overlay: null },
        document,
        target,
        loadEffect(controller, document, target, command.kind === "go-stream" ? { parseMode: "stream" } : {})
      );
    }
    case "cookie-list":
      return updateBrowser(controller, state, { kind: "openDetail", detail: "cookies" }, context);
  }
}

function reduceBrowser(
  controller: BrowserController,
  state: BrowserTuiState,
  message: BrowserTuiMessage,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 100, rows: 24 } }
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  if (message.kind === "pickerQuery") {
    const settled = pickerQuery.update(state.pickerQuery, message.message).state;
    if (settled === state.pickerQuery || state.overlay?.kind !== "picker") return result(state);
    return result({ ...state, pickerQuery: settled,
      overlay: { ...state.overlay, state: searchPickerReducer(state.overlay.state,
        { kind: "firstActive" },
        { searchPickerIndex: state.overlay.index, queryResult: settled.result }) },
      ...(settled.error === null ? {} : { status: status(settled.error.message, "error") })
    });
  }
  if (message.kind === "tabRestored") {
    const current = state.documents.find((entry) => entry.id === message.document.id);
    if (current === undefined || current.kind !== "loading"
      || current.restoreRevision !== message.restoreRevision) return result(state);
    const next = {
      ...state,
      documents: state.documents.map((entry) => entry.id === current.id ? message.document : entry),
      ...(state.activeDocumentIndex === state.documents.indexOf(current) && !state.omniboxDirty
        ? { omnibox: resetCommandInput(state.omnibox, message.document.snapshot.finalUrl) }
        : {}),
      status: status(`Opened ${message.document.snapshot.finalUrl}`, "success"),
    };
    return result(next, { effects: [persistSnapshotEffect(controller, message.document.snapshot), persistEffect(controller, next)] });
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
  if (message.kind === "scroll" && state.overlay?.kind === "detail") {
    return result({ ...state, overlay: { ...state.overlay, scrollRow: Math.max(0, state.overlay.scrollRow + message.rows) } });
  }
  const selectedTab = activeTab(state);
  const viewportRows = browserPageSize(state, context.terminalSize).rows;
  switch (message.kind) {
    case "terminalResized":
      return result({ ...state, documents: state.documents.map((tab) => {
        if (tab.kind !== "ready") return tab;
        // Capture focus before the retained view is cropped to the new terminal.
        // Its native slot can disappear until the matching layout is accepted;
        // a resulting focus-leave must not erase this pending reveal identity.
        const focusedNode = tab.documentState.focus ?? tab.rendering.pendingFocus?.node;
        const focused = tab.id === selectedTab.id && state.overlay === null
          ? tab.rendering.summary?.focusOrder.find((entry) => entry.node === focusedNode)
          : undefined;
        return {
          ...tab,
          ...(tab.search === null ? {} : { search: { ...tab.search, anchors: new Map(), layoutRevision: null } }),
          rendering: {
            ...tab.rendering,
            ...(tab.search === null ? {} : { pendingSearch: null, searchRequestGeneration: tab.rendering.searchRequestGeneration + 1 }),
            ...(focused === undefined ? {} : {
              pendingReveal: { node: focused.node, align: "nearest" as const },
              pendingFocus: { node: focused.node, actionId: focused.actionId, formControl: focused.actionKind === "form-control" },
            }),
          },
        };
      }) });
    case "viewportReady": {
      const payload = message.payload;
      const current = state.documents.find((entry) => entry.id === payload.documentId);
      if (current === undefined || current.kind !== "ready"
        || current.documentRevision !== payload.documentRevision
        || current.stateRevision !== payload.stateRevision
        || current.rendering.requestedViewportRevision !== payload.viewportRevision
        || payload.summary.identity !== payload.summaryIdentity) return result(state);
      const pendingFocus = current.rendering.pendingFocus;
      const focusVisible = current.id === selectedTab.id && pendingFocus !== null
        && payload.focusTargets.some((target) => target.node === pendingFocus.node);
      const updated = updateDocument(state, current.id, (entry) => {
        const committed = {
          ...entry, scrollColumn: payload.scrollColumn ?? 0, scrollOffsets: payload.scrollOffsets,
          rendering: { ...entry.rendering, status: "ready" as const, committedViewportRevision: payload.viewportRevision,
            viewport: payload, summary: payload.summary, pendingReveal: null, pendingFocus: null, error: null },
        };
        const restoreAnchor = entry.rendering.summary === null && entry.rendering.pendingReveal === null;
        const preserveAnchor = entry.rendering.pendingReveal === null && (restoreAnchor || payload.scrollRow === documentScrollRow(entry));
        const positioned = preserveAnchor ? committed : documentWithScrollRow(committed, payload.scrollRow, viewportRows);
        return { ...positioned, rendering: { ...positioned.rendering,
          requestKey: restoreAnchor ? entry.rendering.requestKey : viewportRequestKey(positioned, viewportParameters(state, positioned, context.terminalSize)) } };
      });
      const firstCommittedViewport = current.rendering.committedViewportRevision === 0;
      return result(updated, {
        ...(current.id === selectedTab.id && pendingFocus !== null && !focusVisible && !state.omniboxDirty ? {
          focus: { kind: "element", elementId: `browser-${current.id}` },
        } : {}),
        ...(focusVisible && !state.omniboxDirty ? {
          focus: pendingFocus.formControl
            ? { kind: "element", elementId: pendingFocus.node }
            : {
                kind: "elementTarget",
                elementId: `browser-${current.id}`,
                targetId: pendingFocus.actionId,
              },
        } : {}),
        effects: [{ id: `viewport-accepted:${current.id}`, concurrency: "enqueue", run() {
          controller.acknowledgeViewport(payload); return Promise.resolve({ kind: "none" });
        } }, ...(firstCommittedViewport ? [persistEffect(controller, updated)] : [])],
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
    case "searchFailed": {
      const current = state.documents.find((tab) => tab.id === message.documentId);
      if (current?.kind !== "ready" || current.documentRevision !== message.documentRevision
        || current.stateRevision !== message.stateRevision
        || current.rendering.pendingSearch?.requestGeneration !== message.requestGeneration) return result(state);
      return result({ ...updateDocument(state, current.id, (document) => ({
        ...document, rendering: { ...document.rendering, pendingSearch: null },
      })), status: status(message.message, "error") });
    }
    case "searchReady": {
      const current = state.documents.find((entry) => entry.id === message.documentId);
      if (current === undefined || current.kind !== "ready"
        || current.documentRevision !== message.documentRevision || current.stateRevision !== message.stateRevision
        || current.rendering.pendingSearch?.requestGeneration !== message.requestGeneration
        || current.rendering.pendingSearch.query !== message.query
        || current.rendering.viewport?.layoutRevision !== message.layoutRevision) return result(state);
      const previousId = current.search?.query === message.query
        ? current.search.matches[current.search.activeMatchIndex]?.id : undefined;
      const previousIndex = previousId === undefined ? current.search?.activeMatchIndex ?? 0 : message.matches.findIndex((match) => match.id === previousId);
      const activeMatchIndex = Math.max(0, Math.min(message.matches.length - 1, previousIndex));
      const search: BrowserDocumentSearch = {
        documentRevision: message.documentRevision, stateRevision: message.stateRevision,
        requestGeneration: message.requestGeneration, layoutRevision: message.layoutRevision,
        anchors: new Map(message.anchors), query: message.query, matches: message.matches,
        activeMatchIndex, truncated: message.truncated,
      };
      const match = search.matches[activeMatchIndex];
      const withSearch = { ...current, search, rendering: { ...current.rendering, pendingSearch: null } };
      const updated = match === undefined ? withSearch : { ...withSearch, rendering: { ...withSearch.rendering,
        pendingReveal: { query: search.query, match: match.id, align: "nearest" as const }, pendingFocus: null } };
      return result({
        ...updateDocument(state, current.id, () => updated),
        ...(current.id !== selectedTab.id ? {} : { status: match === undefined
          ? status(`No matches for "${search.query}"`, "error")
          : status(`${String(activeMatchIndex + 1)}/${String(search.matches.length)}${search.truncated ? "+" : ""} matches`, "success") }),
      });
    }
    case "closeFind":
      return result({
        ...state, findBar: null,
        documents: state.documents.map((tab) => tab.kind !== "ready" ? tab : ({
          ...tab, search: null, rendering: { ...tab.rendering, pendingSearch: null,
            searchRequestGeneration: tab.rendering.searchRequestGeneration + 1 },
        })),
      }, { cancel: state.documents.map((tab) => ({ kind: "effect" as const, id: `search:${tab.id}` })) });
    case "actionPaletteSubmit":
      return state.overlay?.kind !== "actionPalette"
        ? result(state)
        : runCommand(controller, state, parseCommand(message.value), context);
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "dismiss":
      return result({ ...state, overlay: null });
    case "navigate": {
      if (selectedTab.kind !== "ready") {
        if (message.operation === "stop") return result({
          ...state, documents: state.documents.map((tab) => tab.id === selectedTab.id
            ? { ...selectedTab, kind: "failed" as const, error: "Loading stopped.", restoreRevision: selectedTab.restoreRevision + 1 } : tab),
        }, { cancel: [{ kind: 'effect', id: `restore:${selectedTab.id}` }] });
        return message.operation === "reload"
          ? reduceBrowser(controller, state, { kind: "restoreTab", documentId: selectedTab.id }, context)
          : result(state);
      }
      const document = selectedTab;
      if (message.operation === "stop") {
        return result(updateDocument(state, document.id, (current) =>
          ({ ...current, loading: false, pendingUrl: null, navigationGeneration: current.navigationGeneration + 1 })
        ), { cancel: [{ kind: 'effect', id: `navigation:${document.id}` }] });
      }
      if (message.operation === "back" && !document.canGoBack) return result(state);
      if (message.operation === "forward" && !document.canGoForward) return result(state);
      if (message.operation === "back" || message.operation === "forward") {
        const loaded = activateHistory(document, traverseHistory(document.navigation, message.operation));
        const next = { ...updateDocument(state, document.id, () => ({ ...loaded, navigationGeneration: document.navigationGeneration + 1 })),
          overlay: null, findBar: loaded.search === null ? null : { input: { text: loaded.search.query, cursor: loaded.search.query.length } }, omnibox: resetCommandInput(state.omnibox, loaded.snapshot.finalUrl), omniboxDirty: false };
        return result(next, { cancel: [{ kind: "effect", id: `navigation:${document.id}` }], effects: [persistEffect(controller, next)] });
      }
      return beginNavigation(controller,
        state,
        document,
        message.operation,
        navigationEffect(controller, document)
      );
    }
    case "omniboxTransition": {
      let omnibox = commandInputReducer(state.omnibox, message.transition);
      const value = omnibox.editor.input.text;
      omnibox = commandInputReducer(omnibox, {
        kind: "setSuggestions",
        suggestions: message.transition.kind === "acceptSuggestion"
          ? EMPTY_COMMAND_SUGGESTIONS
          : replacementCommandSuggestions(
              value,
              controller.omniboxSuggestions(value, selectedTab)
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
        ...updateDocument(state, selectedTab.id, (document) => ({ ...document, rendering: { ...document.rendering, pendingFocus: null } })),
        omnibox: resetCommandInput(
          state.omnibox,
          tabUrl(selectedTab),
          replacementCommandSuggestions(
            tabUrl(selectedTab),
            controller.omniboxSuggestions("", selectedTab)
          )
        ),
        omniboxDirty: false
      }, { focus: { kind: "element", elementId: "browser-omnibox" } });
    case "cancelOmnibox":
      return result({
        ...state,
        omnibox: resetCommandInput(state.omnibox, tabUrl(selectedTab)),
        omniboxDirty: false
      });
    case "omniboxSubmit": {
      const target = controller.resolveOmnibox(message.value, tabUrl(selectedTab));
      if (selectedTab.kind !== "ready") {
        return result({
          ...state,
          documents: state.documents.map((tab) => tab.id === selectedTab.id ? {
            ...selectedTab, kind: "restoring" as const, requestedUrl: target, label: target,
            restoreRevision: selectedTab.restoreRevision + 1, error: null,
          } : tab),
          omnibox: submittedCommandInput(state.omnibox, message.value, target), omniboxDirty: false,
        }, { cancel: [{ kind: 'effect', id: `restore:${selectedTab.id}` }] });
      }
      const document = selectedTab;
      return beginNavigation(controller, {
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
            suggestions: actionCommandSuggestions("")
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
    case "openDetail":
      if (message.detail !== "help" && selectedTab.kind !== "ready") return result(state);
      return result({
        ...state,
        overlay: {
          kind: "detail",
          detailKind: message.detail,
          title: `${message.detail.charAt(0).toUpperCase()}${message.detail.slice(1)}`,
          lines: message.detail === "help" ? formatHelpText().split("\n") : controller.detail(message.detail, selectedTab as BrowserDocumentState),
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
    case "newDocument": {
      const tab = controller.placeholder(message.target ?? "about:newtab");
      const next = {
        ...state, documents: [...state.documents, tab],
        activeDocumentIndex: message.background === true ? state.activeDocumentIndex : state.documents.length,
        ...(message.background === true ? {} : { overlay: null, omnibox: resetCommandInput(state.omnibox, tab.requestedUrl), omniboxDirty: false }),
      };
      return result(next, { effects: [persistEffect(controller, next)],
        ...(message.background === true ? {} : { focus: { kind: "element", elementId: tab.requestedUrl === "about:newtab" ? "browser-omnibox" : `browser-${tab.id}` } }),
      });
    }
    case "closeDocument": {
      const closedTab = selectedTab.kind === "ready" ? resumeDocument(selectedTab) : selectedTab;
      const remaining = state.documents.filter((tab) => tab.id !== selectedTab.id);
      const documents = remaining.length === 0 ? [controller.placeholder("about:newtab")] : remaining;
      const activeDocumentIndex = Math.min(state.activeDocumentIndex, documents.length - 1);
      const selected = documents[activeDocumentIndex];
      const next = {
        ...state, documents, activeDocumentIndex,
        recentlyClosed: [closedTab, ...state.recentlyClosed].slice(0, 10),
        overlay: null, omniboxDirty: false, omnibox: resetCommandInput(state.omnibox, selected === undefined ? "" : tabUrl(selected)),
        status: status(`Closed ${tabLabel(selectedTab)}.`, "success"),
      };
      return result(next, {
        cancel: [{ kind: 'effect', id: `restore:${selectedTab.id}` }, { kind: 'effect', id: `navigation:${selectedTab.id}` }, { kind: 'effect', id: `render:${selectedTab.id}` }, { kind: 'effect', id: `search:${selectedTab.id}` }],
        effects: [persistEffect(controller, next)],
      });
    }
    case "reopenDocument": {
      const closed = state.recentlyClosed[0];
      if (!closed) return result({ ...state, status: status("No recently closed tab.", "error") });
      const restored = closed.kind === "ready"
        ? resumeDocument(closed)
        : { ...closed, kind: "restoring" as const, restoreRevision: closed.restoreRevision + 1 };
      const next = {
        ...state,
        documents: [...state.documents, restored],
        activeDocumentIndex: state.documents.length,
        recentlyClosed: state.recentlyClosed.slice(1),
        omnibox: resetCommandInput(state.omnibox, tabUrl(restored)), omniboxDirty: false,
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
        omnibox: resetCommandInput(state.omnibox, tabUrl(selected)), omniboxDirty: false
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
      if (message.transition.kind !== "acceptSuggestion"
        && palette.editor.input.text !== state.overlay.state.editor.input.text) {
        palette = commandInputReducer(palette, {
          kind: "setSuggestions",
          suggestions: actionCommandSuggestions(palette.editor.input.text)
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
    case "pageLoaded": {
      const loadedIndex = state.documents.findIndex((entry) => entry.id === message.documentId);
      const current = state.documents[loadedIndex];
      if (!current || current.kind !== "ready" || current.documentRevision !== message.documentRevision
        || current.navigationGeneration !== message.navigationGeneration
        || currentEntry(current.navigation)?.id !== message.sourceEntryId) return result(state);
      let loaded: BrowserDocumentState;
      try { loaded = acceptNavigation(current, message.snapshot, message.mode, message.provenance, message.sharedDocumentId); }
      catch (error) { return result(updateDocument({ ...state, status: status(error instanceof Error ? error.message : String(error), "error") }, current.id,
        (entry) => ({ ...entry, loading: false, pendingUrl: null, error: error instanceof Error ? error.message : String(error) }))); }
      const next = {
        ...updateDocument(state, message.documentId, () => loaded),
        ...(loadedIndex === state.activeDocumentIndex && !state.omniboxDirty
          ? {
            findBar: loaded.search === null ? null : { input: { text: loaded.search.query, cursor: loaded.search.query.length } },
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
      const documents = [...state.documents, message.document];
      const nextIndex = message.background ? state.activeDocumentIndex : documents.length - 1;
      const next = {
        ...state,
        documents,
        activeDocumentIndex: nextIndex,
        recentlyClosed: state.recentlyClosed,
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
      }, { cancel: [{ kind: 'effect', id: `download:${message.id}` }] });
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
    case "navigationFailed":
    case "operationFailed": {
      if (message.kind === "navigationFailed") {
        const owner = state.documents.find((tab) => tab.id === message.documentId);
        if (owner?.kind !== "ready" || owner.documentRevision !== message.documentRevision
          || owner.navigationGeneration !== message.navigationGeneration) return result(state);
      }
      const failedState = message.kind === "operationFailed"
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
    default: break;
  }
  if (selectedTab.kind !== "ready") return result(state);
  const document = selectedTab;
  switch (message.kind) {
    case "requestActiveViewport":
      return document.rendering.status === "failed"
        ? result(updateDocument(state, document.id, (entry) => ({
            ...entry,
            rendering: { ...entry.rendering, status: "idle", requestKey: null, error: null },
          })))
        : result(state);
    case "focusDocumentNode":
      return result(updateDocumentFocus(state, document, message.target));
    case "scroll":
      return result(updateDocument(state, document.id, (current) =>
        scrollDocument(current, message.rows, message.columns ?? 0, viewportRows)
      ));
    case "scrollOwner":
      return result(updateDocument(state, document.id, (current) =>
        scrollDocument(current, message.rows, message.columns, viewportRows, message.node)
      ));
    case "scrollTo":
      return result(updateDocument(state, document.id, (current) =>
        current.rendering.viewport?.viewportOverflow.y === "hidden" || current.rendering.viewport?.viewportOverflow.y === "clip"
          ? current : documentWithScrollRow(current, message.row, viewportRows)
      ));
    case "scrollTop":
      return result(updateDocument(state, document.id, (current) => scrollDocument(current, -1_000_000_000, 0, viewportRows)));
    case "scrollBottom":
      return result(updateDocument(state, document.id, (current) =>
        scrollDocument(current, 1_000_000_000, 0, viewportRows)
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
      const visible = document.rendering.viewport?.focusTargets.some((entry) => entry.node === target.node) === true;
      const updated = documentWithFocus({ ...document, rendering: { ...document.rendering,
        pendingReveal: { node: target.node, align: "nearest" },
        pendingFocus: { node: target.node, actionId: target.actionId, formControl: target.actionKind === "form-control" },
      } }, target.node);
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
            focusedDocument
          )]
        });
      }
      return beginNavigation(controller, focusedState, focusedDocument, action.destination, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          focusedDocument,
          await controller.openLink(focusedDocument, action.index, effectContext.signal),
          `Opened ${action.label}`
        ),
        "replace",
        focusedDocument
      ), { kind: "page-initiated", sourceUrl: focusedDocument.snapshot.finalUrl });
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
    case "openPicker":
      return result(openPicker(controller, state, message.picker, message.query));
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
              { searchPickerIndex: state.overlay.index, queryResult: state.pickerQuery.result }
            )
          }
        });
    case "pickerAccept": {
      if (state.overlay?.kind !== "picker" || state.pickerQuery.pending || state.pickerQuery.result === null
        || searchPickerQueryPosition(state.pickerQuery.result, message.event.id) === undefined) return result(state);
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
      return beginNavigation(controller, state, document, target, loadEffect(controller, document, target));
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
    case "formText": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType === "number") return result(state);
      const editor = textEditor(document, control);
      const next = textInputReducer(editor, message.transition);
      return result(updateFormControl(state, document, control, [next.text], { kind: "text", state: next }));
    }
    case "formNumber": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType !== "number") return result(state);
      const editor = numberEditor(document, control);
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
      const editor = areaEditor(document, control);
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
      const values = controlValues(document, control);
      const editor = selectEditor(document, control);
      const next = comboboxReducer(editor.state, message.transition, {
        index: editor.optionsView.interactionIndex,
        pageSize: formComboboxPageSize
      });
      return result(updateFormControl(
        state,
        document,
        control,
        values,
        { ...editor, state: next },
        controlSelections(document, control)
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
        index: current.optionsView.interactionIndex,
        pageSize: formComboboxPageSize
      });
      return result(updateFormControl(
        state,
        document,
        control,
        [option.value],
        { ...current, state: next },
        [option.node]
      ));
    }
    case "formCheckboxGroup": {
      const control = controlById(document, message.controlId);
      if (!control || control.kind !== "select" || !control.multiple) return result(state);
      const options = controlOptions(control);
      const interaction = multiSelectEditor(document, control);
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
      if (control === undefined || control.disabled) return result(state);
      if (control.kind === "radio") {
        const groupNodes = new Set(
          document.snapshot.document.radioGroup(control.node).map((entry) => entry.node)
        );
        const reveal = message.focusTarget !== undefined
          && !document.rendering.viewport?.controls.some((entry) => entry.node === control.node);
        return result(updateDocument(state, document.id, (current) => {
          const focused = documentWithFocus(current, control.node);
          return {
            ...focused,
            ...(reveal ? { rendering: { ...focused.rendering,
              pendingReveal: { node: control.node, align: "nearest" as const },
              pendingFocus: { node: control.node, actionId: `control:${control.node}`, formControl: true }
            } } : {}),
            documentState: [...groupNodes].reduce(
              (next, node) => applyDocumentAction(
                focused.snapshot.document,
                next,
                { kind: "set-checked", target: node, checked: node === control.node && message.values.length > 0 }
              ),
              focused.documentState
            )
          };
        }), message.focusTarget === undefined || reveal ? {} : { focus: { kind: "element", elementId: message.focusTarget } });
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
        const focus = { kind: "element" as const, elementId: missing.node };
        return result({
          ...updateDocumentFocus(focusedState, focusedDocument, missing.node),
          status: status(`${missing.label} is required.`, "error")
        }, { focus });
      }
      return beginNavigation(controller, focusedState, focusedDocument, submitter?.formAction ?? form.action, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
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
        focusedDocument
      ), null);
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
    case "retryDownload": {
      const entry = state.downloads.find((download) => download.id === message.id);
      return entry === undefined ? result(state) : updateBrowser(controller, state, { kind: "download", target: entry.url }, context);
    }
  }
}

/** Reduces browser state synchronously, then schedules only dependency-relevant worker work. */
function preparePickerUpdate(previous: BrowserTuiState, update: TuiUpdateResult<BrowserTuiState, BrowserTuiMessage>): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const next = update.state;
  // Recursive browser actions may already have prepared their final overlay.
  if (next.pickerQuery !== previous.pickerQuery) return update;
  if (next.overlay?.kind !== "picker") {
    if (previous.overlay?.kind !== "picker") return update;
    const cancelled = pickerQuery.cancel(next.pickerQuery);
    return { ...update, state: { ...next, pickerQuery: { ...cancelled.state, result: null } },
      cancel: [...(update.cancel ?? []), ...(cancelled.cancel ?? [])] };
  }
  const before = previous.overlay?.kind === "picker" ? previous.overlay : undefined;
  const editor = next.overlay.state;
  if (before?.index === next.overlay.index && before.state.editor.input.text === editor.editor.input.text
    && before.state.mode === editor.mode && before.state.caseSensitive === editor.caseSensitive) return update;
  const requested = pickerQuery.request({ ...next.pickerQuery, result: null }, {
    index: next.overlay.index, query: { text: editor.editor.input.text, mode: editor.mode, caseSensitive: editor.caseSensitive }
  });
  return { ...update, state: { ...next, pickerQuery: requested.state }, effects: [...(update.effects ?? []), ...(requested.effects ?? [])] };
}

export function updateBrowser(
  controller: BrowserController,
  state: BrowserTuiState,
  message: BrowserTuiMessage,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 100, rows: 24 } },
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  const reduced = preparePickerUpdate(state, reduceBrowser(controller, state, message, context));
  const previous = activeTab(state);
  const selectedId = reduced.exit === undefined ? activeTab(reduced.state).id : null;
  const lifecycleEffects: TuiEffect<BrowserTuiMessage>[] = [];
  if (selectedId !== previous.id || message.kind === "requestActiveViewport") lifecycleEffects.push({ id: "render-priority", concurrency: "replace", run() {
    controller.prioritizeRendering(selectedId); return Promise.resolve({ kind: "none" });
  } });
  if (reduced.exit !== undefined || reduced.state.documents.length === 0) return reduced;
  const restoration = scheduleTabRestorations(controller, reduced.state, previous, message.kind === "requestActiveViewport");
  let nextState = restoration.state;
  for (const tab of state.documents) {
    if (tab.kind !== "ready") continue;
    const next = nextState.documents.find((entry) => entry.id === tab.id);
    if (next === undefined) lifecycleEffects.push({ id: `release-render:${tab.id}`, concurrency: "enqueue", async run() {
      await controller.releaseRendering(tab.id); return { kind: "none" };
    } });
    if (next?.kind !== "ready" || (next.loading && !tab.loading)) lifecycleEffects.push({ id: `cancel-render:${tab.id}`, concurrency: "enqueue", run() { controller.cancelDocumentRendering(tab.id); return Promise.resolve({ kind: "none" }); } });
    if (next?.kind !== "ready" || next.rendering.searchRequestGeneration !== tab.rendering.searchRequestGeneration
      || (next.loading && !tab.loading) || (tab.id === previous.id && previous.id !== selectedId)) {
      lifecycleEffects.push({ id: `cancel-search:${tab.id}`, concurrency: "enqueue", run() { controller.cancelSearch(tab.id); return Promise.resolve({ kind: "none" }); } });
      nextState = updateDocument(nextState, tab.id, (document) => ({
        ...document, rendering: { ...document.rendering, pendingSearch: null,
          searchRequestGeneration: Math.max(document.rendering.searchRequestGeneration, tab.rendering.searchRequestGeneration + 1) },
      }));
    }
  }
  if (previous.id !== selectedId && previous.kind === "ready") {
    nextState = updateDocument(nextState, previous.id, (document) => document.rendering.status !== "rendering" ? document : ({
      ...document, rendering: { ...document.rendering, status: "idle", requestKey: null,
        requestedViewportRevision: document.rendering.requestedViewportRevision + 1 },
    }));
  }
  const selected = activeTab(nextState);
  const restorationEffects = [...restoration.effects];
  if (selected.kind !== "ready") {
    const effects = [...lifecycleEffects, ...(reduced.effects ?? []), ...restorationEffects];
    return {
      ...reduced,
      state: nextState,
      ...(effects.length === 0 ? {} : { effects: Object.freeze(effects) }),
    };
  }
  let active = activeDocument(nextState);
  const addedEffects = [...lifecycleEffects, ...(reduced.effects ?? []), ...restorationEffects];
  if (active.rendering.status === "failed") {
    return {
      ...reduced,
      state: nextState,
      ...(addedEffects.length === 0 ? {} : { effects: Object.freeze(addedEffects) }),
    };
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
  active = activeDocument(nextState);
  const query = nextState.findBar?.input.text.slice(0, MAX_PAGE_SEARCH_QUERY_CODE_UNITS) ?? null;
  const pending = active.rendering.pendingSearch;
  if (pending !== null && (pending.query !== query || pending.stateRevision !== active.stateRevision || active.loading)) {
    const activeId = active.id;
    addedEffects.push({ id: `cancel-search:${activeId}`, concurrency: "enqueue", run() { controller.cancelSearch(activeId); return Promise.resolve({ kind: "none" }); } });
    nextState = updateDocument(nextState, active.id, (document) => ({
      ...document, rendering: { ...document.rendering, pendingSearch: null,
        searchRequestGeneration: document.rendering.searchRequestGeneration + 1 },
    }));
    active = activeDocument(nextState);
  }
  if (query !== null && active.rendering.status === "ready" && !active.loading && message.kind !== "searchFailed"
    && active.rendering.pendingSearch === null
    && (query !== active.search?.query || active.search.stateRevision !== active.stateRevision
      || active.search.layoutRevision !== active.rendering.viewport?.layoutRevision)) {
    const requestGeneration = active.rendering.searchRequestGeneration + 1;
    nextState = updateDocument(nextState, active.id, (document) => ({
      ...document, rendering: { ...document.rendering, searchRequestGeneration: requestGeneration,
        pendingSearch: { query, requestGeneration, stateRevision: document.stateRevision } },
    }));
    active = activeDocument(nextState);
    addedEffects.push(searchEffect(controller, active, query, viewportParameters(nextState, active, context.terminalSize)));
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
      { id: "scroll-left", phase: "afterFocus", triggers: [{ kind: "key", key: "arrowLeft" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scroll", rows: 0, columns: -1 } },
      { id: "scroll-right", phase: "afterFocus", triggers: [{ kind: "key", key: "arrowRight" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scroll", rows: 0, columns: 1 } },
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
    pickerQuery: pickerQuery.init(),
    status: active.kind === "ready"
      ? status(`Opened ${activeUrl}`, "success")
      : status(`Restoring ${activeUrl}`)
  };
}
