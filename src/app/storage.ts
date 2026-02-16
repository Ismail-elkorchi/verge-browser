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

interface BrowserState {
  readonly version: 2;
  readonly bookmarks: readonly BookmarkEntry[];
  readonly history: readonly HistoryEntry[];
  readonly cookies: readonly CookieEntry[];
  readonly indexDocuments: readonly IndexDocument[];
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
    indexDocuments: []
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

function normalizeState(value: unknown): BrowserState {
  if (value === null || typeof value !== "object") {
    return createEmptyState();
  }

  const candidate = value as Record<string, unknown>;
  const bookmarksRaw = Array.isArray(candidate["bookmarks"]) ? candidate["bookmarks"] : [];
  const historyRaw = Array.isArray(candidate["history"]) ? candidate["history"] : [];
  const cookiesRaw = Array.isArray(candidate["cookies"]) ? candidate["cookies"] : [];
  const indexDocumentsRaw = Array.isArray(candidate["indexDocuments"]) ? candidate["indexDocuments"] : [];

  const bookmarks = bookmarksRaw.filter((entry): entry is BookmarkEntry => isBookmarkEntry(entry));
  const history = historyRaw.filter((entry): entry is HistoryEntry => isHistoryEntry(entry));
  const cookies = cookiesRaw.filter((entry): entry is CookieEntry => isCookieEntry(entry));
  const indexDocuments = indexDocumentsRaw.filter((entry): entry is IndexDocument => isIndexDocument(entry));

  return {
    version: STATE_FILE_VERSION,
    bookmarks,
    history,
    cookies,
    indexDocuments
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

  public getStatePath(): string {
    return this.statePath;
  }

  public listBookmarks(): readonly BookmarkEntry[] {
    return this.state.bookmarks;
  }

  public listHistory(): readonly HistoryEntry[] {
    return this.state.history;
  }

  public latestHistoryUrl(): string | null {
    const latest = this.state.history[0];
    return latest ? latest.url : null;
  }

  public listCookies(): readonly CookieEntry[] {
    return this.state.cookies;
  }

  public async clearCookies(): Promise<void> {
    this.state = {
      ...this.state,
      cookies: []
    };
    await saveStateToPath(this.statePath, this.state);
  }

  public async applySetCookieHeaders(requestUrl: string, setCookieHeaders: readonly string[]): Promise<void> {
    const nextCookies = mergeSetCookieHeaders(this.state.cookies, setCookieHeaders, requestUrl);
    this.state = {
      ...this.state,
      cookies: nextCookies
    };
    await saveStateToPath(this.statePath, this.state);
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

    await saveStateToPath(this.statePath, this.state);
    return entry;
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

    await saveStateToPath(this.statePath, this.state);
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
    await saveStateToPath(this.statePath, this.state);
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
}
