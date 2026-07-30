import { dirname } from "node:path";

import { outline as buildOutline, type Edit } from "@ismail-elkorchi/html-parser";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import {
  buildFormSubmissionRequest,
  extractForms,
  type FormControlValue,
  type FormEntry
} from "../app/forms.js";
import { buildPageContent } from "../app/render.js";
import type { BrowserSession } from "../app/session.js";
import {
  type BrowserWorkspace,
  type DownloadRecord,
  type StoredSidePanel,
  type BrowserStore
} from "../app/storage.js";
import type { PageRequestOptions, PageSnapshot } from "../app/types.js";
import {
  DEFAULT_SEARCH_URL_TEMPLATE,
  resolveInputUrl,
  resolveOmniboxInput
} from "../app/url.js";
import type { BrowserServices } from "./services.js";
import type {
  BrowserDocumentState,
  BrowserTuiState,
  DetailKind,
  PickerKind,
  PickerValue
} from "./model.js";

const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

function excerpt(lines: readonly string[]): string {
  return lines
    .slice(0, 8)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 220)
    .trim();
}

function readerLines(snapshot: PageSnapshot): readonly string[] {
  const readerContent = buildPageContent({
    tree: snapshot.document.tree,
    requestUrl: snapshot.requestUrl,
    finalUrl: snapshot.finalUrl,
    status: snapshot.status,
    statusText: snapshot.statusText,
    fetchedAtIso: snapshot.fetchedAtIso,
    authorStyles: "ignore"
  });
  const lines = readerContent.blocks
    .filter((block) => block.kind !== "form")
    .map((block) => block.text.replace(/\s+\[\d+\]/gu, "").trimEnd());
  return lines.length > 0 ? lines : ["No readable content."];
}

function diagnosticsLines(snapshot: PageSnapshot): readonly string[] {
  return [
    `URL: ${snapshot.finalUrl}`,
    `Status: ${String(snapshot.status)} ${snapshot.statusText}`,
    `Content type: ${snapshot.contentType ?? "unknown"}`,
    `Parse mode: ${snapshot.diagnostics.parseMode}`,
    `Request method: ${snapshot.diagnostics.requestMethod}`,
    `Network outcome: ${snapshot.diagnostics.networkOutcome.kind}`,
    `Network detail: ${snapshot.diagnostics.networkOutcome.detailMessage}`,
    `Source bytes: ${String(snapshot.diagnostics.sourceBytes)}`,
    `Parse errors: ${String(snapshot.diagnostics.parseErrorCount)}`,
    `Stylesheets: ${String(snapshot.diagnostics.stylesheetCount)}`,
    `Style issues: ${String(snapshot.diagnostics.styleIssueCount)}`,
    `Total ms: ${String(snapshot.diagnostics.totalDurationMs)}`,
    ...snapshot.content.styleIssues.slice(0, 12).map((issue) =>
      `CSS ${issue.code}${issue.occurrences > 1 ? ` ×${String(issue.occurrences)}` : ""}: ${issue.message} (${issue.sourceUrl})`
    )
  ];
}

export interface BrowserControllerOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
}

export interface BrowserPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: PickerValue;
}

export class BrowserController {
  readonly #store: BrowserStore;
  readonly #services: BrowserServices;
  readonly #createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly #searchUrlTemplate: string;
  readonly #downloadDirectory: string;
  readonly #downloadMaxBytes: number;
  readonly #sessions = new Map<string, BrowserSession>();
  #nextDocumentNumber = 1;

