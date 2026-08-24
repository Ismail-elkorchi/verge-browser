import {
  findAllByTagName,
  getAttributeValue,
  hasAttribute,
  type DocumentTree,
  type ElementNode
} from "@ismail-elkorchi/html-parser";

import { extractCompleteText } from "./text.js";
import type { PageRequestOptions } from "./types.js";
import { resolveHref } from "./url.js";

const MAX_FORMS_PER_PAGE = 256;
const MAX_CONTROLS_PER_FORM = 2_000;
const MAX_OPTIONS_PER_SELECT = 2_000;

export interface FormControlBase {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly required: boolean;
}

export interface FormTextControl extends FormControlBase {
  readonly kind: "text";
  readonly inputType: "text" | "search" | "email" | "url" | "tel" | "password" | "number";
  readonly value: string;
  readonly placeholder?: string;
  readonly readOnly: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface FormTextareaControl extends FormControlBase {
  readonly kind: "textarea";
  readonly value: string;
  readonly placeholder?: string;
  readonly readOnly: boolean;
}

export interface FormCheckboxControl extends FormControlBase {
  readonly kind: "checkbox";
  readonly value: string;
  readonly checked: boolean;
}

export interface FormRadioControl extends FormControlBase {
  readonly kind: "radio";
  readonly value: string;
  readonly checked: boolean;
}

export interface FormSelectOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface FormSelectControl extends FormControlBase {
  readonly kind: "select";
  readonly multiple: boolean;
  readonly options: readonly FormSelectOption[];
}

export interface FormHiddenControl {
  readonly id: string;
  readonly kind: "hidden";
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
}

export interface FormButtonControl extends FormControlBase {
  readonly kind: "submit" | "reset";
  readonly value: string;
}

export interface FormUnsupportedControl extends FormControlBase {
  readonly kind: "unsupported";
  readonly inputType: string;
  readonly reason: string;
}

export type FormControl =
  | FormTextControl
  | FormTextareaControl
  | FormCheckboxControl
  | FormRadioControl
  | FormSelectControl
  | FormHiddenControl
  | FormButtonControl
  | FormUnsupportedControl;

export interface FormEntry {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly method: string;
  readonly encoding: string;
  readonly actionUrl: string;
  readonly controls: readonly FormControl[];
}

function formLabel(formNode: ElementNode, controls: readonly FormControl[], index: number): string {
  const explicit = getAttributeValue(formNode, "aria-label") ?? getAttributeValue(formNode, "title");
  if (explicit?.trim()) return explicit.trim();
  const legend = formNode.children.find(
    (child): child is ElementNode =>
      child.kind === "element" && child.localName.toLowerCase() === "legend"
  );
  const legendText = legend === undefined
    ? ""
    : extractCompleteText(legend).replace(/\s+/gu, " ").trim();
  if (legendText.length > 0) return legendText;
  const searchControl = controls.find(
    (control): control is FormTextControl =>
      control.kind === "text" && control.inputType === "search"
  );
  if (getAttributeValue(formNode, "role")?.toLowerCase() === "search" || searchControl !== undefined) {
    return searchControl?.label ?? "Search";
  }
  return `Form ${String(index)}`;
}

export interface FormControlValue {
  readonly controlId: string;
  /** A null value explicitly marks a choice control as unsuccessful. */
  readonly value: string | null;
}

export interface FormSubmissionRequest {
  readonly url: string;
  readonly requestOptions: PageRequestOptions;
}

interface FormControlNode {
  readonly node: ElementNode;
  readonly disabledByFieldset: boolean;
}

function collectFormControls(formNode: ElementNode): readonly FormControlNode[] {
  const controls: FormControlNode[] = [];
  const pending: FormControlNode[] = [...formNode.children]
    .reverse()
    .filter((child): child is ElementNode => child.kind === "element")
    .map((node) => ({ node, disabledByFieldset: false }));
  while (pending.length > 0 && controls.length < MAX_CONTROLS_PER_FORM) {
    const current = pending.pop();
    if (!current) continue;
    const { node, disabledByFieldset } = current;
    const tag = node.localName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") {
      controls.push(current);
      continue;
    }
    const disabledFieldset = tag === "fieldset" && hasAttribute(node, "disabled");
    const firstLegend = disabledFieldset
      ? node.children.find((child): child is ElementNode =>
        child.kind === "element" && child.localName.toLowerCase() === "legend")
      : undefined;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child?.kind === "element") {
        pending.push({
          node: child,
          disabledByFieldset: disabledByFieldset || (disabledFieldset && child !== firstLegend)
        });
      }
    }
  }
  return controls;
}

