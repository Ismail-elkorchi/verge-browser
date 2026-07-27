import {
  commandInputReducer,
  createScrollState,
  createTextAreaState,
  prepareSearchPickerIndex,
  searchPickerReducer,
  textAreaReducer,
  textInputReducer
} from "@ismail-elkorchi/terminal-ui/behavior";
import { textDocumentText } from "@ismail-elkorchi/terminal-ui/text";
import {
  defineTui,
  type TuiContext,
  type TuiEffect,
  type TuiEffectContext,
  type TuiUpdateResult
} from "@ismail-elkorchi/terminal-ui/tui";

import { formatHelpText, parseCommand, type BrowserCommand } from "../app/commands.js";
import { layoutPageContent } from "../app/render.js";
import type { PageRequestOptions, PageSnapshot } from "../app/types.js";
import type { BrowserController } from "./browser-controller.js";
import {
  actionById,
  blockSearch,
  documentLayout,
  documentScrollRow,
  documentWithScrollRow,
  scrollToAction,
  scrollToBlock
} from "./document-layout.js";
import type {
  BrowserDocumentState,
  BrowserTuiMessage,
  BrowserTuiState,
  FormFieldState,
  FormOverlay,
  PaletteMode,
  PickerKind,
  StatusMessage
} from "./model.js";
import { browserView } from "./view.js";

const ACTION_SUGGESTIONS = [
  "links",
  "documents",
  "diag",
  "history",
  "bookmark add",
  "bookmarks",
  "forms",
  "outline",
  "reader",
  "cookies",
  "save text ./view.txt",
  "download ./page.html",
  "open-external",
  "close",
  "reopen"
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
    readonly effects?: readonly TuiEffect<BrowserTuiMessage>[];
    readonly focus?: TuiUpdateResult<BrowserTuiState, BrowserTuiMessage>["focus"];
  } = {}
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  return {
    state,
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    ...(options.focus === undefined ? {} : { focus: options.focus })
  };
}

