import { outline as buildOutline, type Edit } from "@ismail-elkorchi/html-parser";

import { buildFormSubmissionRequest, extractForms, type FormEntry } from "../app/forms.js";
import type { BrowserSession } from "../app/session.js";
import type { BrowserStore } from "../app/storage.js";
import type { PageRequestOptions, PageSnapshot } from "../app/types.js";
import { resolveInputUrl } from "../app/url.js";
import type { BrowserServices } from "./services.js";
import type {
  BrowserDocumentState,
  DetailKind,
  PickerKind,
  PickerValue
} from "./model.js";

function excerpt(lines: readonly string[]): string {
  return lines
    .slice(0, 8)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 220)
    .trim();
}

function readerLines(snapshot: PageSnapshot): readonly string[] {
  const lines = snapshot.content.blocks
    .filter((block) => block.kind !== "form")
    .map((block) => block.text.replace(/\s+\[\d+\]/gu, "").trimEnd());
  return lines.length > 0 ? lines : ["No readable content."];
}

function diagnosticsLines(snapshot: PageSnapshot): readonly string[] {
  return [
    `URL: ${snapshot.finalUrl}`,
    `Status: ${String(snapshot.status)} ${snapshot.statusText}`,
    `Parse mode: ${snapshot.diagnostics.parseMode}`,
    `Request method: ${snapshot.diagnostics.requestMethod}`,
    `Network outcome: ${snapshot.diagnostics.networkOutcome.kind}`,
    `Network detail: ${snapshot.diagnostics.networkOutcome.detailMessage}`,
    `Source bytes: ${String(snapshot.diagnostics.sourceBytes)}`,
    `Parse errors: ${String(snapshot.diagnostics.parseErrorCount)}`,
    `Triage IDs: ${snapshot.diagnostics.triageIds.join(", ") || "(none)"}`,
    `Fetch ms: ${String(snapshot.diagnostics.fetchDurationMs)}`,
    `Parse ms: ${String(snapshot.diagnostics.parseDurationMs)}`,
    `Content ms: ${String(snapshot.diagnostics.contentDurationMs)}`,
    `Total ms: ${String(snapshot.diagnostics.totalDurationMs)}`
  ];
}

