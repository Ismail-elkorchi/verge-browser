import { createListboxCollection, createListboxView, createNumberInputConfiguration, createScrollState, createTextAreaState } from "@ismail-elkorchi/terminal-ui/behavior";
import { controlValues as documentControlValues, controlSelections as documentControlSelections, type DocumentFormControl, type DocumentNodeRef } from "../document/index.js";
import type { BrowserDocumentState } from "./model.js";

type SelectControl = Extract<DocumentFormControl, { readonly kind: "select" }>;
type SelectEditor = Extract<BrowserDocumentState["formEditors"][string], { readonly kind: "combobox" }>;
const selectOptions = new WeakMap<SelectControl, Pick<SelectEditor, "collection" | "optionsView">>();

type TextControl = Extract<DocumentFormControl, { readonly kind: "text" }>;

export function controlValues(document: BrowserDocumentState, control: DocumentFormControl): readonly string[] {
  return documentControlValues(document.documentState, control);
}

export function controlSelections(document: BrowserDocumentState, control: SelectControl): readonly DocumentNodeRef[] {
  return documentControlSelections(document.documentState, control);
}

export function controlOptions(control: SelectControl) {
  return control.options.map((option, index) => ({
    id: `${control.node}:${String(index)}`,
    label: option.label,
    value: option.value,
    disabled: option.disabled
  }));
}

export function textEditor(document: BrowserDocumentState, control: DocumentFormControl) {
  const current = document.formEditors[control.node];
  const value = controlValues(document, control)[0] ?? "";
  return current?.kind === "text" ? current.state : { text: value, cursor: value.length };
}

export function numberEditor(document: BrowserDocumentState, control: TextControl) {
  const current = document.formEditors[control.node];
  if (current?.kind === "number") return current.state;
  const value = controlValues(document, control)[0] ?? "";
  return {
    input: { text: value, cursor: value.length },
    configuration: createNumberInputConfiguration({
      ...(control.min === null ? {} : { min: control.min }),
      ...(control.max === null ? {} : { max: control.max }),
      ...(control.step === null ? {} : { step: control.step })
    })
  };
}

export function areaEditor(document: BrowserDocumentState, control: DocumentFormControl) {
  const current = document.formEditors[control.node];
  return current?.kind === "textarea" ? current.state : createTextAreaState({
    value: controlValues(document, control)[0] ?? "",
    scroll: createScrollState()
  });
}

export function selectEditor(document: BrowserDocumentState, control: SelectControl): SelectEditor {
  const current = document.formEditors[control.node];
  if (current?.kind === "combobox") return current;
  let options = selectOptions.get(control);
  if (options === undefined) {
    const collection = createListboxCollection(control.options, (option, index) => ({
      id: `${control.node}:${String(index)}`,
      label: option.label,
      disabled: option.disabled
    }));
    options = { collection, optionsView: createListboxView(collection) };
    selectOptions.set(control, options);
  }
  const selected = new Set(controlSelections(document, control));
  const selectedId = control.options.findIndex((option) => selected.has(option.node));
  const id = selectedId < 0 ? undefined : `${control.node}:${String(selectedId)}`;
  return {
    kind: "combobox" as const,
    state: {
      kind: "select" as const,
      open: false as const,
      interaction: {
        ...(id === undefined ? {} : { activeId: id }),
        selection: { mode: "single" as const, ...(id === undefined ? {} : { selectedId: id }) }
      }
    },
    ...options
  };
}

export function multiSelectEditor(document: BrowserDocumentState, control: SelectControl) {
  const current = document.formEditors[control.node];
  if (current?.kind === "checkboxGroup") return current.state;
  const selected = new Set(controlSelections(document, control));
  const selectedIds = control.options.flatMap((option, index) => selected.has(option.node) ? [`${control.node}:${String(index)}`] : []);
  return {
    ...(selectedIds[0] === undefined ? {} : { activeId: selectedIds[0] }),
    selection: { mode: "multiple" as const, selectedIds }
  };
}
