import { PageAcquisition, type BrowserSessionOptions } from "./page-acquisition.js";
import { assertPageInitiatedNavigation } from "./security.js";
import {
  commitNavigation, currentEntry, emptyHistory, fragmentSnapshot, isSameDocumentNavigation,
  navigationAvailability, traverseHistory, type NavigationProvenance, type ParseMode,
} from "./navigation-history.js";
import type { PageRequestOptions, PageSnapshot } from "./types.js";
export type { BrowserSessionOptions, PageLoader, PageStreamLoader, StylesheetLoader, StylesheetPolicyOptions } from "./page-acquisition.js";
const PAGE_INITIATED_NAVIGATION = Symbol("pageInitiatedNavigation");

/** Imperative public facade over the same immutable history used by controlled clients. */
export class BrowserSession {
  readonly #acquisition: PageAcquisition;
  readonly #defaultParseMode: ParseMode;
  #history = emptyHistory();
  #sequence = 0;
  #closed = false;
  #active: AbortController | null = null;
  public constructor(options: BrowserSessionOptions = {}) {
    this.#acquisition = new PageAcquisition(options);
    this.#defaultParseMode = options.defaultParseMode ?? "stream";
  }
  public get current(): PageSnapshot | null { return currentEntry(this.#history)?.snapshot ?? null; }
  public canBack(): boolean { return navigationAvailability(this.#history).canGoBack; }
  public canForward(): boolean { return navigationAvailability(this.#history).canGoForward; }
  public async close(): Promise<void> {
    this.#closed = true;
    this.#cancel();
    this.#history = emptyHistory();
    await this.#acquisition.close();
  }
  public async destroy(reason?: Error): Promise<void> {
    this.#closed = true;
    this.#cancel();
    this.#history = emptyHistory();
    await this.#acquisition.destroy(reason);
  }
  #cancel(): void { this.#sequence += 1; this.#active?.abort(new Error("Navigation superseded.")); this.#active = null; }
  public open(url: string, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.#navigate(url, "push", this.#defaultParseMode, signal === undefined ? {} : { signal }, { kind: "direct" });
  }
  public openStream(url: string, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.#navigate(url, "push", "stream", signal === undefined ? {} : { signal }, { kind: "direct" });
  }
  public openWithRequest(url: string, options: PageRequestOptions, parseMode = this.#defaultParseMode): Promise<PageSnapshot> {
    return this.#navigate(url, "push", parseMode, options, { kind: "direct" });
  }
  public [PAGE_INITIATED_NAVIGATION](sourceUrl: string, url: string, options: PageRequestOptions = {}, parseMode = this.#defaultParseMode): Promise<PageSnapshot> {
    return this.#navigate(url, "push", parseMode, options, { kind: "page-initiated", sourceUrl });
  }
  public reload(signal?: AbortSignal): Promise<PageSnapshot> {
    const current = currentEntry(this.#history);
    if (current === undefined) return Promise.reject(new Error("No page is loaded"));
    return this.#navigate(current.snapshot.finalUrl, "replace", current.parseMode, signal === undefined ? {} : { signal }, current.provenance);
  }
  public back(signal?: AbortSignal): Promise<PageSnapshot> { return this.#traverse("back", signal); }
  public forward(signal?: AbortSignal): Promise<PageSnapshot> { return this.#traverse("forward", signal); }
  async #traverse(direction: "back" | "forward", signal?: AbortSignal): Promise<PageSnapshot> {
    if (this.#closed) throw new Error("Browser session is closed.");
    signal?.throwIfAborted();
    const next = traverseHistory(this.#history, direction);
    this.#cancel();
    this.#history = next;
    const entry = currentEntry(next);
    if (entry === undefined) throw new Error("History entry is missing.");
    return await Promise.resolve(entry.snapshot);
  }
  public async openLink(index: number, signal?: AbortSignal): Promise<PageSnapshot> {
    const current = currentEntry(this.#history)?.snapshot ?? null;
    if (current === null) throw new Error("No page is loaded");
    const link = current.document.links.find((candidate) => candidate.index === index);
    if (link === undefined) throw new Error(`No link exists at index ${String(index)}`);
    return this[PAGE_INITIATED_NAVIGATION](current.finalUrl, link.destination, signal === undefined ? {} : { signal }, current.diagnostics.parseMode);
  }
  async #navigate(url: string, mode: "push" | "replace", parseMode: ParseMode, options: PageRequestOptions, provenance: NavigationProvenance): Promise<PageSnapshot> {
    if (this.#closed) throw new Error("Browser session is closed.");
    options.signal?.throwIfAborted();
    if (provenance.kind === "page-initiated") assertPageInitiatedNavigation(provenance.sourceUrl, url);
    this.#cancel();
    const sequence = this.#sequence;
    const active = new AbortController();
    this.#active = active;
    const signal = options.signal === undefined ? active.signal : AbortSignal.any([active.signal, options.signal]);
    try {
      const current = currentEntry(this.#history);
      const same = mode === "push" && current !== undefined && isSameDocumentNavigation(current.snapshot.finalUrl, url, options);
      const snapshot = same ? fragmentSnapshot(current.snapshot, url)
        : await this.#acquisition.acquire(url, { ...options, signal }, parseMode, provenance);
      signal.throwIfAborted();
      if (sequence !== this.#sequence) throw new Error("Navigation superseded.");
      this.#history = commitNavigation(this.#history, snapshot, mode, provenance, same ? current.documentId : undefined);
      return snapshot;
    } finally { if (this.#active === active) this.#active = null; }
  }
}
/** @internal Applies the browser workspace's page-initiated network capability. */
export function openPageInitiatedNavigation(session: BrowserSession, sourceUrl: string, requestUrl: string, requestOptions: PageRequestOptions = {}, parseMode?: ParseMode): Promise<PageSnapshot> {
  return session[PAGE_INITIATED_NAVIGATION](sourceUrl, requestUrl, requestOptions, parseMode);
}
