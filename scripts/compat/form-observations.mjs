import { createDocumentState, controlChecked, controlSelections, controlValues } from "../../dist/document/index.js";
import { formEntries } from "../../dist/app/forms.js";

/** Document-order positions identify nodes even when authored IDs are duplicated. */
export function nativeFormObservations(document) {
  const elements = [];
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.pop();
    const node = document.node(ref);
    if (node.kind === "element") elements.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
  }
  const keys = new Map(elements.map((element, index) => [element.ref, `element:${index}`]));
  const state = createDocumentState(document);
  const entries = (form, submitter) => {
    try { return { status: "complete", entries: formEntries(document, form, state, submitter) }; }
    catch (error) { return { status: "rejected", reason: error.message }; }
  };
  return {
    controls: document.controls.map((control) => ({
      key: keys.get(control.node), tag: document.node(control.node).name,
      inputType: document.node(control.node).name === "input" ? "inputType" in control ? control.inputType : control.kind : null,
      name: control.name, form: control.form === null ? null : keys.get(control.form), disabled: control.disabled,
      value: control.kind === "checkbox" || control.kind === "radio" ? control.value
        : control.kind === "text" || control.kind === "textarea" || control.kind === "hidden" || control.kind === "select" ? controlValues(state, control)[0] ?? "" : null,
      valueAttribute: document.attribute(control.node, "value"),
      checked: control.kind === "checkbox" || control.kind === "radio" ? controlChecked(state, control) : null,
      options: control.kind === "select" ? control.options.map((option) => ({ key: keys.get(option.node), value: option.value,
        selected: controlSelections(state, control).includes(option.node), defaultSelected: option.defaultSelected, disabled: option.disabled })) : null,
    })),
    forms: document.forms.map((form) => ({ key: keys.get(form.node), entries: entries(form),
      submitters: form.controls.filter((control) => control.kind === "submit" && !control.disabled)
        .map((control) => ({ key: keys.get(control.node), entries: entries(form, control.node) })) })),
    nameTargets: elements.filter((element) => document.attribute(element.ref, "data-oracle-name") !== null)
      .map((element) => ({ key: keys.get(element.ref), name: document.semantic(element.ref)?.accessibleName ?? "" })),
  };
}

/** Executed inside Chromium. Every value/owner/entry is read from native DOM APIs. */
export function collectBrowserFormObservations() {
  const document = globalThis.document;
  const elements = [...document.querySelectorAll("*")];
  const keys = new Map(elements.map((element, index) => [element, `element:${index}`]));
  const entries = (form, submitter) => {
    const data = submitter === undefined ? new globalThis.FormData(form) : new globalThis.FormData(form, submitter);
    return { status: "complete", entries: [...data].map(([name, value]) => ({ name,
      value: typeof value === "string" ? value : { kind: "file", name: value.name, type: value.type, size: value.size } })) };
  };
  return {
    controls: [...document.querySelectorAll("input,select,textarea,button")].map((element) => ({
      key: keys.get(element), tag: element.localName,
      inputType: element.localName === "input" ? element.type : null,
      name: element.name, form: element.form === null ? null : keys.get(element.form), disabled: element.matches(":disabled"),
      value: element.localName === "button" || (element.localName === "input" && ["submit", "reset", "button", "image"].includes(element.type)) ? null : element.value,
      valueAttribute: element.getAttribute("value"),
      checked: element.localName === "input" && ["checkbox", "radio"].includes(element.type) ? element.checked : null,
      options: element.localName === "select" ? [...element.options].map((option) => ({ key: keys.get(option), value: option.value,
        selected: option.selected, defaultSelected: option.defaultSelected, disabled: option.matches(":disabled") })) : null,
    })),
    forms: [...document.forms].map((form) => ({ key: keys.get(form), entries: entries(form),
      submitters: [...form.elements].filter((element) => (element.localName === "button" || element.localName === "input") && element.type === "submit" && !element.matches(":disabled"))
        .map((element) => ({ key: keys.get(element), entries: entries(form, element) })) })),
    nameTargets: elements.filter((element) => element.hasAttribute("data-oracle-name")).map((element) => keys.get(element)),
  };
}

/** CDP supplies Chromium's actual accessible names; no JavaScript name approximation. */
export async function chromiumAccessibleNames(context, page, targets) {
  if (targets.length === 0) return { status: "complete", byKey: {} };
  let session;
  try {
    session = await context.newCDPSession(page);
    await session.send("Accessibility.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: false });
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const byBackend = new Map();
    for (const node of nodes) {
      if (node.backendDOMNodeId === undefined) continue;
      const prior = byBackend.get(node.backendDOMNodeId);
      if (prior === undefined || (prior.ignored && !node.ignored)) byBackend.set(node.backendDOMNodeId, node);
    }
    const byKey = {};
    const pending = [root];
    let index = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (node.nodeType === 1) {
        const key = `element:${index++}`;
        if (targets.includes(key)) {
          const ax = byBackend.get(node.backendNodeId);
          byKey[key] = ax === undefined ? null : { role: ax.role?.value ?? null, name: ax.name?.value ?? null, ignored: ax.ignored };
        }
      }
      for (let child = (node.children?.length ?? 0) - 1; child >= 0; child--) pending.push(node.children[child]);
    }
    return { status: "complete", byKey };
  } catch (error) {
    return { status: "unavailable", reason: error.message, byKey: {} };
  } finally {
    await session?.detach();
  }
}
