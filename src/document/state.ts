import { resolveDocumentFragment } from "./fragment.js";
import { registerRetainedOwner } from "../memory/retained-cost.js";
import type {
  DocumentAction,
  DocumentControlState,
  DocumentFormControl,
  DocumentNodeRef,
  DocumentState,
  IndexedWebDocumentSnapshot
} from "./types.js";

class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: ReadonlyMap<Key, Value>;

  public constructor(values: Iterable<readonly [Key, Value]>) {
    this.#values = new Map(values);
    registerRetainedOwner(this, () => [this.#values]);
    Object.freeze(this);
  }

  public get size(): number { return this.#values.size; }
  public get(key: Key): Value | undefined { return this.#values.get(key); }
  public has(key: Key): boolean { return this.#values.has(key); }
  public entries(): MapIterator<[Key, Value]> { return this.#values.entries(); }
  public keys(): MapIterator<Key> { return this.#values.keys(); }
  public values(): MapIterator<Value> { return this.#values.values(); }
  public forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  public [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
}

class ImmutableSet<Value> implements ReadonlySet<Value> {
  readonly #values: ReadonlySet<Value>;

  public constructor(values: Iterable<Value>) {
    this.#values = new Set(values);
    registerRetainedOwner(this, () => [this.#values]);
    Object.freeze(this);
  }

  public get size(): number { return this.#values.size; }
  public has(value: Value): boolean { return this.#values.has(value); }
  public entries(): SetIterator<[Value, Value]> { return this.#values.entries(); }
  public keys(): SetIterator<Value> { return this.#values.keys(); }
  public values(): SetIterator<Value> { return this.#values.values(); }
  public forEach(
    callbackfn: (value: Value, value2: Value, set: ReadonlySet<Value>) => void,
    thisArg?: unknown
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }
  public [Symbol.iterator](): SetIterator<Value> { return this.values(); }
}

function immutableControlState(state: DocumentControlState): DocumentControlState {
  return Object.freeze(state.kind === "selected"
    ? { ...state, selected: Object.freeze([...state.selected]) }
    : { ...state });
}

/** Canonical state is required: consumers must never reconstruct authored defaults. */
export function controlState(state: DocumentState, node: DocumentNodeRef): DocumentControlState {
  const value = state.controls.get(node);
  if (value === undefined) throw new RangeError(`Missing document control state: ${node}`);
  return value;
}

export function controlChecked(state: DocumentState, control: DocumentFormControl): boolean {
  const current = controlState(state, control.node);
  if (current.kind !== "checked") throw new TypeError("Checked state requires a checkbox or radio control");
  return current.checked;
}

export function controlSelections(state: DocumentState, control: DocumentFormControl): readonly DocumentNodeRef[] {
  const current = controlState(state, control.node);
  if (current.kind !== "selected") throw new TypeError("Selected state requires a select control");
  return current.selected;
}

/** Values are derived from option identity and checkedness, never stored twice. */
export function controlValues(state: DocumentState, control: DocumentFormControl): readonly string[] {
  const current = controlState(state, control.node);
  if (current.kind === "value") return [current.value];
  if (control.kind === "select" && current.kind === "selected") {
    const selected = new Set(current.selected);
    return control.options.filter((option) => selected.has(option.node)).map((option) => option.value);
  }
  if ((control.kind === "checkbox" || control.kind === "radio") && current.kind === "checked") {
    return current.checked ? [control.value] : [];
  }
  if (control.kind === "submit" || control.kind === "reset" || control.kind === "button") return [control.value];
  return [];
}

const ASCII_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu;

/** The supported input value-sanitization algorithms, shared by initialization, edits and reset. */
function sanitizedValue(control: DocumentFormControl, value: string): string {
  if (control.kind === "textarea") return value.replace(/\r\n?/gu, "\n");
  if (control.kind !== "text") return value;
  if (control.inputType === "number") {
    return /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(value)
      && Number.isFinite(Number(value)) ? value : "";
  }
  const singleLine = value.replace(/[\r\n]/gu, "");
  if (control.inputType === "email" && control.multiple) {
    return singleLine.split(",").map((part) => part.replace(ASCII_WHITESPACE, "")).join(",");
  }
  return control.inputType === "email" || control.inputType === "url"
    ? singleLine.replace(ASCII_WHITESPACE, "") : singleLine;
}

function immutableControls(
  controls: ReadonlyMap<DocumentNodeRef, DocumentControlState>
): ReadonlyMap<DocumentNodeRef, DocumentControlState> {
  return new ImmutableMap(
    [...controls].map(([node, control]) => [node, immutableControlState(control)] as const)
  );
}

/** @internal Captures dynamic state for an immutable render-pipeline snapshot. */
export function snapshotDocumentState(state: DocumentState): DocumentState {
  return Object.freeze({
    controls: immutableControls(state.controls),
    open: new ImmutableSet(state.open),
    focus: state.focus,
    hover: state.hover,
    active: state.active,
    urlTarget: state.urlTarget
  });
}

function initialControlState(control: DocumentFormControl): DocumentControlState {
  if (control.kind === "text" || control.kind === "textarea" || control.kind === "hidden") {
    return { kind: "value", value: sanitizedValue(control, control.defaultValue) };
  }
  if (control.kind === "checkbox" || control.kind === "radio") {
    return { kind: "checked", checked: control.defaultChecked };
  }
  if (control.kind === "select") {
    const defaults = control.options.filter((option) => option.defaultSelected);
    const last = defaults.at(-1);
    const fallback = control.displaySize === 1 ? control.options.find((option) => !option.disabled) : undefined;
    const selected = control.multiple ? defaults : last !== undefined ? [last] : fallback === undefined ? [] : [fallback];
    return { kind: "selected", selected: selected.map((option) => option.node) };
  }
  return { kind: "none" };
}

function defaultControlStates(
  controls: readonly DocumentFormControl[]
): ReadonlyMap<DocumentNodeRef, DocumentControlState> {
  const states = new Map<DocumentNodeRef, DocumentControlState>();
  const checkedRadioByGroup = new Map<string, DocumentNodeRef>();
  for (const control of controls) {
    const initial = initialControlState(control);
    states.set(control.node, initial);
    if (control.kind !== "radio" || control.name.length === 0 || initial.kind !== "checked" || !initial.checked) continue;
    const group = `${control.form ?? "document"}\u0000${control.name}`;
    const previous = checkedRadioByGroup.get(group);
    if (previous !== undefined) {
      const previousState = states.get(previous);
      if (previousState !== undefined) states.set(previous, { kind: "checked", checked: false });
    }
    checkedRadioByGroup.set(group, control.node);
  }
  return states;
}

export function createDocumentState(document: IndexedWebDocumentSnapshot, entryUrl: string = document.finalUrl): DocumentState {
  const fragment = resolveDocumentFragment(document, entryUrl);
  const controls = defaultControlStates(document.controls);
  const open = new Set<DocumentNodeRef>();
  for (const disclosure of document.disclosures) {
    if (disclosure.initiallyOpen) open.add(disclosure.node);
  }
  return snapshotDocumentState({
    controls,
    open,
    focus: null,
    hover: null,
    active: null,
    urlTarget: fragment.kind === "node" ? fragment.node : null
  });
}

export function applyDocumentAction(
  document: IndexedWebDocumentSnapshot,
  state: DocumentState,
  action: DocumentAction
): DocumentState {
  if (action.kind === "focus" || action.kind === "hover" || action.kind === "activate") {
    if (action.target !== null) document.node(action.target);
    if (action.kind === "focus") return Object.freeze({ ...state, focus: action.target });
    if (action.kind === "hover") return Object.freeze({ ...state, hover: action.target });
    return Object.freeze({ ...state, active: action.target });
  }
  if (action.kind === "set-url-target") {
    if (action.target !== null && document.node(action.target).kind !== "element") throw new TypeError("URL target must be an element.");
    return Object.freeze({ ...state, urlTarget: action.target });
  }
  if (action.kind === "reset-form") {
    const form = document.form(action.target);
    if (form === null) throw new RangeError("Reset action requires a form target");
    const controls = new Map(state.controls);
    for (const [node, controlState] of defaultControlStates(form.controls)) controls.set(node, controlState);
    return Object.freeze({ ...state, controls: immutableControls(controls) });
  }
  if (action.kind === "set-open") {
    if (document.disclosure(action.target) === null) throw new RangeError("Open state requires a disclosure target");
    const open = new Set(state.open);
    if (action.open) open.add(action.target);
    else open.delete(action.target);
    return Object.freeze({ ...state, open: new ImmutableSet(open) });
  }
  const control = document.control(action.target);
  if (control === null) throw new RangeError("Document control action requires a control target");
  const controls = new Map(state.controls);
  controlState(state, action.target);
  if (action.kind === "set-checked") {
    if (control.kind !== "checkbox" && control.kind !== "radio") {
      throw new TypeError("Checked state requires a checkbox or radio control");
    }
    if (control.kind === "radio" && action.checked && control.name.length > 0) {
      for (const peer of document.radioGroup(control.node)) {
        if (peer.node === control.node) continue;
        controls.set(peer.node, { kind: "checked", checked: false });
      }
    }
    controls.set(action.target, {
      kind: "checked", checked: action.checked
    });
  } else if (action.kind === "set-selected-options") {
    if (control.kind !== "select") throw new TypeError("Selected options require a select control");
    const requested = new Set(action.options);
    const selected = control.options
      .filter((option) => requested.has(option.node) && !option.disabled)
      .slice(0, control.multiple ? control.options.length : 1);
    controls.set(action.target, {
      kind: "selected", selected: selected.map((option) => option.node)
    });
  } else {
    if (control.kind !== "text" && control.kind !== "textarea" && control.kind !== "hidden") {
      throw new TypeError("Text value state requires a text, textarea, or hidden control");
    }
    controls.set(action.target, { kind: "value", value: sanitizedValue(control, action.value) });
  }
  return Object.freeze({ ...state, controls: immutableControls(controls) });
}
