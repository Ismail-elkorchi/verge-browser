import { estimatedRetainedCost } from "../memory/retained-cost.js";
import type { IndexedPageSnapshot, PageRequestOptions } from "./types.js";

export type ParseMode = "text" | "stream";
export type NavigationProvenance = { readonly kind: "direct" }
  | { readonly kind: "page-initiated"; readonly sourceUrl: string };
export interface NavigationEntry {
  readonly id: string;
  readonly documentId: string;
  readonly snapshot: IndexedPageSnapshot;
  readonly parseMode: ParseMode;
  readonly provenance: NavigationProvenance;
}
export interface NavigationHistory {
  readonly entries: readonly NavigationEntry[];
  readonly index: number;
  readonly nextIdentity: number;
}
export const HISTORY_ENTRY_LIMIT = 100;
/** Additional inactive history ownership; active-page admission remains with acquisition/rendering. */
export const HISTORY_BYTE_LIMIT = 64 * 1024 * 1024;
export function emptyHistory(): NavigationHistory {
  return Object.freeze({ entries: Object.freeze([]), index: -1, nextIdentity: 1 });
}
export function currentEntry(history: NavigationHistory): NavigationEntry | undefined {
  return history.entries[history.index];
}
export function navigationAvailability(history: NavigationHistory) {
  return { canGoBack: history.index > 0, canGoForward: history.index >= 0 && history.index < history.entries.length - 1 };
}
/** A shortcut must not discard an explicit resource request or its options. */
export function isSameDocumentNavigation(currentUrl: string, target: string, options: PageRequestOptions = {}): boolean {
  if (options.bodyText !== undefined || options.headers !== undefined || (options.method !== undefined && options.method !== "GET")) return false;
  const next = new URL(target);
  if (!next.href.includes("#")) return false;
  const current = new URL(currentUrl);
  next.hash = "";
  current.hash = "";
  return current.href === next.href;
}
export function fragmentSnapshot(snapshot: IndexedPageSnapshot, target: string): IndexedPageSnapshot {
  return Object.freeze({ ...snapshot, requestUrl: target, finalUrl: target });
}
const snapshotCosts = new WeakMap<IndexedPageSnapshot["document"], number>();
export function retainedSnapshotBytes(snapshot: IndexedPageSnapshot): number {
  const retained = snapshotCosts.get(snapshot.document);
  const imageBytes = snapshot.images === undefined ? 0 : estimatedRetainedCost([snapshot.images]);
  if (retained !== undefined) return retained + imageBytes;
  // URLs/provenance belong to entries, not this shared acquisition owner.
  const bytes = estimatedRetainedCost([snapshot.document, snapshot.stylesheets, snapshot.styleDiagnostics,
    snapshot.diagnostics, snapshot.responseFields]);
  snapshotCosts.set(snapshot.document, bytes);
  return bytes + imageBytes;
}
const entryMetadata = new WeakMap<NavigationEntry, object>();
function metadata(entry: NavigationEntry): object {
  const retained = entryMetadata.get(entry);
  if (retained !== undefined) return retained;
  const value = { id: entry.id, documentId: entry.documentId, parseMode: entry.parseMode,
    provenance: entry.provenance, snapshot: {
      requestUrl: entry.snapshot.requestUrl, finalUrl: entry.snapshot.finalUrl,
      status: entry.snapshot.status, statusText: entry.snapshot.statusText,
      contentType: entry.snapshot.contentType, fetchedAtIso: entry.snapshot.fetchedAtIso,
    } };
  entryMetadata.set(entry, value);
  return value;
}
export function commitNavigation(
  history: NavigationHistory,
  snapshot: IndexedPageSnapshot,
  mode: "push" | "replace",
  provenance: NavigationProvenance,
  sharedDocumentId?: string,
  attachmentBytes: ReadonlyMap<string, number> = new Map(),
): NavigationHistory {
  const identity = history.nextIdentity;
  const entry: NavigationEntry = Object.freeze({
    id: `entry-${String(identity)}`, documentId: sharedDocumentId ?? `live-${String(identity)}`,
    snapshot, parseMode: snapshot.diagnostics.parseMode, provenance,
  });
  const entries = mode === "replace" && history.index >= 0
    ? history.entries.map((previous, index) => index === history.index ? entry : previous)
    : [...history.entries.slice(0, history.index + 1), entry];
  const index = mode === "replace" && history.index >= 0 ? history.index : entries.length - 1;
  return boundHistory({ entries, index, nextIdentity: identity + 1 }, attachmentBytes);
}
/** Retires oldest eligible entries. An inactive document too large to retain is simply evicted. */
export function boundHistory(
  history: NavigationHistory,
  attachmentBytes: ReadonlyMap<string, number> = new Map(),
  entryAttachmentBytes: ReadonlyMap<string, number> = new Map(),
): NavigationHistory {
  let entries = [...history.entries];
  let index = history.index;
  const activeId = entries[index]?.documentId;
  const bytes = (): number => {
    const seen = new Set<string>();
    // This shallow ownership graph contains every entry URL and source URL, including
    // same-document entries. One recount deduplicates request/final/provenance strings
    // without walking any shared DOM, stylesheet or response ownership again.
    let total = estimatedRetainedCost([entries.map(metadata)]) + 128;
    for (const item of entries) total += entryAttachmentBytes.get(item.id) ?? 0;
    for (const item of entries) {
      if (item.documentId === activeId || seen.has(item.documentId)) continue;
      seen.add(item.documentId);
      total += retainedSnapshotBytes(item.snapshot) + (attachmentBytes.get(item.documentId) ?? 0);
    }
    return total;
  };
  while (entries.length > HISTORY_ENTRY_LIMIT || bytes() > HISTORY_BYTE_LIMIT) {
    const retire = index > 0 ? 0 : entries.length > 1 ? entries.length - 1 : -1;
    if (retire < 0) break;
    entries = entries.filter((_, position) => position !== retire);
    if (retire < index) index -= 1;
  }
  return Object.freeze({ entries: Object.freeze(entries), index, nextIdentity: history.nextIdentity });
}
export function traverseHistory(history: NavigationHistory, direction: "back" | "forward"): NavigationHistory {
  const index = history.index + (direction === "back" ? -1 : 1);
  if (index < 0 || index >= history.entries.length) throw new Error(`No ${direction} history entry`);
  return boundHistory({ ...history, index });
}
