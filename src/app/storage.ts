import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  cookieHeaderForUrl as cookieHeaderFromJar,
  mergeSetCookieHeaders,
  type CookieEntry
} from "./cookies.js";

export interface BookmarkEntry {
  readonly url: string;
  readonly name: string;
  readonly addedAtIso: string;
}

export interface HistoryEntry {
  readonly url: string;
  readonly title: string;
  readonly visitedAtIso: string;
  readonly excerpt?: string;
}

export interface IndexDocument {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly indexedAtIso: string;
}

export interface IndexSearchResult {
  readonly url: string;
  readonly title: string;
  readonly score: number;
  readonly indexedAtIso: string;
  readonly excerpt: string;
}

export type DownloadStatus = "queued" | "downloading" | "completed" | "failed" | "interrupted";

export interface DownloadRecord {
  readonly id: string;
  readonly url: string;
  readonly fileName: string;
  readonly destinationPath: string | null;
  readonly status: DownloadStatus;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly error: string | null;
  readonly startedAtIso: string;
  readonly updatedAtIso: string;
}

export type StoredSidePanel = "history" | "bookmarks" | "downloads" | null;

export interface StoredBrowserDocument {
  readonly url: string;
  readonly scrollAnchor: {
    readonly blockId: string;
    readonly rowOffset: number;
  };
}

export interface BrowserWorkspace {
  readonly documents: readonly StoredBrowserDocument[];
  readonly activeDocumentIndex: number;
  readonly sidePanel: StoredSidePanel;
}

interface BrowserState {
  readonly version: 2;
  readonly bookmarks: readonly BookmarkEntry[];
  readonly history: readonly HistoryEntry[];
  readonly cookies: readonly CookieEntry[];
  readonly indexDocuments: readonly IndexDocument[];
  readonly downloads: readonly DownloadRecord[];
  readonly workspace: BrowserWorkspace | null;
}

const DEFAULT_HISTORY_LIMIT = 500;
const STATE_FILE_VERSION = 2;

function defaultStatePath(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  const stateRoot = xdgStateHome && xdgStateHome.length > 0
    ? xdgStateHome
    : join(homedir(), ".local", "state");
  return join(stateRoot, "verge-browser", "state.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyState(): BrowserState {
  return {
    version: STATE_FILE_VERSION,
    bookmarks: [],
    history: [],
    cookies: [],
    indexDocuments: [],
    downloads: [],
    workspace: null
  };
}

function isBookmarkEntry(value: unknown): value is BookmarkEntry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["url"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["addedAtIso"] === "string"
  );
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["url"] === "string" &&
    typeof candidate["title"] === "string" &&
    typeof candidate["visitedAtIso"] === "string" &&
    (candidate["excerpt"] === undefined || typeof candidate["excerpt"] === "string")
  );
}

function isCookieEntry(value: unknown): value is CookieEntry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["name"] === "string" &&
    typeof candidate["value"] === "string" &&
    typeof candidate["domain"] === "string" &&
    typeof candidate["path"] === "string" &&
    typeof candidate["hostOnly"] === "boolean" &&
    typeof candidate["secure"] === "boolean" &&
    typeof candidate["httpOnly"] === "boolean" &&
    (candidate["sameSite"] === null || candidate["sameSite"] === "Lax" || candidate["sameSite"] === "Strict" || candidate["sameSite"] === "None") &&
    (candidate["expiresAtIso"] === null || typeof candidate["expiresAtIso"] === "string")
  );
}

function isIndexDocument(value: unknown): value is IndexDocument {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["url"] === "string" &&
    typeof candidate["title"] === "string" &&
    typeof candidate["text"] === "string" &&
    typeof candidate["indexedAtIso"] === "string"
  );
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string"
    && typeof candidate["url"] === "string"
    && typeof candidate["fileName"] === "string"
    && (candidate["destinationPath"] === null || typeof candidate["destinationPath"] === "string")
    && ["queued", "downloading", "completed", "failed", "interrupted"].includes(String(candidate["status"]))
    && Number.isSafeInteger(candidate["receivedBytes"])
    && (candidate["totalBytes"] === null || Number.isSafeInteger(candidate["totalBytes"]))
    && (candidate["error"] === null || typeof candidate["error"] === "string")
    && typeof candidate["startedAtIso"] === "string"
    && typeof candidate["updatedAtIso"] === "string";
}