function optionNodes(selectNode: ElementNode): readonly { readonly node: ElementNode; readonly disabled: boolean }[] {
  const options: { readonly node: ElementNode; readonly disabled: boolean }[] = [];
  const pending = [{ node: selectNode, disabled: false }];
  while (pending.length > 0 && options.length < MAX_OPTIONS_PER_SELECT) {
    const current = pending.pop();
    if (!current) continue;
    const { node } = current;
    if (node !== selectNode && node.localName.toLowerCase() === "option") {
      options.push(current);
      continue;
    }
    const disabled = current.disabled
      || (node.localName.toLowerCase() === "optgroup" && hasAttribute(node, "disabled"));
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child?.kind === "element") pending.push({ node: child, disabled });
    }
  }
  return options;
}

function controlLabel(
  control: ElementNode,
  labelsByTarget: ReadonlyMap<string, string>
): string {
  const target = getAttributeValue(control, "id");
  const explicit = target == null ? undefined : labelsByTarget.get(`attribute:${target}`);
  return explicit
    ?? labelsByTarget.get(`node:${String(control.id)}`)
    ?? getAttributeValue(control, "aria-label")
    ?? getAttributeValue(control, "placeholder")
    ?? getAttributeValue(control, "name")
    ?? "Unnamed control";
}

function labels(tree: DocumentTree): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const pending = [...tree.children].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.kind !== "element") continue;
    if (node.localName.toLowerCase() !== "label") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) pending.push(child);
      }
      continue;
    }
    const target = getAttributeValue(node, "for");
    const text = extractCompleteText(node).replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    if (target) values.set(`attribute:${target}`, text);
    const labelChildren = [...node.children];
    while (labelChildren.length > 0) {
      const child = labelChildren.pop();
      if (!child || child.kind !== "element") continue;
      if (["input", "textarea", "select", "button"].includes(child.localName.toLowerCase())) {
        values.set(`node:${String(child.id)}`, text);
      }
      labelChildren.push(...child.children);
    }
  }
  return values;
}

function commonControl(
  node: ElementNode,
  labelsByTarget: ReadonlyMap<string, string>,
  disabledByFieldset = false
): FormControlBase {
  return {
    id: `control:${String(node.id)}`,
    name: getAttributeValue(node, "name") ?? "",
    label: controlLabel(node, labelsByTarget),
    disabled: disabledByFieldset || hasAttribute(node, "disabled"),
    required: hasAttribute(node, "required")
  };
}

function extractControl(
  node: ElementNode,
  labelsByTarget: ReadonlyMap<string, string>,
  disabledByFieldset = false
): FormControl {
  const tag = node.localName.toLowerCase();
  const common = commonControl(node, labelsByTarget, disabledByFieldset);
  if (tag === "textarea") {
    const placeholder = getAttributeValue(node, "placeholder");
    return {
      ...common,
      kind: "textarea",
      value: extractCompleteText(node),
      ...(placeholder == null ? {} : { placeholder }),
      readOnly: hasAttribute(node, "readonly")
    };
  }
  if (tag === "select") {
    const optionEntries = optionNodes(node);
    const hasSelectedOption = optionEntries.some((entry) =>
      hasAttribute(entry.node, "selected")
    );
    const options = optionEntries.map((entry, index) => ({
      value: getAttributeValue(entry.node, "value") ?? extractCompleteText(entry.node),
      label: extractCompleteText(entry.node).replace(/\s+/gu, " ").trim(),
      selected: hasAttribute(entry.node, "selected")
        || (!hasAttribute(node, "multiple") && !hasSelectedOption && index === 0),
      disabled: entry.disabled || hasAttribute(entry.node, "disabled")
    }));
    return { ...common, kind: "select", multiple: hasAttribute(node, "multiple"), options };
  }
  if (tag === "button") {
    const type = (getAttributeValue(node, "type") ?? "submit").toLowerCase();
    if (type === "submit" || type === "reset") {
      const buttonText = extractCompleteText(node).replace(/\s+/gu, " ").trim();
      return {
        ...common,
        label: buttonText || common.label,
        kind: type,
        value: getAttributeValue(node, "value") ?? ""
      };
    }
    return { ...common, kind: "unsupported", inputType: type, reason: `Unsupported button type: ${type}` };
  }

  const inputType = (getAttributeValue(node, "type") ?? "text").toLowerCase();
  const value = getAttributeValue(node, "value") ?? (inputType === "checkbox" || inputType === "radio" ? "on" : "");
  if (inputType === "hidden") {
    return { id: common.id, kind: "hidden", name: common.name, value, disabled: common.disabled };
  }
  if (inputType === "checkbox" || inputType === "radio") {
    return { ...common, kind: inputType, value, checked: hasAttribute(node, "checked") };
  }
  if (inputType === "submit" || inputType === "reset") {
    return { ...common, kind: inputType, value: value || (inputType === "submit" ? "Submit" : "Reset") };
  }
  if (["text", "search", "email", "url", "tel", "password", "number"].includes(inputType)) {
    const placeholder = getAttributeValue(node, "placeholder");
    const rawMin = inputType === "number" ? finiteNumberAttribute(node, "min") : undefined;
    const rawMax = inputType === "number" ? finiteNumberAttribute(node, "max") : undefined;
    const validRange = rawMin === undefined || rawMax === undefined || rawMin <= rawMax;
    const min = validRange ? rawMin : undefined;
    const max = validRange ? rawMax : undefined;
    const rawStep = inputType === "number" ? finiteNumberAttribute(node, "step") : undefined;
    const step = rawStep !== undefined && rawStep > 0 ? rawStep : undefined;
    return {
      ...common,
      kind: "text",
      inputType: inputType as FormTextControl["inputType"],
      value,
      ...(placeholder == null ? {} : { placeholder }),
      readOnly: hasAttribute(node, "readonly"),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step })
    };
  }
  return {
    ...common,
    kind: "unsupported",
    inputType,
    reason: inputType === "file"
      ? "File uploads are not supported."
      : `Unsupported input type: ${inputType}`
  };
}

