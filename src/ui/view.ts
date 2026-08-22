import {
  commandInputPresentation,
  contextMenuPresentation,
  createNumberInputConfiguration,
  createScrollState,
  createTextAreaState,
  menuTriggerPresentation,
  numberInputPresentation,
  radioGroupReducer,
  searchPickerPresentation,
  textInputPresentation
} from "@ismail-elkorchi/terminal-ui/behavior";
import {
  button,
  checkbox,
  checkboxGroup,
  combobox,
  commandInput,
  contextMenu,
  dialog,
  field,
  form,
  menuTrigger,
  numberInput,
  passwordInput,
  progressBar,
  radioGroup,
  searchPicker,
  statusBar,
  tabs,
  text,
  textArea,
  textInput,
  toggleButton,
  toolbar as toolbarComponent,
  type CheckboxGroupAction,
  type RadioGroupAction
} from "@ismail-elkorchi/terminal-ui/components";
import {
  defineComponent,
  ignoreMessage,
  type Element
} from "@ismail-elkorchi/terminal-ui/component";
import { column, overlay, row, splitPane, surface, viewport } from "@ismail-elkorchi/terminal-ui/layout";
import type { RoutedPointerEvent } from "@ismail-elkorchi/terminal-ui/input";
import type {
  Rect,
  RenderSpan,
  TerminalStyle
} from "@ismail-elkorchi/terminal-ui/renderer";
import type { TuiContext } from "@ismail-elkorchi/terminal-ui/tui";
import { themeColor } from "@ismail-elkorchi/terminal-ui/theme";

import { extractForms, type FormControl, type FormEntry } from "../app/forms.js";
import type {
  PageAction,
  PageBlock,
  PageLayout,
  PageLinkAction,
  PageLayoutRow,
  PageTextStyle
} from "../app/types.js";
import {
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
import { browserMenuItems, formComboboxPageSize, linkMenuItems } from "./model.js";

interface BrowserDocumentViewModel {
  readonly id: string;
  readonly content: BrowserDocumentState["snapshot"]["content"];
  readonly actionsById: ReadonlyMap<string, PageAction>;
  readonly blocksById: ReadonlyMap<string, PageBlock>;
  readonly linksByBlockId: ReadonlyMap<string, readonly PageLinkAction[]>;
  readonly linkPositionsById: ReadonlyMap<string, number>;
  readonly layout: PageLayout;
  readonly finalUrl: string;
  readonly search: BrowserDocumentState["search"];
  readonly forms: readonly FormEntry[];
  readonly formValues: BrowserDocumentState["formValues"];
  readonly formEditors: BrowserDocumentState["formEditors"];
}

interface BrowserDocumentComponentOptions {
  readonly document: BrowserDocumentViewModel;
}

type BrowserDocumentAction = Extract<
  BrowserTuiMessage,
  { readonly kind: "activateActionAt" | "openLinkMenu" }
>;

function actionForId(document: BrowserDocumentViewModel, id: string | undefined): PageAction | undefined {
  return id === undefined ? undefined : document.actionsById.get(id);
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
      fg: themeColor(
        block.kind === "heading" && block.level === 1 ? "accent.primary" : "text.strong"
      ),
      bold: true
    };
  }
  if (block.kind === "quote") {
    return { fg: themeColor("text.muted"), italic: true };
  }
  if (block.kind === "notice") {
    return { fg: themeColor("status.warning") };
  }
  return { fg: themeColor("text.default") };
}

function terminalStyle(style: PageTextStyle | undefined): TerminalStyle {
  if (style === undefined) return {};
  return {
    ...(style.foreground === undefined
      ? {}
      : { fg: { kind: "rgb" as const, ...style.foreground } }),
    ...(style.background === undefined
      ? {}
      : { bg: { kind: "rgb" as const, ...style.background } }),
    ...(style.bold === undefined ? {} : { bold: style.bold }),
    ...(style.italic === undefined ? {} : { italic: style.italic }),
    ...(style.underline === undefined ? {} : { underline: style.underline }),
    ...(style.strikethrough === undefined ? {} : { strikethrough: style.strikethrough })
  };
}

