import { controlValues, controlOptions, textEditor, numberEditor, areaEditor, selectEditor, multiSelectEditor } from "./form-editors.js";
import { numberInputView, radioGroupReducer } from "@ismail-elkorchi/terminal-ui/behavior";
import { button, checkbox, checkboxGroup, combobox, numberInput, passwordInput, radioGroup, text, textArea, textInput,
  type CheckboxGroupTransition, type RadioGroupTransition } from "@ismail-elkorchi/terminal-ui/components";
import { ignoreMessage, type Element } from "@ismail-elkorchi/terminal-ui/component";
import type { TerminalStyle } from "@ismail-elkorchi/terminal-ui/renderer";
import type { DocumentChoiceControl, DocumentFormControl, DocumentNodeRef, IndexedWebDocumentSnapshot } from "../document/index.js";
import type { BrowserDocumentState, BrowserTuiMessage } from "./model.js";
import { formComboboxPageSize } from "./model.js";

export type NativeControlSource = Pick<BrowserDocumentState, "documentState" | "formEditors"> & {
  readonly document: IndexedWebDocumentSnapshot;
};
/** Explicit part overrides preserve native focus/selection cues while pairing document colors. */
interface NativeControlStyles {
  readonly root?: TerminalStyle;
  readonly parts?: Readonly<Record<string, TerminalStyle>>;
}

function radioAction(
  controls: readonly DocumentChoiceControl[],
  selectedId: string | undefined,
  activeId: string,
  transition: RadioGroupTransition
): BrowserTuiMessage {
  const options = controls.map((control) => ({
    id: control.node,
    label: control.label,
    value: control.value,
    disabled: control.disabled
  }));
  const initial = {
    activeId,
    selection: {
      mode: "single" as const,
      ...(selectedId === undefined ? {} : { selectedId })
    }
  };
  const moved = radioGroupReducer(initial, transition, options);
  const next = transition.kind === "moveActive" || transition.kind === "firstActive" || transition.kind === "lastActive"
    ? radioGroupReducer(moved, { kind: "commitActive" }, options) : moved;
  const nextId = next.selection.mode === "single" ? next.selection.selectedId : undefined;
  const control = controls.find((entry) => entry.node === nextId) ?? controls[0];
  if (!control) throw new Error("A radio group must contain at least one control.");
  return {
    kind: "formValues",
    controlId: control.node,
    values: nextId === undefined ? [] : [control.value],
    focusTarget: control.node
  };
}

function multiChoiceAction(
  control: Extract<DocumentFormControl, { readonly kind: "select" }>,
  transition: CheckboxGroupTransition
): BrowserTuiMessage {
  return { kind: "formCheckboxGroup", controlId: control.node, transition };
}

