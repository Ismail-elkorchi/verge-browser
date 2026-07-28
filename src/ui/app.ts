import {
  commandInputReducer,
  createNumberInputConfiguration,
  createScrollState,
  createTextAreaState,
  prepareSearchPickerIndex,
  numberInputReducer,
  searchPickerReducer,
  selectReducer,
  scrollReducer,
  textAreaReducer,
  textInputReducer
} from "@ismail-elkorchi/terminal-ui/behavior";
import { textDocumentText } from "@ismail-elkorchi/terminal-ui/text";
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
import type { FormControl, FormControlValue } from "../app/forms.js";
import type { DownloadRecord } from "../app/storage.js";
import type { PageRequestOptions, PageSnapshot } from "../app/types.js";
import type { BrowserController } from "./browser-controller.js";
import {
  actionById,
  documentLayout,
  documentScrollRow,
  documentWithScrollRow,
  scrollToBlock
} from "./document-layout.js";
import type {
  BrowserDocumentSearch,
  BrowserDocumentState,
  BrowserTuiMessage,
  BrowserTuiState,
  PickerKind,
  StatusMessage
} from "./model.js";
import { browserView } from "./view.js";

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
].map((value) => ({ value }));

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
      scrollAnchor: document.scrollAnchor,
      search: document.search
    }
  };
  const restored = savedViews[snapshot.finalUrl];
  return {
    ...document,
    snapshot,
    scrollAnchor: restored?.scrollAnchor
      ?? { blockId: snapshot.content.blocks[0]?.id ?? "page:empty", rowOffset: 0 },
    search: restored?.search ?? null,
    formValues: {},
    formEditors: {},
    savedViews,
    loading: false,
    pendingUrl: null,
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    error: null
  };
}

function pageText(document: BrowserDocumentState, columns: number): string {
  return documentLayout(document, columns).rows.map((row) => row.text).join("\n");
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
  return {
    ...state,
    overlay: {
      kind: "picker",
      pickerKind: picker,
      title: picker === "recall" ? `Search visited pages: ${query}` : `${picker[0]?.toUpperCase() ?? ""}${picker.slice(1)}`,
      index: prepareSearchPickerIndex(entries),
      state: { query: "", selectedIndex: 0 }
    }
  };
}

function searchDocument(
  document: BrowserDocumentState,
  query: string,
  columns: number
): BrowserDocumentSearch {
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery.length === 0) return { query, matches: [], activeMatchIndex: 0 };
  const layout = documentLayout(document, columns);
  const matches: BrowserDocumentSearch["matches"][number][] = [];
  for (const block of document.snapshot.content.blocks) {
    const haystack = block.text.toLocaleLowerCase();
    let start = 0;
    while (start <= haystack.length - normalizedQuery.length) {
      const found = haystack.indexOf(normalizedQuery, start);
      if (found < 0) break;
      const rowIndex = layout.rows.findIndex((row) =>
        row.blockId === block.id
        && found >= row.blockTextStartCodeUnitIndex
        && found < Math.max(
          row.blockTextEndCodeUnitIndexExclusive,
          row.blockTextStartCodeUnitIndex + 1
        )
      );
      matches.push({
        blockId: block.id,
        rowIndex: Math.max(0, rowIndex),
        startCodeUnitIndex: found,
        endCodeUnitIndexExclusive: found + query.length
      });
      start = found + Math.max(1, normalizedQuery.length);
    }
  }
  return { query, matches, activeMatchIndex: 0 };
}

function applySearch(state: BrowserTuiState, query: string, columns: number): BrowserTuiState {
  const document = activeDocument(state);
  const search = searchDocument(document, query, columns);
  const first = search.matches[0];
  const updated = first === undefined
    ? { ...document, search }
    : documentWithScrollRow({ ...document, search }, documentLayout(document, columns), first.rowIndex);
  return {
    ...updateDocument(state, document.id, () => updated),
    status: search.matches.length === 0
      ? status(`No matches for "${query}"`, "error")
      : status(`1/${String(search.matches.length)} matches`, "success")
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
      documentLayout(document, columns),
      match.rowIndex
    );
}

