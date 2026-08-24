import type {
  DocumentForm,
  DocumentNodeRef,
  DocumentState
} from "../document/index.js";
import type { PageRequestOptions } from "./types.js";

export interface FormSubmissionRequest {
  readonly url: string;
  readonly requestOptions: PageRequestOptions;
}

function successfulValues(
  form: DocumentForm,
  state: DocumentState,
  submitter?: DocumentNodeRef
): URLSearchParams {
  const params = new URLSearchParams();
  for (const control of form.controls) {
    if (control.disabled || control.name.length === 0 || control.kind === "reset" || control.kind === "unsupported") continue;
    const dynamic = state.controls.get(control.node);
    if (control.kind === "submit") {
      if (control.node === submitter) params.append(control.name, control.value);
      continue;
    }
    if (control.kind === "hidden") {
      params.append(control.name, dynamic?.values[0] ?? control.defaultValue);
      continue;
    }
    if (control.kind === "text" || control.kind === "textarea") {
      params.append(control.name, dynamic?.values[0] ?? control.defaultValue);
      continue;
    }
    if (control.kind === "checkbox" || control.kind === "radio") {
      if (dynamic?.checked ?? control.defaultChecked) {
        params.append(control.name, control.value);
      }
      continue;
    }
    if (!("options" in control)) continue;
    const defaults = control.options.filter((option) => option.defaultSelected);
    const effectiveDefaults = control.multiple
      ? defaults
      : [defaults.at(-1) ?? control.options[0]].filter((option) => option !== undefined);
    const selected = new Set(dynamic?.selected ?? effectiveDefaults.map((option) => option.node));
    for (const option of control.options) {
      if (!option.disabled && selected.has(option.node)) params.append(control.name, option.value);
    }
  }
  return params;
}

export function buildGetSubmissionUrl(
  form: DocumentForm,
  state: DocumentState,
  submitter?: DocumentNodeRef
): string {
  if (form.method !== "get") throw new Error(`Unsupported form method: ${form.method}`);
  const url = new URL(form.action);
  url.search = successfulValues(form, state, submitter).toString();
  return url.toString();
}

export function buildFormSubmissionRequest(
  form: DocumentForm,
  state: DocumentState,
  submitter?: DocumentNodeRef
): FormSubmissionRequest {
  const submitControl = submitter === undefined
    ? undefined
    : form.controls.find((control) => control.node === submitter && control.kind === "submit");
  const method = submitControl?.kind === "submit" ? submitControl.formMethod ?? form.method : form.method;
  const encoding = submitControl?.kind === "submit" ? submitControl.formEncoding ?? form.encoding : form.encoding;
  const action = submitControl?.kind === "submit" ? submitControl.formAction ?? form.action : form.action;
  if (method !== "get" && method !== "post") {
    throw new Error(`Unsupported form method: ${method}`);
  }
  if (method === "post" && encoding !== "application/x-www-form-urlencoded") {
    throw new Error(`Unsupported form encoding: ${encoding}`);
  }
  if (method === "get") {
    const url = new URL(action);
    url.search = successfulValues(form, state, submitter).toString();
    return { url: url.toString(), requestOptions: { method: "GET" } };
  }
  return {
    url: action,
    requestOptions: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      bodyText: successfulValues(form, state, submitter).toString()
    }
  };
}
