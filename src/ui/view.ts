import {
  commandInputView,
  contextMenuView,
  createNumberInputConfiguration,
  createScrollState,
  createTextAreaState,
  menuTriggerView,
  numberInputView,
  radioGroupReducer,
  searchPickerView,
  textInputState
} from "@ismail-elkorchi/terminal-ui/behavior";
import {
  button,
  checkbox,
  checkboxGroup,
  combobox,
  commandInput,
  contextMenu,
  dialog,
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
  type CheckboxGroupTransition,
  type RadioGroupTransition
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

import type {
  DocumentChoiceControl,
  DocumentFormControl,
  DocumentNodeRef
} from "../document/index.js";
import type {
  TerminalAccessibilityBound,
  TerminalCellRow,
  TerminalFocusTarget,
  TerminalHitRegion,
  TerminalSearchResult,
  TerminalStyle as ActualTerminalStyle
} from "../presentation/terminal/index.js";
import { documentActionId } from "../presentation/formatting/index.js";
import {
  committedDocumentScrollRow,
  documentContentBounds
} from "./document-layout.js";
import type {
  ActionPaletteOverlay,
  BrowserDocumentState,
  BrowserTabState,
  BrowserTuiMessage,
  BrowserTuiState,
  DetailOverlay,
  DownloadPromptOverlay,
  LinkMenuOverlay,
  PickerOverlay
} from "./model.js";
import { browserMenuItems, formComboboxPageSize, linkMenuItems } from "./model.js";
import { terminalCellMeasurer } from "./terminal-measure.js";

const TERMINAL_CELL_MEASURER = terminalCellMeasurer();

interface BrowserDocumentComponentModel {
  readonly id: string;
  readonly source: BrowserDocumentState;
  readonly terminalRender: BrowserViewportTerminal;
  readonly finalUrl: string;
  readonly search: BrowserDocumentState["search"];
  readonly searchRangesByRow: ReadonlyMap<number, readonly {
    readonly match: string;
    readonly start: number;
    readonly end: number;
  }[]>;
  readonly controlGroups: readonly BrowserControlGroup[];
  readonly formEditors: BrowserDocumentState["formEditors"];
}

interface BrowserViewportTerminal {
  readonly cellBuffer: NonNullable<BrowserDocumentState["rendering"]["viewport"]>["cellBuffer"];
  readonly hitTestIndex: { readonly regions: readonly TerminalHitRegion[] };
  readonly focusMap: { readonly targets: readonly TerminalFocusTarget[] };
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly search: TerminalSearchResult | null;
  readonly documentRowCount: number;
  readonly visibleDocumentNodes: readonly DocumentNodeRef[];
  cellRectsForDocumentNode(node: DocumentNodeRef): readonly Rect[];
}

interface BrowserControlGroup {
  readonly form: DocumentNodeRef | null;
  readonly controls: readonly DocumentFormControl[];
}

interface BrowserDocumentComponentOptions {
  readonly document: BrowserDocumentComponentModel;
}

interface BrowserControlComponentOptions {
  readonly label: string;
  readonly node: DocumentNodeRef;
}

type BrowserDocumentAction = Extract<
  BrowserTuiMessage,
  { readonly kind: "activateActionAt" | "focusDocumentNode" | "openLinkMenu" }
>;

const browserControlSlots = {
  control: { cardinality: "one", owner: "caller", messages: "bubble" }
} as const;

const browserControlComponent = defineComponent<
  BrowserControlComponentOptions,
  BrowserControlComponentOptions,
  Extract<BrowserTuiMessage, { readonly kind: "focusDocumentNode" }>,
  never,
  readonly [],
  "required",
  readonly [],
  typeof browserControlSlots
>({
  name: "verge-browser/components/labelled-control",
  identity: "required",
  structure: "composite",
  semantics: "semantic",
  accessibleRole: "group",
  slots: browserControlSlots,
  measure({ slots }) {
    return slots.measure("control");
  },
  layout({ bounds }) {
    return { control: bounds };
  },
  accessibility({ id, model, slots }) {
    const control = slots.control[0];
    if (control === undefined) throw new Error("A labelled browser control requires its control slot.");
    const labelId = `${id}:label`;
    return {
      id,
      role: "group",
      label: model.label,
      children: [
        { id: labelId, role: "text", value: model.label, controls: control.id },
        { ...control, labelledBy: labelId }
      ]
    };
  },
  onFocus(event, { model }) {
    return {
      kind: "focusDocumentNode",
      target: event.kind === "focusEnter" ? model.node : null
    };
  }
});

function labelledBrowserControl(
  id: string,
  node: DocumentNodeRef,
  label: string,
  control: Element<BrowserTuiMessage>
): Element<BrowserTuiMessage> {
  return browserControlComponent({
    id: `${id}:labelled-control`,
    label,
    node,
    onAction: (action): BrowserTuiMessage => action,
    slots: { control }
  });
}

function terminalStyle(style: ActualTerminalStyle | undefined): TerminalStyle {
  if (style === undefined) return {};
  return {
    ...(style.foreground === null
      ? {}
      : {
        fg: {
          kind: "rgb" as const,
          r: style.foreground.r,
          g: style.foreground.g,
          b: style.foreground.b
        }
      }),
    ...(style.background === null
      ? {}
      : {
        bg: {
          kind: "rgb" as const,
          r: style.background.r,
          g: style.background.g,
          b: style.background.b
        }
      }),
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough
  };
}

function rowSegments(
  document: BrowserDocumentComponentModel,
  cellRow: TerminalCellRow,
  rowIndex: number
): readonly RenderSpan[] {
  type InlineRowAction = {
    readonly start: number;
    readonly end: number;
  } & ({ readonly kind: "link"; readonly destination: string } | { readonly kind: "disclosure" });
  const rowText = cellRow.text;
  const snapshot = document.source.snapshot.document;
  const inlineActions = cellRow.spans.flatMap((entry): InlineRowAction[] => {
    const action = entry.action;
    if (action === null || action.kind === "form-control") return [];
    const range = {
      start: entry.startCodeUnit,
      end: entry.endCodeUnit
    };
    return action.kind === "link"
      ? [{ ...range, kind: "link", destination: action.destination }]
      : [{ ...range, kind: "disclosure" }];
  });
  const active = document.search?.matches[document.search.activeMatchIndex]?.id;
  const searchRanges = (document.searchRangesByRow.get(rowIndex) ?? [])
    .map((range) => ({
      start: range.start,
      end: range.end,
      active: active === range.match
    }));
  const boundaries = new Set([0, rowText.length]);
  for (const range of [...inlineActions, ...searchRanges]) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const run of cellRow.styles) {
    boundaries.add(run.startCodeUnit);
    boundaries.add(run.endCodeUnit);
  }
  for (const span of cellRow.spans) {
    boundaries.add(span.startCodeUnit);
    boundaries.add(span.endCodeUnit);
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const spans: RenderSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? rowText.length;
    if (start >= end) continue;
    const inlineAction = inlineActions.find((range) => range.start <= start && range.end >= end);
    const search = searchRanges.find((range) => range.start <= start && range.end >= end);
    const authored = Object.assign(
      {},
      ...cellRow.styles
        .filter((run) =>
          run.startCodeUnit <= start && run.endCodeUnit >= end
        )
        .map((run) => terminalStyle(run.style))
    ) as TerminalStyle;
    const isControlText = cellRow.spans.some((span) =>
      span.startCodeUnit <= start
      && span.endCodeUnit >= end
      && span.documentNode !== null
      && snapshot.control(span.documentNode) !== null
    );
    const style: TerminalStyle = {
      ...(inlineAction?.kind !== "link"
        ? {}
        : {
          fg: themeColor("link.foreground"),
          underline: true
        }),
      ...authored,
      ...(search === undefined
        ? {}
        : search.active
          ? { inverse: true, bold: true }
          : { underline: true })
    };
    spans.push({
      text: isControlText
        ? " ".repeat(TERMINAL_CELL_MEASURER.width(rowText.slice(start, end)))
        : rowText.slice(start, end),
      style,
      ...(inlineAction?.kind !== "link" ? {} : { link: { href: inlineAction.destination } })
    });
  }
  return spans;
}