function effect(
  id: string,
  run: (context: TuiEffectContext) => Promise<BrowserTuiMessage>,
  concurrency: TuiEffect<BrowserTuiMessage>["concurrency"] = "enqueue"
): TuiEffect<BrowserTuiMessage> {
  return {
    id,
    concurrency,
    async run(context) {
      try {
        return { kind: "message", message: await run(context) };
      } catch (error) {
        context.signal.throwIfAborted();
        return {
          kind: "message",
          message: {
            kind: "operationFailed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
  };
}

function withLoading(state: BrowserTuiState, documentId: string, label: string): BrowserTuiState {
  return {
    ...updateDocument(state, documentId, (document) => ({ ...document, loading: true })),
    status: status(label)
  };
}

function navigationEffect(
  controller: BrowserController,
  document: BrowserDocumentState,
  operation: "back" | "forward" | "reload"
): TuiEffect<BrowserTuiMessage> {
  return effect(`navigation:${document.id}`, async (context) => ({
    kind: "pageLoaded",
    documentId: document.id,
    snapshot: await controller.traverse(document, operation, context.signal),
    status: operation === "back" ? "Back" : operation === "forward" ? "Forward" : "Reloaded"
  }), "replace");
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
  return effect(`navigation:${document.id}`, async (context) => ({
    kind: "pageLoaded",
    documentId: document.id,
    snapshot: await controller.navigate(
      document,
      target,
      { ...(options.requestOptions ?? {}), signal: context.signal },
      options.parseMode
    ),
    status: `Opened ${target}`
  }), "replace");
}

function pageFromSnapshot(
  document: BrowserDocumentState,
  snapshot: PageSnapshot
): BrowserDocumentState {
  const savedViews = {
    ...document.savedViews,
    [document.snapshot.finalUrl]: {
      scrollAnchor: document.scrollAnchor,
      focusedActionId: document.focusedActionId,
      search: document.search
    }
  };
  const restored = savedViews[snapshot.finalUrl];
  return {
    ...document,
    snapshot,
    scrollAnchor: restored?.scrollAnchor
      ?? { blockId: snapshot.content.blocks[0]?.id ?? "page:empty", rowOffset: 0 },
    focusedActionId: restored?.focusedActionId ?? null,
    search: restored?.search ?? null,
    savedViews,
    loading: false
  };
}

function pageText(document: BrowserDocumentState, columns: number): string {
  return layoutPageContent(document.snapshot.content, columns).rows.map((row) => row.text).join("\n");
}

function paletteSuggestions(
  mode: PaletteMode,
  value: string,
  document: BrowserDocumentState
) {
  const focused = actionById(document, document.focusedActionId);
  const candidates = mode === "action"
    ? ACTION_SUGGESTIONS
    : mode === "location"
      ? [
        { value: document.snapshot.finalUrl },
        ...(focused?.kind === "link" ? [{ value: focused.resolvedHref }] : [])
      ]
      : [];
  const query = value.trim().toLowerCase();
  return query.length === 0
    ? candidates
    : candidates.filter((candidate) => candidate.value.toLowerCase().includes(query));
}

function openPalette(state: BrowserTuiState, mode: PaletteMode): BrowserTuiState {
  const document = activeDocument(state);
  const initialValue = mode === "search" ? document.search?.query ?? "" : "";
  return {
    ...state,
    overlay: {
      kind: "palette",
      mode,
      state: {
        input: { text: initialValue, cursor: initialValue.length },
        history: [],
        suggestions: paletteSuggestions(mode, initialValue, document)
      }
    }
  };
}

function openPicker(
  controller: BrowserController,
  state: BrowserTuiState,
  picker: PickerKind,
  query = ""
): BrowserTuiState {
  const entries = controller.pickerEntries(picker, state.documents, state.activeDocumentIndex, query);
  const title = picker === "recall" ? `Recall: ${query}` : `${picker[0]?.toUpperCase() ?? ""}${picker.slice(1)}`;
  return {
    ...state,
    overlay: {
      kind: "picker",
      pickerKind: picker,
      title,
      index: prepareSearchPickerIndex(entries),
      state: { query: "", selectedIndex: 0 }
    }
  };
}

function formField(field: FormOverlay["form"]["fields"][number]): FormFieldState {
  if (field.type === "textarea") {
    const lines = Math.max(1, field.value.split("\n").length);
    return {
      name: field.name,
      label: field.name,
      multiline: true,
      input: {
        kind: "multiline",
        state: createTextAreaState({
          value: field.value,
          scroll: createScrollState({ contentRows: lines, viewportRows: Math.min(5, lines) })
        })
      }
    };
  }
  return {
    name: field.name,
    label: field.name,
    multiline: false,
    input: {
      kind: "singleLine",
      state: { text: field.value, cursor: field.value.length }
    }
  };
}

function formFieldValue(field: FormFieldState): string {
  return field.input.kind === "singleLine"
    ? field.input.state.text
    : textDocumentText(field.input.state.document);
}

function openForm(
  controller: BrowserController,
  state: BrowserTuiState,
  formIndex: number
): BrowserTuiState {
  const entry = controller.form(activeDocument(state), formIndex);
  if (!entry) return { ...state, status: status(`No form exists at index ${String(formIndex)}.`, "error") };
  return {
    ...state,
    overlay: {
      kind: "form",
      form: entry,
      fields: entry.fields.map(formField),
      focusedField: 0
    }
  };
}

function applySearch(state: BrowserTuiState, query: string): BrowserTuiState {
  const document = activeDocument(state);
  const search = blockSearch(document, query);
  const updated = scrollToBlock({ ...document, search, focusedActionId: null }, search.blockIds[0]);
  return {
    ...updateDocument(state, document.id, () => updated),
    overlay: null,
    status: search.blockIds.length === 0
      ? status(`No matches for "${query}"`, "error")
      : status(`find 1/${String(search.blockIds.length)} "${query}"`, "success")
  };
}

function moveSearch(document: BrowserDocumentState, direction: "next" | "prev"): BrowserDocumentState {
  const search = document.search;
  if (!search || search.blockIds.length === 0) return document;
  const delta = direction === "next" ? 1 : -1;
  const activeMatchIndex = (search.activeMatchIndex + delta + search.blockIds.length) % search.blockIds.length;
  return scrollToBlock(
    { ...document, search: { ...search, activeMatchIndex } },
    search.blockIds[activeMatchIndex]
  );
}

function beginNavigation(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  label: string,
  navigation: TuiEffect<BrowserTuiMessage>
): TuiUpdateResult<BrowserTuiState, BrowserTuiMessage> {
  return result(withLoading({ ...state, overlay: null }, document.id, label), {
    effects: [navigation]
  });
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
      overlay: state.overlay?.kind === "palette"
        ? { ...state.overlay, validation: command.reason }
        : state.overlay,
      status: status(command.reason, "error")
    });
  }
  switch (command.kind) {
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "help":
      return result({ ...state, overlay: { kind: "detail", detailKind: "help", title: "Help", lines: formatHelpText().split("\n"), scrollRow: 0 } });
    case "view":
      return result({ ...state, overlay: null });
    case "reader":
    case "diag":
      return result({
        ...state,
        overlay: {
          kind: "detail",
          detailKind: command.kind === "reader" ? "reader" : "diagnostics",
          title: command.kind === "reader" ? "Reader" : "Diagnostics",
          lines: controller.detail(command.kind === "reader" ? "reader" : "diagnostics", document),
          scrollRow: 0
        }
      });
    case "links":
    case "documents":
    case "outline":
      return result(openPicker(controller, state, command.kind));
    case "history-list":
      return result(openPicker(controller, state, "history"));
    case "bookmark-list":
      return result(openPicker(controller, state, "bookmarks"));
    case "form-list":
      return result(openPicker(controller, state, "forms"));
    case "recall":
      return result(openPicker(controller, state, "recall", command.query));
    case "page-down":
      return updateBrowser(controller, state, { kind: "scroll", rows: 10 }, {
        terminalSize: { columns, rows: 24 }
      });
    case "page-up":
      return updateBrowser(controller, state, { kind: "scroll", rows: -10 }, {
        terminalSize: { columns, rows: 24 }
      });
    case "page-top":
      return updateBrowser(controller, state, { kind: "scrollTop" }, {
        terminalSize: { columns, rows: 24 }
      });
    case "page-bottom":
      return updateBrowser(controller, state, { kind: "scrollBottom" }, {
        terminalSize: { columns, rows: 24 }
      });
    case "find":
      return result(applySearch(state, command.query));
    case "find-next":
    case "find-prev":
      return updateBrowser(controller, state, {
        kind: "moveSearch",
        direction: command.kind === "find-next" ? "next" : "prev"
      }, { terminalSize: { columns, rows: 24 } });
    case "back":
    case "forward":
    case "reload":
      return beginNavigation(state, document, `${command.kind}…`, navigationEffect(controller, document, command.kind));
    case "bookmark-add":
      return result({ ...state, overlay: null }, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.addBookmark(document)
      }))] });
    case "bookmark-open":
    case "history-open":
    case "recall-open":
    case "open-link": {
      const picker = command.kind === "bookmark-open"
        ? "bookmarks"
        : command.kind === "history-open"
          ? "history"
          : command.kind === "recall-open"
            ? "recall"
            : "links";
      const entry = controller.pickerEntries(
        picker,
        state.documents,
        state.activeDocumentIndex,
        command.kind === "recall-open" ? "" : undefined
      )[command.index - 1];
      if (!entry) return result({ ...state, status: status(`No ${picker} entry exists at index ${String(command.index)}.`, "error") });
      if (entry.value.kind === "link") {
        return beginNavigation(state, document, "Opening link…", effect(
          `navigation:${document.id}`,
          async (context) => ({
            kind: "pageLoaded",
            documentId: document.id,
            snapshot: await controller.openLink(document, entry.value.index, context.signal),
            status: `Opened link ${String(entry.value.index)}`
          }),
          "replace"
        ));
      }
      return beginNavigation(
        state,
        document,
        `Opening ${entry.value.target ?? ""}…`,
        loadEffect(controller, document, entry.value.target ?? "")
      );
    }
    case "form-submit": {
      const form = controller.form(document, command.index);
      if (!form) return result({ ...state, status: status(`No form exists at index ${String(command.index)}.`, "error") });
      return beginNavigation(state, document, "Submitting form…", effect(
        `navigation:${document.id}`,
        async (context) => ({
          kind: "pageLoaded",
          documentId: document.id,
          snapshot: await controller.submitForm(document, form, command.overrides, context.signal),
          status: "Submitted form"
        }),
        "replace"
      ));
    }
    case "close-document":
      return updateBrowser(controller, state, { kind: "closeDocument" }, {
        terminalSize: { columns, rows: 24 }
      });
    case "reopen-document":
      return updateBrowser(controller, state, { kind: "reopenDocument" }, {
        terminalSize: { columns, rows: 24 }
      });
    case "download":
      return result({ ...state, overlay: null }, { effects: [effect("download", async () => ({
        kind: "operationComplete",
        status: await controller.download(document, command.path)
      }))] });
    case "save-text":
      return result({ ...state, overlay: null }, { effects: [effect("save-text", async () => ({
        kind: "operationComplete",
        status: await controller.saveText(command.path, pageText(document, columns))
      }))] });
    case "save-csv":
      return result({ ...state, status: status("CSV export is only available from a picker screen.", "error") });
    case "open-external":
      return result({ ...state, overlay: null }, { effects: [effect("open-external", async () => ({
        kind: "operationComplete",
        status: await controller.openExternal(document)
      }))] });
    case "go":
    case "go-stream":
      return beginNavigation(
        state,
        document,
        `Opening ${command.target}…`,
        loadEffect(controller, document, command.target, command.kind === "go-stream" ? { parseMode: "stream" } : {})
      );
    case "cookie-list":
      return result({
        ...state,
        overlay: {
          kind: "detail",
          detailKind: "cookies",
          title: "Cookies",
          lines: controller.detail("cookies", document),
          scrollRow: 0
        }
      });
    case "cookie-clear":
      return result({ ...state, overlay: null }, { effects: [effect("cookie-clear", async () => ({
        kind: "operationComplete",
        status: await controller.clearCookies()
      }))] });
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
      return beginNavigation(state, document, "Applying page edit…", effect(
        `navigation:${document.id}`,
        async () => ({
          kind: "pageLoaded",
          documentId: document.id,
          snapshot: await controller.applyEdits(document, [edit]),
          status: "Patched page"
        }),
        "replace"
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
  const columns = context.terminalSize.columns;
  const layout = documentLayout(document, columns);
  switch (message.kind) {
    case "quit":
      return { state, exit: { reason: "quit" } };
    case "dismiss":
      return result({ ...state, overlay: null });
    case "scroll": {
      if (state.overlay?.kind === "detail") {
        return result({
          ...state,
          overlay: { ...state.overlay, scrollRow: Math.max(0, state.overlay.scrollRow + message.rows) }
        });
      }
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, layout, documentScrollRow(current, layout) + message.rows)
      ));
    }
    case "scrollTop":
      return result(updateDocument(state, document.id, (current) => documentWithScrollRow(current, layout, 0)));
    case "scrollBottom":
      return result(updateDocument(state, document.id, (current) =>
        documentWithScrollRow(current, layout, Math.max(0, layout.rows.length - 1))
      ));
    case "moveSearch": {
      if (!document.search) return result({ ...state, status: status("No active search.", "error") });
      return result(updateDocument(state, document.id, (current) => moveSearch(current, message.direction)));
    }
    case "clearBrowseState":
      return result(updateDocument(state, document.id, (current) => ({
        ...current,
        search: null,
        focusedActionId: null
      })));
    case "moveAction": {
      const actions = document.snapshot.content.actions;
      if (actions.length === 0) return result({ ...state, status: status("No page actions are available.", "error") });
      const currentIndex = actions.findIndex((action) => action.id === document.focusedActionId);
      const start = currentIndex < 0 ? (message.delta === 1 ? -1 : actions.length) : currentIndex;
      const nextIndex = (start + message.delta + actions.length) % actions.length;
      const action = actions[nextIndex];
      if (!action) return result(state);
      const nextDocument = scrollToAction({ ...document, focusedActionId: action.id }, layout, action.id);
      return result(updateDocument(state, document.id, () => nextDocument), {
        focus: {
          kind: "elementTarget",
          elementId: `browser-${document.id}`,
          targetId: action.id
        }
      });
    }
    case "activateAction":
    case "activateActionAt": {
      const actionId = message.kind === "activateActionAt" ? message.actionId : document.focusedActionId;
      const action = actionById(document, actionId);
      if (!action) return result({ ...state, status: status("Focus a link or form first.", "error") });
      if (action.kind === "form") return result(openForm(controller, state, action.index));
      return beginNavigation(state, document, `Opening ${action.resolvedHref}…`, effect(
        `navigation:${document.id}`,
        async (effectContext) => ({
          kind: "pageLoaded",
          documentId: document.id,
          snapshot: await controller.openLink(document, action.index, effectContext.signal),
          status: `Opened link ${String(action.index)}`
        }),
        "replace"
      ));
    }
    case "navigate":
      return beginNavigation(state, document, `${message.operation}…`, navigationEffect(controller, document, message.operation));
    case "openPalette":
      return result(openPalette(state, message.mode));
    case "openPicker":
      return result(openPicker(controller, state, message.picker, message.query));
    case "openDetail":
      return result({
        ...state,
        overlay: {
          kind: "detail",
          detailKind: message.detail,
          title: `${message.detail.charAt(0).toUpperCase()}${message.detail.slice(1)}`,
          lines: controller.detail(message.detail, document),
          scrollRow: 0
        }
      });
    case "bookmark":
      return result(state, { effects: [effect("bookmark", async () => ({
        kind: "operationComplete",
        status: await controller.addBookmark(document)
      }))] });
    case "newDocument": {
      const action = actionById(document, document.focusedActionId);
      if (action?.kind !== "link") {
        return result({ ...state, status: status("Focus a link before opening a new document.", "error") });
      }
      return result(state, { effects: [effect("new-document", async (effectContext) => ({
        kind: "documentOpened",
        document: await controller.openNew(action.resolvedHref, effectContext.signal)
      }))] });
    }
    case "closeDocument":
      if (state.documents.length <= 1) {
        return result({ ...state, status: status("At least one document must remain open.", "error") });
      }
      return result({
        ...state,
        documents: state.documents.filter((_, index) => index !== state.activeDocumentIndex),
        activeDocumentIndex: Math.max(0, state.activeDocumentIndex - 1),
        recentlyClosed: [document, ...state.recentlyClosed].slice(0, 10),
        overlay: null,
        status: status(`Closed ${document.snapshot.content.title}.`, "success")
      });
    case "reopenDocument": {
      const closed = state.recentlyClosed[0];
      if (!closed) return result({ ...state, status: status("No recently closed document.", "error") });
      return result({
        ...state,
        documents: [...state.documents, closed],
        activeDocumentIndex: state.documents.length,
        recentlyClosed: state.recentlyClosed.slice(1),
        status: status(`Reopened ${closed.snapshot.content.title}.`, "success")
      });
    }
    case "tabs": {
      const action = message.action;
      if (action.kind === "select" || action.kind === "close") {
        const index = state.documents.findIndex((entry) => entry.id === action.id);
        if (index < 0) return result(state);
        return action.kind === "select"
          ? result({ ...state, activeDocumentIndex: index })
          : updateBrowser(controller, { ...state, activeDocumentIndex: index }, { kind: "closeDocument" }, context);
      }
      const nextIndex = action.kind === "first"
        ? 0
        : action.kind === "last"
          ? state.documents.length - 1
          : Math.max(0, Math.min(state.documents.length - 1, state.activeDocumentIndex + action.delta));
      return result({ ...state, activeDocumentIndex: nextIndex });
    }
    case "paletteAction": {
      if (state.overlay?.kind !== "palette") return result(state);
      const next = commandInputReducer(state.overlay.state, message.action);
      return result({
        ...state,
        overlay: {
          kind: "palette",
          mode: state.overlay.mode,
          state: {
            ...next,
            suggestions: paletteSuggestions(state.overlay.mode, next.input.text, document)
          }
        }
      });
    }
    case "paletteSubmit": {
      if (state.overlay?.kind !== "palette") return result(state);
      const value = message.value.trim();
      if (value.length === 0) {
        return result({ ...state, overlay: { ...state.overlay, validation: "Enter a value." } });
      }
      if (state.overlay.mode === "search") return result(applySearch(state, value));
      if (state.overlay.mode === "location") {
        return beginNavigation(state, document, `Opening ${value}…`, loadEffect(controller, document, value));
      }
      return runCommand(controller, state, parseCommand(value), columns);
    }
    case "pickerAction":
      return state.overlay?.kind !== "picker"
        ? result(state)
        : result({
          ...state,
          overlay: {
            ...state.overlay,
            state: searchPickerReducer(state.overlay.state, message.action, {
              searchPickerIndex: state.overlay.index
            })
          }
        });
    case "pickerSelect": {
      const value = message.value;
      if (!value) return result({ ...state, status: status("No item is selected.", "error") });
      if (value.kind === "document") return result({ ...state, activeDocumentIndex: value.index, overlay: null });
      if (value.kind === "outline") {
        return result({
          ...updateDocument(state, document.id, (current) => scrollToBlock(current, value.blockId)),
          overlay: null
        });
      }
      if (value.kind === "form") return result(openForm(controller, state, value.index));
      if (value.kind === "link") {
        return beginNavigation(state, document, "Opening link…", effect(
          `navigation:${document.id}`,
          async (effectContext) => ({
            kind: "pageLoaded",
            documentId: document.id,
            snapshot: await controller.openLink(document, value.index, effectContext.signal),
            status: `Opened link ${String(value.index)}`
          }),
          "replace"
        ));
      }
      return beginNavigation(
        state,
        document,
        `Opening ${value.target ?? ""}…`,
        loadEffect(controller, document, value.target ?? "")
      );
    }
    case "formField":
      if (state.overlay?.kind !== "form") return result(state);
      return result({
        ...state,
        overlay: {
          ...state.overlay,
          focusedField: message.fieldIndex,
          fields: state.overlay.fields.map((entry, index) => {
            if (index !== message.fieldIndex) return entry;
            if (entry.input.kind === "multiline" && message.control === "multiline") {
              return { ...entry, input: { kind: "multiline", state: textAreaReducer(entry.input.state, message.action) } };
            }
            if (entry.input.kind === "singleLine" && message.control === "singleLine") {
              return { ...entry, input: { kind: "singleLine", state: textInputReducer(entry.input.state, message.action) } };
            }
            return entry;
          })
        }
      });
    case "focusFormField":
      return state.overlay?.kind !== "form"
        ? result(state)
        : result(
          { ...state, overlay: { ...state.overlay, focusedField: message.fieldIndex } },
          { focus: { kind: "element", elementId: `form-input-${String(message.fieldIndex)}` } }
        );
    case "editFormFieldExternal": {
      if (state.overlay?.kind !== "form") return result(state);
      const field = state.overlay.fields[message.fieldIndex];
      if (!field) return result(state);
      return result(state, { effects: [effect("external-form-editor", async (effectContext) => ({
        kind: "formFieldReplaced",
        fieldIndex: message.fieldIndex,
        value: await effectContext.withTerminalSuspended(
          () => controller.editFormFieldExternally(formFieldValue(field), field.label)
        )
      }))] });
    }
    case "formFieldReplaced":
      if (state.overlay?.kind !== "form") return result(state);
      return result({
        ...state,
        overlay: {
          ...state.overlay,
          fields: state.overlay.fields.map((entry, index) =>
            index === message.fieldIndex ? formField({
              name: entry.name,
              type: entry.multiline ? "textarea" : "text",
              value: message.value
            }) : entry
          )
        },
        status: status("Updated the form field in the external editor.", "success")
      });
    case "submitForm": {
      if (state.overlay?.kind !== "form") return result(state);
      const formOverlay = state.overlay;
      const values = Object.fromEntries(formOverlay.fields.map((entry) => [entry.name, formFieldValue(entry)]));
      return beginNavigation(state, document, "Submitting form…", effect(
        `navigation:${document.id}`,
        async (effectContext) => ({
          kind: "pageLoaded",
          documentId: document.id,
          snapshot: await controller.submitForm(document, formOverlay.form, values, effectContext.signal),
          status: "Submitted form"
        }),
        "replace"
      ));
    }
    case "discardForm":
      return result({ ...state, overlay: null, status: status("Discarded form changes.") });
    case "pageLoaded": {
      const loadedDocumentIndex = state.documents.findIndex((entry) => entry.id === message.documentId);
      const currentDocument = state.documents[loadedDocumentIndex];
      if (!currentDocument) return result(state);
      const loadedDocument = pageFromSnapshot(currentDocument, message.snapshot);
      return result({
        ...updateDocument(state, message.documentId, () => loadedDocument),
        overlay: null,
        status: status(`${message.status}: ${message.snapshot.finalUrl}`, "success")
      }, {
        ...(loadedDocument.focusedActionId === null || loadedDocumentIndex !== state.activeDocumentIndex
          ? {}
          : {
            focus: {
              kind: "elementTarget" as const,
              elementId: `browser-${message.documentId}`,
              targetId: loadedDocument.focusedActionId
            }
          })
      });
    }
    case "documentOpened":
      return result({
        ...state,
        documents: [...state.documents, message.document],
        activeDocumentIndex: state.documents.length,
        overlay: null,
        status: status(`Opened ${message.document.snapshot.finalUrl}`, "success")
      });
    case "operationComplete":
      return result({ ...state, status: status(message.status, "success") });
    case "operationFailed":
      return result({
        ...state,
        documents: state.documents.map((entry) => ({ ...entry, loading: false })),
        status: status(message.message, "error")
      });
  }
}

