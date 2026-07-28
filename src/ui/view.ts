import {
  commandInputPresentation,
  contextMenuPresentation,
  createNumberInputConfiguration,
  createScrollState,
  createTextAreaState,
  dropdownMenuPresentation,
  numberInputPresentation,
  scrollReducer,
  selectedSearchPickerEntry,
  textInputPresentation
} from "@ismail-elkorchi/terminal-ui/behavior";
import {
  button,
  checkbox,
  checkboxGroup,
  commandInput,
  contextMenu,
  dialog,
  dropdownMenu,
  field,
  form,
  numberInput,
  passwordInput,
  progressBar,
  radioGroup,
  searchPicker,
  select,
  statusBar,
  tabs,
  text,
  textArea,
  textInput,
  type CheckboxGroupAction,
  type RadioGroupAction
} from "@ismail-elkorchi/terminal-ui/components";
import {
  customComposite,
  type CustomCompositeRenderer,
  type Element
} from "@ismail-elkorchi/terminal-ui/component";
import { column, overlay, row, splitPane, surface, viewport } from "@ismail-elkorchi/terminal-ui/layout";
import type { RoutedPointerEvent } from "@ismail-elkorchi/terminal-ui/input";
import type { RenderSpan, TerminalStyle } from "@ismail-elkorchi/terminal-ui/renderer";
import type { TuiContext } from "@ismail-elkorchi/terminal-ui/tui";

import { extractForms, type FormControl, type FormEntry } from "../app/forms.js";
import type { PageAction, PageBlock, PageLayoutRow } from "../app/types.js";
import {
  activeSearchMatch,
  documentContentBounds,
  documentLayout,
  documentScrollRow
} from "./document-layout.js";
import type {
  ActionPaletteOverlay,
  BrowserDocumentState,
  BrowserTuiMessage,
  BrowserTuiState,
  DetailOverlay,
  DownloadPromptOverlay,
  LinkMenuOverlay,
  PickerOverlay
} from "./model.js";
import { browserMenuItems, linkMenuItems } from "./model.js";

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
  return { id: block.id, role: "text" as const, label: block.text };
}

function blockStyle(block: PageBlock): TerminalStyle {
  if (block.kind === "heading" || block.kind === "definitionTerm") {
    return {
      fg: {
        kind: "theme",
        token: block.kind === "heading" && block.level === 1 ? "accent.primary" : "text.strong"
      },
      bold: true
    };
  }
  if (block.kind === "quote") {
    return { fg: { kind: "theme", token: "text.muted" }, italic: true };
  }
  if (block.kind === "notice") {
    return { fg: { kind: "theme", token: "status.warning" } };
  }
  return { fg: { kind: "theme", token: "text.default" } };
}

function rowSegments(
  document: BrowserDocumentState,
  block: PageBlock,
  layoutRow: PageLayoutRow,
  rowIndex: number,
  focusedActionId: string | undefined
): readonly RenderSpan[] {
  const rowText = layoutRow.text;
  const visibleBlockText = block.text.slice(
    layoutRow.blockTextStartCodeUnitIndex,
    layoutRow.blockTextEndCodeUnitIndexExclusive
  );
  const contentStart = Math.max(0, rowText.length - visibleBlockText.length);
  const links = document.snapshot.content.links.flatMap((link) => {
    if (link.blockId !== block.id) return [];
    const start = Math.max(link.textOffset, layoutRow.blockTextStartCodeUnitIndex);
    const end = Math.min(
      link.textOffset + link.label.length,
      layoutRow.blockTextEndCodeUnitIndexExclusive
    );
    return start >= end
      ? []
      : [{
        link,
        start: contentStart + start - layoutRow.blockTextStartCodeUnitIndex,
        end: contentStart + end - layoutRow.blockTextStartCodeUnitIndex
      }];
  });
  const query = document.search?.query ?? "";
  const active = activeSearchMatch(document);
  const searchRanges: { readonly start: number; readonly end: number; readonly active: boolean }[] = [];
  if (query.length > 0) {
    const normalizedRow = rowText.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    let start = 0;
    while (start < rowText.length) {
      const match = normalizedRow.indexOf(normalizedQuery, start);
      if (match < 0) break;
      searchRanges.push({
        start: match,
        end: match + query.length,
        active: active?.rowIndex === rowIndex
          && active.startCodeUnitIndex === layoutRow.blockTextStartCodeUnitIndex + match - contentStart
      });
      start = match + Math.max(1, query.length);
    }
  }
  const boundaries = new Set([0, rowText.length]);
  for (const range of [...links, ...searchRanges]) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const spans: RenderSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? rowText.length;
    if (start >= end) continue;
    const link = links.find((range) => range.start <= start && range.end >= end)?.link;
    const search = searchRanges.find((range) => range.start <= start && range.end >= end);
    const style: TerminalStyle = {
      ...blockStyle(block),
      ...(link === undefined
        ? {}
        : {
          fg: { kind: "theme" as const, token: "link.foreground" as const },
          underline: true
        }),
      ...(link !== undefined && link.id === focusedActionId ? { inverse: true, bold: true } : {}),
      ...(search === undefined
        ? {}
        : search.active
          ? { inverse: true, bold: true }
          : { underline: true })
    };
    spans.push({
      text: rowText.slice(start, end),
      style,
      ...(link === undefined ? {} : { link: { href: link.resolvedHref, id: link.id } })
    });
  }
  return spans;
}