function controlGroups(controls: readonly DocumentFormControl[]): readonly BrowserControlGroup[] {
  const groups: BrowserControlGroup[] = [];
  const radioGroups = new Map<string, DocumentFormControl[]>();
  for (const control of controls) {
    if (control.kind !== "radio") continue;
    const groupName = control.name.length === 0
      ? control.node
      : `${control.form ?? "document"}\u0000${control.name}`;
    const group = radioGroups.get(groupName) ?? [];
    group.push(control);
    radioGroups.set(groupName, group);
  }
  const emittedRadios = new Set<string>();
  for (const control of controls) {
    if (control.kind === "hidden") continue;
    if (control.kind !== "radio") {
      groups.push({ form: control.form, controls: [control] });
      continue;
    }
    const groupName = control.name.length === 0
      ? control.node
      : `${control.form ?? "document"}\u0000${control.name}`;
    if (emittedRadios.has(groupName)) continue;
    emittedRadios.add(groupName);
    groups.push({ form: control.form, controls: radioGroups.get(groupName) ?? [control] });
  }
  return groups;
}

function radioGroupElementId(group: BrowserControlGroup): string | null {
  const first = group.controls[0];
  if (first?.kind !== "radio") return null;
  return `${group.form ?? "document"}:radio:${first.name.length === 0 ? first.node : first.name}`;
}

