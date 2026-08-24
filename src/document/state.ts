import type {
  DocumentAction,
  DocumentControlState,
  DocumentFormControl,
  DocumentNodeRef,
  DocumentState,
  WebDocumentSnapshotView
} from "./types.js";

class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: ReadonlyMap<Key, Value>;

  public constructor(values: Iterable<readonly [Key, Value]>) {
    this.#values = new Map(values);
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
  return Object.freeze({
    values: Object.freeze([...state.values]),
    checked: state.checked,
    selected: Object.freeze([...state.selected])
  });
}

/** @internal Captures dynamic state for an immutable presentation snapshot. */
export function snapshotDocumentState(state: DocumentState): DocumentState {
  return Object.freeze({
    controls: new ImmutableMap(
      [...state.controls].map(([node, control]) => [node, immutableControlState(control)] as const)
    ),
    open: new ImmutableSet(state.open),
    focus: state.focus,
    hover: state.hover,
    active: state.active,
    urlTarget: state.urlTarget
  });
}

function initialControlState(control: DocumentFormControl): DocumentControlState {
  if (control.kind === "text" || control.kind === "textarea") {
    return { values: [control.defaultValue], checked: null, selected: [] };
  }
  if (control.kind === "hidden") {
    return { values: [control.defaultValue], checked: null, selected: [] };
  }
  if (control.kind === "checkbox" || control.kind === "radio") {
    return {
      values: control.defaultChecked ? [control.value] : [],
      checked: control.defaultChecked,
      selected: []
    };
  }
  if (control.kind === "select") {
    const defaults = control.options.filter((option) => option.defaultSelected);
    const selectedOptions = control.multiple
      ? defaults
      : [defaults.at(-1) ?? control.options[0]].filter((option) => option !== undefined);
    return {
      values: selectedOptions.map((option) => option.value),
      checked: null,
      selected: selectedOptions.map((option) => option.node)
    };
  }
  if (control.kind === "submit" || control.kind === "reset") {
    return { values: [control.value], checked: null, selected: [] };
  }
  return { values: [], checked: null, selected: [] };
}

function initialUrlTarget(document: WebDocumentSnapshotView): DocumentNodeRef | null {
  let fragment: string;
  try {
    fragment = new URL(document.finalUrl).hash.slice(1);
  } catch {
    return null;
  }
  if (fragment.length === 0) return null;
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // A malformed escape sequence remains a literal fragment identifier.
  }
  return document.elementById(fragment);
}

function followedUrlTarget(document: WebDocumentSnapshotView, destination: string): DocumentNodeRef | null {
  let target: URL;
  let current: URL;
  try {
    target = new URL(destination);
    current = new URL(document.finalUrl);
  } catch {
    return null;
  }
  const fragment = target.hash.slice(1);
  target.hash = "";
  current.hash = "";
  if (target.toString() !== current.toString() || fragment.length === 0) return null;
  let id = fragment;
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape sequence remains a literal fragment identifier.
  }
  return document.elementById(id);
}

export function createDocumentState(document: WebDocumentSnapshotView): DocumentState {
  const controls = new Map<DocumentNodeRef, DocumentControlState>();
  const checkedRadioByGroup = new Map<string, DocumentNodeRef>();
  for (const control of document.controls) {
    const initial = initialControlState(control);
    controls.set(control.node, initial);
    if (control.kind !== "radio" || control.name.length === 0 || !initial.checked) continue;
    const group = `${control.form ?? "document"}\u0000${control.name}`;
    const previous = checkedRadioByGroup.get(group);
    if (previous !== undefined) {
      const previousState = controls.get(previous);
      if (previousState !== undefined) controls.set(previous, { ...previousState, checked: false, values: [] });
    }
    checkedRadioByGroup.set(group, control.node);
  }
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
    urlTarget: initialUrlTarget(document)
  });
}

export function applyDocumentAction(
  document: WebDocumentSnapshotView,
  state: DocumentState,
  action: DocumentAction
): DocumentState {
  if (action.kind === "focus" || action.kind === "hover" || action.kind === "activate") {
    if (action.target !== null) document.node(action.target);
    if (action.kind === "focus") return snapshotDocumentState({ ...state, focus: action.target });
    if (action.kind === "hover") return snapshotDocumentState({ ...state, hover: action.target });
    return snapshotDocumentState({ ...state, active: action.target });
  }
  if (action.kind === "follow-link") {
    const link = document.link(action.target);
    if (link === null) throw new RangeError("Link action requires a link target");
    return snapshotDocumentState({ ...state, urlTarget: followedUrlTarget(document, link.destination) });
  }
  if (action.kind === "reset-form") {
    const form = document.form(action.target);
    if (form === null) throw new RangeError("Reset action requires a form target");
    const controls = new Map(state.controls);
    for (const control of form.controls) controls.set(control.node, initialControlState(control));
    return snapshotDocumentState({ ...state, controls });
  }
  if (action.kind === "set-open") {
    if (document.disclosure(action.target) === null) throw new RangeError("Open state requires a disclosure target");
    const open = new Set(state.open);
    if (action.open) open.add(action.target);
    else open.delete(action.target);
    return snapshotDocumentState({ ...state, open });
  }
  const control = document.control(action.target);
  if (control === null) throw new RangeError("Document control action requires a control target");
  const controls = new Map(state.controls);
  const current = controls.get(action.target) ?? { values: [], checked: null, selected: [] };
  if (action.kind === "set-checked") {
    if (control.kind !== "checkbox" && control.kind !== "radio") {
      throw new TypeError("Checked state requires a checkbox or radio control");
    }
    if (control.kind === "radio" && action.checked && control.name.length > 0) {
      for (const peer of document.radioGroup(control.node)) {
        if (peer.node === control.node) continue;
        const peerState = controls.get(peer.node) ?? initialControlState(peer);
        controls.set(peer.node, { ...peerState, checked: false, values: [] });
      }
    }
    controls.set(action.target, {
      ...current,
      checked: action.checked,
      values: action.checked ? [control.value] : []
    });
  } else if (action.kind === "set-selected-options") {
    if (control.kind !== "select") throw new TypeError("Selected options require a select control");
    const requested = new Set(action.options);
    const selected = control.options
      .filter((option) => requested.has(option.node) && !option.disabled)
      .slice(0, control.multiple ? control.options.length : 1);
    controls.set(action.target, {
      ...current,
      selected: selected.map((option) => option.node),
      values: selected.map((option) => option.value)
    });
  } else {
    if (control.kind !== "text" && control.kind !== "textarea" && control.kind !== "hidden") {
      throw new TypeError("Text value state requires a text, textarea, or hidden control");
    }
    controls.set(action.target, { ...current, values: [action.value] });
  }
  return snapshotDocumentState({ ...state, controls });
}