function rowSegments(
  document: BrowserDocumentViewModel,
  layoutRow: PageLayoutRow,
  rowIndex: number,
  focusedActionId: string | undefined
): readonly RenderSpan[] {
  const rowText = layoutRow.text;
  const links = layoutRow.fragments.flatMap((fragment) =>
    (document.linksByBlockId.get(fragment.blockId) ?? []).flatMap((link) => {
      const start = Math.max(link.textOffset, fragment.blockStartCodeUnitIndex);
      const end = Math.min(
        link.textOffset + link.label.length,
        fragment.blockEndCodeUnitIndexExclusive
      );
      return start >= end
        ? []
        : [{
          link,
          start: fragment.rowStartCodeUnitIndex + start - fragment.blockStartCodeUnitIndex,
          end: fragment.rowStartCodeUnitIndex + end - fragment.blockStartCodeUnitIndex
        }];
    })
  );
  const active = document.search?.matches[document.search.activeMatchIndex];
  const searchRanges: { readonly start: number; readonly end: number; readonly active: boolean }[] = [];
  for (const match of document.search?.matches ?? []) {
    if (match.rowIndex !== rowIndex) continue;
    for (const fragment of layoutRow.fragments) {
      if (fragment.blockId !== match.blockId) continue;
      const start = Math.max(match.startCodeUnitIndex, fragment.blockStartCodeUnitIndex);
      const end = Math.min(match.endCodeUnitIndexExclusive, fragment.blockEndCodeUnitIndexExclusive);
      if (start >= end) continue;
      searchRanges.push({
        start: fragment.rowStartCodeUnitIndex + start - fragment.blockStartCodeUnitIndex,
        end: fragment.rowStartCodeUnitIndex + end - fragment.blockStartCodeUnitIndex,
        active: active === match
      });
    }
  }
  const boundaries = new Set([0, rowText.length]);
  for (const range of [...links, ...searchRanges]) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const run of layoutRow.styleRuns) {
    boundaries.add(run.startCodeUnitIndex);
    boundaries.add(run.endCodeUnitIndexExclusive);
  }
  for (const fragment of layoutRow.fragments) {
    boundaries.add(fragment.rowStartCodeUnitIndex);
    boundaries.add(fragment.rowEndCodeUnitIndexExclusive);
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const spans: RenderSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? rowText.length;
    if (start >= end) continue;
    const link = links.find((range) => range.start <= start && range.end >= end)?.link;
    const search = searchRanges.find((range) => range.start <= start && range.end >= end);
    const fragment = layoutRow.fragments.find((candidate) =>
      candidate.rowStartCodeUnitIndex <= start
      && candidate.rowEndCodeUnitIndexExclusive >= end
    );
    const block = fragment === undefined ? undefined : document.blocksById.get(fragment.blockId);
    const authored = Object.assign(
      {},
      ...layoutRow.styleRuns
        .filter((run) =>
          run.startCodeUnitIndex <= start && run.endCodeUnitIndexExclusive >= end
        )
        .map((run) => terminalStyle(run.style))
    ) as TerminalStyle;
    const style: TerminalStyle = {
      ...(block === undefined ? {} : blockStyle(block)),
      ...(link === undefined
        ? {}
        : {
          fg: themeColor("link.foreground"),
          underline: true
        }),
      ...authored,
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
      ...(link === undefined ? {} : { link: { href: link.resolvedHref } })
    });
  }
  return spans;
}

function forms(document: BrowserDocumentViewModel): readonly FormEntry[] {
  return document.forms;
}

function formControlValues(document: BrowserDocumentViewModel, control: FormControl): readonly string[] {
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
  const options = controls.map((control) => ({
    id: control.id,
    label: control.label,
    value: control.value,
    disabled: control.disabled
  }));
  const initial = {
    ...(selectedId === undefined ? {} : { activeId: selectedId }),
    selection: {
      mode: "single" as const,
      ...(selectedId === undefined ? {} : { selectedId })
    }
  };
  const next = radioGroupReducer(initial, action, options);
  const nextId = next.selection.mode === "single" ? next.selection.selectedId : undefined;
  const control = controls.find((entry) => entry.id === nextId) ?? controls[0];
  if (!control) throw new Error("A radio group must contain at least one control.");
  return {
    kind: "formValues",
    controlId: control.id,
    values: nextId === undefined ? [] : [control.value]
  };
}

function multiChoiceAction(
  control: Extract<FormControl, { readonly kind: "select" }>,
  action: CheckboxGroupAction
): BrowserTuiMessage {
  return { kind: "formCheckboxGroup", controlId: control.id, action };
}

