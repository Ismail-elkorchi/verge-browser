import type { FormattingFormControlNode, FormattingTree } from "./types.js";
import type { DocumentDirection } from "../../document/index.js";

export interface ControlDisplayTextSegment {
  readonly kind: "control-decoration" | "control-value" | "label" | "placeholder";
  readonly text: string;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly direction: DocumentDirection;
}

export interface ControlDisplayText {
  readonly label: string;
  readonly value: string;
  readonly text: string;
  readonly segments: readonly ControlDisplayTextSegment[];
}

/** Serializes document control state for its atomic inline box. */
export function controlDisplayText(node: FormattingFormControlNode, tree: FormattingTree): ControlDisplayText {
  const control = node.control;
  const state = tree.state.controls.get(control.node);
  const indexedDirection = (kind: ControlDisplayTextSegment["kind"], value: string): DocumentDirection => {
    const renderedKind = kind === "control-decoration" ? null : kind;
    const indexed = renderedKind === null ? undefined : tree.document.directionality(control.node).renderedText
      .find((entry) => entry.kind === renderedKind && entry.value === value);
    return indexed?.direction ?? tree.document.directionForRenderedText(control.node, value);
  };
  const result = (
    label: string,
    value: string,
    parts: readonly { readonly kind: ControlDisplayTextSegment["kind"]; readonly text: string }[]
  ): ControlDisplayText => {
    let offset = 0;
    const segments: ControlDisplayTextSegment[] = [];
    for (const part of parts) {
      if (part.text.length === 0) continue;
      const start = offset;
      offset += part.text.length;
      segments.push(Object.freeze({
        ...part,
        contentStartCodeUnit: start,
        contentEndCodeUnit: offset,
        direction: indexedDirection(part.kind, part.text)
      }));
    }
    return Object.freeze({ label, value, text: segments.map((segment) => segment.text).join(""), segments: Object.freeze(segments) });
  };
  if (control.kind === "text" || control.kind === "textarea") {
    const value = state?.values[0] ?? control.defaultValue;
    const visibleValue = value || control.placeholder || "";
    return result(control.label, value, [
      { kind: "label", text: control.label },
      { kind: "control-decoration", text: control.label.length > 0 ? ": " : "" },
      { kind: value.length > 0 ? "control-value" : "placeholder", text: visibleValue }
    ]);
  }
  if (control.kind === "checkbox" || control.kind === "radio") {
    const checked = state?.checked ?? control.defaultChecked;
    return result(control.label, checked ? control.value : "", [
      { kind: "control-decoration", text: `${checked ? "[x]" : "[ ]"} ` },
      { kind: "label", text: control.label }
    ]);
  }
  if (control.kind === "select") {
    const values = state?.values ?? control.options
      .filter((option) => option.defaultSelected)
      .map((option) => option.value);
    const value = values.join(", ");
    return result(control.label, value, [
      { kind: "label", text: control.label },
      { kind: "control-decoration", text: control.label.length > 0 ? ": " : "" },
      { kind: "control-value", text: value }
    ]);
  }
  if (control.kind === "submit" || control.kind === "reset") {
    const label = control.label || control.value;
    return result(control.label, control.value, [
      { kind: "control-decoration", text: "[" },
      { kind: "label", text: label },
      { kind: "control-decoration", text: "]" }
    ]);
  }
  if (control.kind === "hidden") return result("", control.defaultValue, []);
  return result(control.label, "", [
    { kind: "label", text: control.label },
    { kind: "control-decoration", text: control.label.length > 0 ? ": unsupported control" : "unsupported control" }
  ]);
}