  public constructor(options: BrowserControllerOptions) {
    this.#store = options.store;
    this.#services = options.services;
    this.#createSession = options.createSession;
    this.#searchUrlTemplate = options.searchUrlTemplate ?? DEFAULT_SEARCH_URL_TEMPLATE;
    this.#downloadDirectory = options.downloadDirectory ?? "Downloads";
    this.#downloadMaxBytes = options.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  }

  public library() {
    return {
      history: this.#store.listHistory(),
      bookmarks: this.#store.listBookmarks(),
      downloads: this.#store.listDownloads()
    };
  }

  public workspace(): BrowserWorkspace | null {
    return this.#store.workspace();
  }

  public async saveWorkspace(state: BrowserTuiState): Promise<void> {
    await this.#releaseDiscardedSessions(state);
    const workspace: BrowserWorkspace = {
      documents: state.documents.map((document) => ({
        url: document.snapshot.finalUrl,
        scrollAnchor: document.scrollAnchor
      })),
      activeDocumentIndex: state.activeDocumentIndex,
      sidePanel: state.sidePanel satisfies StoredSidePanel
    };
    await this.#store.saveWorkspace(workspace);
  }

  public async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all([
      ...sessions.map(async (session) => {
        await session.close();
      }),
      this.#services.close()
    ]);
  }

  public async openInitial(
    target: string,
    scrollAnchor?: BrowserDocumentState["scrollAnchor"]
  ): Promise<BrowserDocumentState> {
    return this.#openNewDocument(target, undefined, scrollAnchor);
  }