function inlineFormControl(
  document: BrowserDocumentViewModel,
  control: FormControl,
  formId: string
): Element<BrowserTuiMessage> | null {
  const values = formControlValues(document, control);
  if (control.kind === "hidden") return null;
  if (control.kind === "unsupported") {
    return text({ content: `${control.label}: ${control.reason}`, id: `${control.id}:unsupported` });
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
      const numberOptions = {
        id: control.id,
        presentation: numberInputPresentation(numberEditor),
        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
        required: control.required
      };
      const input = control.disabled
        ? numberInput({ ...numberOptions, disabled: true })
        : numberInput({
          ...numberOptions,
          readOnly: control.readOnly,
          onAction: (action): BrowserTuiMessage => ({
            kind: "formNumber",
            controlId: control.id,
            action
          })
        });
      return field({
        id: `${control.id}:field`,
        label: control.label,
        control: input
      });
    }
    const presentation = editor?.kind === "text"
      ? textInputPresentation(editor.state)
      : { value, cursor: value.length };
    const inputOptions = {
      id: control.id,
      presentation,
      ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
      required: control.required
    };
    const input = control.inputType === "password"
      ? control.disabled
        ? passwordInput({ ...inputOptions, disabled: true })
        : passwordInput({
          ...inputOptions,
          readOnly: control.readOnly,
          onAction: (action): BrowserTuiMessage => ({
            kind: "formText",
            controlId: control.id,
            action
          })
        })
      : control.disabled
        ? textInput({ ...inputOptions, disabled: true })
        : textInput({
          ...inputOptions,
          readOnly: control.readOnly,
          onAction: (action): BrowserTuiMessage => ({
            kind: "formText",
            controlId: control.id,
            action
          })
        });
    return field({
      id: `${control.id}:field`,
      label: control.label,
      control: input
    });
  }
  if (control.kind === "textarea") {
    const editor = document.formEditors[control.id];
    const presentation = editor?.kind === "textarea"
      ? editor.state
      : createTextAreaState({
        value: values[0] ?? "",
        scroll: createScrollState()
      });
    const areaOptions = {
      id: control.id,
      presentation,
      wrap: true
    };
    const area = control.disabled
      ? textArea({ ...areaOptions, disabled: true })
      : textArea({
        ...areaOptions,
        readOnly: control.readOnly,
        onAction: (
          action: Extract<BrowserTuiMessage, { readonly kind: "formArea" }>["action"]
        ): BrowserTuiMessage => ({ kind: "formArea", controlId: control.id, action })
      });
    return field({
      id: `${control.id}:field`,
      label: control.label,
      control: area
    });
  }
  if (control.kind === "checkbox") {
    const checkboxOptions = {
      id: control.id,
      label: control.label,
      checked: values.includes(control.value),
      required: control.required
    };
    return control.disabled
      ? checkbox({ ...checkboxOptions, disabled: true })
      : checkbox({
        ...checkboxOptions,
        onAction: (action): BrowserTuiMessage => ({
          kind: "formValues",
          controlId: control.id,
          values: action.checked ? [control.value] : []
        })
      });
  }
  if (control.kind === "select") {
    if (control.multiple) {
      const selectedIds = control.options.flatMap((option, index) =>
        values.includes(option.value) ? [`${control.id}:${String(index)}`] : []
      );
      const editor = document.formEditors[control.id];
      const groupOptions = {
        id: control.id,
        label: control.label,
        options: control.options.map((option, index) => ({
          id: `${control.id}:${String(index)}`,
          label: option.label,
          value: option.value,
          disabled: option.disabled
        })),
        presentation: editor?.kind === "checkboxGroup"
          ? editor.state
          : {
            ...(selectedIds[0] === undefined ? {} : { activeId: selectedIds[0] }),
            selection: { mode: "multiple" as const, selectedIds }
          },
        required: control.required
      };
      return control.disabled
        ? checkboxGroup({ ...groupOptions, disabled: true })
        : checkboxGroup({
          ...groupOptions,
          onAction: (action): BrowserTuiMessage => multiChoiceAction(control, action)
        });
    }
    const selectedIndex = control.options.findIndex((option) => values.includes(option.value));
    const editor = document.formEditors[control.id];
    const selectedId = selectedIndex < 0 ? undefined : `${control.id}:${String(selectedIndex)}`;
    const closedPresentation = {
      kind: "select" as const,
      open: false as const,
      interaction: {
        ...(selectedId === undefined ? {} : { activeId: selectedId }),
        selection: {
          mode: "single" as const,
          ...(selectedId === undefined ? {} : { selectedId })
        }
      }
    };
    const selectOptions = {
      id: control.id,
      label: control.label,
      options: control.options.map((option, index) => ({
        id: `${control.id}:${String(index)}`,
        label: option.label,
        value: option.value,
        disabled: option.disabled
      })),
      required: control.required,
      maxVisibleOptions: formComboboxPageSize
    };
    return control.disabled
      ? combobox({
        ...selectOptions,
        presentation: closedPresentation,
        disabled: true
      })
      : combobox({
        ...selectOptions,
        presentation: editor?.kind === "combobox" ? editor.state : closedPresentation,
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "formComboboxTransition",
          controlId: control.id,
          transition
        }),
        onCommit: (event): BrowserTuiMessage => ({
          kind: "formComboboxCommit",
          controlId: control.id,
          event
        })
      });
  }
  if (control.kind === "submit") {
    const buttonOptions = {
      id: control.id,
      label: control.label || control.value || "Submit",
      tone: "primary" as const
    };
    return control.disabled
      ? button({ ...buttonOptions, disabled: true })
      : button({
        ...buttonOptions,
        onAction: buttonAction({
          kind: "submitForm",
          formId,
          submitterId: control.id
        })
      });
  }
  if (control.kind === "reset") {
    const buttonOptions = {
      id: control.id,
      label: control.label || "Reset"
    };
    return control.disabled
      ? button({ ...buttonOptions, disabled: true })
      : button({
        ...buttonOptions,
        onAction: buttonAction({
          kind: "resetForm",
          formId
        })
      });
  }
  return null;
}

