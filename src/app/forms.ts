import {
  controlChecked,
  controlSelections,
  controlValues,
  type DocumentForm,
  type DocumentFormControl,
  type DocumentNodeRef,
  type DocumentState,
  type IndexedWebDocumentSnapshot,
} from "../document/index.js";
import type { PageRequestOptions } from "./types.js";

export interface FormSubmissionRequest {
  readonly url: string;
  readonly requestOptions: PageRequestOptions;
}

export interface FormEntry {
  readonly name: string;
  readonly value: string;
}

function inDatalist(document: IndexedWebDocumentSnapshot, control: DocumentFormControl): boolean {
  let parent = document.parent(control.node);
  while (parent !== null) {
    if (parent.kind === "element" && parent.namespace === "http://www.w3.org/1999/xhtml" && parent.name === "datalist") return true;
    parent = document.parent(parent.ref);
  }
  return false;
}

function selectedSubmitter(document: IndexedWebDocumentSnapshot, form: DocumentForm, submitter: DocumentNodeRef | undefined) {
  if (document.form(form.node) !== form) throw new TypeError("Submission requires the indexed form");
  if (submitter === undefined) return undefined;
  const control = document.control(submitter);
  if (control?.kind !== "submit" || control.form !== form.node || control.disabled || inDatalist(document, control)) {
    throw new TypeError("Invalid form submitter");
  }
  return control;
}

/** The sole ordered successful-entry construction path, before transport newline normalization. */
export function formEntries(
  document: IndexedWebDocumentSnapshot,
  form: DocumentForm,
  state: DocumentState,
  submitter?: DocumentNodeRef,
): readonly FormEntry[] {
  selectedSubmitter(document, form, submitter);
  if (document.indexOutcome.status !== "complete") throw new Error("Cannot submit an incompletely indexed document");
  const entries: FormEntry[] = [];
  const scalarValueString = (value: string): string => value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const append = (name: string, value: string): void => { entries.push(Object.freeze({ name: scalarValueString(name), value: scalarValueString(value) })); };
  for (const control of form.controls) {
    if (control.disabled || control.name.length === 0 || control.kind === "reset" || control.kind === "button" || inDatalist(document, control)) continue;
    if (control.kind === "unsupported") {
      // Image buttons contribute only when activated; activation itself is unsupported.
      if (control.inputType === "image") continue;
      throw new Error(`Unsupported contributing form control: ${control.inputType}`);
    }
    let values: readonly string[];
    if (control.kind === "submit") {
      if (control.node !== submitter) continue;
      values = [control.value];
    } else if (control.kind === "checkbox" || control.kind === "radio") {
      if (!controlChecked(state, control)) continue;
      values = [control.value];
    } else if (control.kind === "select") {
      const selected = new Set(controlSelections(state, control));
      values = control.options.filter((option) => selected.has(option.node) && !option.disabled).map((option) => option.value);
    } else {
      values = control.kind === "hidden" && control.name.toLowerCase() === "_charset_" ? ["UTF-8"] : controlValues(state, control);
    }
    for (const value of values) append(control.name, value);
    const element = document.node(control.node);
    const supportsDirname = control.kind === "textarea" || control.kind === "hidden"
      || (control.kind === "text" && control.inputType !== "number")
      || (control.kind === "submit" && element.kind === "element" && element.name === "input");
    if (supportsDirname) {
      const dirname = document.attribute(control.node, "dirname");
      if (dirname !== null && dirname.length > 0) append(dirname, document.directionForRenderedText(control.node, values[0] ?? ""));
    }
  }
  return Object.freeze(entries);
}

function encodeEntries(entries: readonly FormEntry[]): string {
  const normalize = (value: string): string => value.replace(/\r\n|\r|\n/gu, "\r\n");
  const params = new URLSearchParams();
  for (const entry of entries) params.append(normalize(entry.name), normalize(entry.value));
  return params.toString();
}

export function buildFormSubmissionRequest(
  document: IndexedWebDocumentSnapshot,
  form: DocumentForm,
  state: DocumentState,
  submitter?: DocumentNodeRef,
  currentUrl: string = document.finalUrl,
): FormSubmissionRequest {
  const submitControl = selectedSubmitter(document, form, submitter);
  const method = submitControl?.formMethod ?? form.method;
  const encoding = submitControl?.formEncoding ?? form.encoding;
  const overridesAction = submitControl !== undefined && submitControl.formAction !== null;
  const rawAction = overridesAction
    ? document.attribute(submitControl.node, "formaction") : document.attribute(form.node, "action");
  const action = (rawAction ?? "").trim().length === 0 ? currentUrl : submitControl?.formAction ?? form.action;
  if (method !== "get" && method !== "post") throw new Error(`Unsupported form method: ${method}`);
  if (method === "post" && encoding !== "application/x-www-form-urlencoded") throw new Error(`Unsupported form encoding: ${encoding}`);
  const body = encodeEntries(formEntries(document, form, state, submitter));
  if (method === "get") {
    const url = new URL(action);
    url.search = body;
    return { url: url.toString(), requestOptions: { method: "GET" } };
  }
  return {
    url: action,
    requestOptions: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      bodyText: body,
    },
  };
}