function controlById(
  controller: BrowserController,
  document: BrowserDocumentState,
  controlId: string
): FormControl | undefined {
  return controller.forms(document).flatMap((form) => form.controls)
    .find((control) => control.id === controlId);
}

function defaultControlValues(control: FormControl): readonly string[] {
  if (control.kind === "hidden" || control.kind === "text" || control.kind === "textarea") return [control.value];
  if ((control.kind === "checkbox" || control.kind === "radio") && control.checked) return [control.value];
  if (control.kind === "select") return control.options.filter((option) => option.selected).map((option) => option.value);
  return [];
}

function controlValues(document: BrowserDocumentState, control: FormControl): readonly string[] {
  return document.formValues[control.id] ?? defaultControlValues(control);
}

function updateFormControl(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  control: FormControl,
  values: readonly string[],
  editor?: BrowserDocumentState["formEditors"][string]
): BrowserTuiState {
  return updateDocument(state, document.id, (current) => ({
    ...current,
    formValues: { ...current.formValues, [control.id]: values },
    ...(editor === undefined
      ? {}
      : { formEditors: { ...current.formEditors, [control.id]: editor } })
  }));
}

function submissionValues(
  controller: BrowserController,
  document: BrowserDocumentState,
  formId: string
): readonly FormControlValue[] {
  const form = controller.form(document, formId);
  if (!form) return [];
  const submitted: FormControlValue[] = [];
  for (const control of form.controls) {
    const values = controlValues(document, control);
    if (values.length === 0) submitted.push({ controlId: control.id, value: null });
    else {
      for (const value of values) submitted.push({ controlId: control.id, value });
    }
  }
  return submitted;
}

function firstMissingRequiredControl(
  controller: BrowserController,
  document: BrowserDocumentState,
  formId: string
): Exclude<FormControl, { readonly kind: "hidden" }> | undefined {
  const form = controller.form(document, formId);
  if (!form) return undefined;
  for (const control of form.controls) {
    if (control.disabled || !("required" in control) || !control.required) continue;
    if (control.kind === "radio") {
      const group = control.name.length === 0
        ? [control]
        : form.controls.filter(
          (candidate): candidate is Extract<FormControl, { readonly kind: "radio" }> =>
            candidate.kind === "radio" && candidate.name === control.name
        );
      if (!group.some((candidate) => controlValues(document, candidate).length > 0)) return control;
      continue;
    }
    const values = controlValues(document, control);
    if ((control.kind === "text" || control.kind === "textarea" || control.kind === "select")
      && !values.some((value) => value.length > 0)) return control;
    if (control.kind === "checkbox" && values.length === 0) return control;
  }
  return undefined;
}