function inlineForm(document: BrowserDocumentViewModel, entry: FormEntry): Element<BrowserTuiMessage> {
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
        presentation: {
          ...(selected === undefined ? {} : { activeId: selected.id }),
          selection: {
            mode: "single",
            ...(selected === undefined ? {} : { selectedId: selected.id })
          }
        },
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
      onAction: buttonAction({ kind: "submitForm", formId: entry.id })
    }));
  }
  return form({
    id: entry.id,
    title: entry.label,
    gap: 0,
    slots: { content: controls }
  });
}

function browserDocumentChildBounds(
  document: BrowserDocumentViewModel,
  bounds: Rect,
  childCount: number
): readonly Rect[] {
  const layout = document.layout;
  const contentBounds = documentContentBounds(bounds);
  const entries = forms(document);
  const placements = new Map(layout.blockPlacements.map((placement) => [
    placement.blockId,
    placement
  ]));
  return Array.from({ length: childCount }, (_, index) => {
    const entry = entries[index];
    if (!entry) {
      return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
    }
    const placement = placements.get(entry.id);
    if (placement === undefined) {
      return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
    }
    return {
      row: contentBounds.row + placement.rowIndex,
      column: contentBounds.column + placement.columnIndex,
      width: placement.width,
      height: placement.height
    };
  });
}

const browserDocumentSlots = {
  forms: { cardinality: "many", owner: "caller", messages: "bubble" }
} as const;

const browserDocumentComponent = defineComponent<
  BrowserDocumentComponentOptions,
  BrowserDocumentComponentOptions,
  BrowserDocumentAction,
  never,
  readonly [],
  "required",
  readonly [],
  typeof browserDocumentSlots