function documentNodeForTerminalFocusTarget(
  document: BrowserDocumentComponentModel,
  targetId: string
): DocumentNodeRef | null {
  const directControl = document.source.snapshot.document.control(targetId as DocumentNodeRef);
  if (directControl !== null) return directControl.node;
  for (const group of document.controlGroups) {
    if (radioGroupElementId(group) !== targetId) continue;
    return group.controls.find((control) => formControlValues(document, control).length > 0)?.node
      ?? group.controls[0]?.node
      ?? null;
  }
  const action = document.terminalRender.focusMap.targets.find(
    (candidate) => documentActionId(candidate.action) === targetId
  );
  return action?.node ?? null;
}

function formControlValues(document: BrowserDocumentComponentModel, control: DocumentFormControl): readonly string[] {
  const explicit = document.source.documentState.controls.get(control.node)?.values;
  if (explicit !== undefined) return explicit;
  if (control.kind === "hidden" || control.kind === "text" || control.kind === "textarea") return [control.defaultValue];
  if ((control.kind === "checkbox" || control.kind === "radio") && control.defaultChecked) return [control.value];
  if (control.kind === "select") return control.options.filter((option) => option.defaultSelected).map((option) => option.value);
  return [];
}

function formControlSelections(
  document: BrowserDocumentComponentModel,
  control: Extract<DocumentFormControl, { readonly kind: "select" }>
): ReadonlySet<DocumentNodeRef> {
  const explicit = document.source.documentState.controls.get(control.node)?.selected;
  if (explicit !== undefined) return new Set(explicit);
  const defaults = control.options.filter((option) => option.defaultSelected);
  const effective = control.multiple ? defaults : [defaults.at(-1) ?? control.options[0]];
  return new Set(effective.flatMap((option) => option === undefined ? [] : [option.node]));
}

