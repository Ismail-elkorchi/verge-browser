import type { PageContent, PageSnapshot } from "./types.js";

const PAGE_CONTENT = new WeakMap<PageSnapshot, PageContent>();

export function attachPageContent(snapshot: PageSnapshot, content: PageContent): PageSnapshot {
  PAGE_CONTENT.set(snapshot, content);
  return snapshot;
}

export function pageContent(snapshot: PageSnapshot): PageContent {
  const content = PAGE_CONTENT.get(snapshot);
  if (content !== undefined) return content;
  throw new Error("The page snapshot is not attached to this browser workspace.");
}
