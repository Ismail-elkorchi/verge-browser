import type { DocumentNodeRef } from "../../document/index.js";
import type { DocumentActionIdentity, FormattingTree } from "./types.js";

const ACTION_IDENTITY_CACHE = new WeakMap<FormattingTree, Map<DocumentNodeRef, DocumentActionIdentity | null>>();

/** Resolves the document action inherited by a generated box or inline item. */
export function documentActionIdentity(
  tree: FormattingTree,
  source: DocumentNodeRef
): DocumentActionIdentity | null {
  let cache = ACTION_IDENTITY_CACHE.get(tree);
  if (cache === undefined) {
    cache = new Map<DocumentNodeRef, DocumentActionIdentity | null>();
    ACTION_IDENTITY_CACHE.set(tree, cache);
  }
  if (cache.has(source)) return cache.get(source) ?? null;
  const visited: DocumentNodeRef[] = [];
  let current: DocumentNodeRef | null = source;
  let action: DocumentActionIdentity | null = null;
  while (current !== null) {
    if (cache.has(current)) {
      action = cache.get(current) ?? null;
      break;
    }
    visited.push(current);
    const link = tree.document.link(current);
    if (link !== null) {
      action = Object.freeze({ kind: "link", node: link.node, destination: link.destination });
      break;
    }
    const control = tree.document.control(current);
    if (control !== null) {
      action = Object.freeze({ kind: "form-control", node: control.node, form: control.form });
      break;
    }
    const parent = tree.document.parent(current);
    const disclosure = parent === null ? null : tree.document.disclosure(parent.ref);
    if (disclosure?.kind === "details" && disclosure.summary === current) {
      action = Object.freeze({
        kind: "disclosure",
        node: disclosure.node,
        open: tree.state.open.has(disclosure.node)
      });
      break;
    }
    current = parent?.ref ?? null;
  }
  for (const node of visited) cache.set(node, action);
  return action;
}