export function nativeFormControl(
  document: NativeControlSource,
  control: DocumentFormControl,
  formId: DocumentNodeRef | null,
  style: TerminalStyle = {}
): Element<BrowserTuiMessage> | null {
  const parts = control.kind === "text"
    ? ["border", "value", "placeholder", "error", ...(control.inputType === "number" ? ["stepper"] : ["label"])]
    : control.kind === "textarea" ? ["value", "placeholder", "error"]
    : control.kind === "checkbox" || control.kind === "radio" || (control.kind === "select" && control.multiple)
      ? ["label", "marker", "option", "description", "error"]
      : control.kind === "select" ? ["label", "marker", "option", "description", "value", "placeholder", "error"]
      : ["frame", "marker", "leading", "label", "trailing"];
  // CSS chrome is already in the document cells. Clear widget base backgrounds
  // for ordinary parts so each cell inherits its own painted backdrop. Popup
  // options and selection retain their native surface/highlight contracts.
  const transparent: TerminalStyle = { ...style, bg: style.bg ?? null };
  const styles: NativeControlStyles = { root: style, parts: Object.fromEntries(parts.map((part) => [part,
    control.kind === "select" && !control.multiple && (part === "option" || part === "description") ? style : transparent])) };
  const values = controlValues(document, control);
  if (control.kind === "hidden") return null;
  if (control.kind === "unsupported") {
    return text({ content: `${control.label}: ${control.reason}`, id: `${control.node}:unsupported`,
      styles: { root: style, parts: { content: style } } });
  }
  if (control.kind === "text") {
    if (control.inputType === "number") {
      const editor = numberEditor(document, control);
      const numberOptions = {
        styles,
        id: control.node,
        view: numberInputView(editor),
        ...(control.placeholder === null ? {} : { placeholder: control.placeholder }),
        required: control.required
      };
      const input = numberInput({
        ...numberOptions,
        disabled: control.disabled,
        readOnly: control.readOnly,
        onTransition: (transition): BrowserTuiMessage => ({
          kind: "formNumber",
          controlId: control.node,
          transition
        })
      });
      return input;
    }
    const inputState = textEditor(document, control);
    const inputOptions = {
      styles,
      id: control.node,
      state: inputState,
      ...(control.placeholder === null ? {} : { placeholder: control.placeholder }),
      required: control.required
    };
    const input = (control.inputType === "password" ? passwordInput : textInput)({
      ...inputOptions,
      disabled: control.disabled,
      readOnly: control.readOnly,
      onSubmit: (): BrowserTuiMessage => ({ kind: "implicitSubmit", controlId: control.node }),
      onTransition: (transition): BrowserTuiMessage => ({ kind: "formText", controlId: control.node, transition })
    });
    return input;
  }
  if (control.kind === "textarea") {
    const areaState = areaEditor(document, control);
    const areaOptions = {
      styles,
      id: control.node,
      state: areaState,
      wrap: true
    };
    const area = textArea({
      ...areaOptions,
      disabled: control.disabled,
      readOnly: control.readOnly,
      onTransition: (
        transition: Extract<BrowserTuiMessage, { readonly kind: "formArea" }>["transition"]
      ): BrowserTuiMessage => ({ kind: "formArea", controlId: control.node, transition })
    });
    return area;
  }
  if (control.kind === "checkbox") {
    const checkboxOptions = {
      styles,
      id: control.node,
      label: "",
      checked: values.includes(control.value),
      required: control.required
    };
    return checkbox({
      ...checkboxOptions,
      disabled: control.disabled,
      onTransition: (transition): BrowserTuiMessage => ({
        kind: "formValues",
        controlId: control.node,
        values: transition.checked ? [control.value] : []
      })
    });
  }
  if (control.kind === "select") {
    if (control.multiple) {
      const groupOptions = {
        styles,
        id: control.node,
        label: control.label,
        labelVisibility: "hidden" as const,
        options: controlOptions(control),
        state: multiSelectEditor(document, control),
        required: control.required
      };
      return checkboxGroup({
        ...groupOptions,
        disabled: control.disabled,
        onTransition: (transition): BrowserTuiMessage => multiChoiceAction(control, transition)
      });
    }
    const editor = selectEditor(document, control);
    const selectOptions = {
      styles,
      id: control.node,
      label: control.label,
      labelVisibility: "hidden" as const,
      collection: editor.collection,
      optionsView: editor.optionsView,
      required: control.required,
      maxVisibleOptions: formComboboxPageSize
    };
    return combobox({
      disabled: control.disabled,
      ...selectOptions,
      state: editor.state,
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
    return button({
      styles,
      id: control.node,
      label: control.caption,
      accessibleName: control.label,
      tone: "primary",
      disabled: control.disabled || formId === null,
      onPress: () => formId === null ? ignoreMessage() : ({
        kind: "submitForm",
        formId,
        submitterId: control.node
      })
    });
  }
  if (control.kind === "reset") {
    return button({
      styles,
      id: control.node,
      label: control.caption,
      accessibleName: control.label,
      disabled: control.disabled || formId === null,
      onPress: () => formId === null ? ignoreMessage() : ({
        kind: "resetForm",
        formId,
        resetterId: control.node
      })
    });
  }
  if (control.kind === "button") {
    const buttonOptions = {
      id: control.node,
      label: control.caption,
      accessibleName: control.label
    };
    return button({
      styles,
        ...buttonOptions,
      disabled: control.disabled,
      onPress: () => ({ kind: "activateButton", controlId: control.node })
    });
  }
  const controls = document.document.radioGroup(control.node);
  const selected = controls.find((candidate) => controlValues(document, candidate).length > 0);
  return radioGroup({
    id: control.node, label: control.label, labelVisibility: "hidden", styles,
    options: [{ id: control.node, label: "", value: control.value, disabled: control.disabled }],
    state: { activeId: control.node, selection: { mode: "single",
      ...(selected?.node === control.node ? { selectedId: control.node } : {}) } },
    disabled: control.disabled, required: control.required,
    onTransition: (transition): BrowserTuiMessage => radioAction(controls, selected?.node, control.node, transition),
  });
}