function forms(document: BrowserDocumentState): readonly FormEntry[] {
  return extractForms(document.snapshot.document.tree, document.snapshot.finalUrl);
}

function formControlValues(document: BrowserDocumentState, control: FormControl): readonly string[] {
  const explicit = document.formValues[control.id];
  if (explicit !== undefined) return explicit;
  if (control.kind === "hidden" || control.kind === "text" || control.kind === "textarea") return [control.value];
  if ((control.kind === "checkbox" || control.kind === "radio") && control.checked) return [control.value];
  if (control.kind === "select") return control.options.filter((option) => option.selected).map((option) => option.value);
  return [];
}

function radioAction(
  controls: readonly Extract<FormControl, { readonly kind: "radio" }>[],
  selectedId: string | undefined,
  action: RadioGroupAction
): BrowserTuiMessage {
  const selectedIndex = Math.max(0, controls.findIndex((control) => control.id === selectedId));
  const nextId = action.kind === "select"
    ? action.id
    : action.kind === "first"
      ? controls[0]?.id
      : action.kind === "last"
        ? controls.at(-1)?.id
        : action.kind === "move"
          ? controls[(selectedIndex + action.delta + controls.length) % controls.length]?.id
          : action.id;
  const control = controls.find((entry) => entry.id === nextId) ?? controls[selectedIndex];
  if (!control) throw new Error("A radio group must contain at least one control.");
  return { kind: "formValues", controlId: control.id, values: [control.value] };
}

function multiChoiceAction(
  control: Extract<FormControl, { readonly kind: "select" }>,
  selected: readonly string[],
  action: CheckboxGroupAction
): BrowserTuiMessage {
  if (action.kind !== "toggle") {
    return { kind: "formValues", controlId: control.id, values: selected };
  }
  const option = control.options.find((_, index) => `${control.id}:${String(index)}` === action.id);
  if (!option) return { kind: "formValues", controlId: control.id, values: selected };
  return {
    kind: "formValues",
    controlId: control.id,
    values: selected.includes(option.value)
      ? selected.filter((value) => value !== option.value)
      : [...selected, option.value]
  };
}