function normalizeWorkspace(value: unknown): BrowserWorkspace | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate["documents"])) return null;
  const documents = candidate["documents"].flatMap((entry): StoredBrowserDocument[] => {
    if (entry === null || typeof entry !== "object") return [];
    const document = entry as Record<string, unknown>;
    const anchor = document["scrollAnchor"];
    if (typeof document["url"] !== "string" || anchor === null || typeof anchor !== "object") return [];
    const anchorRecord = anchor as Record<string, unknown>;
    if (
      typeof anchorRecord["blockId"] !== "string"
      || !Number.isSafeInteger(anchorRecord["rowOffset"])
      || Number(anchorRecord["rowOffset"]) < 0
    ) return [];
    return [{
      url: document["url"],
      scrollAnchor: {
        blockId: anchorRecord["blockId"],
        rowOffset: Number(anchorRecord["rowOffset"])
      }
    }];
  });
  if (documents.length === 0) return null;
  const rawActiveIndex = Number.isSafeInteger(candidate["activeDocumentIndex"])
    ? Number(candidate["activeDocumentIndex"])
    : 0;
  const sidePanel = candidate["sidePanel"];
  return {
    documents,
    activeDocumentIndex: Math.max(0, Math.min(documents.length - 1, rawActiveIndex)),
    sidePanel: sidePanel === "history" || sidePanel === "bookmarks" || sidePanel === "downloads"
      ? sidePanel
      : null
  };
}

function normalizeState(value: unknown): BrowserState {
  if (value === null || typeof value !== "object") {
    return createEmptyState();
  }

  const candidate = value as Record<string, unknown>;
  const bookmarksRaw = Array.isArray(candidate["bookmarks"]) ? candidate["bookmarks"] : [];
  const historyRaw = Array.isArray(candidate["history"]) ? candidate["history"] : [];
  const cookiesRaw = Array.isArray(candidate["cookies"]) ? candidate["cookies"] : [];
  const indexDocumentsRaw = Array.isArray(candidate["indexDocuments"]) ? candidate["indexDocuments"] : [];
  const downloadsRaw = Array.isArray(candidate["downloads"]) ? candidate["downloads"] : [];

  const bookmarks = bookmarksRaw.filter((entry): entry is BookmarkEntry => isBookmarkEntry(entry));
  const history = historyRaw.filter((entry): entry is HistoryEntry => isHistoryEntry(entry));
  const cookies = cookiesRaw.filter((entry): entry is CookieEntry => isCookieEntry(entry));
  const indexDocuments = indexDocumentsRaw.filter((entry): entry is IndexDocument => isIndexDocument(entry));
  const downloads = downloadsRaw
    .filter((entry): entry is DownloadRecord => isDownloadRecord(entry))
    .map((entry) => entry.status === "downloading"
      ? { ...entry, status: "interrupted" as const, error: "Download interrupted when the browser stopped." }
      : entry);

  return {
    version: STATE_FILE_VERSION,
    bookmarks,
    history,
    cookies,
    indexDocuments,
    downloads,
    workspace: normalizeWorkspace(candidate["workspace"])
  };
}

async function loadStateFromPath(statePath: string): Promise<BrowserState> {
  try {
    const rawText = await readFile(statePath, "utf8");
    try {
      const parsed = JSON.parse(rawText) as unknown;
      return normalizeState(parsed);
    } catch {
      return createEmptyState();
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error["code"] === "ENOENT") {
      return createEmptyState();
    }
    throw error;
  }
}

