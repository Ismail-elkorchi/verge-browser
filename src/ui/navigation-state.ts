import { comboboxReducer } from "@ismail-elkorchi/terminal-ui/behavior";
import { createDocumentState, resolveDocumentFragment } from "../document/index.js";
import { boundHistory, commitNavigation, currentEntry, navigationAvailability, type NavigationHistory, type NavigationProvenance } from "../app/navigation-history.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import type { BrowserDocumentState } from "./model.js";
import { estimatedRetainedCost } from "../memory/retained-cost.js";

export function emptyRendering(): BrowserDocumentState["rendering"] {
  return { status: "idle", requestedViewportRevision: 0, committedViewportRevision: 0, requestKey: null,
    pendingSearch: null, searchRequestGeneration: 0, pendingReveal: null, pendingFocus: null, viewport: null, previousViewport: null, summary: null, error: null };
}
function closedEditors(editors: BrowserDocumentState["formEditors"]): BrowserDocumentState["formEditors"] {
  return Object.fromEntries(Object.entries(editors).map(([key, editor]) => [key, editor.kind === "combobox"
    ? { ...editor, state: comboboxReducer(editor.state, { kind: "dismiss", reason: "programmatic" }, { index: editor.optionsView.interactionIndex }) }
    : editor]));
}
export function navigationFocus(snapshot: IndexedPageSnapshot, node: BrowserDocumentState["documentState"]["focus"]): BrowserDocumentState["rendering"]["pendingFocus"] {
  if (node === null) return null;
  const control = snapshot.document.control(node);
  if (control !== null) return { node, actionId: `control:${node}`, formControl: true };
  if (snapshot.document.link(node) !== null) return { node, actionId: `link:${node}`, formControl: false };
  if (snapshot.document.disclosure(node) !== null) return { node, actionId: `disclosure:${node}`, formControl: false };
  return { node, actionId: "", formControl: false };
}
/** The active projection is captured at reduction time, including edits made while a request ran. */
function capture(document: BrowserDocumentState) {
  const current = currentEntry(document.navigation);
  if (current === undefined) throw new Error("Active navigation entry is missing.");
  return {
    entryViews: { ...document.entryViews, [current.id]: {
      scrollColumn: document.scrollColumn ?? 0, scrollAnchor: document.scrollAnchor, focus: document.documentState.focus, search: document.search === null ? null
        : { query: document.search.query, activeMatchIndex: document.search.activeMatchIndex },
    } },
    liveDocuments: { ...document.liveDocuments, [current.documentId]: {
      documentState: { ...document.documentState, hover: null, active: null }, formEditors: closedEditors(document.formEditors), scrollOffsets: document.scrollOffsets,
    } },
  };
}
export function activateHistory(document: BrowserDocumentState, navigation: NavigationHistory): BrowserDocumentState {
  const attachments = capture(document);
  const costs = new Map(Object.entries(attachments.liveDocuments).map(([id, live]) => [id, estimatedRetainedCost([live])]));
  const viewCosts = new Map(Object.entries(attachments.entryViews).map(([id, view]) => [id, estimatedRetainedCost([view])]));
  navigation = boundHistory(navigation, costs, viewCosts);
  const entry = currentEntry(navigation);
  if (entry === undefined) throw new Error("Activated navigation entry is missing.");
  const view = attachments.entryViews[entry.id];
  const live = attachments.liveDocuments[entry.documentId];
  const defaults = live === undefined ? createDocumentState(entry.snapshot.document, entry.snapshot.finalUrl) : live.documentState;
  const fragment = resolveDocumentFragment(entry.snapshot.document, entry.snapshot.finalUrl);
  const liveIds = new Set(navigation.entries.map((item) => item.documentId));
  const sameDocument = currentEntry(document.navigation)?.documentId === entry.documentId;
  const entryIds = new Set(navigation.entries.map((item) => item.id));
  return {
    ...document, navigation, snapshot: entry.snapshot,
    documentRevision: document.documentRevision + 1, stateRevision: document.stateRevision + 1,
    entryViews: Object.fromEntries(Object.entries(attachments.entryViews).filter(([id]) => entryIds.has(id) && id !== entry.id)),
    liveDocuments: Object.fromEntries(Object.entries(attachments.liveDocuments).filter(([id]) => liveIds.has(id) && id !== entry.documentId)),
    scrollColumn: view?.scrollColumn ?? (sameDocument ? document.scrollColumn ?? 0 : 0),
    scrollAnchor: view?.scrollAnchor ?? (sameDocument && fragment.kind === "none" ? document.scrollAnchor
      : { source: entry.snapshot.document.body ?? entry.snapshot.document.documentElement, rowOffset: 0 }),
    scrollOffsets: live?.scrollOffsets ?? [],
    documentState: { ...(live?.documentState ?? defaults), focus: view?.focus ?? null, hover: null, active: null, urlTarget: fragment.kind === "node" ? fragment.node : null },
    formEditors: live?.formEditors ?? {},
    search: view?.search === undefined || view.search === null ? null : { ...view.search, anchors: new Map(), layoutRevision: null,
      documentRevision: document.documentRevision + 1, stateRevision: document.stateRevision + 1, requestGeneration: 0, matches: [], truncated: false },
    rendering: { ...emptyRendering(),
      previousViewport: sameDocument ? document.rendering.viewport ?? document.rendering.previousViewport : null,
      pendingReveal: view === undefined && fragment.kind === "node" ? { node: fragment.node, blockAlign: "start" } : null,
      pendingFocus: navigationFocus(entry.snapshot, view?.focus ?? (view === undefined && fragment.kind === "node" ? fragment.node : null)),
    }, loading: false, pendingUrl: null, error: null,
    ...navigationAvailability(navigation),
  };
}
export function acceptNavigation(document: BrowserDocumentState, snapshot: IndexedPageSnapshot, mode: "push" | "replace", provenance: NavigationProvenance, sharedDocumentId?: string): BrowserDocumentState {
  return activateHistory(document, commitNavigation(document.navigation, snapshot, mode, provenance, sharedDocumentId));
}
/** Stop and reopen retain the accepted page; no external current snapshot can be adopted. */
export function resumeDocument(document: BrowserDocumentState): BrowserDocumentState {
  return { ...document, navigationGeneration: document.navigationGeneration + 1,
    documentState: { ...document.documentState, hover: null, active: null }, formEditors: closedEditors(document.formEditors),
    documentRevision: document.documentRevision + 1, stateRevision: document.stateRevision + 1,
    loading: false, pendingUrl: null, error: null, rendering: { ...emptyRendering(), previousViewport: document.rendering.viewport ?? document.rendering.previousViewport,
      pendingFocus: navigationFocus(document.snapshot, document.documentState.focus) } };
}