function textBinding(id: string, text: string, message: BrowserTuiMessage) {
  return {
    id,
    phase: "beforeFocus" as const,
    triggers: [{ kind: "text" as const, text }],
    enabled: ({ state }: { readonly state: BrowserTuiState }) => state.overlay === null,
    message
  };
}

export function createBrowserApp(
  initialDocument: BrowserDocumentState,
  controller: BrowserController
) {
  const initialState = createBrowserInitialState(initialDocument);
  return defineTui<BrowserTuiState, BrowserTuiMessage>({
    id: "verge-browser",
    init: () => initialState,
    update: (state, message, context) => updateBrowser(controller, state, message, context),
    view: browserView,
    inputBindings: [
      {
        id: "quit-control",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "c", modifiers: { ctrl: true } }],
        message: { kind: "quit" }
      },
      textBinding("quit", "q", { kind: "quit" }),
      textBinding("next-action", "]", { kind: "moveAction", delta: 1 }),
      textBinding("previous-action", "[", { kind: "moveAction", delta: -1 }),
      textBinding("back", "h", { kind: "navigate", operation: "back" }),
      textBinding("forward", "f", { kind: "navigate", operation: "forward" }),
      textBinding("reload", "r", { kind: "navigate", operation: "reload" }),
      textBinding("location", "g", { kind: "openPalette", mode: "location" }),
      textBinding("actions", ":", { kind: "openPalette", mode: "action" }),
      textBinding("search", "/", { kind: "openPalette", mode: "search" }),
      textBinding("search-next", "n", { kind: "moveSearch", direction: "next" }),
      textBinding("search-previous", "N", { kind: "moveSearch", direction: "prev" }),
      textBinding("links", "l", { kind: "openPicker", picker: "links" }),
      textBinding("documents", "D", { kind: "openPicker", picker: "documents" }),
      textBinding("history", "H", { kind: "openPicker", picker: "history" }),
      textBinding("bookmarks", "B", { kind: "openPicker", picker: "bookmarks" }),
      textBinding("forms", "F", { kind: "openPicker", picker: "forms" }),
      textBinding("outline", "o", { kind: "openPicker", picker: "outline" }),
      textBinding("help", "?", { kind: "openDetail", detail: "help" }),
      textBinding("diagnostics", "d", { kind: "openDetail", detail: "diagnostics" }),
      textBinding("bookmark", "m", { kind: "bookmark" }),
      textBinding("new-document", "t", { kind: "newDocument" }),
      textBinding("close-document", "x", { kind: "closeDocument" }),
      textBinding("reopen-document", "u", { kind: "reopenDocument" }),
      {
        id: "activate",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "enter" }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "activateAction" }
      },
      {
        id: "next-action-tab",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "tab" }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "moveAction", delta: 1 }
      },
      {
        id: "previous-action-tab",
        phase: "beforeFocus",
        triggers: [{ kind: "key", key: "tab", modifiers: { shift: true } }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "moveAction", delta: -1 }
      },
      {
        id: "scroll-down",
        triggers: [{ kind: "key", key: "arrowDown" }],
        enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail",
        message: { kind: "scroll", rows: 1 }
      },
      {
        id: "scroll-up",
        triggers: [{ kind: "key", key: "arrowUp" }],
        enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail",
        message: { kind: "scroll", rows: -1 }
      },
      {
        id: "page-down",
        triggers: [{ kind: "key", key: "pageDown" }, { kind: "text", text: " " }],
        enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail",
        message: { kind: "scroll", rows: 10 }
      },
      {
        id: "page-up",
        triggers: [{ kind: "key", key: "pageUp" }],
        enabled: ({ state }) => state.overlay === null || state.overlay.kind === "detail",
        message: { kind: "scroll", rows: -10 }
      },
      {
        id: "scroll-top",
        triggers: [{ kind: "key", key: "home" }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "scrollTop" }
      },
      {
        id: "scroll-bottom",
        triggers: [{ kind: "key", key: "end" }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "scrollBottom" }
      },
      {
        id: "dismiss",
        triggers: [{ kind: "key", key: "escape" }],
        enabled: ({ state }) => state.overlay !== null,
        message: { kind: "dismiss" }
      },
      {
        id: "clear-browse-state",
        triggers: [{ kind: "key", key: "escape" }],
        enabled: ({ state }) => state.overlay === null,
        message: { kind: "clearBrowseState" }
      }
    ],
    nonTty: { mode: "last_frame" }
  });
}

export function createBrowserInitialState(initialDocument: BrowserDocumentState): BrowserTuiState {
  return {
    documents: [initialDocument],
    activeDocumentIndex: 0,
    recentlyClosed: [],
    overlay: null,
    status: status(`Opened ${initialDocument.snapshot.finalUrl}`, "success")
  };
}