>({
  name: "verge-browser/components/document",
  identity: "required",
  structure: "composite",
  semantics: "semantic",
  accessibleRole: "document",
  slots: browserDocumentSlots,
  measure({ model, constraints, slots }) {
    const bounds = {
      row: 0,
      column: 0,
      width: constraints.width,
      height: constraints.height
    };
    const layout = model.document.layout;
    const childCount = slots.count("forms");
    const childBounds = browserDocumentChildBounds(
      model.document,
      bounds,
      childCount
    );
    return {
      minWidth: 0,
      minHeight: 0,
      preferredWidth: bounds.width,
      preferredHeight: Math.max(
        layout.rows.length,
        ...childBounds.map((child) => child.row - bounds.row + child.height)
      )
    };
  },
  layout({ model, bounds, slots }) {
    return {
      forms: browserDocumentChildBounds(
        model.document,
        bounds,
        slots.count("forms")
      )
    };
  },
  renderBeforeChildren({ model, bounds, viewport: visibleBounds, target, focusedTargetId }) {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const document = model.document;
    const layout = document.layout;
    const focusedAction = actionForId(document, focusedTargetId);
    const contentBounds = documentContentBounds(bounds);
    const formIds = new Set(forms(document).map((entry) => entry.id));
    const startIndex = Math.max(0, visibleBounds.row - contentBounds.row);
    const endIndexExclusive = Math.min(
      layout.rows.length,
      visibleBounds.row + visibleBounds.height - contentBounds.row
    );
    const canvas = terminalStyle(layout.canvasStyle);
    if (canvas.bg !== undefined || canvas.fg !== undefined) {
      for (let rowIndex = startIndex; rowIndex < endIndexExclusive; rowIndex += 1) {
        target.write(
          contentBounds.row + rowIndex,
          contentBounds.column,
          [{ text: " ".repeat(contentBounds.width), style: canvas }]
        );
      }
    }
    for (let rowIndex = startIndex; rowIndex < endIndexExclusive; rowIndex += 1) {
      const layoutRow = layout.rows[rowIndex];
      if (!layoutRow || layoutRow.fragments.length > 0
        && layoutRow.fragments.every((fragment) => formIds.has(fragment.blockId))) continue;
      target.write(
        contentBounds.row + rowIndex,
        contentBounds.column,
        rowSegments(document, layoutRow, rowIndex, focusedAction?.id)
      );
    }
  },
  accessibility({ id, model, bounds, viewport: visibleBounds, focusedTargetId, slots }) {
    const document = model.document;
    const layout = document.layout;
    const contentBounds = documentContentBounds(bounds);
    const startIndex = Math.min(
      Math.max(0, visibleBounds.row - contentBounds.row),
      layout.rows.length
    );
    const endIndexExclusive = Math.min(
      Math.max(startIndex, visibleBounds.row + visibleBounds.height - contentBounds.row),
      layout.rows.length
    );
    const visibleBlockIds = new Set(
      layout.rows
        .slice(startIndex, endIndexExclusive)
        .flatMap((row) => row.fragments.map((fragment) => fragment.blockId))
    );
    const focusedAction = actionForId(document, focusedTargetId);
    const visibleActionIds = new Set(layout.actionPlacements
      .filter((placement) =>
        placement.rowIndex >= startIndex
        && placement.rowIndex < endIndexExclusive
      )
      .map((placement) => placement.actionId));
    const visibleActions = document.content.actions.filter((action) =>
      visibleActionIds.has(action.id)
    );
    return {
      id,
      role: "document",
      label: document.content.title,
      description: document.finalUrl,
      window: {
        startIndex,
        endIndexExclusive,
        totalCount: layout.rows.length,
        omittedBefore: startIndex,
        omittedAfter: layout.rows.length - endIndexExclusive
      },
      children: [
        ...[...visibleBlockIds].flatMap((blockId) => {
          const block = document.blocksById.get(blockId);
          return block === undefined || block.kind === "form" ? [] : [accessibleBlock(block)];
        }),
        ...visibleActions.filter((action) => action.kind === "link").map((action) => ({
          id: action.id,
          role: "link" as const,
          label: action.label,
          ...(focusedAction?.id === action.id ? { focused: true } : {}),
          position: {
            positionInSet: document.linkPositionsById.get(action.id) ?? 1,
            setSize: document.content.links.length
          }
        })),
        ...slots.forms
      ]
    };
  },
  focusTargets({ model, bounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const document = model.document;
    const layout = document.layout;
    const contentBounds = documentContentBounds(bounds);
    const seen = new Set<string>();
    return layout.actionPlacements
      .flatMap((placement) => {
        const action = actionForId(document, placement.actionId);
        if (action?.kind !== "link"
          || seen.has(placement.actionId)) {
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
  hitTargets({ model, bounds, viewport: visibleBounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const document = model.document;
    const layout = document.layout;
    const contentBounds = documentContentBounds(bounds);
    return layout.actionPlacements
      .filter((placement) => {
        const action = actionForId(document, placement.actionId);
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
          accepts: ["click" as const, "contextMenu" as const, "pointerDown" as const],
          cursor: "pointer" as const,
          focus: { kind: "target" as const, targetId: placement.actionId },
          message: (event: RoutedPointerEvent) =>
            event.kind === "pointerDown" && event.button !== "middle"
              ? ignoreMessage()
              : event.kind === "contextMenu"
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
});

function browserDocument(
  document: BrowserDocumentState,
  availableColumns: number
): Element<BrowserTuiMessage> {
  const contentColumns = Math.max(1, Math.floor(availableColumns) - 1);
  const layout = documentLayout(document, contentColumns);
  const scrollRow = documentScrollRow(document, layout);
  const model = browserDocumentViewModel(document, layout);
  const children = forms(model).map((entry) => inlineForm(model, entry));
  const content = browserDocumentComponent({
    id: `browser-${document.id}`,
    document: model,
    slots: { forms: children },
    onAction: (action): BrowserTuiMessage => action
  });
  return surface(viewport(content, {
    id: `browser-viewport-${document.id}`,
    offset: { row: scrollRow },
    scrollbar: { axis: "vertical", visible: "auto" },
    scrollPolicy: { wheel: { unit: "line", rows: 3 } },
    onScroll: (event): BrowserTuiMessage => ({
      kind: "scrollTo",
      row: event.nextState.offsetRow
    })
  }), {
    id: `browser-page-surface-${document.id}`,
    appearance: "neutral"
  });
}

function browserDocumentViewModel(
  document: BrowserDocumentState,
  layout: PageLayout
): BrowserDocumentViewModel {
  const content = document.snapshot.content;
  const linksByBlockId = new Map<string, PageLinkAction[]>();
  for (const link of content.links) {
    const links = linksByBlockId.get(link.blockId) ?? [];
    links.push(link);
    linksByBlockId.set(link.blockId, links);
  }
  return {
    id: document.id,
    content,
    actionsById: new Map(content.actions.map((action) => [action.id, action])),
    blocksById: new Map(content.blocks.map((block) => [block.id, block])),
    linksByBlockId,
    linkPositionsById: new Map(content.links.map((link, index) => [link.id, index + 1])),
    layout,
    finalUrl: document.snapshot.finalUrl,
    search: document.search,
    forms: extractForms(document.snapshot.document.tree, document.snapshot.finalUrl),
    formValues: document.formValues,
    formEditors: document.formEditors
  };
}

function buttonAction(message: BrowserTuiMessage) {
  return (): BrowserTuiMessage => message;
}

function newTabDashboard(state: BrowserTuiState): Element<BrowserTuiMessage> {
  const recent = state.history.slice(0, 5).map((entry, index) => button({
    id: `new-tab-recent-${String(index)}`,
    label: entry.title,
    tone: "ghost",
    onAction: buttonAction({ kind: "omniboxSubmit", value: entry.url })
  }));
  const bookmarks = state.bookmarks.slice(0, 5).map((entry, index) => button({
    id: `new-tab-bookmark-${String(index)}`,
    label: `★ ${entry.name}`,
    tone: "ghost",
    onAction: buttonAction({ kind: "omniboxSubmit", value: entry.url })
  }));
  return surface(column([
    text({ content: "New Tab", id: "new-tab-title", textRole: "title" }),
    text({ content: "Type a URL or search in the address bar.", id: "new-tab-hint" }),
    ...(bookmarks.length > 0 ? [text({ content: "Bookmarks", textRole: "heading" }), ...bookmarks] : []),
    ...(recent.length > 0 ? [text({ content: "Recent", textRole: "heading" }), ...recent] : [])
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
    onAction: buttonAction({ kind: "omniboxSubmit", value: target })
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
          onAction: buttonAction({ kind: "cancelDownload", id: download.id })
        })]
        : download.status === "completed"
          ? [
            button({
              id: `download-open-${String(index)}`,
              label: "Open",
              onAction: buttonAction({ kind: "openDownload", id: download.id, location: "file" })
            }),
            button({
              id: `download-folder-${String(index)}`,
              label: "Folder",
              onAction: buttonAction({ kind: "openDownload", id: download.id, location: "directory" })
            })
          ]
          : [button({
            id: `download-retry-${String(index)}`,
            label: "Retry",
            onAction: buttonAction({ kind: "retryDownload", id: download.id })
          })];
      return [
        progress,
        row([
          ...actions,
          button({
            id: `download-remove-${String(index)}`,
            label: "Remove",
            onAction: buttonAction({ kind: "removeDownload", id: download.id })
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
        onAction: buttonAction({ kind: "toggleSidePanel", panel: "history" })
      }),
      button({
        id: "panel-bookmarks",
        label: "Bookmarks",
        tone: panel === "bookmarks" ? "primary" : "ghost",
        onAction: buttonAction({ kind: "toggleSidePanel", panel: "bookmarks" })
      }),
      button({
        id: "panel-downloads",
        label: "Downloads",
        tone: panel === "downloads" ? "primary" : "ghost",
        onAction: buttonAction({ kind: "toggleSidePanel", panel: "downloads" })
      })
    ], { gap: 1 });
  const panelContent = content.length === 0 ? [text({ content: `No ${panel}.` })] : content;
  return surface(column([
    header,
    viewport(column(panelContent), {
      id: "browser-side-panel-scroll",
      offset: { row: state.sidePanelScroll.offsetRow },
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

function browserToolbar(
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
    onTransition: (transition): BrowserTuiMessage => ({
      kind: "omniboxTransition",
      transition
    }),
    onSubmit: (event): BrowserTuiMessage => ({ kind: "omniboxSubmit", value: event.value }),
    meta: { accessibleName: "Address and search" }
  });
  const showLibrary = columns >= 96;
  const back = document.canGoBack
    ? button({
      id: "browser-back",
      label: "←",
      accessibleName: "Back",
      density: "compact",
      tone: "ghost",
      onAction: buttonAction({ kind: "navigate", operation: "back" })
    })
    : button({
      id: "browser-back",
      label: "←",
      accessibleName: "Back",
      density: "compact",
      tone: "ghost",
      disabled: true
    });
  const forward = document.canGoForward
    ? button({
      id: "browser-forward",
      label: "→",
      accessibleName: "Forward",
      density: "compact",
      tone: "ghost",
      onAction: buttonAction({ kind: "navigate", operation: "forward" })
    })
    : button({
      id: "browser-forward",
      label: "→",
      accessibleName: "Forward",
      density: "compact",
      tone: "ghost",
      disabled: true
    });
  return surface(toolbarComponent(row([
    back,
    forward,
    button({
      id: "browser-reload",
      label: document.loading ? "■" : "↻",
      accessibleName: document.loading ? "Stop loading" : "Reload",
      density: "compact",
      tone: "ghost",
      onAction: buttonAction({ kind: "navigate", operation: document.loading ? "stop" : "reload" })
    }),
    button({
      id: "browser-new-tab",
      label: "+",
      accessibleName: "New tab",
      density: "compact",
      tone: "ghost",
      onAction: buttonAction({ kind: "newDocument" })
    }),
    omnibox,
    toggleButton({
      id: "browser-bookmark",
      label: bookmarked ? "★" : "☆",
      accessibleName: "Bookmark current page",
      pressed: bookmarked,
      density: "compact",
      tone: "ghost",
      onTransition: () => ({ kind: "toggleBookmark" })
    }),
    ...(showLibrary
      ? [button({
          id: "browser-library",
          label: "Library",
          density: "compact",
          tone: state.sidePanel === null ? "ghost" : "primary",
          onAction: buttonAction({ kind: "toggleSidePanel", panel: "history" })
        })]
      : []),
    menuTrigger({
      id: "browser-menu",
      items: browserMenuItems,
      presentation: menuTriggerPresentation(
        browserMenuItems,
        state.overlay?.kind === "browserMenu" ? state.overlay.state : { kind: "closed" }
      ),
      placeholder: "☰",
      density: "compact",
      placement: "below",
      onTransition: (transition): BrowserTuiMessage => ({
        kind: "browserMenuTransition",
        transition
      }),
      onActivate: (event): BrowserTuiMessage => ({ kind: "browserMenuActivate", event }),
      meta: { accessibleName: "Browser menu" }
    })
  ], {
    id: "browser-toolbar-layout",
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
    ]
  }), {
    id: "browser-toolbar",
    label: "Browser navigation"
  }), {
    id: "browser-toolbar-surface",
    appearance: "bar",
    padding: { right: 1, left: 1 }
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
      onAction: (action): BrowserTuiMessage => action.kind === "submit"
        ? { kind: "findSubmit" }
        : { kind: "findAction", action },
      meta: { accessibleName: "Find in page" }
    }),
    text({
      content: search === null || search === undefined || search.matches.length === 0
        ? "0/0"
        : `${String(search.activeMatchIndex + 1)}/${String(search.matches.length)}`
    }),
    button({ id: "find-previous", label: "↑", accessibleName: "Previous match", tone: "ghost", onAction: buttonAction({ kind: "moveSearch", direction: "prev" }) }),
    button({ id: "find-next", label: "↓", accessibleName: "Next match", tone: "ghost", onAction: buttonAction({ kind: "moveSearch", direction: "next" }) }),
    button({ id: "find-close", label: "×", accessibleName: "Close find", tone: "ghost", onAction: buttonAction({ kind: "closeFind" }) })
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
    browserToolbar(state, selected, columns),
    ...(find === null ? [] : [find]),
    body
  ], {
    id: "browser-selected-tab",
    sizes: [
      { kind: "fixed", cells: 1 },
      ...(find === null ? [] : [{ kind: "fixed" as const, cells: 1 }]),
      { kind: "fill" }
    ]
  });
  return column([
    tabs({
      id: "browser-tabs",
      presentation: { activeId: selected.id, selectedId: selected.id },
      maxTabWidth: 36,
      tabs: state.documents.map((document) => ({
        id: document.id,
        label: `${document.loading ? "◌ " : ""}${document.snapshot.content.title}`,
        closable: true,
        panel: document.id === selected.id ? selectedPanel : text({ content: "" })
      })),
      onTransition: (transition): BrowserTuiMessage => ({
        kind: "tabsTransition",
        transition
      }),
      onClose: (event): BrowserTuiMessage => ({ kind: "tabsClose", event }),
      meta: { accessibleName: "Browser tabs" }
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
  return dialog({
    id: "browser-action-palette",
    title: "Browser actions",
    modal: true,
    focusPolicy: { initialFocus: { kind: "element", elementId: "browser-action-input" }, returnFocus: "restore" },
    slots: {
      content: commandInput({
        id: "browser-action-input",
        prompt: ": ",
        placeholder: "Run browser action",
        presentation: commandInputPresentation(palette.state),
        ...(palette.validation === undefined ? {} : { validation: { level: "error" as const, message: palette.validation } }),
        display: "expanded",
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "actionPaletteTransition",
          transition
        }),
        onSubmit: (event): BrowserTuiMessage => ({
          kind: "actionPaletteSubmit",
          value: event.value
        }),
        meta: { accessibleName: "Browser action" }
      })
    },
    width: 72,
    maxHeight: 12,
    padding: { left: 1, right: 1 }
  });
}

function pickerView(picker: PickerOverlay): Element<BrowserTuiMessage> {
  return dialog({
    id: "browser-picker",
    title: picker.title,
    modal: true,
    focusPolicy: { initialFocus: { kind: "element", elementId: "browser-picker-list" }, returnFocus: "restore" },
    slots: {
      content: searchPicker({
        id: "browser-picker-list",
        searchPickerIndex: picker.index,
        presentation: searchPickerPresentation(picker.state),
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "pickerTransition",
          transition
        }),
        onAccept: (event): BrowserTuiMessage => ({ kind: "pickerAccept", event }),
        meta: { accessibleName: picker.title }
      })
    },
    width: 76,
    maxHeight: 18,
    padding: { left: 1, right: 1 }
  });
}

function detailView(detail: DetailOverlay): Element<BrowserTuiMessage> {
  return dialog({
    id: "browser-detail",
    title: detail.title,
    modal: true,
    focusPolicy: { returnFocus: "restore" },
    slots: {
      content: column(detail.lines.slice(detail.scrollRow).map((line, index) => text({
        id: `detail-line-${String(index)}`,
        content: line
      })))
    },
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
    onTransition: (transition): BrowserTuiMessage => ({
      kind: "linkMenuTransition",
      transition
    }),
    onActivate: (event): BrowserTuiMessage => ({ kind: "linkMenuActivate", event })
  });
}

function downloadPromptView(prompt: DownloadPromptOverlay): Element<BrowserTuiMessage> {
  return dialog({
    id: "download-prompt",
    title: "Download resource?",
    modal: true,
    focusPolicy: {
      initialFocus: { kind: "element", elementId: "download-prompt-confirm" },
      returnFocus: "restore"
    },
    slots: {
      content: column([
        text({ content: "This resource is not an HTML page." }),
        text({ content: prompt.target })
      ], { gap: 1 }),
      actions: row([
        button({
          id: "download-prompt-confirm",
          label: "Download",
          tone: "primary",
          onAction: buttonAction({ kind: "download", target: prompt.target })
        }),
        button({ id: "download-prompt-cancel", label: "Cancel", onAction: buttonAction({ kind: "dismiss" }) })
      ], { gap: 1 })
    },
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