export interface BrowserControllerOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createSession: () => BrowserSession;
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
  readonly #createSession: () => BrowserSession;
  readonly #sessions = new Map<string, BrowserSession>();
  #nextDocumentNumber = 1;

  public constructor(options: BrowserControllerOptions) {
    this.#store = options.store;
    this.#services = options.services;
    this.#createSession = options.createSession;
  }

  public async openInitial(target: string): Promise<BrowserDocumentState> {
    const documentId = this.#newDocumentId();
    const session = this.#createSession();
    this.#sessions.set(documentId, session);
    const snapshot = await this.#open(session, target);
    return this.#document(documentId, snapshot);
  }

  public async navigate(
    document: BrowserDocumentState,
    target: string,
    requestOptions: PageRequestOptions = {},
    parseMode: "text" | "stream" = "text"
  ): Promise<PageSnapshot> {
    const session = this.#session(document.id);
    const resolvedTarget = resolveInputUrl(target, document.snapshot.finalUrl);
    const snapshot = await session.openWithRequest(
      resolvedTarget,
      this.#withCookies(resolvedTarget, requestOptions),
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
    await this.#persist(snapshot, operation === "reload");
    return snapshot;
  }

  public async openNew(target: string, signal?: AbortSignal): Promise<BrowserDocumentState> {
    const id = this.#newDocumentId();
    const session = this.#createSession();
    this.#sessions.set(id, session);
    const snapshot = await this.#open(session, target, signal);
    return this.#document(id, snapshot);
  }

  public async submitForm(
    document: BrowserDocumentState,
    form: FormEntry,
    values: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ): Promise<PageSnapshot> {
    const submission = buildFormSubmissionRequest(form, values);
    return this.navigate(document, submission.url, {
      ...submission.requestOptions,
      ...(signal === undefined ? {} : { signal })
    });
  }

  public async applyEdits(
    document: BrowserDocumentState,
    edits: readonly Edit[]
  ): Promise<PageSnapshot> {
    const snapshot = this.#session(document.id).applyEdits(edits);
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
    switch (kind) {
      case "documents":
        return documents.map((document, index) => ({
          id: document.id,
          label: document.snapshot.content.title,
          description: document.snapshot.finalUrl,
          value: { kind: "document", index }
        }));
      case "links":
        return active.snapshot.content.links.map((link) => ({
          id: `link-${String(link.index)}`,
          label: link.label,
          description: link.resolvedHref,
          value: { kind: "link", index: link.index, target: link.resolvedHref }
        }));
      case "history":
        return this.#store.listHistory().map((entry, index) => ({
          id: `history-${String(index)}`,
          label: entry.title,
          description: entry.url,
          value: { kind: "history", index, target: entry.url }
        }));
      case "bookmarks":
        return this.#store.listBookmarks().map((entry, index) => ({
          id: `bookmark-${String(index)}`,
          label: entry.name,
          description: entry.url,
          value: { kind: "bookmark", index, target: entry.url }
        }));
      case "forms":
        return extractForms(active.snapshot.document.tree, active.snapshot.finalUrl).map((form) => ({
          id: `form-${String(form.index)}`,
          label: `${form.method.toUpperCase()} ${form.actionUrl}`,
          description: `${String(form.fields.length)} fields`,
          value: { kind: "form", index: form.index }
        }));
      case "outline":
        return buildOutline(active.snapshot.document.tree).entries.map((entry, index) => {
          const blockId = active.snapshot.content.blocks.find(
            (block) => block.text.toLowerCase().includes(entry.text.trim().toLowerCase())
          )?.id;
          return {
            id: `outline-${String(index)}`,
            label: entry.text,
            description: `<${entry.localName}>`,
            value: {
              kind: "outline",
              index,
              ...(blockId === undefined ? {} : { blockId })
            }
          };
        });
      case "recall":
        return this.#store.searchIndex(query, 20).map((entry, index) => ({
          id: `recall-${String(index)}`,
          label: entry.title,
          description: entry.url,
          value: { kind: "recall", index, target: entry.url }
        }));
    }
  }

  public form(document: BrowserDocumentState, formIndex: number) {
    return extractForms(document.snapshot.document.tree, document.snapshot.finalUrl)
      .find((form) => form.index === formIndex);
  }

  public detail(kind: DetailKind, document: BrowserDocumentState): readonly string[] {
    if (kind === "help") {
      return [
        "] / [ focus next / previous link or form",
        "Enter activate · h back · f forward · r reload",
        "g location · : actions · / find · n/N next/previous match",
        "l links · D documents · H history · B bookmarks · F forms · o outline",
        "m bookmark · t new tab · x close tab · u reopen tab · q quit"
      ];
    }
    if (kind === "diagnostics") return diagnosticsLines(document.snapshot);
    if (kind === "reader") return readerLines(document.snapshot);
    const cookies = this.#store.listCookies();
    return cookies.length === 0
      ? ["No cookies stored."]
      : cookies.flatMap((cookie) => [
        `${cookie.name}=${cookie.value}`,
        `  scope: ${cookie.domain}${cookie.path}`,
        `  expires: ${cookie.expiresAtIso ?? "session"}`
      ]);
  }

  public async addBookmark(document: BrowserDocumentState): Promise<string> {
    const bookmark = await this.#store.addBookmark(
      document.snapshot.finalUrl,
      document.snapshot.content.title
    );
    return `Saved bookmark: ${bookmark.name}`;
  }

  public async clearCookies(): Promise<string> {
    await this.#store.clearCookies();
    return "Cookie store cleared.";
  }

  public editFormFieldExternally(value: string, label: string): Promise<string> {
    return this.#services.editTextExternally(value, label);
  }

  public async saveText(path: string, text: string): Promise<string> {
    await this.#services.writeTextFile(path, `${text}\n`);
    return `Saved text export to ${path}.`;
  }

  public async download(document: BrowserDocumentState, path: string): Promise<string> {
    const source = document.snapshot.document.sourceText;
    if (source === null) throw new Error("No HTML snapshot is available to download.");
    await this.#services.writeTextFile(path, source);
    return `Saved HTML snapshot to ${path}.`;
  }

  public async openExternal(document: BrowserDocumentState): Promise<string> {
    const actionable = document.focusedActionId === null
      ? undefined
      : document.snapshot.content.actions.find((action) => action.id === document.focusedActionId);
    const target = actionable?.kind === "link" ? actionable.resolvedHref : document.snapshot.finalUrl;
    await this.#services.openExternal(target);
    return `Opened ${target} externally.`;
  }

  async #open(session: BrowserSession, target: string, signal?: AbortSignal): Promise<PageSnapshot> {
    const resolvedTarget = resolveInputUrl(target);
    const snapshot = await session.openWithRequest(
      resolvedTarget,
      this.#withCookies(resolvedTarget, signal === undefined ? {} : { signal }),
      "text"
    );
    await this.#persist(snapshot);
    return snapshot;
  }

  #withCookies(target: string, options: PageRequestOptions): PageRequestOptions {
    const cookie = this.#store.cookieHeaderForUrl(target);
    if (!cookie || Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "cookie")) {
      return options;
    }
    return { ...options, headers: { ...(options.headers ?? {}), cookie } };
  }

  async #persist(snapshot: PageSnapshot, applyResponseCookies = true): Promise<void> {
    if (applyResponseCookies && snapshot.setCookieHeaders.length > 0) {
      await this.#store.applySetCookieHeaders(snapshot.finalUrl, snapshot.setCookieHeaders);
    }
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

  #newDocumentId(): string {
    const id = `document-${String(this.#nextDocumentNumber)}`;
    this.#nextDocumentNumber += 1;
    return id;
  }

  #document(id: string, snapshot: PageSnapshot): BrowserDocumentState {
    return {
      id,
      snapshot,
      scrollAnchor: { blockId: snapshot.content.blocks[0]?.id ?? "page:empty", rowOffset: 0 },
      focusedActionId: null,
      search: null,
      savedViews: {},
      loading: false
    };
  }
}