function radioAction(
  controls: readonly DocumentChoiceControl[],
  selectedId: string | undefined,
  transition: RadioGroupTransition
): BrowserTuiMessage {
  const options = controls.map((control) => ({
    id: control.node,
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
  const next = radioGroupReducer(initial, transition, options);
  const nextId = next.selection.mode === "single" ? next.selection.selectedId : undefined;
  const control = controls.find((entry) => entry.node === nextId) ?? controls[0];
  if (!control) throw new Error("A radio group must contain at least one control.");
  return {
    kind: "formValues",
    controlId: control.node,
    values: nextId === undefined ? [] : [control.value]
  };
}

function multiChoiceAction(
  control: Extract<DocumentFormControl, { readonly kind: "select" }>,
  transition: CheckboxGroupTransition
): BrowserTuiMessage {
  return { kind: "formCheckboxGroup", controlId: control.node, transition };
}

function inlineFormControl(
  document: BrowserDocumentComponentModel,
  control: DocumentFormControl,
  formId: DocumentNodeRef | null
): Element<BrowserTuiMessage> | null {
  const values = formControlValues(document, control);
  if (control.kind === "hidden") return null;
  if (control.kind === "unsupported") {
    return text({ content: `${control.label}: ${control.reason}`, id: `${control.node}:unsupported` });
  }
  if (control.kind === "text") {
    const editor = document.formEditors[control.node];
    const value = values[0] ?? "";
    if (control.inputType === "number") {
      const numberEditor = editor?.kind === "number"
        ? editor.state
        : {
          input: { text: value, cursor: value.length },
          configuration: createNumberInputConfiguration({
            ...(control.min === null ? {} : { min: control.min }),
            ...(control.max === null ? {} : { max: control.max }),
            ...(control.step === null ? {} : { step: control.step })
          })
        };
      const numberOptions = {
        id: control.node,
        view: numberInputView(numberEditor),
        ...(control.placeholder === null ? {} : { placeholder: control.placeholder }),
        required: control.required
      };
      const input = control.disabled
        ? numberInput({ ...numberOptions, disabled: true })
        : numberInput({
          ...numberOptions,
          readOnly: control.readOnly,
          onTransition: (transition): BrowserTuiMessage => ({
            kind: "formNumber",
            controlId: control.node,
            transition
          })
        });
      return input;
    }
    const inputState = editor?.kind === "text"
      ? textInputState(editor.state)
      : { value, cursor: value.length };
    const inputOptions = {
      id: control.node,
      state: inputState,
      ...(control.placeholder === null ? {} : { placeholder: control.placeholder }),
      required: control.required
    };
    const input = control.inputType === "password"
      ? control.disabled
        ? passwordInput({ ...inputOptions, disabled: true })
        : passwordInput({
          ...inputOptions,
          readOnly: control.readOnly,
          onTransition: (transition): BrowserTuiMessage => ({
            kind: "formText",
            controlId: control.node,
            transition
          })
        })
      : control.disabled
        ? textInput({ ...inputOptions, disabled: true })
        : textInput({
          ...inputOptions,
          readOnly: control.readOnly,
          onTransition: (transition): BrowserTuiMessage => ({
            kind: "formText",
            controlId: control.node,
            transition
          })
        });
    return input;
  }
  if (control.kind === "textarea") {
    const editor = document.formEditors[control.node];
    const areaState = editor?.kind === "textarea"
      ? editor.state
      : createTextAreaState({
        value: values[0] ?? "",
        scroll: createScrollState()
      });
    const areaOptions = {
      id: control.node,
      state: areaState,
      wrap: true
    };
    const area = control.disabled
      ? textArea({ ...areaOptions, disabled: true })
      : textArea({
        ...areaOptions,
        readOnly: control.readOnly,
        onTransition: (
          transition: Extract<BrowserTuiMessage, { readonly kind: "formArea" }>["transition"]
        ): BrowserTuiMessage => ({ kind: "formArea", controlId: control.node, transition })
      });
    return area;
  }
  if (control.kind === "checkbox") {
    const checkboxOptions = {
      id: control.node,
      label: control.label,
      checked: values.includes(control.value),
      required: control.required
    };
    return control.disabled
      ? checkbox({ ...checkboxOptions, disabled: true })
      : checkbox({
        ...checkboxOptions,
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "formValues",
          controlId: control.node,
          values: transition.checked ? [control.value] : []
        })
      });
  }
  if (control.kind === "select") {
    const selectedNodes = formControlSelections(document, control);
    if (control.multiple) {
      const selectedIds = control.options.flatMap((option, index) =>
        selectedNodes.has(option.node) ? [`${control.node}:${String(index)}`] : []
      );
      const editor = document.formEditors[control.node];
      const groupOptions = {
        id: control.node,
        label: control.label,
        options: control.options.map((option, index) => ({
          id: `${control.node}:${String(index)}`,
          label: option.label,
          value: option.value,
          disabled: option.disabled
        })),
        state: editor?.kind === "checkboxGroup"
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
          onTransition: (transition): BrowserTuiMessage => multiChoiceAction(control, transition)
        });
    }
    const selectedIndex = control.options.findIndex((option) => selectedNodes.has(option.node));
    const editor = document.formEditors[control.node];
    const selectedId = selectedIndex < 0 ? undefined : `${control.node}:${String(selectedIndex)}`;
    const closedState = {
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
      id: control.node,
      label: control.label,
      options: control.options.map((option, index) => ({
        id: `${control.node}:${String(index)}`,
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
        state: closedState,
        disabled: true
      })
      : combobox({
        ...selectOptions,
        state: editor?.kind === "combobox" ? editor.state : closedState,
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "formComboboxTransition",
          controlId: control.node,
          transition
        }),
        onCommit: (event): BrowserTuiMessage => ({
          kind: "formComboboxCommit",
          controlId: control.node,
          event
        })
      });
  }
  if (control.kind === "submit") {
    const buttonOptions = {
      id: control.node,
      label: control.label || control.value || "Submit",
      tone: "primary" as const
    };
    return control.disabled || formId === null
      ? button({ ...buttonOptions, disabled: true })
      : button({
        ...buttonOptions,
        onPress: buttonAction({
          kind: "submitForm",
          formId,
          submitterId: control.node
        })
      });
  }
  if (control.kind === "reset") {
    const buttonOptions = {
      id: control.node,
      label: control.label || "Reset"
    };
    return control.disabled || formId === null
      ? button({ ...buttonOptions, disabled: true })
      : button({
        ...buttonOptions,
        onPress: buttonAction({
          kind: "resetForm",
          formId,
          resetterId: control.node
        })
      });
  }
  if (control.kind === "button") {
    const buttonOptions = {
      id: control.node,
      label: control.label || control.value || "Button"
    };
    return control.disabled
      ? button({ ...buttonOptions, disabled: true })
      : button({
        ...buttonOptions,
        onPress: buttonAction({ kind: "activateButton", controlId: control.node })
      });
  }
  return null;
}

function inlineControlGroup(
  document: BrowserDocumentComponentModel,
  group: BrowserControlGroup
): Element<BrowserTuiMessage> | null {
  const first = group.controls[0];
  if (first === undefined) return null;
  if (first.kind === "hidden") return null;
  if (first.kind !== "radio") {
    const control = inlineFormControl(document, first, group.form);
    return control === null
      ? null
      : labelledBrowserControl(first.node, first.node, first.label, control);
  }
  const controls = group.controls.filter(
    (control): control is DocumentChoiceControl => control.kind === "radio"
  );
  const selected = controls.find((candidate) => formControlValues(document, candidate).length > 0);
  const id = radioGroupElementId(group);
  if (id === null) throw new Error("A radio control group requires a radio-group identity.");
  const control = radioGroup({
    id,
    label: first.label,
    options: controls.map((candidate) => ({
      id: candidate.node,
      label: candidate.label,
      value: candidate.value,
      disabled: candidate.disabled
    })),
    state: {
      ...(selected === undefined ? {} : { activeId: selected.node }),
      selection: {
        mode: "single",
        ...(selected === undefined ? {} : { selectedId: selected.node })
      }
    },
    required: controls.some((candidate) => candidate.required),
    onTransition: (transition): BrowserTuiMessage => radioAction(controls, selected?.node, transition)
  });
  const focusNode = selected?.node ?? controls.find((candidate) => !candidate.disabled)?.node ?? first.node;
  return labelledBrowserControl(id, focusNode, first.label, control);
}

