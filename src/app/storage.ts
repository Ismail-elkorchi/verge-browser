import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";
import type { SerializedCookieJar } from "tough-cookie";

import {
  BrowserCookieSession,
  serializedCookieJar,
  type CookieSummary
} from "./cookie-session.js";

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
  readonly bookmarks: readonly BookmarkEntry[];
  readonly history: readonly HistoryEntry[];
  readonly cookieJar: SerializedCookieJar | null;
  readonly indexDocuments: readonly IndexDocument[];
  readonly downloads: readonly DownloadRecord[];
  readonly workspace: BrowserWorkspace | null;
}

const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_INDEX_LIMIT = 250;
const MAX_HISTORY_LIMIT = 2000;
const MAX_INDEX_LIMIT = 250;
const MAX_INDEX_TEXT_CODE_UNITS = 16 * 1024;
const MAX_STATE_BYTES = 80 * 1024 * 1024;
const MAX_WORKSPACE_DOCUMENTS = 50;
const MAX_SCROLL_BLOCK_ID_CODE_UNITS = 512;
const MAX_SCROLL_ROW_OFFSET = 10_000_000;
const MAX_SEARCH_QUERY_TOKENS = 16;
const MAX_SEARCH_TOKEN_CODE_UNITS = 128;
const MAX_SEARCH_QUERY_CODE_UNITS = 2048;
const MAX_BOOKMARKS = 1000;
const MAX_DOWNLOADS = 200;
const MAX_URL_CODE_UNITS = 8 * 1024;
const MAX_TITLE_CODE_UNITS = 512;
const MAX_PATH_CODE_UNITS = 16 * 1024;
const MAX_ERROR_CODE_UNITS = 2048;
const MAX_ID_CODE_UNITS = 256;
const MAX_TIMESTAMP_CODE_UNITS = 64;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function defaultStatePath(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  const stateRoot = xdgStateHome && xdgStateHome.length > 0
    ? xdgStateHome
    : process.platform === "win32"
      ? process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : join(homedir(), ".local", "state");
  return join(stateRoot, "verge-browser", "state.json");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate)
    ? Math.max(minimum, Math.min(maximum, Math.floor(candidate)))
    : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyState(): BrowserState {
  return {
    bookmarks: [],
    history: [],
    cookieJar: null,
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
    && Number(candidate["receivedBytes"]) >= 0
    && (candidate["totalBytes"] === null || (
      Number.isSafeInteger(candidate["totalBytes"])
      && Number(candidate["totalBytes"]) >= 0
    ))
    && (candidate["error"] === null || typeof candidate["error"] === "string")
    && typeof candidate["startedAtIso"] === "string"
    && typeof candidate["updatedAtIso"] === "string";
}

function normalizeDownload(entry: DownloadRecord): DownloadRecord {
  return {
    id: entry.id.slice(0, MAX_ID_CODE_UNITS),
    url: entry.url.slice(0, MAX_URL_CODE_UNITS),
    fileName: entry.fileName.slice(0, MAX_TITLE_CODE_UNITS),
    destinationPath: entry.destinationPath?.slice(0, MAX_PATH_CODE_UNITS) ?? null,
    status: entry.status,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    error: entry.error?.slice(0, MAX_ERROR_CODE_UNITS) ?? null,
    startedAtIso: entry.startedAtIso.slice(0, MAX_TIMESTAMP_CODE_UNITS),
    updatedAtIso: entry.updatedAtIso.slice(0, MAX_TIMESTAMP_CODE_UNITS)
  };
}

function normalizeWorkspace(value: unknown): BrowserWorkspace | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate["documents"])) return null;
  const documents = candidate["documents"].flatMap((entry): StoredBrowserDocument[] => {
    if (entry === null || typeof entry !== "object") return [];
    const document = entry as Record<string, unknown>;
    const anchor = document["scrollAnchor"];
    if (
      typeof document["url"] !== "string"
      || document["url"].length > MAX_URL_CODE_UNITS
      || anchor === null
      || typeof anchor !== "object"
    ) return [];
    const anchorRecord = anchor as Record<string, unknown>;
    if (
      typeof anchorRecord["blockId"] !== "string"
      || !Number.isSafeInteger(anchorRecord["rowOffset"])
      || Number(anchorRecord["rowOffset"]) < 0
    ) return [];
    return [{
      url: document["url"],
      scrollAnchor: {
        blockId: anchorRecord["blockId"].slice(0, MAX_SCROLL_BLOCK_ID_CODE_UNITS),
        rowOffset: Math.min(Number(anchorRecord["rowOffset"]), MAX_SCROLL_ROW_OFFSET)
      }
    }];
  }).slice(0, MAX_WORKSPACE_DOCUMENTS);
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
  const indexDocumentsRaw = Array.isArray(candidate["indexDocuments"]) ? candidate["indexDocuments"] : [];
  const downloadsRaw = Array.isArray(candidate["downloads"]) ? candidate["downloads"] : [];

  const bookmarks = bookmarksRaw
    .filter((entry): entry is BookmarkEntry => isBookmarkEntry(entry))
    .slice(0, MAX_BOOKMARKS)
    .map((entry) => ({
      url: entry.url.slice(0, MAX_URL_CODE_UNITS),
      name: entry.name.slice(0, MAX_TITLE_CODE_UNITS),
      addedAtIso: entry.addedAtIso.slice(0, MAX_TIMESTAMP_CODE_UNITS)
    }));
  const history = historyRaw
    .filter((entry): entry is HistoryEntry => isHistoryEntry(entry))
    .slice(0, MAX_HISTORY_LIMIT)
    .map((entry) => ({
      url: entry.url.slice(0, MAX_URL_CODE_UNITS),
      title: entry.title.slice(0, MAX_TITLE_CODE_UNITS),
      visitedAtIso: entry.visitedAtIso.slice(0, MAX_TIMESTAMP_CODE_UNITS),
      ...(entry.excerpt === undefined ? {} : { excerpt: entry.excerpt.slice(0, 220) })
    }));
  const indexDocuments = indexDocumentsRaw
    .filter((entry): entry is IndexDocument => isIndexDocument(entry))
    .slice(0, MAX_INDEX_LIMIT)
    .map((entry) => ({
      url: entry.url.slice(0, MAX_URL_CODE_UNITS),
      title: entry.title.slice(0, MAX_TITLE_CODE_UNITS),
      text: entry.text.slice(0, MAX_INDEX_TEXT_CODE_UNITS),
      indexedAtIso: entry.indexedAtIso.slice(0, MAX_TIMESTAMP_CODE_UNITS)
    }));
  const downloads = downloadsRaw
    .filter((entry): entry is DownloadRecord => isDownloadRecord(entry))
    .slice(0, MAX_DOWNLOADS)
    .map(normalizeDownload)
    .map((entry) => entry.status === "downloading"
      ? { ...entry, status: "interrupted" as const, error: "Download interrupted when the browser stopped." }
      : entry);

  return {
    bookmarks,
    history,
    cookieJar: serializedCookieJar(candidate["cookieJar"]),
    indexDocuments,
    downloads,
    workspace: normalizeWorkspace(candidate["workspace"])
  };
}

