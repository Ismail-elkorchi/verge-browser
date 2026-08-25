import type { FormattingFormControlNode, FormattingTree } from "./types.js";

export interface ControlDisplayText {
  readonly label: string;
  readonly value: string;
  readonly text: string;
}

/** Serializes document control state for its atomic inline box. */
export function controlDisplayText(node: FormattingFormControlNode, tree: FormattingTree): ControlDisplayText {
  const control = node.control;
  const state = tree.state.controls.get(control.node);
  if (control.kind === "text" || control.kind === "textarea") {
    const value = state?.values[0] ?? control.defaultValue;
    return { label: control.label, value, text: `${control.label}: ${value || control.placeholder || ""}` };
  }
  if (control.kind === "checkbox" || control.kind === "radio") {
    const checked = state?.checked ?? control.defaultChecked;
    return { label: control.label, value: checked ? control.value : "", text: `${checked ? "[x]" : "[ ]"} ${control.label}` };
  }
  if (control.kind === "select") {
    const values = state?.values ?? control.options
      .filter((option) => option.defaultSelected)
      .map((option) => option.value);
    return { label: control.label, value: values.join(", "), text: `${control.label}: ${values.join(", ")}` };
  }
  if (control.kind === "submit" || control.kind === "reset") {
    return { label: control.label, value: control.value, text: `[${control.label || control.value}]` };
  }
  if (control.kind === "hidden") return { label: "", value: control.defaultValue, text: "" };
  return { label: control.label, value: "", text: `${control.label}: unsupported control` };
}
