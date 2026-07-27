import {
  commandInputPresentation,
  selectedSearchPickerEntry,
  textInputPresentation
} from "@ismail-elkorchi/terminal-ui/behavior";
import {
  button,
  commandInput,
  dialog,
  field,
  form,
  helpBar,
  searchPicker,
  statusBar,
  tabs,
  text,
  textArea,
  textInput
} from "@ismail-elkorchi/terminal-ui/components";
import { custom, type CustomRenderer, type Element } from "@ismail-elkorchi/terminal-ui/component";
import { column, overlay, row, surface } from "@ismail-elkorchi/terminal-ui/layout";
import type { TuiContext } from "@ismail-elkorchi/terminal-ui/tui";

import type { PageAction, PageBlock } from "../app/types.js";
import {
  activeSearchBlockId,
  documentLayout,
  documentScrollRow
} from "./document-layout.js";
import type {
  BrowserDocumentState,
  BrowserTuiMessage,
  BrowserTuiState,
  DetailOverlay,
  FormOverlay,
  PaletteOverlay,
  PickerOverlay
} from "./model.js";

function actionForId(document: BrowserDocumentState, id: string | undefined): PageAction | undefined {
  return id === undefined
    ? undefined
    : document.snapshot.content.actions.find((action) => action.id === id);
}

function accessibleBlock(block: PageBlock) {
  if (block.kind === "heading") {
    return {
      id: block.id,
      role: "heading" as const,
      label: block.text,
      position: { level: block.level ?? 1 }
    };
  }
  return {
    id: block.id,
    role: "text" as const,
    label: block.text
  };
}