function browserDocumentChildBounds(
  document: BrowserDocumentComponentModel,
  bounds: Rect,
  childCount: number
): readonly Rect[] {
  const terminalRender = document.terminalRender;
  const contentBounds = documentContentBounds(bounds);
  const entries = document.controlGroups;
  return Array.from({ length: childCount }, (_, index) => {
    const entry = entries[index];
    if (!entry) {
      return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
    }
    const rectangles = entry.controls.flatMap((control) => terminalRender.cellRectsForDocumentNode(control.node))
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rectangles.length === 0) {
      return { row: contentBounds.row, column: contentBounds.column, width: 0, height: 0 };
    }
    let row = rectangles[0]?.row ?? 0;
    let column = rectangles[0]?.column ?? 0;
    let bottom = row;
    let edge = column;
    for (const rect of rectangles) {
      row = Math.min(row, rect.row);
      column = Math.min(column, rect.column);
      bottom = Math.max(bottom, rect.row + rect.height);
      edge = Math.max(edge, rect.column + rect.width);
    }
    return {
      row: contentBounds.row + row,
      column: contentBounds.column + column,
      width: Math.max(1, edge - column),
      height: Math.max(1, bottom - row)
    };
  });
}

const browserDocumentSlots = {
  controls: { cardinality: "many", owner: "caller", messages: "bubble" }
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
    const terminalRender = model.document.terminalRender;
    const childCount = slots.count("controls");
    const childBounds = browserDocumentChildBounds(
      model.document,
      bounds,
      childCount
    );
    return {
      minWidth: 0,
      minHeight: 0,
      preferredWidth: bounds.width,
      preferredHeight: childBounds.reduce(
        (height, child) => Math.max(height, child.row - bounds.row + child.height),
        terminalRender.documentRowCount
      )
    };
  },
  layout({ model, bounds, slots }) {
    return {
      controls: browserDocumentChildBounds(
        model.document,
        bounds,
        slots.count("controls")
      )
    };
  },
  renderBeforeChildren({ model, bounds, viewport: visibleBounds, target }) {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const document = model.document;
    const terminalRender = document.terminalRender;
    const contentBounds = documentContentBounds(bounds);
    const startIndex = Math.max(0, visibleBounds.row - contentBounds.row);
    const endIndexExclusive = Math.min(terminalRender.documentRowCount,
      visibleBounds.row + visibleBounds.height - contentBounds.row);
    for (const cellRow of terminalRender.cellBuffer.rows) {
      const rowIndex = cellRow.row;
      if (rowIndex < startIndex || rowIndex >= endIndexExclusive) continue;
      target.write(
        contentBounds.row + rowIndex,
        contentBounds.column,
        rowSegments(document, cellRow, rowIndex)
      );
    }
  },
  accessibility({ id, model, bounds, viewport: visibleBounds, focusedTargetId, slots }) {
    const document = model.document;
    const terminalRender = document.terminalRender;
    const contentBounds = documentContentBounds(bounds);
    const startIndex = Math.min(
      Math.max(0, visibleBounds.row - contentBounds.row),
      terminalRender.documentRowCount
    );
    const endIndexExclusive = Math.min(
      Math.max(startIndex, visibleBounds.row + visibleBounds.height - contentBounds.row),
      terminalRender.documentRowCount
    );
    const visibleSemantic = terminalRender.accessibilityBounds.filter((entry) => {
      if (document.source.snapshot.document.control(entry.documentNode) !== null) return false;
      if (focusedTargetId === `link:${entry.documentNode}`
        || focusedTargetId === `disclosure:${entry.documentNode}`) return true;
      if (entry.rect.width === 0 || entry.rect.height === 0) {
        return entry.rect.row >= startIndex && entry.rect.row < endIndexExclusive;
      }
      return entry.rect.row < endIndexExclusive && entry.rect.row + entry.rect.height > startIndex;
    });
    return {
      id,
      role: "document",
      label: document.source.snapshot.document.title,
      description: document.finalUrl,
      window: {
        startIndex,
        endIndexExclusive,
        totalCount: terminalRender.documentRowCount,
        omittedBefore: startIndex,
        omittedAfter: terminalRender.documentRowCount - endIndexExclusive
      },
      children: [
        ...visibleSemantic.map((entry) => ({
          id: `semantic:${entry.documentNode}`,
          role: entry.role === "heading" ? "heading" as const : entry.role === "link" ? "link" as const : "text" as const,
          label: entry.name,
          description: entry.description,
          ...(focusedTargetId === `link:${entry.documentNode}`
            || focusedTargetId === `control:${entry.documentNode}`
            || focusedTargetId === `disclosure:${entry.documentNode}`
            ? { focused: true }
            : {})
        })),
        ...slots.controls
      ]
    };
  },
  focusTargets({ model, bounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const document = model.document;
    const terminalRender = document.terminalRender;
    const contentBounds = documentContentBounds(bounds);
    return terminalRender.focusMap.targets
      .filter((target) => target.action.kind !== "form-control")
      .map((target) => {
      let row = target.rects[0]?.row ?? 0;
      let column = target.rects[0]?.column ?? 0;
      let bottom = row;
      let edge = column;
      for (const rect of target.rects) {
        row = Math.min(row, rect.row);
        column = Math.min(column, rect.column);
        bottom = Math.max(bottom, rect.row + rect.height);
        edge = Math.max(edge, rect.column + rect.width);
      }
      return {
        id: documentActionId(target.action),
        bounds: {
          row: contentBounds.row + row,
          column: contentBounds.column + column,
          width: target.rects.length === 0
            ? 0 : Math.max(1, Math.min(edge - column, contentBounds.width - column)),
          height: target.rects.length === 0 ? 0 : Math.max(1, bottom - row)
        }
      };
      });
  },
  onFocus(event) {
    return event.kind === "focusLeave"
      ? { kind: "focusDocumentNode", target: null }
      : ignoreMessage();
  },
  onFocusTarget(event, { model }) {
    if (event.kind === "focusTargetLeave") return ignoreMessage();
    const target = documentNodeForTerminalFocusTarget(model.document, event.targetId);
    return target === null
      ? ignoreMessage()
      : { kind: "focusDocumentNode", target };
  },
  hitTargets({ model, bounds, viewport: visibleBounds }) {
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const document = model.document;
    const terminalRender = document.terminalRender;
    const contentBounds = documentContentBounds(bounds);
    return terminalRender.hitTestIndex.regions
      .filter((placement) => placement.action.kind !== "form-control"
        && contentBounds.row + placement.rect.row < visibleBounds.row + visibleBounds.height
        && contentBounds.row + placement.rect.row + placement.rect.height > visibleBounds.row)
      .map((placement) => {
        const placementActionId = documentActionId(placement.action);
        const columnIndex = Math.min(contentBounds.width - 1, placement.rect.column);
        return {
          id: `activate:${placementActionId}:${placement.id}`,
          bounds: {
            row: contentBounds.row + placement.rect.row,
            column: contentBounds.column + columnIndex,
            width: Math.max(1, Math.min(placement.rect.width, contentBounds.width - columnIndex)),
            height: Math.max(1, placement.rect.height)
          },
          accepts: placement.action.kind === "link"
            ? ["click" as const, "contextMenu" as const, "pointerDown" as const]
            : ["click" as const, "pointerDown" as const],
          cursor: "pointer" as const,
          focus: { kind: "target" as const, targetId: placementActionId },
          message: (event: RoutedPointerEvent) =>
            event.kind === "pointerDown" && event.button !== "middle"
              ? ignoreMessage()
              : event.kind === "contextMenu" && placement.action.kind === "link"
                ? {
                  kind: "openLinkMenu",
                  actionId: placementActionId,
                  row: event.row,
                  column: event.column
                }
                : {
                  kind: "activateActionAt",
                  actionId: placementActionId,
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
  terminalRender: BrowserViewportTerminal
): Element<BrowserTuiMessage> {
  const scrollRow = committedDocumentScrollRow(document);
  const model = browserDocumentComponentModel(document, terminalRender);
  const children = model.controlGroups.flatMap((group) => {
    const element = inlineControlGroup(model, group);
    return element === null ? [] : [element];
  });
  const content = browserDocumentComponent({
    id: `browser-${document.id}`,
    document: model,
    slots: { controls: children },
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

function committedBrowserViewport(document: BrowserDocumentState): BrowserViewportTerminal | null {
  const payload = document.rendering.viewport;
  if (payload === null) return null;
  const rects = new Map(payload.cellRectsByDocumentNode);
  return {
    cellBuffer: payload.cellBuffer,
    hitTestIndex: { regions: payload.hitRegions },
    focusMap: { targets: payload.focusTargets },
    accessibilityBounds: payload.accessibilityBounds,
    search: payload.search,
    visibleDocumentNodes: Object.freeze([...rects.keys()]),
    documentRowCount: document.rendering.summary?.documentRowCount
      ?? payload.cellBuffer.documentRowCount,
    cellRectsForDocumentNode: (node) => rects.get(node) ?? [],
  };
}

function browserDocumentComponentModel(
  document: BrowserDocumentState,
  terminalRender: BrowserViewportTerminal
): BrowserDocumentComponentModel {
  const searchRangesByRow = new Map<number, {
    readonly match: string;
    readonly start: number;
    readonly end: number;
  }[]>();
  if (document.search !== null) {
    const retained = new Set(document.search.matches.map((match) => match.id));
    for (const match of terminalRender.search?.matches ?? []) {
      if (!retained.has(match.id)) continue;
      for (const range of match.ranges) {
        const entries = searchRangesByRow.get(range.row) ?? [];
        entries.push({ match: match.id, start: range.startCodeUnit, end: range.endCodeUnit });
        searchRangesByRow.set(range.row, entries);
      }
    }
  }
  return {
    id: document.id,
    source: document,
    terminalRender,
    finalUrl: document.snapshot.finalUrl,
    search: document.search,
    searchRangesByRow,
    controlGroups: controlGroups(terminalRender.visibleDocumentNodes.flatMap((node) => {
      const control = document.snapshot.document.control(node);
      return control === null ? [] : [control];
    })),
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
    onPress: buttonAction({ kind: "omniboxSubmit", value: entry.url })
  }));
  const bookmarks = state.bookmarks.slice(0, 5).map((entry, index) => button({
    id: `new-tab-bookmark-${String(index)}`,
    label: `★ ${entry.name}`,
    tone: "ghost",
    onPress: buttonAction({ kind: "omniboxSubmit", value: entry.url })
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
    onPress: buttonAction({ kind: "omniboxSubmit", value: target })
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
          onPress: buttonAction({ kind: "cancelDownload", id: download.id })
        })]
        : download.status === "completed"
          ? [
            button({
              id: `download-open-${String(index)}`,
              label: "Open",
              onPress: buttonAction({ kind: "openDownload", id: download.id, location: "file" })
            }),
            button({
              id: `download-folder-${String(index)}`,
              label: "Folder",
              onPress: buttonAction({ kind: "openDownload", id: download.id, location: "directory" })
            })
          ]
          : [button({
            id: `download-retry-${String(index)}`,
            label: "Retry",
            onPress: buttonAction({ kind: "retryDownload", id: download.id })
          })];
      return [
        progress,
        row([
          ...actions,
          button({
            id: `download-remove-${String(index)}`,
            label: "Remove",
            onPress: buttonAction({ kind: "removeDownload", id: download.id })
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
        onPress: buttonAction({ kind: "toggleSidePanel", panel: "history" })
      }),
      button({
        id: "panel-bookmarks",
        label: "Bookmarks",
        tone: panel === "bookmarks" ? "primary" : "ghost",
        onPress: buttonAction({ kind: "toggleSidePanel", panel: "bookmarks" })
      }),
      button({
        id: "panel-downloads",
        label: "Downloads",
        tone: panel === "downloads" ? "primary" : "ghost",
        onPress: buttonAction({ kind: "toggleSidePanel", panel: "downloads" })
      })
    ], { gap: 1 });
  const panelContent = content.length === 0 ? [text({ content: `No ${panel}.` })] : content;
  return surface(column([
    header,
    viewport(column(panelContent), {
      id: "browser-side-panel-scroll",
      offset: { row: state.sidePanelScroll.offsetRow },
      scrollbar: { axis: "vertical", visible: "auto" },
      onScroll: (request): BrowserTuiMessage => ({ kind: "sidePanelScroll", request })
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
  document: BrowserTabState,
  columns: number
): Element<BrowserTuiMessage> {
  const ready = document.kind === "ready" ? document : null;
  const currentUrl = document.kind === "ready" ? document.snapshot.finalUrl : document.requestedUrl;
  const loading = ready?.loading ?? document.kind === "loading";
  const bookmarked = state.bookmarks.some((entry) => entry.url === currentUrl);
  const omnibox = commandInput({
    id: "browser-omnibox",
    prompt: loading ? "… " : "⌕ ",
    placeholder: "Search or enter address",
    view: commandInputView(state.omnibox),
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
  const back = ready?.canGoBack === true
    ? button({
      id: "browser-back",
      label: "←",
      accessibleName: "Back",
      density: "compact",
      tone: "ghost",
      onPress: buttonAction({ kind: "navigate", operation: "back" })
    })
    : button({
      id: "browser-back",
      label: "←",
      accessibleName: "Back",
      density: "compact",
      tone: "ghost",
      disabled: true
    });
  const forward = ready?.canGoForward === true
    ? button({
      id: "browser-forward",
      label: "→",
      accessibleName: "Forward",
      density: "compact",
      tone: "ghost",
      onPress: buttonAction({ kind: "navigate", operation: "forward" })
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
      label: loading ? "■" : "↻",
      accessibleName: loading ? "Stop loading" : "Reload",
      density: "compact",
      tone: "ghost",
      onPress: buttonAction({ kind: "navigate", operation: loading ? "stop" : "reload" })
    }),
    button({
      id: "browser-new-tab",
      label: "+",
      accessibleName: "New tab",
      density: "compact",
      tone: "ghost",
      onPress: buttonAction({ kind: "newDocument" })
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
          onPress: buttonAction({ kind: "toggleSidePanel", panel: "history" })
        })]
      : []),
    menuTrigger({
      id: "browser-menu",
      items: browserMenuItems,
      view: menuTriggerView(
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
  const search = document?.kind === "ready" ? document.search : null;
  return row([
    textInput({
      id: "browser-find-input",
      state: textInputState(state.findBar.input),
      placeholder: "Find in page",
      onTransition: (transition): BrowserTuiMessage => ({ kind: "findAction", transition }),
      onSubmit: (): BrowserTuiMessage => ({ kind: "findSubmit" }),
      meta: { accessibleName: "Find in page" }
    }),
    text({
      content: search === null || search.matches.length === 0
        ? "0/0"
        : `${String(search.activeMatchIndex + 1)}/${String(search.matches.length)}${search.truncated ? "+" : ""}`
    }),
    button({ id: "find-previous", label: "↑", accessibleName: "Previous match", tone: "ghost", onPress: buttonAction({ kind: "moveSearch", direction: "prev" }) }),
    button({ id: "find-next", label: "↓", accessibleName: "Next match", tone: "ghost", onPress: buttonAction({ kind: "moveSearch", direction: "next" }) }),
    button({ id: "find-close", label: "×", accessibleName: "Close find", tone: "ghost", onPress: buttonAction({ kind: "closeFind" }) })
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

function baseView(state: BrowserTuiState, columns: number, rows: number): Element<BrowserTuiMessage> {
  const selected = state.documents[state.activeDocumentIndex] ?? state.documents[0];
  if (!selected) throw new Error("The browser view requires an open document.");
  const selectedUrl = selected.kind === "ready" ? selected.snapshot.finalUrl : selected.requestedUrl;
  const pageColumns = state.sidePanel !== null && columns >= 100 ? columns - 41 : columns;
  void pageColumns;
  void rows;
  const ready = selected.kind === "ready" ? selected : null;
  const terminalRender = ready === null ? null : committedBrowserViewport(ready);
  const incompleteRendering = terminalRender?.cellBuffer.outcome.status === "rejected"
    ? [`cell-buffer.${terminalRender.cellBuffer.outcome.reason}`]
    : terminalRender?.cellBuffer.outcome.status === "truncated"
      ? terminalRender.cellBuffer.outcome.truncations.map((entry) =>
        `terminal.${entry.budget}=${String(entry.limit)}`
      )
      : [];
  const allIncompleteRendering = [
    ...(ready?.rendering.summary?.incomplete ?? []),
    ...incompleteRendering,
  ];
  const incompleteStatus = allIncompleteRendering.length === 0
    ? null
    : `${selectedUrl} — rendering incomplete (${allIncompleteRendering.join(", ")})`;
  const pagePanel = ready === null
    ? surface(column([
        text({
          content: selected.kind === "failed"
            ? `Could not restore ${selectedUrl}`
            : `Restoring ${selectedUrl}…`,
        }),
        ...(selected.error === null ? [] : [text({ content: selected.error })]),
        ...(selected.kind === "failed"
          ? [button({
              id: `retry-${selected.id}`,
              label: "Retry",
              onPress: buttonAction({ kind: "restoreTab", documentId: selected.id }),
            })]
          : []),
      ]), { appearance: "neutral" })
    : ready.snapshot.finalUrl === "about:newtab"
    ? newTabDashboard(state)
    : terminalRender === null
      ? surface(column([
          text({ content: ready.rendering.status === "failed" ? "Rendering failed" : "Rendering page…" }),
          ...(ready.rendering.error === null ? [] : [text({ content: ready.rendering.error })]),
          ...(ready.rendering.status === "failed"
            ? [button({
                id: `retry-render-${ready.id}`,
                label: "Retry rendering",
                onPress: buttonAction({ kind: "requestActiveViewport" }),
              })]
            : []),
        ]), { appearance: "neutral" })
      : browserDocument(ready, terminalRender);
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
      state: { activeId: selected.id, selectedId: selected.id },
      maxTabWidth: 36,
      tabs: state.documents.map((document) => ({
        id: document.id,
        label: `${document.kind === "loading" || (document.kind === "ready" && document.loading) ? "◌ " : ""}${
          document.kind === "ready" ? document.snapshot.document.title : document.label
        }`,
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
        text: selected.error ?? incompleteStatus ?? state.status?.text
          ?? (selected.kind === "ready" ? selected.snapshot.finalUrl : selected.requestedUrl),
        status: selected.error !== null || incompleteStatus !== null || state.status?.tone === "error"
          ? "error"
          : state.status?.tone === "success"
            ? "success"
            : selected.kind === "loading" || (selected.kind === "ready" && selected.loading)
              ? "running"
              : "info"
      }],
      trailing: [{
        id: "position",
        kind: "text",
        text: selected.kind === "ready"
          ? `${String(committedDocumentScrollRow(selected) + 1)}/${String(Math.max(1, selected.rendering.summary?.documentRowCount ?? 1))}`
          : "…"
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
        view: commandInputView(palette.state),
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
        view: searchPickerView(picker.state),
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
    view: contextMenuView(linkMenuItems, menu.state),
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
          onPress: buttonAction({ kind: "download", target: prompt.target })
        }),
        button({ id: "download-prompt-cancel", label: "Cancel", onPress: buttonAction({ kind: "dismiss" }) })
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
  const base = baseView(state, context.terminalSize.columns, context.terminalSize.rows);
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
