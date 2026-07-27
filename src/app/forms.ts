import {
  findAllByTagName,
  getAttributeValue,
  hasAttribute,
  type DocumentTree,
  type ElementNode
} from "@ismail-elkorchi/html-parser";

import { resolveHref } from "./url.js";
import { extractCompleteText } from "./text.js";
import type { PageRequestOptions } from "./types.js";

export interface FormField {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface FormEntry {
  readonly id: string;
  readonly index: number;
  readonly method: string;
  readonly actionUrl: string;
  readonly fields: readonly FormField[];
}

export interface FormSubmissionRequest {
  readonly url: string;
  readonly requestOptions: PageRequestOptions;
}

function collectFormControls(formNode: ElementNode): readonly ElementNode[] {
  const controls: ElementNode[] = [];
  const pending: ElementNode[] = [];
  for (let index = formNode.children.length - 1; index >= 0; index -= 1) {
    const child = formNode.children[index];
    if (child?.kind === "element") pending.push(child);
  }

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    const tag = node.localName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      controls.push(node);
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child?.kind === "element") pending.push(child);
    }
  }

  return controls;
}

function selectValue(selectNode: ElementNode): string {
  const options: ElementNode[] = [];
  const pending: ElementNode[] = [selectNode];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node !== selectNode && node.localName.toLowerCase() === "option") options.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child?.kind === "element") pending.push(child);
    }
  }
  if (options.length === 0) return "";
  const selected = options.find((option) => hasAttribute(option, "selected")) ?? options[0];
  if (!selected) return "";
  return getAttributeValue(selected, "value") ?? extractCompleteText(selected);
}

function normalizeMethod(value: string | null | undefined): string {
  if (!value) return "get";
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "get";
}/**
 * Extracts deterministic public data for `extractForms`.
 */


export function extractForms(tree: DocumentTree, baseUrl: string): readonly FormEntry[] {
  const forms: FormEntry[] = [];
  let index = 1;
  for (const formNode of findAllByTagName(tree, "form")) {
    const method = normalizeMethod(getAttributeValue(formNode, "method"));
    const actionRaw = getAttributeValue(formNode, "action") ?? baseUrl;
    const actionUrl = resolveHref(actionRaw, baseUrl);
    const controls = collectFormControls(formNode);
    const fields: FormField[] = [];

    for (const control of controls) {
      const name = getAttributeValue(control, "name");
      if (!name || name.trim().length === 0) {
        continue;
      }

      const tag = control.localName.toLowerCase();
      if (tag === "textarea") {
        fields.push({
          name,
          type: "textarea",
          value: extractCompleteText(control)
        });
        continue;
      }

      if (tag === "select") {
        fields.push({
          name,
          type: "select",
          value: selectValue(control)
        });
        continue;
      }

      const type = (getAttributeValue(control, "type") ?? "text").toLowerCase();
      if ((type === "checkbox" || type === "radio") && !hasAttribute(control, "checked")) {
        continue;
      }

      fields.push({
        name,
        type,
        value: getAttributeValue(control, "value") ?? ""
      });
    }

    forms.push({
      id: `form:${String(formNode.id)}`,
      index,
      method,
      actionUrl,
      fields
    });
    index += 1;
  }
  return forms;
}/**
 * Computes deterministic public output for `buildGetSubmissionUrl`.
 */


export function buildGetSubmissionUrl(form: FormEntry, overrides: Record<string, string> = {}): string {
  if (form.method !== "get") {
    throw new Error(`Unsupported form method: ${form.method}`);
  }

  const url = new URL(form.actionUrl);
  const values = new Map<string, string>();
  for (const field of form.fields) {
    values.set(field.name, field.value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    values.set(name, value);
  }

  for (const [name, value] of values.entries()) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}/**
 * Computes deterministic public output for `buildFormSubmissionRequest`.
 */


export function buildFormSubmissionRequest(
  form: FormEntry,
  overrides: Record<string, string> = {}
): FormSubmissionRequest {
  const method = form.method.toLowerCase();
  if (method !== "get" && method !== "post") {
    throw new Error(`Unsupported form method: ${form.method}`);
  }

  const values = new URLSearchParams();
  for (const field of form.fields) {
    values.set(field.name, field.value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    values.set(name, value);
  }

  if (method === "get") {
    return {
      url: buildGetSubmissionUrl(form, overrides),
      requestOptions: {
        method: "GET"
      }
    };
  }

  return {
    url: form.actionUrl,
    requestOptions: {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      bodyText: values.toString()
    }
  };
}