const browserDocumentRenderer: CustomRenderer<BrowserDocumentState, BrowserTuiMessage> = {
  render({ state, bounds, target, focusedTargetId }) {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const layout = documentLayout(state, bounds.width);
    const scrollRow = documentScrollRow(state, layout);
    const focusedAction = actionForId(state, focusedTargetId ?? state.focusedActionId ?? undefined);
    const focusedPlacement = layout.actionPlacements.find(
      (placement) => placement.actionId === focusedAction?.id
    );
    const searchBlockId = activeSearchBlockId(state);
    for (let localRow = 0; localRow < bounds.height; localRow += 1) {
      const rowIndex = scrollRow + localRow;
      const row = layout.rows[rowIndex];
      if (!row) break;
      const focused = focusedPlacement?.rowIndex === rowIndex;
      target.write(bounds.row + localRow, bounds.column, [{
        text: row.text,
        ...(focused
          ? { style: { bold: true, underline: true } }
          : row.blockId === searchBlockId
            ? { style: { inverse: true } }
            : {})
      }]);
    }
  },
  accessibility({ id, state, bounds, focusedTargetId }) {
    const layout = documentLayout(state, bounds.width);
    const startIndex = Math.min(documentScrollRow(state, layout), layout.rows.length);
    const endIndexExclusive = Math.min(startIndex + bounds.height, layout.rows.length);
    const visibleBlockIds = new Set(
      layout.rows.slice(startIndex, endIndexExclusive).map((row) => row.blockId)
    );
    const focusedAction = actionForId(state, focusedTargetId);
    const visibleActions = state.snapshot.content.actions.filter((action) =>
      layout.actionPlacements.some(
        (placement) =>
          placement.actionId === action.id
          && placement.rowIndex >= startIndex
          && placement.rowIndex < endIndexExclusive
      )
    );
    return {
      id,
      role: "document",
      label: state.snapshot.content.title,
      description: state.snapshot.finalUrl,
      window: {
        startIndex,
        endIndexExclusive,
        totalCount: layout.rows.length,
        omittedBefore: startIndex,
        omittedAfter: layout.rows.length - endIndexExclusive
      },
      children: [
        ...state.snapshot.content.blocks
          .filter((block) => visibleBlockIds.has(block.id) && block.kind !== "form")
          .map(accessibleBlock),
        ...visibleActions.map((action) => ({
          id: action.id,
          role: action.kind === "link" ? "link" as const : "form" as const,
          label: action.label,
          ...(focusedAction?.id === action.id ? { focused: true } : {}),
          position: {
            positionInSet: state.snapshot.content.actions.indexOf(action) + 1,
            setSize: state.snapshot.content.actions.length
          }
        }))
      ]
    };
  },
  focusTargets({ state, bounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const layout = documentLayout(state, bounds.width);
    const scrollRow = documentScrollRow(state, layout);
    return layout.actionPlacements
      .filter((placement) =>
        placement.rowIndex >= scrollRow
        && placement.rowIndex < scrollRow + bounds.height
      )
      .map((placement) => ({
        id: placement.actionId,
        bounds: {
          row: bounds.row + placement.rowIndex - scrollRow,
          column: bounds.column + Math.min(bounds.width - 1, placement.columnIndex),
          width: Math.max(1, Math.min(
            placement.width,
            bounds.width - Math.min(bounds.width - 1, placement.columnIndex)
          )),
          height: 1
        }
      }));
  },
  hitTargets({ state, bounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const layout = documentLayout(state, bounds.width);
    const scrollRow = documentScrollRow(state, layout);
    return layout.actionPlacements
      .filter((placement) =>
        placement.rowIndex >= scrollRow
        && placement.rowIndex < scrollRow + bounds.height
      )
      .map((placement) => ({
        id: `activate:${placement.actionId}`,
        bounds: {
          row: bounds.row + placement.rowIndex - scrollRow,
          column: bounds.column + Math.min(bounds.width - 1, placement.columnIndex),
          width: Math.max(1, Math.min(
            placement.width,
            bounds.width - Math.min(bounds.width - 1, placement.columnIndex)
          )),
          height: 1
        },
        accepts: ["pointerDown" as const],
        cursor: "pointer" as const,
        focus: { kind: "target" as const, targetId: placement.actionId },
        message: (): BrowserTuiMessage => ({
          kind: "activateActionAt",
          actionId: placement.actionId
        })
      }));
  }
};

function browserDocument(document: BrowserDocumentState): Element<BrowserTuiMessage> {
  return custom({
    id: `browser-${document.id}`,
    renderer: browserDocumentRenderer,
    state: document
  });
}

function baseView(state: BrowserTuiState, columns: number): Element<BrowserTuiMessage> {
  const selected = state.documents[state.activeDocumentIndex] ?? state.documents[0];
  if (!selected) throw new Error("The browser view requires an open document.");
  const layout = documentLayout(selected, columns);
  return column([
    tabs({
      id: "browser-tabs",
      selected: selected.id,
      tabs: state.documents.map((document) => ({
        id: document.id,
        label: document.snapshot.content.title,
        closable: state.documents.length > 1,
        panel: browserDocument(document)
      })),
      onAction: (action): BrowserTuiMessage => ({ kind: "tabs", action })
    }),
    statusBar({
      id: "browser-status",
      leading: [{
        id: "status",
        kind: "status",
        text: selected.loading
          ? `Loading ${selected.snapshot.finalUrl}…`
          : state.status?.text ?? selected.snapshot.finalUrl,
        status: state.status?.tone === "error"
          ? "error"
          : state.status?.tone === "success"
            ? "success"
            : "info"
      }],
      trailing: [{
        id: "position",
        kind: "text",
        text: `${String(documentScrollRow(selected, layout) + 1)}/${String(layout.rows.length)}`
      }]
    }),
    helpBar({
      id: "browser-help",
      groups: [{
        id: "browse",
        bindings: [
          { key: "] [", label: "actions" },
          { key: "Enter", label: "open" },
          { key: "g / :", label: "location / commands" },
          { key: "?", label: "help" },
          { key: "q", label: "quit" }
        ]
      }]
    })
  ], {
    id: "browser-root",
    sizes: [
      { kind: "fill" },
      { kind: "fixed", cells: 1 },
      { kind: "fixed", cells: 1 }
    ]
  });
}

function paletteView(palette: PaletteOverlay): Element<BrowserTuiMessage> {
  const title = palette.mode === "location"
    ? "Open location"
    : palette.mode === "search"
      ? "Find in page"
      : "Run action";
  return dialog(commandInput({
    id: "browser-command-input",
    prompt: palette.mode === "action" ? ": " : palette.mode === "search" ? "/ " : "g ",
    placeholder: title,
    presentation: commandInputPresentation(palette.state),
    ...(palette.validation === undefined
      ? {}
      : { validation: { level: "error" as const, message: palette.validation } }),
    display: "expanded",
    onAction: (action): BrowserTuiMessage => ({ kind: "paletteAction", action }),
    onSubmit: (value): BrowserTuiMessage => ({ kind: "paletteSubmit", value }),
    keys: { escape: (): BrowserTuiMessage => ({ kind: "dismiss" }) }
  }), {
    id: "browser-palette",
    title,
    modal: true,
    focusPolicy: {
      initialFocus: { kind: "element", elementId: "browser-command-input" },
      returnFocus: "restore"
    },
    width: 72,
    height: 10
  });
}

function pickerView(picker: PickerOverlay): Element<BrowserTuiMessage> {
  return dialog(searchPicker({
    id: "browser-picker-list",
    title: picker.title,
    searchPickerIndex: picker.index,
    query: picker.state.query,
    selectedIndex: picker.state.selectedIndex,
    onAction: (action): BrowserTuiMessage => ({ kind: "pickerAction", action }),
    onSelect: (entry): BrowserTuiMessage => ({ kind: "pickerSelect", value: entry.value }),
    keys: {
      enter: (): BrowserTuiMessage => {
        const value = selectedSearchPickerEntry({
          searchPickerIndex: picker.index,
          state: picker.state
        })?.value;
        return value === undefined ? { kind: "pickerSelect" } : { kind: "pickerSelect", value };
      },
      escape: (): BrowserTuiMessage => ({ kind: "dismiss" })
    }
  }), {
    id: "browser-picker",
    title: picker.title,
    modal: true,
    focusPolicy: {
      initialFocus: { kind: "element", elementId: "browser-picker-list" },
      returnFocus: "restore"
    },
    width: 76,
    height: 18
  });
}

function formView(editor: FormOverlay): Element<BrowserTuiMessage> {
  const fields = editor.fields.map((item, fieldIndex) => field([
    item.input.kind === "multiline"
      ? textArea({
        id: `form-input-${String(fieldIndex)}`,
        presentation: item.input.state,
        wrap: true,
        onAction: (action): BrowserTuiMessage => ({
          kind: "formField",
          fieldIndex,
          control: "multiline",
          action
        })
      })
      : textInput({
        id: `form-input-${String(fieldIndex)}`,
        presentation: textInputPresentation(item.input.state),
        onAction: (action): BrowserTuiMessage => ({
          kind: "formField",
          fieldIndex,
          control: "singleLine",
          action
        }),
        onSubmit: (): BrowserTuiMessage => fieldIndex === editor.fields.length - 1
          ? { kind: "submitForm" }
          : { kind: "focusFormField", fieldIndex: fieldIndex + 1 }
      })
  ], {
    id: `form-field-${String(fieldIndex)}`,
    label: item.label
  }));
  return dialog(form([
    ...fields,
    row([
      button({
        id: "form-submit",
        label: "Submit",
        tone: "primary",
        onPress: (): BrowserTuiMessage => ({ kind: "submitForm" })
      }),
      button({
        id: "form-external",
        label: "External editor",
        onPress: (): BrowserTuiMessage => ({
          kind: "editFormFieldExternal",
          fieldIndex: editor.focusedField
        })
      }),
      button({
        id: "form-discard",
        label: "Discard",
        onPress: (): BrowserTuiMessage => ({ kind: "discardForm" })
      })
    ], { gap: 1 })
  ], {
    id: "browser-form-fields",
    title: `${editor.form.method.toUpperCase()} ${editor.form.actionUrl}`,
    gap: 1
  }), {
    id: "browser-form",
    title: "Edit form",
    modal: true,
    focusPolicy: {
      initialFocus: { kind: "element", elementId: `form-input-${String(editor.focusedField)}` },
      returnFocus: "restore"
    },
    keys: { escape: (): BrowserTuiMessage => ({ kind: "discardForm" }) },
    width: 76,
    height: Math.min(22, Math.max(8, editor.fields.length * 3 + 4))
  });
}

function detailView(detail: DetailOverlay): Element<BrowserTuiMessage> {
  return dialog(surface(column(detail.lines.slice(detail.scrollRow).map((line, index) => text(line, {
    id: `detail-line-${String(index)}`
  }))), {
    id: "browser-detail-surface",
    padding: 1
  }), {
    id: "browser-detail",
    title: detail.title,
    modal: true,
    focusPolicy: { returnFocus: "restore" },
    keys: { escape: (): BrowserTuiMessage => ({ kind: "dismiss" }) },
    width: 82,
    height: 22
  });
}

export function browserView(
  state: BrowserTuiState,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 80, rows: 24 } }
): Element<BrowserTuiMessage> {
  const base = baseView(state, context.terminalSize.columns);
  if (state.overlay === null) return base;
  const transient = state.overlay.kind === "palette"
    ? paletteView(state.overlay)
    : state.overlay.kind === "picker"
      ? pickerView(state.overlay)
      : state.overlay.kind === "form"
        ? formView(state.overlay)
        : detailView(state.overlay);
  return overlay([base, transient], { id: "browser-layers" });
}