function normalizeMethod(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "post" || normalized === "dialog" ? normalized : "get";
}

function finiteNumberAttribute(node: ElementNode, name: string): number | undefined {
  const raw = getAttributeValue(node, name);
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function extractForms(tree: DocumentTree, baseUrl: string): readonly FormEntry[] {
  const forms: FormEntry[] = [];
  const labelsByTarget = labels(tree);
  let formIndex = 0;
  for (const formNode of findAllByTagName(tree, "form")) {
    if (formIndex >= MAX_FORMS_PER_PAGE) break;
    const actionRaw = getAttributeValue(formNode, "action") ?? baseUrl;
    const controls = collectFormControls(formNode).map(({ node, disabledByFieldset }) =>
      extractControl(node, labelsByTarget, disabledByFieldset)
    );
    const index = formIndex + 1;
    forms.push({
      id: `form:${String(formNode.id)}`,
      index,
      label: formLabel(formNode, controls, index),
      method: normalizeMethod(getAttributeValue(formNode, "method")),
      encoding: (getAttributeValue(formNode, "enctype") ?? "application/x-www-form-urlencoded").toLowerCase(),
      actionUrl: resolveHref(actionRaw, baseUrl),
      controls
    });
    formIndex += 1;
  }
  return forms;
}

function successfulValues(
  form: FormEntry,
  values: readonly FormControlValue[],
  submitterId?: string
): URLSearchParams {
  const replacements = new Map<string, (string | null)[]>();
  for (const entry of values) {
    const current = replacements.get(entry.controlId) ?? [];
    current.push(entry.value);
    replacements.set(entry.controlId, current);
  }
  const params = new URLSearchParams();
  for (const control of form.controls) {
    if (control.disabled || control.name.length === 0 || control.kind === "reset" || control.kind === "unsupported") continue;
    if (control.kind === "submit") {
      if (control.id === submitterId) params.append(control.name, control.value);
      continue;
    }
    const supplied = replacements.get(control.id);
    if (supplied !== undefined) {
      const enabledSelectValues = control.kind === "select"
        ? new Set(control.options.filter((option) => !option.disabled).map((option) => option.value))
        : null;
      for (const value of supplied) {
        if (value === null) continue;
        if (enabledSelectValues === null || enabledSelectValues.has(value)) {
          params.append(control.name, value);
        }
      }
      continue;
    }
    if (control.kind === "hidden" || control.kind === "text" || control.kind === "textarea") {
      params.append(control.name, control.value);
      continue;
    }
    if ((control.kind === "checkbox" || control.kind === "radio") && control.checked) {
      params.append(control.name, control.value);
      continue;
    }
    if (control.kind === "select") {
      for (const option of control.options) {
        if (option.selected && !option.disabled) params.append(control.name, option.value);
      }
    }
  }
  return params;
}

export function buildGetSubmissionUrl(
  form: FormEntry,
  values: readonly FormControlValue[] = [],
  submitterId?: string
): string {
  if (form.method !== "get") throw new Error(`Unsupported form method: ${form.method}`);
  const url = new URL(form.actionUrl);
  const params = successfulValues(form, values, submitterId);
  url.search = params.toString();
  return url.toString();
}

export function buildFormSubmissionRequest(
  form: FormEntry,
  values: readonly FormControlValue[] = [],
  submitterId?: string
): FormSubmissionRequest {
  const method = form.method.toLowerCase();
  if (method !== "get" && method !== "post") throw new Error(`Unsupported form method: ${form.method}`);
  if (method === "post" && form.encoding !== "application/x-www-form-urlencoded") {
    throw new Error(`Unsupported form encoding: ${form.encoding}`);
  }
  const params = successfulValues(form, values, submitterId);
  if (method === "get") {
    return { url: buildGetSubmissionUrl(form, values, submitterId), requestOptions: { method: "GET" } };
  }
  return {
    url: form.actionUrl,
    requestOptions: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      bodyText: params.toString()
    }
  };
}