  public resolveOmnibox(value: string, currentUrl: string): string {
    return resolveOmniboxInput(value, currentUrl, this.#searchUrlTemplate);
  }

  public omniboxSuggestions(
    value: string,
    document: BrowserDocumentState,
    limit = 8
  ): readonly { readonly value: string; readonly label: string; readonly description?: string }[] {
    const query = value.trim().toLowerCase();
    const candidates = [
      ...document.snapshot.content.links.map((link) => ({
        value: link.resolvedHref,
        label: link.label,
        description: "Current page"
      })),
      ...this.#store.listBookmarks().map((entry) => ({
        value: entry.url,
        label: entry.name,
        description: "Bookmark"
      })),
      ...this.#store.listHistory().map((entry) => ({
        value: entry.url,
        label: entry.title,
        description: "History"
      })),
      ...this.#store.searchIndex(value, limit).map((entry) => ({
        value: entry.url,
        label: entry.title,
        description: "Page text"
      }))
    ];
    const seen = new Set<string>();
    return candidates
      .filter((entry) => {
        if (seen.has(entry.value)) return false;
        seen.add(entry.value);
        return query.length === 0
          || entry.value.toLowerCase().includes(query)
          || entry.label.toLowerCase().includes(query);
      })
      .slice(0, limit);
  }

  public navigationAvailability(document: BrowserDocumentState): {
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
  } {
    const session = this.#session(document.id);
    return { canGoBack: session.canBack(), canGoForward: session.canForward() };
  }

  public async navigate(
    document: BrowserDocumentState,
    target: string,
    requestOptions: PageRequestOptions = {},
    parseMode?: "text" | "stream"
  ): Promise<PageSnapshot> {
    const resolvedTarget = resolveInputUrl(target, document.snapshot.finalUrl);
    const snapshot = await this.#session(document.id).openWithRequest(
      resolvedTarget,
      requestOptions,
      parseMode
    );
    await this.#persist(snapshot);
    return snapshot;
  }

  public async openLink(
    document: BrowserDocumentState,
    linkIndex: number,
    signal?: AbortSignal
  ): Promise<PageSnapshot> {
    const snapshot = await this.#session(document.id).openLink(linkIndex, signal);
    await this.#persist(snapshot);
    return snapshot;
  }

  public async traverse(
    document: BrowserDocumentState,
    operation: "back" | "forward" | "reload",
    signal?: AbortSignal
  ): Promise<PageSnapshot> {
    const session = this.#session(document.id);
    const snapshot = operation === "back"
      ? await session.back(signal)
      : operation === "forward"
        ? await session.forward(signal)
        : await session.reload(signal);
    await this.#persist(snapshot);
    return snapshot;
  }

  public openNew(
    target = "about:newtab",
    signal?: AbortSignal
  ): Promise<BrowserDocumentState> {
    return this.#openNewDocument(target, signal);
  }

  public async submitForm(
    document: BrowserDocumentState,
    form: FormEntry,
    values: readonly FormControlValue[],
    submitterId: string | undefined,
    signal?: AbortSignal
  ): Promise<PageSnapshot> {
    const submission = buildFormSubmissionRequest(form, values, submitterId);
    return this.navigate(document, submission.url, {
      ...submission.requestOptions,
      ...(signal === undefined ? {} : { signal })
    });
  }

  public async applyEdits(
    document: BrowserDocumentState,
    edits: readonly Edit[]
  ): Promise<PageSnapshot> {
    const snapshot = await this.#session(document.id).applyEdits(edits);
    await this.#persist(snapshot);
    return snapshot;
  }

  public pickerEntries(
    kind: PickerKind,
    documents: readonly BrowserDocumentState[],
    activeDocumentIndex: number,
    query = ""
  ): readonly BrowserPickerEntry[] {
    const active = documents[activeDocumentIndex];
    if (!active) return [];
    if (kind === "links") {
      return active.snapshot.content.links.map((link) => ({
        id: `link-${String(link.index)}`,
        label: link.label,
        description: link.resolvedHref,
        value: { kind: "link", index: link.index, target: link.resolvedHref }
      }));
    }
    if (kind === "outline") {
      return buildOutline(active.snapshot.document.tree).entries.map((entry, index) => {
        const blockId = active.snapshot.content.blocks.find(
          (block) => block.text.toLowerCase().includes(entry.text.trim().toLowerCase())
        )?.id;
        return {
          id: `outline-${String(index)}`,
          label: entry.text,
          description: `<${entry.localName}>`,
          value: { kind: "outline", index, ...(blockId === undefined ? {} : { blockId }) }
        };
      });
    }
    return this.#store.searchIndex(query, 20).map((entry, index) => ({
      id: `recall-${String(index)}`,
      label: entry.title,
      description: entry.url,
      value: { kind: "recall", index, target: entry.url }
    }));
  }

  public forms(document: BrowserDocumentState): readonly FormEntry[] {
    return extractForms(document.snapshot.document.tree, document.snapshot.finalUrl);
  }

  public form(document: BrowserDocumentState, formId: string): FormEntry | undefined {
    return this.forms(document).find((form) => form.id === formId);
  }

  public detail(kind: Exclude<DetailKind, "help">, document: BrowserDocumentState): readonly string[] {
    if (kind === "diagnostics") return diagnosticsLines(document.snapshot);
    if (kind === "reader") return readerLines(document.snapshot);
    const cookies = this.#store.listCookies();
    return cookies.length === 0
      ? ["No cookies stored."]
      : cookies.flatMap((cookie) => [
        `${cookie.name}=${cookie.value}`,
        `  scope: ${cookie.domain}${cookie.path}`,
        `  expires: ${cookie.expiresAt ?? "session"}`
      ]);
  }

  public async toggleBookmark(document: BrowserDocumentState, name?: string): Promise<string> {
    const added = await this.#store.toggleBookmark(
      document.snapshot.finalUrl,
      name ?? document.snapshot.content.title
    );
    return added ? "Bookmark added." : "Bookmark removed.";
  }

  public async clearCookies(): Promise<string> {
    await this.#store.clearCookies();
    return "Cookie store cleared.";
  }

  public async saveText(path: string, text: string): Promise<string> {
    await this.#services.writeTextFile(path, `${text}\n`);
    return `Saved text export to ${path}.`;
  }

  public async savePage(document: BrowserDocumentState, path: string): Promise<string> {
    const source = document.snapshot.document.sourceText;
    if (source === null) throw new Error("No HTML source is available for this page.");
    await this.#services.writeTextFile(path, source);
    return `Saved page source to ${path}.`;
  }

  public async download(
    url: string,
    id: string,
    signal?: AbortSignal
  ): Promise<DownloadRecord> {
    const startedAtIso = new Date().toISOString();
    const initial: DownloadRecord = {
      id,
      url,
      fileName: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "download",
      destinationPath: null,
      status: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      startedAtIso,
      updatedAtIso: startedAtIso
    };
    await this.#store.upsertDownload(initial);
    try {
      const downloaded = await this.#services.downloadFile({
        url,
        directory: this.#downloadDirectory,
        maxBytes: this.#downloadMaxBytes,
        session: this.#store.httpSession,
        ...(signal === undefined ? {} : { signal })
      });
      const completed: DownloadRecord = {
        ...initial,
        fileName: downloaded.fileName,
        destinationPath: downloaded.path,
        status: "completed",
        receivedBytes: downloaded.receivedBytes,
        totalBytes: downloaded.totalBytes,
        updatedAtIso: new Date().toISOString()
      };
      await this.#store.upsertDownload(completed);
      return completed;
    } catch (error) {
      const failed: DownloadRecord = {
        ...initial,
        status: signal?.aborted === true ? "interrupted" : "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAtIso: new Date().toISOString()
      };
      await this.#store.upsertDownload(failed);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { download: failed });
    }
  }

  public async removeDownload(id: string): Promise<string> {
    await this.#store.removeDownload(id);
    return "Download removed from the list.";
  }

  public async openDownload(id: string, location: "file" | "directory"): Promise<string> {
    const download = this.#store.listDownloads().find((entry) => entry.id === id);
    if (!download?.destinationPath) throw new Error("The download has no completed file.");
    await this.#services.openPath(location === "file" ? download.destinationPath : dirname(download.destinationPath));
    return location === "file" ? "Opened downloaded file." : "Opened download directory.";
  }

  public async openExternal(target: string): Promise<string> {
    await this.#services.openExternal(target);
    return `Opened ${target} externally.`;
  }

  async #openNewDocument(
    target: string,
    signal?: AbortSignal,
    scrollAnchor?: BrowserDocumentState["scrollAnchor"]
  ): Promise<BrowserDocumentState> {
    const id = this.#newDocumentId();
    const session = this.#createSession(this.#store.httpSession);
    this.#sessions.set(id, session);
    const snapshot = await this.#open(session, target, signal);
    return this.#document(id, snapshot, scrollAnchor);
  }

  async #open(session: BrowserSession, target: string, signal?: AbortSignal): Promise<PageSnapshot> {
    const resolvedTarget = resolveInputUrl(target);
    const snapshot = await session.open(
      resolvedTarget,
      signal
    );
    await this.#persist(snapshot);
    return snapshot;
  }

  async #persist(snapshot: PageSnapshot): Promise<void> {
    if (snapshot.finalUrl.startsWith("about:")) return;
    await this.#store.recordHistory(
      snapshot.finalUrl,
      snapshot.content.title,
      excerpt(snapshot.content.blocks.map((block) => block.text))
    );
    await this.#store.recordIndexDocument(
      snapshot.finalUrl,
      snapshot.content.title,
      snapshot.content.blocks.map((block) => block.text).join("\n")
    );
  }

  #session(documentId: string): BrowserSession {
    const session = this.#sessions.get(documentId);
    if (!session) throw new Error(`No browser session exists for ${documentId}.`);
    return session;
  }

  async #releaseDiscardedSessions(state: BrowserTuiState): Promise<void> {
    const retainedIds = new Set([
      ...state.documents.map((document) => document.id),
      ...state.recentlyClosed.map((document) => document.id)
    ]);
    const discarded = [...this.#sessions.entries()]
      .filter(([id]) => !retainedIds.has(id));
    for (const [id] of discarded) {
      this.#sessions.delete(id);
    }
    await Promise.all(
      discarded.map(async ([, session]) => {
        await session.close();
      })
    );
  }

  #newDocumentId(): string {
    const id = `document-${String(this.#nextDocumentNumber)}`;
    this.#nextDocumentNumber += 1;
    return id;
  }

  #document(
    id: string,
    snapshot: PageSnapshot,
    restoredScrollAnchor?: BrowserDocumentState["scrollAnchor"]
  ): BrowserDocumentState {
    const firstAnchor = { blockId: snapshot.content.blocks[0]?.id ?? "page:empty", rowOffset: 0 };
    return {
      id,
      snapshot,
      scrollAnchor: restoredScrollAnchor
        && snapshot.content.blocks.some((block) => block.id === restoredScrollAnchor.blockId)
        ? restoredScrollAnchor
        : firstAnchor,
      search: null,
      formValues: {},
      formEditors: {},
      savedViews: {},
      loading: false,
      pendingUrl: null,
      canGoBack: false,
      canGoForward: false,
      error: null
    };
  }
}