async function saveStateToPath(statePath: string, state: BrowserState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${String(process.pid)}`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, statePath);
}

export class BrowserStore {
  private readonly statePath: string;
  private readonly historyLimit: number;
  private readonly indexLimit: number;
  private state: BrowserState;
  private saveTail: Promise<void> = Promise.resolve();

  private constructor(statePath: string, historyLimit: number, indexLimit: number, state: BrowserState) {
    this.statePath = statePath;
    this.historyLimit = historyLimit;
    this.indexLimit = indexLimit;
    this.state = state;
  }

  public static async open(options: {
    readonly statePath?: string;
    readonly historyLimit?: number;
    readonly indexLimit?: number;
  } = {}): Promise<BrowserStore> {
    const statePath = options.statePath ?? defaultStatePath();
    const historyLimit = Math.max(1, Math.floor(options.historyLimit ?? DEFAULT_HISTORY_LIMIT));
    const indexLimit = Math.max(50, Math.floor(options.indexLimit ?? 1000));
    const state = await loadStateFromPath(statePath);
    return new BrowserStore(statePath, historyLimit, indexLimit, state);
  }

  public listBookmarks(): readonly BookmarkEntry[] {
    return this.state.bookmarks;
  }

  public listHistory(): readonly HistoryEntry[] {
    return this.state.history;
  }

  public workspace(): BrowserWorkspace | null {
    return this.state.workspace;
  }

  public listDownloads(): readonly DownloadRecord[] {
    return this.state.downloads;
  }

  public isBookmarked(url: string): boolean {
    return this.state.bookmarks.some((bookmark) => bookmark.url === url);
  }

  public listCookies(): readonly CookieEntry[] {
    return this.state.cookies;
  }

  public async clearCookies(): Promise<void> {
    this.state = {
      ...this.state,
      cookies: []
    };
    await this.save();
  }

  public async applySetCookieHeaders(requestUrl: string, setCookieHeaders: readonly string[]): Promise<void> {
    const nextCookies = mergeSetCookieHeaders(this.state.cookies, setCookieHeaders, requestUrl);
    this.state = {
      ...this.state,
      cookies: nextCookies
    };
    await this.save();
  }

  public cookieHeaderForUrl(requestUrl: string): string | null {
    return cookieHeaderFromJar(this.state.cookies, requestUrl);
  }

  public async addBookmark(url: string, name: string): Promise<BookmarkEntry> {
    const trimmedName = name.trim();
    const entry: BookmarkEntry = {
      url,
      name: trimmedName.length > 0 ? trimmedName : url,
      addedAtIso: nowIso()
    };

    const filteredBookmarks = this.state.bookmarks.filter((bookmark) => bookmark.url !== url);
    this.state = {
      ...this.state,
      bookmarks: [entry, ...filteredBookmarks]
    };

    await this.save();
    return entry;
  }

  public async toggleBookmark(url: string, name: string): Promise<boolean> {
    if (this.isBookmarked(url)) {
      this.state = {
        ...this.state,
        bookmarks: this.state.bookmarks.filter((bookmark) => bookmark.url !== url)
      };
      await this.save();
      return false;
    }
    await this.addBookmark(url, name);
    return true;
  }

  public async saveWorkspace(workspace: BrowserWorkspace): Promise<void> {
    this.state = { ...this.state, workspace };
    await this.save();
  }

  public async upsertDownload(download: DownloadRecord): Promise<void> {
    this.state = {
      ...this.state,
      downloads: [
        download,
        ...this.state.downloads.filter((entry) => entry.id !== download.id)
      ].slice(0, 200)
    };
    await this.save();
  }

  public async removeDownload(id: string): Promise<void> {
    this.state = {
      ...this.state,
      downloads: this.state.downloads.filter((entry) => entry.id !== id)
    };
    await this.save();
  }

  public async recordHistory(url: string, title: string, excerpt?: string): Promise<HistoryEntry> {
    const entry: HistoryEntry = {
      url,
      title: title.trim().length > 0 ? title : url,
      visitedAtIso: nowIso(),
      ...(excerpt && excerpt.trim().length > 0 ? { excerpt: excerpt.trim() } : {})
    };

    const deduplicatedHistory = this.state.history.filter((historyItem) => historyItem.url !== url);
    const nextHistory = [entry, ...deduplicatedHistory].slice(0, this.historyLimit);

    this.state = {
      ...this.state,
      history: nextHistory
    };

    await this.save();
    return entry;
  }

  public async recordIndexDocument(url: string, title: string, text: string): Promise<void> {
    const normalizedText = text.trim();
    if (normalizedText.length === 0) {
      return;
    }

    const nextDocument: IndexDocument = {
      url,
      title: title.trim().length > 0 ? title : url,
      text: normalizedText,
      indexedAtIso: nowIso()
    };

    const deduplicated = this.state.indexDocuments.filter((document) => document.url !== url);
    const nextIndexDocuments = [nextDocument, ...deduplicated].slice(0, this.indexLimit);

    this.state = {
      ...this.state,
      indexDocuments: nextIndexDocuments
    };
    await this.save();
  }

  public searchIndex(query: string, limit = 10): readonly IndexSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }
    const queryTokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
    if (queryTokens.length === 0) {
      return [];
    }

    const ranked = this.state.indexDocuments
      .map((document) => {
        const haystack = `${document.title}\n${document.text}`.toLowerCase();
        let score = 0;
        for (const queryToken of queryTokens) {
          const escapedToken = queryToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const matches = haystack.match(new RegExp(escapedToken, "g"));
          score += matches ? matches.length : 0;
        }
        if (score === 0) {
          return null;
        }
        return {
          url: document.url,
          title: document.title,
          score,
          indexedAtIso: document.indexedAtIso,
          excerpt: document.text.slice(0, 220)
        };
      })
      .filter((entry): entry is IndexSearchResult => entry !== null)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return right.indexedAtIso.localeCompare(left.indexedAtIso);
      });

    return ranked.slice(0, Math.max(1, Math.floor(limit)));
  }

  private save(): Promise<void> {
    const snapshot = this.state;
    const completion = this.saveTail.then(() => saveStateToPath(this.statePath, snapshot));
    this.saveTail = completion.catch(() => undefined);
    return completion;
  }
}