function inlineFormControl(
  document: BrowserDocumentState,
  control: FormControl,
  formId: string
): Element<BrowserTuiMessage> | null {
  const values = formControlValues(document, control);
  if (control.kind === "hidden") return null;
  if (control.kind === "unsupported") {
    return text(`${control.label}: ${control.reason}`, { id: `${control.id}:unsupported` });
  }
  if (control.kind === "text") {
    const editor = document.formEditors[control.id];
    const value = values[0] ?? "";
    if (control.inputType === "number") {
      const numberEditor = editor?.kind === "number"
        ? editor.state
        : {
          input: { text: value, cursor: value.length },
          configuration: createNumberInputConfiguration({
            ...(control.min === undefined ? {} : { min: control.min }),
            ...(control.max === undefined ? {} : { max: control.max }),
            ...(control.step === undefined ? {} : { step: control.step })
          })
        };
      return field([numberInput({
        id: control.id,
        presentation: numberInputPresentation(numberEditor),
        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
        required: control.required,
        disabled: control.disabled || control.readOnly,
        onAction: (action): BrowserTuiMessage => ({ kind: "formNumber", controlId: control.id, action })
      })], { id: `${control.id}:field`, label: control.label, required: control.required });
    }
    const presentation = editor?.kind === "text"
      ? textInputPresentation(editor.state)
      : { value, cursor: value.length };
    const input = control.inputType === "password"
      ? passwordInput<never, BrowserTuiMessage>({
        id: control.id,
        presentation,
        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
        required: control.required,
        disabled: control.disabled || control.readOnly,
        onAction: (action): BrowserTuiMessage => ({ kind: "formText", controlId: control.id, action })
      })
      : textInput<never, BrowserTuiMessage>({
        id: control.id,
        presentation,
        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
        required: control.required,
        disabled: control.disabled || control.readOnly,
        onAction: (action): BrowserTuiMessage => ({ kind: "formText", controlId: control.id, action })
      });
    return field([input], { id: `${control.id}:field`, label: control.label, required: control.required });
  }
  if (control.kind === "textarea") {
    const editor = document.formEditors[control.id];
    const presentation = editor?.kind === "textarea"
      ? editor.state
      : createTextAreaState({
        value: values[0] ?? "",
        scroll: createScrollState({ contentRows: 1, viewportRows: 2 })
      });
    return field([textArea({
      id: control.id,
      presentation,
      wrap: true,
      disabled: control.disabled || control.readOnly,
      onAction: (action): BrowserTuiMessage => ({ kind: "formArea", controlId: control.id, action })
    })], { id: `${control.id}:field`, label: control.label, required: control.required });
  }
  if (control.kind === "checkbox") {
    return checkbox({
      id: control.id,
      label: control.label,
      checked: values.includes(control.value),
      disabled: control.disabled,
      required: control.required,
      onChange: (checked): BrowserTuiMessage => ({
        kind: "formValues",
        controlId: control.id,
        values: checked ? [control.value] : []
      })
    });
  }
  if (control.kind === "select") {
    if (control.multiple) {
      return checkboxGroup({
        id: control.id,
        label: control.label,
        options: control.options.map((option, index) => ({
          id: `${control.id}:${String(index)}`,
          label: option.label,
          value: option.value,
          disabled: option.disabled
        })),
        selected: control.options.flatMap((option, index) =>
          values.includes(option.value) ? [`${control.id}:${String(index)}`] : []
        ),
        disabled: control.disabled,
        required: control.required,
        onAction: (action): BrowserTuiMessage => multiChoiceAction(control, values, action)
      });
    }
    const selectedIndex = control.options.findIndex((option) => values.includes(option.value));
    const editor = document.formEditors[control.id];
    return select({
      id: control.id,
      label: control.label,
      options: control.options.map((option, index) => ({
        id: `${control.id}:${String(index)}`,
        label: option.label,
        value: option.value,
        disabled: option.disabled
      })),
      presentation: editor?.kind === "select"
        ? editor.state
        : {
          kind: "closed",
          ...(selectedIndex < 0 ? {} : { selected: `${control.id}:${String(selectedIndex)}` })
        },
      disabled: control.disabled,
      required: control.required,
      onAction: (action): BrowserTuiMessage => ({ kind: "formSelect", controlId: control.id, action })
    });
  }
  if (control.kind === "submit") {
    return button({
      id: control.id,
      label: control.label || control.value || "Submit",
      tone: "primary",
      disabled: control.disabled,
      onPress: (): BrowserTuiMessage => ({
        kind: "submitForm",
        formId,
        submitterId: control.id
      })
    });
  }
  if (control.kind === "reset") {
    return button({
      id: control.id,
      label: control.label || "Reset",
      disabled: control.disabled,
      onPress: (): BrowserTuiMessage => ({
        kind: "resetForm",
        formId
      })
    });
  }
  return null;
}

function inlineForm(document: BrowserDocumentState, entry: FormEntry): Element<BrowserTuiMessage> {
  const radioNames = new Set<string>();
  const controls: Element<BrowserTuiMessage>[] = [];
  for (const control of entry.controls) {
    if (control.kind === "radio") {
      const groupName = control.name.length === 0 ? control.id : control.name;
      if (radioNames.has(groupName)) continue;
      radioNames.add(groupName);
      const group = entry.controls.filter(
        (candidate): candidate is Extract<FormControl, { readonly kind: "radio" }> =>
          candidate.kind === "radio"
          && (control.name.length === 0 ? candidate.id === control.id : candidate.name === control.name)
      );
      const selected = group.find((candidate) => formControlValues(document, candidate).length > 0);
      controls.push(radioGroup({
        id: `${entry.id}:radio:${groupName}`,
        label: control.label,
        options: group.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          value: candidate.value,
          disabled: candidate.disabled
        })),
        ...(selected === undefined ? {} : { selected: selected.id }),
        required: group.some((candidate) => candidate.required),
        onAction: (action): BrowserTuiMessage => radioAction(group, selected?.id, action)
      }));
      continue;
    }
    const element = inlineFormControl(document, control, entry.id);
    if (element !== null) controls.push(element);
  }
  const hasSubmitter = entry.controls.some((control) => control.kind === "submit");
  if (!hasSubmitter) {
    controls.push(button({
      id: `${entry.id}:submit`,
      label: "Submit",
      tone: "primary",
      onPress: (): BrowserTuiMessage => ({ kind: "submitForm", formId: entry.id })
    }));
  }
  return form(controls, {
    id: entry.id,
    title: entry.label,
    gap: 0
  });
}