function openNewDocumentEffect(
  controller: BrowserController,
  target: string,
  background: boolean,
  replaceCurrent = false
): TuiEffect<BrowserTuiMessage> {
  return effect("new-document", async (context) => ({
    kind: "documentOpened",
    document: await controller.openNew(target, context.signal),
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
    case "patch-remove-node":
    case "patch-replace-text":
    case "patch-set-attr":
    case "patch-remove-attr":
    case "patch-insert-before":
    case "patch-insert-after": {
      const edit = command.kind === "patch-remove-node"
        ? { kind: "removeNode" as const, target: command.target }
        : command.kind === "patch-replace-text"
          ? { kind: "replaceText" as const, target: command.target, value: command.value }
          : command.kind === "patch-set-attr"
            ? { kind: "setAttr" as const, target: command.target, name: command.name, value: command.value }
            : command.kind === "patch-remove-attr"
              ? { kind: "removeAttr" as const, target: command.target, name: command.name }
              : command.kind === "patch-insert-before"
                ? { kind: "insertHtmlBefore" as const, target: command.target, html: command.html }
                : { kind: "insertHtmlAfter" as const, target: command.target, html: command.html };
      return beginNavigation(state, document, document.snapshot.finalUrl, effect(
        `navigation:${document.id}`,
        async () => navigationMessage(controller, document, await controller.applyEdits(document, [edit]), "Patched page"),
        "replace",
        document.id
      ));
    }
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
  const layout = documentLayout(document, columns);
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
    case "moveSearch": {
      if (!document.search) return result({ ...state, status: status("No active find query.", "error") });
      const updated = moveSearch(document, message.direction, columns);
      const search = updated.search;
      return result({
        ...updateDocument(state, document.id, () => updated),
        status: search === null || search.matches.length === 0
          ? status("No matches.", "error")
          : status(`${String(search.activeMatchIndex + 1)}/${String(search.matches.length)} matches`, "success")
      });
    }
    case "activateActionAt": {
      const action = actionById(document, message.actionId);
      if (!action) return result({ ...state, status: status("Focus a link or form first.", "error") });
      if (message.disposition === "context") {
        return result({ ...state, overlay: { kind: "linkMenu", actionId: action.id } });
      }
      if (action.kind === "form") {
        const firstControl = controller.form(document, action.id)?.controls.find(
          (control) => control.kind !== "hidden" && control.kind !== "unsupported"
        );
        return firstControl === undefined
          ? result({ ...state, status: status("This form has no interactive controls.", "error") })
          : result(state, { focus: { kind: "element", elementId: firstControl.id } });
      }
      const disposition = message.disposition ?? "current";
      if (disposition === "newForeground" || disposition === "newBackground") {
        return result(state, {
          effects: [openNewDocumentEffect(controller, action.resolvedHref, disposition === "newBackground")]
        });
      }
      return beginNavigation(state, document, action.resolvedHref, effect(
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
    case "navigate":
      if (message.operation === "stop") {
        return result(updateDocument(state, document.id, (current) => ({
          ...current,
          loading: false,
          pendingUrl: null
        })), { cancelEffects: [`navigation:${document.id}`] });
      }
      if (message.operation === "back" && !document.canGoBack) return result(state);
      if (message.operation === "forward" && !document.canGoForward) return result(state);
      return beginNavigation(
        state,
        document,
        message.operation,
        navigationEffect(controller, document, message.operation)
      );
    case "omniboxAction": {
      const omnibox = commandInputReducer(state.omnibox, message.action);
      return result({
        ...state,
        omnibox: {
          ...omnibox,
          suggestions: message.action.kind === "acceptSuggestion"
            ? []
            : controller.omniboxSuggestions(omnibox.input.text, document)
        },
        omniboxDirty: true
      });
    }
    case "focusOmnibox":
      return result({
        ...state,
        omnibox: {
          input: { text: document.snapshot.finalUrl, cursor: document.snapshot.finalUrl.length },
          history: state.omnibox.history,
          suggestions: controller.omniboxSuggestions("", document)
        },
        omniboxDirty: false
      }, { focus: { kind: "element", elementId: "browser-omnibox" } });
    case "cancelOmnibox":
      return result({
        ...state,
        omnibox: {
          input: { text: document.snapshot.finalUrl, cursor: document.snapshot.finalUrl.length },
          history: state.omnibox.history,
          suggestions: []
        },
        omniboxDirty: false
      });
    case "omniboxSubmit": {
      const target = controller.resolveOmnibox(message.value, document.snapshot.finalUrl);
      return beginNavigation({
        ...state,
        omnibox: {
          input: { text: target, cursor: target.length },
          history: [message.value, ...state.omnibox.history.filter((entry) => entry !== message.value)].slice(0, 50),
          suggestions: []
        },
        omniboxDirty: false
      }, document, target, loadEffect(controller, document, target));
    }
    case "openActionPalette":
      return result({
        ...state,
        overlay: {
          kind: "actionPalette",
          state: { input: { text: "", cursor: 0 }, history: [], suggestions: ACTION_SUGGESTIONS }
        }
      }, { focus: { kind: "element", elementId: "browser-action-input" } });
    case "openBrowserMenu":
      return result({ ...state, overlay: { kind: "browserMenu" } });
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
        sidePanelScroll: scrollReducer(message.event.scroll, message.event.action)
      });
    case "toggleBookmark":
      return result(state, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.toggleBookmark(document)
      }))] });
    case "openExternal":
      return result({ ...state, overlay: null }, { effects: [effect("open-external", async () => ({
        kind: "operationComplete",
        status: await controller.openExternal(message.target ?? document.snapshot.finalUrl)
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
          omnibox: {
            input: { text: selected?.snapshot.finalUrl ?? "", cursor: selected?.snapshot.finalUrl.length ?? 0 },
            history: state.omnibox.history,
            suggestions: []
          },
          status: status(`Closed ${document.snapshot.content.title}.`, "success")
        };
        return result(next, { effects: [persistEffect(controller, next)] });
      }
    case "reopenDocument": {
      const closed = state.recentlyClosed[0];
      if (!closed) return result({ ...state, status: status("No recently closed tab.", "error") });
      const next = {
        ...state,
        documents: [...state.documents, closed],
        activeDocumentIndex: state.documents.length,
        recentlyClosed: state.recentlyClosed.slice(1),
        omnibox: {
          input: { text: closed.snapshot.finalUrl, cursor: closed.snapshot.finalUrl.length },
          history: state.omnibox.history,
          suggestions: []
        },
        status: status(`Reopened ${closed.snapshot.content.title}.`, "success")
      };
      return result(next, { effects: [persistEffect(controller, next)] });
    }
    case "selectDocument": {
      const selected = state.documents[message.index];
      if (!selected) return result(state);
      const next = {
        ...state,
        activeDocumentIndex: message.index,
        omnibox: {
          input: { text: selected.snapshot.finalUrl, cursor: selected.snapshot.finalUrl.length },
          history: state.omnibox.history,
          suggestions: []
        }
      };
      return result(next, { effects: [persistEffect(controller, next)] });
    }
    case "tabs": {
      const action = message.action;
      if (action.kind === "select" || action.kind === "close") {
        const index = state.documents.findIndex((entry) => entry.id === action.id);
        if (index < 0) return result(state);
        return action.kind === "select"
          ? updateBrowser(controller, state, { kind: "selectDocument", index }, context)
          : updateBrowser(controller, { ...state, activeDocumentIndex: index }, { kind: "closeDocument" }, context);
      }
      const nextIndex = action.kind === "first"
        ? 0
        : action.kind === "last"
          ? state.documents.length - 1
          : (state.activeDocumentIndex + action.delta + state.documents.length) % state.documents.length;
      return updateBrowser(controller, state, { kind: "selectDocument", index: nextIndex }, context);
    }
    case "actionPaletteAction":
      if (state.overlay?.kind !== "actionPalette") return result(state);
      return result({
        ...state,
        overlay: { ...state.overlay, state: commandInputReducer(state.overlay.state, message.action) }
      });
    case "actionPaletteSubmit":
      return state.overlay?.kind !== "actionPalette"
        ? result(state)
        : runCommand(controller, state, parseCommand(message.value), columns);
    case "pickerAction":
      return state.overlay?.kind !== "picker"
        ? result(state)
        : result({
          ...state,
          overlay: {
            ...state.overlay,
            state: searchPickerReducer(state.overlay.state, message.action, { searchPickerIndex: state.overlay.index })
          }
        });
    case "pickerSelect": {
      const value = message.value;
      if (!value) return result({ ...state, status: status("No item is selected.", "error") });
      if (value.kind === "outline") {
        return result({ ...updateDocument(state, document.id, (current) => scrollToBlock(current, value.blockId)), overlay: null });
      }
      if (value.kind === "link") {
        const action = document.snapshot.content.links.find((entry) => entry.index === value.index);
        return action === undefined
          ? result(state)
          : updateBrowser(controller, state, { kind: "activateActionAt", actionId: action.id }, context);
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
      const input = textInputReducer(state.findBar.input, message.action);
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
      const control = controlById(controller, document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType === "number") return result(state);
      const current = document.formEditors[control.id];
      const editor = current?.kind === "text"
        ? current.state
        : { text: controlValues(document, control)[0] ?? "", cursor: (controlValues(document, control)[0] ?? "").length };
      const next = textInputReducer(editor, message.action);
      return result(updateFormControl(state, document, control, [next.text], { kind: "text", state: next }));
    }
    case "formNumber": {
      const control = controlById(controller, document, message.controlId);
      if (!control || control.kind !== "text" || control.inputType !== "number") return result(state);
      const value = controlValues(document, control)[0] ?? "";
      const current = document.formEditors[control.id];
      const editor = current?.kind === "number"
        ? current.state
        : {
          input: { text: value, cursor: value.length },
          configuration: createNumberInputConfiguration({
            ...(control.min === undefined ? {} : { min: control.min }),
            ...(control.max === undefined ? {} : { max: control.max }),
            ...(control.step === undefined ? {} : { step: control.step })
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
      const control = controlById(controller, document, message.controlId);
      if (!control || control.kind !== "textarea") return result(state);
      const current = document.formEditors[control.id];
      const editor = current?.kind === "textarea"
        ? current.state
        : createTextAreaState({
          value: controlValues(document, control)[0] ?? "",
          scroll: createScrollState({ contentRows: 1, viewportRows: 2 })
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
    case "formSelect": {
      const control = controlById(controller, document, message.controlId);
      if (!control || control.kind !== "select" || control.multiple) return result(state);
      const options = control.options.map((option, index) => ({
        id: `${control.id}:${String(index)}`,
        label: option.label,
        value: option.value,
        disabled: option.disabled
      }));
      const values = controlValues(document, control);
      const selectedIndex = control.options.findIndex((option) => values.includes(option.value));
      const current = document.formEditors[control.id];
      const editor = current?.kind === "select"
        ? current.state
        : {
          kind: "closed" as const,
          ...(selectedIndex < 0 ? {} : { selected: `${control.id}:${String(selectedIndex)}` })
        };
      const next = selectReducer(editor, message.action, options);
      const selected = next.selected === undefined
        ? undefined
        : control.options[Number(next.selected.slice(next.selected.lastIndexOf(":") + 1))];
      return result(updateFormControl(
        state,
        document,
        control,
        selected === undefined ? values : [selected.value],
        { kind: "select", state: next }
      ));
    }
    case "formValues": {
      const control = controlById(controller, document, message.controlId);
      if (control === undefined) return result(state);
      if (control.kind === "radio" && message.values.length > 0) {
        const containingForm = controller.forms(document).find(
          (entry) => entry.controls.some((candidate) => candidate.id === control.id)
        );
        const groupIds = new Set(
          (containingForm?.controls ?? [])
            .filter((entry) =>
              entry.kind === "radio"
              && (control.name.length === 0 ? entry.id === control.id : entry.name === control.name)
            )
            .map((entry) => entry.id)
        );
        return result(updateDocument(state, document.id, (current) => ({
          ...current,
          formValues: {
            ...Object.fromEntries(
              Object.entries(current.formValues).filter(([id]) => !groupIds.has(id))
            ),
            [control.id]: message.values
          }
        })));
      }
      return result(updateFormControl(state, document, control, message.values));
    }
    case "resetForm": {
      const form = controller.form(document, message.formId);
      if (!form) return result(state);
      const ids = new Set(form.controls.map((control) => control.id));
      return result(updateDocument(state, document.id, (current) => ({
        ...current,
        formValues: Object.fromEntries(Object.entries(current.formValues).filter(([id]) => !ids.has(id))),
        formEditors: Object.fromEntries(Object.entries(current.formEditors).filter(([id]) => !ids.has(id)))
      })));
    }
    case "submitForm": {
      const form = controller.form(document, message.formId);
      if (!form) return result({ ...state, status: status("The form no longer exists.", "error") });
      const missing = firstMissingRequiredControl(controller, document, form.id);
      if (missing !== undefined) {
        const focus = missing.kind === "radio"
          ? {
            kind: "elementTarget" as const,
            elementId: `${form.id}:radio:${missing.name.length === 0 ? missing.id : missing.name}`,
            targetId: missing.id
          }
          : { kind: "element" as const, elementId: missing.id };
        return result({
          ...state,
          status: status(`${missing.label} is required.`, "error")
        }, { focus });
      }
      return beginNavigation(state, document, form.actionUrl, effect(
        `navigation:${document.id}`,
        async (effectContext) => navigationMessage(
          controller,
          document,
          await controller.submitForm(
            document,
            form,
            submissionValues(controller, document, form.id),
            message.submitterId,
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
            omnibox: {
              input: { text: message.snapshot.finalUrl, cursor: message.snapshot.finalUrl.length },
              history: state.omnibox.history,
              suggestions: []
            },
            omniboxDirty: false
          }
          : {}),
        ...controller.library(),
        status: status(`${message.status}: ${message.snapshot.finalUrl}`, "success")
      };
      return result(next, { effects: [persistEffect(controller, next)] });
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
            omnibox: {
              input: { text: message.document.snapshot.finalUrl, cursor: message.document.snapshot.finalUrl.length },
              history: state.omnibox.history,
              suggestions: []
            }
          }),
        status: status(`Opened ${message.document.snapshot.finalUrl}`, "success")
      };
      return result(next, {
        effects: [persistEffect(controller, next)],
        ...(message.background
          ? {}
          : { focus: { kind: "element" as const, elementId: message.document.snapshot.finalUrl === "about:newtab" ? "browser-omnibox" : `browser-${message.document.id}` } })
      });
    }
    case "download": {
      const target = message.target ?? document.snapshot.finalUrl;
      if (target.startsWith("about:")) return result({ ...state, status: status("Local browser pages cannot be downloaded.", "error") });
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
              const download = await controller.download(target, id, effectContext.signal);
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
    init: () => initialState,
    update: (state, message, context) => updateBrowser(controller, state, message, context),
    view: browserView,
    inputBindings: [
      { id: "quit-control", phase: "beforeFocus", triggers: [{ kind: "key", key: "c", modifiers: { ctrl: true } }], message: { kind: "quit" } },
      { id: "new-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "t", modifiers: { ctrl: true } }], message: { kind: "newDocument" } },
      { id: "close-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "w", modifiers: { ctrl: true } }], message: { kind: "closeDocument" } },
      { id: "reopen-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "t", modifiers: { ctrl: true, shift: true } }], message: { kind: "reopenDocument" } },
      { id: "next-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "tab", modifiers: { ctrl: true } }], message: { kind: "tabs", action: { kind: "move", delta: 1 } } },
      { id: "previous-tab", phase: "beforeFocus", triggers: [{ kind: "key", key: "tab", modifiers: { ctrl: true, shift: true } }], message: { kind: "tabs", action: { kind: "move", delta: -1 } } },
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
      { id: "scroll-down", triggers: [{ kind: "key", key: "arrowDown" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: 1 } },
      { id: "scroll-up", triggers: [{ kind: "key", key: "arrowUp" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: -1 } },
      { id: "page-down", triggers: [{ kind: "key", key: "pageDown" }, { kind: "text", text: " " }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: 10 } },
      { id: "page-up", triggers: [{ kind: "key", key: "pageUp" }], enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail", message: { kind: "scroll", rows: -10 } },
      { id: "scroll-top", triggers: [{ kind: "key", key: "home" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scrollTop" } },
      { id: "scroll-bottom", triggers: [{ kind: "key", key: "end" }], enabled: ({ state }) => state.overlay === null, message: { kind: "scrollBottom" } },
      { id: "dismiss", triggers: [{ kind: "key", key: "escape" }], enabled: ({ state }) => state.overlay !== null, message: { kind: "dismiss" } },
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
    omnibox: {
      input: { text: active.snapshot.finalUrl, cursor: active.snapshot.finalUrl.length },
      history: [],
      suggestions: []
    },
    omniboxDirty: false,
    findBar: null,
    sidePanel,
    sidePanelScroll: createScrollState(),
    ...controller.library(),
    overlay: null,
    status: status(`Opened ${active.snapshot.finalUrl}`, "success")
  };
}