async function loadStateFromPath(statePath: string): Promise<BrowserState> {
  try {
    const file = await lstat(statePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error(`Browser state path must be a regular file: ${statePath}`);
    }
    if (file.size > MAX_STATE_BYTES) {
      throw new Error(`Browser state exceeds the ${String(MAX_STATE_BYTES)}-byte safety limit: ${statePath}`);
    }
    await restrictPermissions(statePath, PRIVATE_FILE_MODE);
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

async function restrictPermissions(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, mode);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function prepareStateDirectory(statePath: string): Promise<void> {
  const directory = dirname(statePath);
  const created = await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryEntry = await lstat(directory);
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new Error(`Browser state directory must be a real directory: ${directory}`);
  }
  if (created !== undefined || basename(directory) === "verge-browser") {
    await restrictPermissions(directory, PRIVATE_DIRECTORY_MODE);
  }
}

async function saveStateToPath(statePath: string, state: BrowserState): Promise<void> {
  await prepareStateDirectory(statePath);
  const tempPath = `${statePath}.tmp-${String(process.pid)}-${randomUUID()}`;
  const payload = `${JSON.stringify(normalizeState(state), null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) {
    throw new Error(
      `Browser state exceeds the ${String(MAX_STATE_BYTES)}-byte safety limit.`
    );
  }
  try {
    await writeFile(tempPath, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    await restrictPermissions(tempPath, PRIVATE_FILE_MODE);
    await rename(tempPath, statePath);
    await restrictPermissions(statePath, PRIVATE_FILE_MODE);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export class BrowserStore {
  private readonly statePath: string;
  private readonly historyLimit: number;
  private readonly indexLimit: number;
  private readonly cookieSession: BrowserCookieSession;
  private state: BrowserState;
  private saveTail: Promise<void> = Promise.resolve();

  private constructor(statePath: string, historyLimit: number, indexLimit: number, state: BrowserState) {
    this.statePath = statePath;
    this.historyLimit = historyLimit;
    this.indexLimit = indexLimit;
    this.state = state;
    this.cookieSession = new BrowserCookieSession(
      state.cookieJar,
      async (cookieJar) => {
        this.state = { ...this.state, cookieJar };
        await this.save();
      }
    );
  }

  public static async open(options: {
    readonly statePath?: string;
    readonly historyLimit?: number;
    readonly indexLimit?: number;
  } = {}): Promise<BrowserStore> {
    const statePath = options.statePath ?? defaultStatePath();
    const historyLimit = boundedInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
    const indexLimit = boundedInteger(options.indexLimit, DEFAULT_INDEX_LIMIT, 50, MAX_INDEX_LIMIT);
    await prepareStateDirectory(statePath);
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
    const normalizedUrl = url.slice(0, MAX_URL_CODE_UNITS);
    return this.state.bookmarks.some((bookmark) => bookmark.url === normalizedUrl);
  }

  public get httpSession(): HttpSessionAdapter {
    return this.cookieSession;
  }

  public listCookies(): readonly CookieSummary[] {
    return this.cookieSession.list();
  }

  public async clearCookies(): Promise<void> {
    await this.cookieSession.clear();
  }

  public async addBookmark(url: string, name: string): Promise<BookmarkEntry> {
    const trimmedName = name.trim();
    const entry: BookmarkEntry = {
      url: url.slice(0, MAX_URL_CODE_UNITS),
      name: (trimmedName.length > 0 ? trimmedName : url).slice(0, MAX_TITLE_CODE_UNITS),
      addedAtIso: nowIso()
    };

    const filteredBookmarks = this.state.bookmarks.filter((bookmark) => bookmark.url !== entry.url);
    this.state = {
      ...this.state,
      bookmarks: [entry, ...filteredBookmarks].slice(0, MAX_BOOKMARKS)
    };

    await this.save();
    return entry;
  }

  public async toggleBookmark(url: string, name: string): Promise<boolean> {
    if (this.isBookmarked(url)) {
      this.state = {
        ...this.state,
        bookmarks: this.state.bookmarks.filter(
          (bookmark) => bookmark.url !== url.slice(0, MAX_URL_CODE_UNITS)
        )
      };
      await this.save();
      return false;
    }
    await this.addBookmark(url, name);
    return true;
  }

  public async saveWorkspace(workspace: BrowserWorkspace): Promise<void> {
    this.state = { ...this.state, workspace: normalizeWorkspace(workspace) };
    await this.save();
  }

  public async upsertDownload(download: DownloadRecord): Promise<void> {
    const normalized = normalizeDownload(download);
    this.state = {
      ...this.state,
      downloads: [
        normalized,
        ...this.state.downloads.filter((entry) => entry.id !== normalized.id)
      ].slice(0, MAX_DOWNLOADS)
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
      url: url.slice(0, MAX_URL_CODE_UNITS),
      title: (title.trim().length > 0 ? title : url).slice(0, MAX_TITLE_CODE_UNITS),
      visitedAtIso: nowIso(),
      ...(excerpt && excerpt.trim().length > 0 ? { excerpt: excerpt.trim().slice(0, 220) } : {})
    };

    const deduplicatedHistory = this.state.history.filter((historyItem) => historyItem.url !== entry.url);
    const nextHistory = [entry, ...deduplicatedHistory].slice(0, this.historyLimit);

    this.state = {
      ...this.state,
      history: nextHistory
    };

    await this.save();
    return entry;
  }

  public async recordIndexDocument(url: string, title: string, text: string): Promise<void> {
    const normalizedText = text.trim().slice(0, MAX_INDEX_TEXT_CODE_UNITS);
    if (normalizedText.length === 0) {
      return;
    }

    const nextDocument: IndexDocument = {
      url: url.slice(0, MAX_URL_CODE_UNITS),
      title: (title.trim().length > 0 ? title : url).slice(0, MAX_TITLE_CODE_UNITS),
      text: normalizedText,
      indexedAtIso: nowIso()
    };

    const deduplicated = this.state.indexDocuments.filter((document) => document.url !== nextDocument.url);
    const nextIndexDocuments = [nextDocument, ...deduplicated].slice(0, this.indexLimit);

    this.state = {
      ...this.state,
      indexDocuments: nextIndexDocuments
    };
    await this.save();
  }

  public async recordPage(
    url: string,
    title: string,
    excerpt: string,
    text: string
  ): Promise<void> {
    const normalizedUrl = url.slice(0, MAX_URL_CODE_UNITS);
    const normalizedTitle = (title.trim().length > 0 ? title : url).slice(0, MAX_TITLE_CODE_UNITS);
    const historyEntry: HistoryEntry = {
      url: normalizedUrl,
      title: normalizedTitle,
      visitedAtIso: nowIso(),
      ...(excerpt.trim().length === 0 ? {} : { excerpt: excerpt.trim().slice(0, 220) })
    };
    const normalizedText = text.trim().slice(0, MAX_INDEX_TEXT_CODE_UNITS);
    const history = [
      historyEntry,
      ...this.state.history.filter((entry) => entry.url !== normalizedUrl)
    ].slice(0, this.historyLimit);
    const indexDocuments = normalizedText.length === 0
      ? this.state.indexDocuments
      : [{
        url: normalizedUrl,
        title: normalizedTitle,
        text: normalizedText,
        indexedAtIso: nowIso()
      }, ...this.state.indexDocuments.filter((entry) => entry.url !== normalizedUrl)]
        .slice(0, this.indexLimit);
    this.state = { ...this.state, history, indexDocuments };
    await this.save();
  }

  public searchIndex(query: string, limit = 10): readonly IndexSearchResult[] {
    const normalizedQuery = query
      .slice(0, MAX_SEARCH_QUERY_CODE_UNITS)
      .trim()
      .toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }
    const queryTokens = [...new Set(normalizedQuery
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .slice(0, MAX_SEARCH_QUERY_TOKENS)
      .map((token) => token.slice(0, MAX_SEARCH_TOKEN_CODE_UNITS)))];
    if (queryTokens.length === 0) {
      return [];
    }

    const ranked = this.state.indexDocuments
      .map((document) => {
        const haystack = `${document.title}\n${document.text}`.toLowerCase();
        let score = 0;
        for (const queryToken of queryTokens) {
          let offset = 0;
          while (offset < haystack.length) {
            const match = haystack.indexOf(queryToken, offset);
            if (match < 0) break;
            score += 1;
            offset = match + Math.max(1, queryToken.length);
          }
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

    return ranked.slice(0, boundedInteger(limit, 10, 1, 100));
  }

  public async flush(): Promise<void> {
    await this.cookieSession.flush();
    await this.saveTail;
  }

  private save(): Promise<void> {
    const snapshot = this.state;
    const completion = this.saveTail.then(() => saveStateToPath(this.statePath, snapshot));
    this.saveTail = completion.catch(() => undefined);
    return completion;
  }
}
