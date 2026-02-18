import { findAllByTagName, textContent, type DocumentTree, type ElementNode } from "html-parser";

import { resolveHref } from "./url.js";
import type { PageRequestOptions } from "./types.js";

export interface FormField {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface FormEntry {
  readonly index: number;
  readonly method: string;
  readonly actionUrl: string;
  readonly fields: readonly FormField[];
}

export interface FormSubmissionRequest {
  readonly url: string;
  readonly requestOptions: PageRequestOptions;
}

function attrValue(node: ElementNode, name: string): string | null {
  const target = name.toLowerCase();
  for (const attribute of node.attributes) {
    if (attribute.name.toLowerCase() === target) {
      return attribute.value;
    }
  }
  return null;
}

function hasAttr(node: ElementNode, name: string): boolean {
  return attrValue(node, name) !== null;
}

function collectFormControls(formNode: ElementNode): readonly ElementNode[] {
  const controls: ElementNode[] = [];
  const walk = (node: ElementNode): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        controls.push(child);
      }
      walk(child);
    }
  };
  walk(formNode);
  return controls;
}

function selectValue(selectNode: ElementNode): string {
  const options = selectNode.children.filter(
    (child): child is ElementNode => child.kind === "element" && child.tagName.toLowerCase() === "option"
  );
  if (options.length === 0) return "";
  const selected = options.find((option) => hasAttr(option, "selected")) ?? options[0];
  if (!selected) return "";
  return attrValue(selected, "value") ?? textContent(selected);
}

function normalizeMethod(value: string | null): string {
  if (!value) return "get";
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "get";
}

export function extractForms(tree: DocumentTree, baseUrl: string): readonly FormEntry[] {
  const forms: FormEntry[] = [];
  let index = 1;
  for (const formNode of findAllByTagName(tree, "form")) {
    const method = normalizeMethod(attrValue(formNode, "method"));
    const actionRaw = attrValue(formNode, "action") ?? baseUrl;
    const actionUrl = resolveHref(actionRaw, baseUrl);
    const controls = collectFormControls(formNode);
    const fields: FormField[] = [];

    for (const control of controls) {
      const name = attrValue(control, "name");
      if (!name || name.trim().length === 0) {
        continue;
      }

      const tag = control.tagName.toLowerCase();
      if (tag === "textarea") {
        fields.push({
          name,
          type: "textarea",
          value: textContent(control)
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

      const type = (attrValue(control, "type") ?? "text").toLowerCase();
      if ((type === "checkbox" || type === "radio") && !hasAttr(control, "checked")) {
        continue;
      }

      fields.push({
        name,
        type,
        value: attrValue(control, "value") ?? ""
      });
    }

    forms.push({
      index,
      method,
      actionUrl,
      fields
    });
    index += 1;
  }
  return forms;
}

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
}

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