const browserDocumentRenderer: CustomCompositeRenderer<BrowserDocumentState, BrowserTuiMessage> = {
  layout({ state, bounds, childCount, measureChild }) {
    const layout = documentLayout(state, bounds.width);
    const contentBounds = documentContentBounds(bounds);
    const entries = forms(state);
    return Array.from({ length: childCount }, (_, index) => {
      const entry = entries[index];
      if (!entry) return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
      const first = layout.rows.findIndex((candidate) => candidate.blockId === entry.id);
      const count = layout.rows.filter((candidate) => candidate.blockId === entry.id).length;
      if (first < 0) {
        return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
      }
      const childHeight = Math.max(count, measureChild(index).preferredHeight);
      return {
        row: contentBounds.row + first,
        column: contentBounds.column,
        width: contentBounds.width,
        height: childHeight
      };
    });
  },
  render({ state, bounds, viewport: visibleBounds, target, focusedTargetId }) {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const layout = documentLayout(state, bounds.width);
    const focusedAction = actionForId(state, focusedTargetId);
    const contentBounds = documentContentBounds(bounds);
    const blocksById = new Map(state.snapshot.content.blocks.map((block) => [block.id, block]));
    const formIds = new Set(forms(state).map((entry) => entry.id));
    const startIndex = Math.max(0, visibleBounds.row - contentBounds.row);
    const endIndexExclusive = Math.min(
      layout.rows.length,
      visibleBounds.row + visibleBounds.height - contentBounds.row
    );
    for (let rowIndex = startIndex; rowIndex < endIndexExclusive; rowIndex += 1) {
      const layoutRow = layout.rows[rowIndex];
      if (!layoutRow || formIds.has(layoutRow.blockId)) continue;
      const block = blocksById.get(layoutRow.blockId);
      if (!block) continue;
      target.write(
        contentBounds.row + rowIndex,
        contentBounds.column,
        rowSegments(state, block, layoutRow, rowIndex, focusedAction?.id)
      );
    }
  },
  accessibility({ id, state, bounds, viewport: visibleBounds, focusedTargetId, children }) {
    const layout = documentLayout(state, bounds.width);
    const contentBounds = documentContentBounds(bounds);
    const startIndex = Math.min(
      Math.max(0, visibleBounds.row - contentBounds.row),
      layout.rows.length
    );
    const endIndexExclusive = Math.min(
      Math.max(startIndex, visibleBounds.row + visibleBounds.height - contentBounds.row),
      layout.rows.length
    );
    const visibleBlockIds = new Set(layout.rows.slice(startIndex, endIndexExclusive).map((row) => row.blockId));
    const focusedAction = actionForId(state, focusedTargetId);
    const visibleActions = state.snapshot.content.actions.filter((action) =>
      layout.actionPlacements.some((placement) =>
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
        ...visibleActions.filter((action) => action.kind === "link").map((action) => ({
          id: action.id,
          role: "link" as const,
          label: action.label,
          ...(focusedAction?.id === action.id ? { focused: true } : {}),
          position: {
            positionInSet: state.snapshot.content.links.indexOf(action) + 1,
            setSize: state.snapshot.content.links.length
          }
        })),
        ...children
      ]
    };
  },
  focusTargets({ state, bounds, viewport: visibleBounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const layout = documentLayout(state, bounds.width);
    const contentBounds = documentContentBounds(bounds);
    const seen = new Set<string>();
    return layout.actionPlacements
      .flatMap((placement) => {
        const action = actionForId(state, placement.actionId);
        if (action?.kind !== "link"
          || seen.has(placement.actionId)
          || contentBounds.row + placement.rowIndex < visibleBounds.row
          || contentBounds.row + placement.rowIndex >= visibleBounds.row + visibleBounds.height) {
          return [];
        }
        seen.add(placement.actionId);
        const columnIndex = Math.min(contentBounds.width - 1, placement.columnIndex);
        return [{
          id: placement.actionId,
          bounds: {
            row: contentBounds.row + placement.rowIndex,
            column: contentBounds.column + columnIndex,
            width: Math.max(1, Math.min(placement.width, contentBounds.width - columnIndex)),
            height: 1
          }
        }];
      });
  },
  hitTargets({ state, bounds, viewport: visibleBounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const layout = documentLayout(state, bounds.width);
    const contentBounds = documentContentBounds(bounds);
    return layout.actionPlacements
      .filter((placement) => {
        const action = actionForId(state, placement.actionId);
        return action?.kind === "link"
          && contentBounds.row + placement.rowIndex >= visibleBounds.row
          && contentBounds.row + placement.rowIndex < visibleBounds.row + visibleBounds.height;
      })
      .map((placement) => {
        const columnIndex = Math.min(contentBounds.width - 1, placement.columnIndex);
        return {
          id: `activate:${placement.actionId}:${String(placement.rowIndex)}:${String(placement.columnIndex)}`,
          bounds: {
            row: contentBounds.row + placement.rowIndex,
            column: contentBounds.column + columnIndex,
            width: Math.max(1, Math.min(placement.width, contentBounds.width - columnIndex)),
            height: 1
          },
          accepts: ["click" as const, "contextMenu" as const],
          cursor: "pointer" as const,
          focus: { kind: "target" as const, targetId: placement.actionId },
          message: (event: RoutedPointerEvent): BrowserTuiMessage =>
            event.kind === "contextMenu" || event.button === "right"
              ? {
                kind: "openLinkMenu",
                actionId: placement.actionId,
                row: event.row,
                column: event.column
              }
              : {
                kind: "activateActionAt",
                actionId: placement.actionId,
                disposition: event.button === "middle"
                  ? "newBackground"
                  : event.modifiers.ctrl
                    ? "newForeground"
                    : "current"
              }
        };
      });
  }
};

function browserDocument(
  document: BrowserDocumentState,
  availableColumns: number
): Element<BrowserTuiMessage> {
  const contentColumns = Math.max(1, Math.floor(availableColumns) - 1);
  const layout = documentLayout(document, contentColumns);
  const scrollRow = documentScrollRow(document, layout);
  const children = forms(document).map((entry) => inlineForm(document, entry));
  const content = customComposite({
    id: `browser-${document.id}`,
    renderer: browserDocumentRenderer,
    state: document,
    children
  });
  return surface(viewport(content, {
    id: `browser-viewport-${document.id}`,
    scrollRow,
    scrollColumn: 0,
    contentRows: layout.rows.length,
    contentColumns,
    scrollbar: { axis: "vertical", visible: "auto" },
    scrollPolicy: { wheel: { unit: "line", rows: 3 } },
    onScroll: (event): BrowserTuiMessage => ({
      kind: "scrollTo",
      row: scrollReducer(event.scroll, event.action).offsetRow
    })
  }), {
    id: `browser-page-surface-${document.id}`,
    appearance: "neutral"
  });
}

function newTabDashboard(state: BrowserTuiState): Element<BrowserTuiMessage> {
  const recent = state.history.slice(0, 5).map((entry, index) => button({
    id: `new-tab-recent-${String(index)}`,
    label: entry.title,
    tone: "ghost",
    onPress: (): BrowserTuiMessage => ({ kind: "omniboxSubmit", value: entry.url })
  }));
  const bookmarks = state.bookmarks.slice(0, 5).map((entry, index) => button({
    id: `new-tab-bookmark-${String(index)}`,
    label: `★ ${entry.name}`,
    tone: "ghost",
    onPress: (): BrowserTuiMessage => ({ kind: "omniboxSubmit", value: entry.url })
  }));
  return surface(column([
    text("New Tab", { id: "new-tab-title", textRole: "title" }),
    text("Type a URL or search in the address bar.", { id: "new-tab-hint" }),
    ...(bookmarks.length > 0 ? [text("Bookmarks", { textRole: "heading" }), ...bookmarks] : []),
    ...(recent.length > 0 ? [text("Recent", { textRole: "heading" }), ...recent] : [])
  ], { gap: 1 }), {
    id: "new-tab-dashboard",
    padding: 1,
    maxWidth: 80,
    align: "center",
    meta: { accessibility: { role: "document", label: "New Tab" } }
  });
}

function panelEntryButton(id: string, label: string, target: string): Element<BrowserTuiMessage> {
  return button({
    id,
    label,
    tone: "ghost",
    onPress: (): BrowserTuiMessage => ({ kind: "omniboxSubmit", value: target })
  });
}

function compactLocation(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function sidePanel(state: BrowserTuiState): Element<BrowserTuiMessage> {
  const panel = state.sidePanel ?? "history";
  let content: readonly Element<BrowserTuiMessage>[];
  if (panel === "history") {
    content = state.history.slice(0, 30).map((entry, index) =>
      panelEntryButton(
        `history-${String(index)}`,
        `${entry.title} · ${compactLocation(entry.url)}`,
        entry.url
      )
    );
  } else if (panel === "bookmarks") {
    content = state.bookmarks.slice(0, 30).map((entry, index) =>
      panelEntryButton(`bookmark-${String(index)}`, `★ ${entry.name}`, entry.url)
    );
  } else {
    content = state.downloads.slice(0, 20).flatMap((download, index) => {
      const progress = progressBar({
        id: `download-progress-${String(index)}`,
        label: download.fileName,
        mode: download.totalBytes === null || download.status === "downloading" && download.receivedBytes === 0
          ? { kind: "indeterminate" }
          : download.totalBytes === 0
            ? { kind: "determinate", value: 1, max: 1 }
            : { kind: "determinate", value: download.receivedBytes, max: download.totalBytes },
        status: download.status === "completed"
          ? "success"
          : download.status === "failed"
            ? "error"
            : download.status === "downloading"
              ? "running"
              : "idle",
        barWidth: 18
      });
      const actions = download.status === "downloading"
        ? [button({
          id: `download-cancel-${String(index)}`,
          label: "Cancel",
          onPress: (): BrowserTuiMessage => ({ kind: "cancelDownload", id: download.id })
        })]
        : download.status === "completed"
          ? [
            button({
              id: `download-open-${String(index)}`,
              label: "Open",
              onPress: (): BrowserTuiMessage => ({ kind: "openDownload", id: download.id, location: "file" })
            }),
            button({
              id: `download-folder-${String(index)}`,
              label: "Folder",
              onPress: (): BrowserTuiMessage => ({ kind: "openDownload", id: download.id, location: "directory" })
            })
          ]
          : [button({
            id: `download-retry-${String(index)}`,
            label: "Retry",
            onPress: (): BrowserTuiMessage => ({ kind: "retryDownload", id: download.id })
          })];
      return [
        progress,
        row([
          ...actions,
          button({
            id: `download-remove-${String(index)}`,
            label: "Remove",
            onPress: (): BrowserTuiMessage => ({ kind: "removeDownload", id: download.id })
          })
        ], { gap: 1 })
      ];
    });
  }
  const header = row([
      button({
        id: "panel-history",
        label: "History",
        tone: panel === "history" ? "primary" : "ghost",
        onPress: (): BrowserTuiMessage => ({ kind: "toggleSidePanel", panel: "history" })
      }),
      button({
        id: "panel-bookmarks",
        label: "Bookmarks",
        tone: panel === "bookmarks" ? "primary" : "ghost",
        onPress: (): BrowserTuiMessage => ({ kind: "toggleSidePanel", panel: "bookmarks" })
      }),
      button({
        id: "panel-downloads",
        label: "Downloads",
        tone: panel === "downloads" ? "primary" : "ghost",
        onPress: (): BrowserTuiMessage => ({ kind: "toggleSidePanel", panel: "downloads" })
      })
    ], { gap: 1 });
  const panelContent = content.length === 0 ? [text(`No ${panel}.`)] : content;
  return surface(column([
    header,
    viewport(column(panelContent), {
      id: "browser-side-panel-scroll",
      scrollRow: state.sidePanelScroll.offsetRow,
      scrollColumn: 0,
      contentRows: panelContent.length,
      contentColumns: 38,
      scrollbar: { axis: "vertical", visible: "auto" },
      onScroll: (event): BrowserTuiMessage => ({ kind: "sidePanelScroll", event })
    })
  ], {
    sizes: [{ kind: "fixed", cells: 1 }, { kind: "fill" }]
  }), {
    id: "browser-side-panel",
    padding: { left: 1, right: 1 },
    appearance: "inset",
    border: { kind: "none" },
    meta: { accessibility: { role: "complementary", label: panel } }
  });
}

function toolbar(
  state: BrowserTuiState,
  document: BrowserDocumentState,
  columns: number
): Element<BrowserTuiMessage> {
  const bookmarked = state.bookmarks.some((entry) => entry.url === document.snapshot.finalUrl);
  const omnibox = commandInput({
    id: "browser-omnibox",
    prompt: document.loading ? "… " : "⌕ ",
    placeholder: "Search or enter address",
    presentation: commandInputPresentation(state.omnibox),
    display: "popup",
    placement: "below",
    maxVisibleSuggestions: 8,
    onAction: (action): BrowserTuiMessage => ({ kind: "omniboxAction", action }),
    onSubmit: (value): BrowserTuiMessage => ({ kind: "omniboxSubmit", value }),
    keys: { escape: (): BrowserTuiMessage => ({ kind: "cancelOmnibox" }) }
  });
  const showLibrary = columns >= 96;
  return surface(row([
    button({ id: "browser-back", label: "←", density: "compact", tone: "ghost", disabled: !document.canGoBack, onPress: (): BrowserTuiMessage => ({ kind: "navigate", operation: "back" }) }),
    button({ id: "browser-forward", label: "→", density: "compact", tone: "ghost", disabled: !document.canGoForward, onPress: (): BrowserTuiMessage => ({ kind: "navigate", operation: "forward" }) }),
    button({
      id: "browser-reload",
      label: document.loading ? "■" : "↻",
      density: "compact",
      tone: "ghost",
      onPress: (): BrowserTuiMessage => ({ kind: "navigate", operation: document.loading ? "stop" : "reload" })
    }),
    button({ id: "browser-new-tab", label: "+", density: "compact", tone: "ghost", onPress: (): BrowserTuiMessage => ({ kind: "newDocument" }) }),
    omnibox,
    button({ id: "browser-bookmark", label: bookmarked ? "★" : "☆", density: "compact", tone: "ghost", onPress: (): BrowserTuiMessage => ({ kind: "toggleBookmark" }) }),
    ...(showLibrary
      ? [button({
          id: "browser-library",
          label: "Library",
          density: "compact",
          tone: state.sidePanel === null ? "ghost" : "primary",
          onPress: (): BrowserTuiMessage => ({ kind: "toggleSidePanel", panel: "history" })
        })]
      : []),
    dropdownMenu({
      id: "browser-menu",
      items: browserMenuItems,
      presentation: dropdownMenuPresentation(
        browserMenuItems,
        state.overlay?.kind === "browserMenu" ? state.overlay.state : { kind: "closed" }
      ),
      placeholder: "☰",
      density: "compact",
      placement: "below",
      onAction: (action): BrowserTuiMessage => ({ kind: "browserMenuAction", action })
    })
  ], {
    id: "browser-toolbar",
    gap: 1,
    align: "center",
    sizes: [
      { kind: "content" },
      { kind: "content" },
      { kind: "content" },
      { kind: "content" },
      { kind: "fill" },
      { kind: "content" },
      ...(showLibrary ? [{ kind: "content" as const }] : []),
      { kind: "content" }
    ],
    meta: { accessibility: { role: "toolbar", label: "Browser navigation" } }
  }), {
    id: "browser-toolbar-surface",
    appearance: "bar",
    padding: { right: 1, bottom: 1, left: 1 }
  });
}

function findBar(state: BrowserTuiState): Element<BrowserTuiMessage> | null {
  if (state.findBar === null) return null;
  const document = state.documents[state.activeDocumentIndex];
  const search = document?.search;
  return row([
    textInput({
      id: "browser-find-input",
      presentation: textInputPresentation(state.findBar.input),
      placeholder: "Find in page",
      onAction: (action): BrowserTuiMessage => ({ kind: "findAction", action }),
      onSubmit: (): BrowserTuiMessage => ({ kind: "findSubmit" })
    }),
    text(search === null || search === undefined || search.matches.length === 0
      ? "0/0"
      : `${String(search.activeMatchIndex + 1)}/${String(search.matches.length)}`),
    button({ id: "find-previous", label: "↑", tone: "ghost", onPress: (): BrowserTuiMessage => ({ kind: "moveSearch", direction: "prev" }) }),
    button({ id: "find-next", label: "↓", tone: "ghost", onPress: (): BrowserTuiMessage => ({ kind: "moveSearch", direction: "next" }) }),
    button({ id: "find-close", label: "×", tone: "ghost", onPress: (): BrowserTuiMessage => ({ kind: "closeFind" }) })
  ], {
    id: "browser-find",
    gap: 1,
    sizes: [
      { kind: "fill" },
      { kind: "content" },
      { kind: "content" },
      { kind: "content" },
      { kind: "content" }
    ],
    meta: { accessibility: { role: "search", label: "Find in page" } }
  });
}

function baseView(state: BrowserTuiState, columns: number): Element<BrowserTuiMessage> {
  const selected = state.documents[state.activeDocumentIndex] ?? state.documents[0];
  if (!selected) throw new Error("The browser view requires an open document.");
  const pageColumns = state.sidePanel !== null && columns >= 100 ? columns - 41 : columns;
  const pagePanel = selected.snapshot.finalUrl === "about:newtab"
    ? newTabDashboard(state)
    : browserDocument(selected, pageColumns);
  const body = state.sidePanel !== null
    ? columns >= 100
      ? splitPane([pagePanel, sidePanel(state)], {
        id: "browser-content-with-panel",
        direction: "horizontal",
        gap: 1,
        sizes: [{ kind: "fill" }, { kind: "fixed", cells: 40 }]
      })
      : sidePanel(state)
    : pagePanel;
  const layout = documentLayout(selected, Math.max(1, pageColumns - 1));
  const find = findBar(state);
  const selectedPanel = column([
    toolbar(state, selected, columns),
    ...(find === null ? [] : [find]),
    body
  ], {
    id: "browser-selected-tab",
    sizes: [
      { kind: "fixed", cells: 2 },
      ...(find === null ? [] : [{ kind: "fixed" as const, cells: 1 }]),
      { kind: "fill" }
    ]
  });
  return column([
    tabs({
      id: "browser-tabs",
      selected: selected.id,
      maxTabWidth: 36,
      tabBarRows: 2,
      tabs: state.documents.map((document) => ({
        id: document.id,
        label: `${document.loading ? "◌ " : ""}${document.snapshot.content.title}`,
        closable: true,
        panel: document.id === selected.id ? selectedPanel : text("")
      })),
      onAction: (action): BrowserTuiMessage => ({ kind: "tabs", action })
    }),
    statusBar({
      id: "browser-status",
      leading: [{
        id: "status",
        kind: "status",
        text: selected.error ?? state.status?.text ?? selected.snapshot.finalUrl,
        status: selected.error !== null || state.status?.tone === "error"
          ? "error"
          : state.status?.tone === "success"
            ? "success"
            : selected.loading ? "running" : "info"
      }],
      trailing: [{
        id: "position",
        kind: "text",
        text: `${String(documentScrollRow(selected, layout) + 1)}/${String(Math.max(1, layout.rows.length))}`
      }]
    })
  ], {
    id: "browser-root",
    sizes: [
      { kind: "fill" },
      { kind: "fixed", cells: 1 }
    ]
  });
}

function actionPaletteView(palette: ActionPaletteOverlay): Element<BrowserTuiMessage> {
  return dialog(commandInput({
    id: "browser-action-input",
    prompt: ": ",
    placeholder: "Run browser action",
    presentation: commandInputPresentation(palette.state),
    ...(palette.validation === undefined ? {} : { validation: { level: "error" as const, message: palette.validation } }),
    display: "expanded",
    onAction: (action): BrowserTuiMessage => ({ kind: "actionPaletteAction", action }),
    onSubmit: (value): BrowserTuiMessage => ({ kind: "actionPaletteSubmit", value }),
    keys: { escape: (): BrowserTuiMessage => ({ kind: "dismiss" }) }
  }), {
    id: "browser-action-palette",
    title: "Browser actions",
    modal: true,
    focusPolicy: { initialFocus: { kind: "element", elementId: "browser-action-input" }, returnFocus: "restore" },
    width: 72,
    maxHeight: 12,
    padding: { left: 1, right: 1 }
  });
}

function pickerView(picker: PickerOverlay): Element<BrowserTuiMessage> {
  return dialog(searchPicker({
    id: "browser-picker-list",
    searchPickerIndex: picker.index,
    query: picker.state.query,
    selectedIndex: picker.state.selectedIndex,
    onAction: (action): BrowserTuiMessage => ({ kind: "pickerAction", action }),
    onSelect: (entry): BrowserTuiMessage => ({ kind: "pickerSelect", value: entry.value }),
    keys: {
      enter: (): BrowserTuiMessage => {
        const value = selectedSearchPickerEntry({ searchPickerIndex: picker.index, state: picker.state })?.value;
        return value === undefined ? { kind: "pickerSelect" } : { kind: "pickerSelect", value };
      },
      escape: (): BrowserTuiMessage => ({ kind: "dismiss" })
    }
  }), {
    id: "browser-picker",
    title: picker.title,
    modal: true,
    focusPolicy: { initialFocus: { kind: "element", elementId: "browser-picker-list" }, returnFocus: "restore" },
    width: 76,
    maxHeight: 18,
    padding: { left: 1, right: 1 }
  });
}

function detailView(detail: DetailOverlay): Element<BrowserTuiMessage> {
  return dialog(column(detail.lines.slice(detail.scrollRow).map((line, index) => text(line, {
    id: `detail-line-${String(index)}`
  }))), {
    id: "browser-detail",
    title: detail.title,
    modal: true,
    focusPolicy: { returnFocus: "restore" },
    keys: { escape: (): BrowserTuiMessage => ({ kind: "dismiss" }) },
    width: 82,
    maxHeight: 22,
    padding: { left: 1, right: 1 }
  });
}

function linkMenuView(menu: LinkMenuOverlay): Element<BrowserTuiMessage> {
  return contextMenu({
    id: "browser-link-menu",
    title: "Link",
    presentation: contextMenuPresentation(linkMenuItems, menu.state),
    placement: "cursor",
    onAction: (action): BrowserTuiMessage => ({ kind: "linkMenuAction", action })
  });
}

function downloadPromptView(prompt: DownloadPromptOverlay): Element<BrowserTuiMessage> {
  return dialog(column([
    text("This resource is not an HTML page."),
    text(prompt.target)
  ], { gap: 1 }), {
    id: "download-prompt",
    title: "Download resource?",
    modal: true,
    focusPolicy: {
      initialFocus: { kind: "element", elementId: "download-prompt-confirm" },
      returnFocus: "restore"
    },
    actions: row([
      button({
        id: "download-prompt-confirm",
        label: "Download",
        tone: "primary",
        onPress: (): BrowserTuiMessage => ({ kind: "download", target: prompt.target })
      }),
      button({ id: "download-prompt-cancel", label: "Cancel", onPress: (): BrowserTuiMessage => ({ kind: "dismiss" }) })
    ], { gap: 1 }),
    keys: { escape: (): BrowserTuiMessage => ({ kind: "dismiss" }) },
    width: 64,
    maxHeight: 9,
    padding: { left: 1, right: 1 }
  });
}

export function browserView(
  state: BrowserTuiState,
  context: Pick<TuiContext, "terminalSize"> = { terminalSize: { columns: 80, rows: 24 } }
): Element<BrowserTuiMessage> {
  const base = baseView(state, context.terminalSize.columns);
  if (state.overlay === null || state.overlay.kind === "browserMenu") return base;
  const transient = state.overlay.kind === "actionPalette"
    ? actionPaletteView(state.overlay)
    : state.overlay.kind === "picker"
      ? pickerView(state.overlay)
      : state.overlay.kind === "detail"
        ? detailView(state.overlay)
        : state.overlay.kind === "linkMenu"
          ? linkMenuView(state.overlay)
          : downloadPromptView(state.overlay);
  return overlay([base, transient], { id: "browser-layers" });
}
