import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { findAllByAttr, findAllByTagName, textContent, type ElementNode } from "html-parser";

import type { PageSnapshot } from "./types.js";

const UTF8_ENCODER = new TextEncoder();

const DEFAULT_CSS_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_CSS_FETCH_CONCURRENCY = 4;
const DEFAULT_MAX_CSS_BYTES_PER_SHEET = 512 * 1024;
const DEFAULT_MAX_LINKED_CSS_PER_PAGE = 20;
const DEFAULT_MAX_TOTAL_BYTES_PER_PAGE = 3 * 1024 * 1024;
const ALLOWED_LINKED_CSS_SCHEMES = new Set(["http:", "https:"]);

interface PageManifestRecord {
  readonly url: string;
  readonly urlSha256: string;
  readonly finalUrl: string;
  readonly finalUrlSha256: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly contentLength: number;
  readonly fetchedAtIso: string;
  readonly sha256: string;
  readonly headersSha256: string;
  readonly encodingHint: string | null;
  readonly skipped?: string;
}

interface CssManifestRecord {
  readonly pageSha256: string;
  readonly pageUrl: string;
  readonly kind: "inline-style" | "style-attr" | "linked";
  readonly sourceUrl: string | null;
  readonly sourceUrlSha256: string | null;
  readonly status: number | null;
  readonly contentType: string | null;
  readonly contentLength: number;
  readonly fetchedAtIso: string;
  readonly sha256: string | null;
  readonly skipReason: string | null;
}

interface LinkedCssCandidate {
  readonly hrefUrl: string;
  readonly skipReason: string | null;
}

interface LinkedCssFetchResult {
  readonly status: number | null;
  readonly contentType: string | null;
  readonly fetchedAtIso: string;
  readonly cssBytes: Uint8Array | null;
  readonly skipReason: string | null;
}

interface CorpusLayout {
  readonly baseDir: string;
  readonly htmlCacheDir: string;
  readonly cssCacheDir: string;
  readonly oracleCacheDir: string;
  readonly manifestsDir: string;
  readonly reportsDir: string;
  readonly triageDir: string;
  readonly pagesManifestPath: string;
  readonly cssManifestPath: string;
}

export interface CorpusRecorderOptions {
  readonly baseDir?: string;
  readonly cssFetchTimeoutMs?: number;
  readonly cssFetchConcurrency?: number;
  readonly maxCssBytesPerSheet?: number;
  readonly maxLinkedSheetsPerPage?: number;
  readonly maxTotalBytesPerPage?: number;
  readonly extraAllowedCssHosts?: readonly string[];
}

function hashSha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashSha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stripUrlFragment(value: string): string {
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    const hashIndex = value.indexOf("#");
    return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  }
}

function parseEncodingHint(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }
  const match = /charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(contentType);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].toLowerCase();
}

function buildCorpusLayout(baseDir: string): CorpusLayout {
  const resolvedBaseDir = resolve(baseDir);
  const htmlCacheDir = resolve(resolvedBaseDir, "cache/html");
  const cssCacheDir = resolve(resolvedBaseDir, "cache/css");
  const oracleCacheDir = resolve(resolvedBaseDir, "cache/oracle");
  const manifestsDir = resolve(resolvedBaseDir, "manifests");
  const reportsDir = resolve(resolvedBaseDir, "reports");
  const triageDir = resolve(resolvedBaseDir, "triage");
  return {
    baseDir: resolvedBaseDir,
    htmlCacheDir,
    cssCacheDir,
    oracleCacheDir,
    manifestsDir,
    reportsDir,
    triageDir,
    pagesManifestPath: resolve(manifestsDir, "pages.ndjson"),
    cssManifestPath: resolve(manifestsDir, "css.ndjson")
  };
}

async function ensureCorpusLayout(layout: CorpusLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.htmlCacheDir, { recursive: true }),
    mkdir(layout.cssCacheDir, { recursive: true }),
    mkdir(layout.oracleCacheDir, { recursive: true }),
    mkdir(layout.manifestsDir, { recursive: true }),
    mkdir(layout.reportsDir, { recursive: true }),
    mkdir(layout.triageDir, { recursive: true })
  ]);
}

async function writeBlobIfMissing(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

async function appendNdjsonRecord(path: string, value: object): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function assertPathWithinRoot(rootPath: string, targetPath: string, label: string): void {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`corpus-path-outside-root:${label}`);
}

function canonicalizeHeaders(headers: Readonly<Record<string, string>> | undefined): readonly [string, string][] {
  const entries = Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return entries;
}

function getAttrValue(node: ElementNode, attrName: string): string | null {
  for (const attribute of node.attributes) {
    if (attribute.name.toLowerCase() === attrName.toLowerCase()) {
      return attribute.value;
    }
  }
  return null;
}

function parseExtraAllowedCssHosts(rawValue: string | undefined): readonly string[] {
  if (!rawValue) {
    return [];
  }
  const values = rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return Array.from(new Set(values));
}

function linkedStylesheetCandidates(
  snapshot: PageSnapshot,
  maxLinkedSheetsPerPage: number,
  allowedHosts: ReadonlySet<string>
): readonly LinkedCssCandidate[] {
  const candidates: LinkedCssCandidate[] = [];
  for (const node of findAllByTagName(snapshot.tree, "link")) {
    if (candidates.length >= maxLinkedSheetsPerPage) {
      break;
    }
    const rel = getAttrValue(node, "rel");
    const href = getAttrValue(node, "href");
    if (!rel || !href) {
      continue;
    }
    const relTokens = rel.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    if (!relTokens.includes("stylesheet")) {
      continue;
    }

    let hrefUrl: string;
    try {
      const resolvedUrl = new URL(href, snapshot.finalUrl);
      if (!ALLOWED_LINKED_CSS_SCHEMES.has(resolvedUrl.protocol)) {
        candidates.push({ hrefUrl: resolvedUrl.toString(), skipReason: `blocked-url-scheme:${resolvedUrl.protocol}` });
        continue;
      }
      const host = resolvedUrl.hostname.toLowerCase();
      if (!allowedHosts.has(host)) {
        candidates.push({ hrefUrl: resolvedUrl.toString(), skipReason: `blocked-url-host:${host}` });
        continue;
      }
      hrefUrl = resolvedUrl.toString();
    } catch {
      candidates.push({ hrefUrl: href, skipReason: "blocked-url-parse" });
      continue;
    }

    candidates.push({ hrefUrl: stripUrlFragment(hrefUrl), skipReason: null });
  }
  return candidates;
}

async function readResponseBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<{ readonly bytes: Uint8Array | null; readonly skipReason: string | null }> {
  if (!stream) {
    return { bytes: new Uint8Array(), skipReason: null };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const nextChunk = await reader.read();
      if (nextChunk.done) {
        break;
      }
      totalBytes += nextChunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("css-byte-limit");
        return { bytes: null, skipReason: "sheet-byte-limit-exceeded" };
      }
      chunks.push(nextChunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const mergedBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    mergedBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: mergedBytes, skipReason: null };
}

async function fetchLinkedCss(
  hrefUrl: string,
  timeoutMs: number,
  maxCssBytesPerSheet: number
): Promise<LinkedCssFetchResult> {
  const startedAtIso = new Date().toISOString();
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort("linked-css-timeout");
  }, timeoutMs);

  try {
    const response = await fetch(hrefUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: {
        accept: "text/css,*/*;q=0.1",
        "user-agent": "verge-browser/0.1 (+field-corpus)"
      }
    });

    if (!response.ok) {
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        fetchedAtIso: startedAtIso,
        cssBytes: null,
        skipReason: `http-status-${String(response.status)}`
      };
    }

    const readResult = await readResponseBytesWithLimit(response.body, maxCssBytesPerSheet);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      fetchedAtIso: startedAtIso,
      cssBytes: readResult.bytes,
      skipReason: readResult.skipReason
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        status: null,
        contentType: null,
        fetchedAtIso: startedAtIso,
        cssBytes: null,
        skipReason: "request-timeout"
      };
    }
    return {
      status: null,
      contentType: null,
      fetchedAtIso: startedAtIso,
      cssBytes: null,
      skipReason: "request-error"
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const mappedValues: Array<R | undefined> = Array.from({ length: items.length }, () => undefined);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      mappedValues[index] = await mapper(item, index);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  for (const mappedValue of mappedValues) {
    if (mappedValue === undefined) {
      throw new Error("concurrency mapper produced incomplete result");
    }
  }
  return mappedValues as readonly R[];
}

export class CorpusRecorder {
  private readonly layout: CorpusLayout;
  private readonly cssFetchTimeoutMs: number;
  private readonly cssFetchConcurrency: number;
  private readonly maxCssBytesPerSheet: number;
  private readonly maxLinkedSheetsPerPage: number;
  private readonly maxTotalBytesPerPage: number;
  private readonly extraAllowedCssHosts: ReadonlySet<string>;
  private layoutReady = false;

  public constructor(options: CorpusRecorderOptions = {}) {
    const baseDir = options.baseDir
      ?? process.env.VERGE_CORPUS_DIR
      ?? resolve(process.cwd(), "realworld/corpus");
    this.layout = buildCorpusLayout(baseDir);
    this.cssFetchTimeoutMs = options.cssFetchTimeoutMs ?? DEFAULT_CSS_FETCH_TIMEOUT_MS;
    this.cssFetchConcurrency = options.cssFetchConcurrency ?? DEFAULT_CSS_FETCH_CONCURRENCY;
    this.maxCssBytesPerSheet = options.maxCssBytesPerSheet ?? DEFAULT_MAX_CSS_BYTES_PER_SHEET;
    this.maxLinkedSheetsPerPage = options.maxLinkedSheetsPerPage ?? DEFAULT_MAX_LINKED_CSS_PER_PAGE;
    this.maxTotalBytesPerPage = options.maxTotalBytesPerPage ?? DEFAULT_MAX_TOTAL_BYTES_PER_PAGE;
    const extraAllowedHosts = options.extraAllowedCssHosts ?? parseExtraAllowedCssHosts(process.env.VERGE_CSS_HOST_ALLOWLIST);
    this.extraAllowedCssHosts = new Set(extraAllowedHosts.map((host) => host.toLowerCase()));
  }

  public get corpusDir(): string {
    return this.layout.baseDir;
  }

  public async recordNavigation(snapshot: PageSnapshot): Promise<void> {
    if (!this.layoutReady) {
      await ensureCorpusLayout(this.layout);
      this.layoutReady = true;
    }

    const normalizedRequestUrl = stripUrlFragment(snapshot.requestUrl);
    const normalizedFinalUrl = stripUrlFragment(snapshot.finalUrl);

    if (!snapshot.sourceHtml) {
      const skippedRecord: PageManifestRecord = {
        url: normalizedRequestUrl,
        urlSha256: hashSha256String(normalizedRequestUrl),
        finalUrl: normalizedFinalUrl,
        finalUrlSha256: hashSha256String(normalizedFinalUrl),
        status: snapshot.status,
        contentType: snapshot.contentType,
        contentLength: 0,
        fetchedAtIso: snapshot.fetchedAtIso,
        sha256: "",
        headersSha256: hashSha256String("[]"),
        encodingHint: parseEncodingHint(snapshot.contentType),
        skipped: "source-html-unavailable"
      };
      assertPathWithinRoot(this.layout.baseDir, this.layout.pagesManifestPath, "pages-manifest");
      await appendNdjsonRecord(this.layout.pagesManifestPath, skippedRecord);
      return;
    }

    const htmlBytes = UTF8_ENCODER.encode(snapshot.sourceHtml);
    const pageSha256 = hashSha256Bytes(htmlBytes);
    const htmlPath = resolve(this.layout.htmlCacheDir, `${pageSha256}.bin`);
    assertPathWithinRoot(this.layout.baseDir, htmlPath, "html-cache");
    await writeBlobIfMissing(htmlPath, htmlBytes);

    const headersCanonical = canonicalizeHeaders(snapshot.responseHeaders);
    const headersSha256 = hashSha256String(JSON.stringify(headersCanonical));

    const pageRecord: PageManifestRecord = {
      url: normalizedRequestUrl,
      urlSha256: hashSha256String(normalizedRequestUrl),
      finalUrl: normalizedFinalUrl,
      finalUrlSha256: hashSha256String(normalizedFinalUrl),
      status: snapshot.status,
      contentType: snapshot.contentType,
      contentLength: htmlBytes.byteLength,
      fetchedAtIso: snapshot.fetchedAtIso,
      sha256: pageSha256,
      headersSha256,
      encodingHint: parseEncodingHint(snapshot.contentType)
    };
    assertPathWithinRoot(this.layout.baseDir, this.layout.pagesManifestPath, "pages-manifest");
    await appendNdjsonRecord(this.layout.pagesManifestPath, pageRecord);

    let totalBytes = htmlBytes.byteLength;
    const cssRecords: CssManifestRecord[] = [];

    const appendInlineCssRecord = async (
      kind: "inline-style" | "style-attr",
      cssText: string,
      fetchedAtIso: string,
      sourceUrl: string | null
    ): Promise<void> => {
      const cssBytes = UTF8_ENCODER.encode(cssText);
      if (cssBytes.byteLength === 0) {
        return;
      }

      let skipReason: string | null = null;
      let cssSha256: string | null = null;
      if (cssBytes.byteLength > this.maxCssBytesPerSheet) {
        skipReason = "sheet-byte-limit-exceeded";
      } else if (totalBytes + cssBytes.byteLength > this.maxTotalBytesPerPage) {
        skipReason = "page-byte-budget-exceeded";
      } else {
        cssSha256 = hashSha256Bytes(cssBytes);
        const suffix = kind === "style-attr" ? ".decl" : ".css";
        const cssPath = resolve(this.layout.cssCacheDir, `${cssSha256}${suffix}`);
        assertPathWithinRoot(this.layout.baseDir, cssPath, "css-cache");
        await writeBlobIfMissing(cssPath, cssBytes);
        totalBytes += cssBytes.byteLength;
      }

      cssRecords.push({
        pageSha256,
        pageUrl: normalizedFinalUrl,
        kind,
        sourceUrl,
        sourceUrlSha256: sourceUrl ? hashSha256String(stripUrlFragment(sourceUrl)) : null,
        status: 200,
        contentType: kind === "style-attr" ? "text/css-declaration" : "text/css",
        contentLength: cssBytes.byteLength,
        fetchedAtIso,
        sha256: cssSha256,
        skipReason
      });
    };

    for (const styleNode of findAllByTagName(snapshot.tree, "style")) {
      await appendInlineCssRecord("inline-style", textContent(styleNode), snapshot.fetchedAtIso, normalizedFinalUrl);
    }

    for (const node of findAllByAttr(snapshot.tree, "style")) {
      const value = getAttrValue(node, "style");
      if (!value) {
        continue;
      }
      await appendInlineCssRecord("style-attr", value, snapshot.fetchedAtIso, normalizedFinalUrl);
    }

    let finalHost: string | null = null;
    try {
      finalHost = new URL(normalizedFinalUrl).hostname.toLowerCase();
    } catch {
      finalHost = null;
    }
    const allowedHosts = new Set(this.extraAllowedCssHosts);
    if (finalHost) {
      allowedHosts.add(finalHost);
    }
    const linkedCandidates = linkedStylesheetCandidates(snapshot, this.maxLinkedSheetsPerPage, allowedHosts);
    const linkedResults = await mapWithConcurrency(
      linkedCandidates,
      this.cssFetchConcurrency,
      async (candidate) => {
        if (candidate.skipReason) {
          return {
            candidate,
            fetchResult: {
              status: null,
              contentType: null,
              fetchedAtIso: snapshot.fetchedAtIso,
              cssBytes: null,
              skipReason: candidate.skipReason
            } as LinkedCssFetchResult
          };
        }
        return {
          candidate,
          fetchResult: await fetchLinkedCss(candidate.hrefUrl, this.cssFetchTimeoutMs, this.maxCssBytesPerSheet)
        };
      }
    );

    for (const linkedResult of linkedResults) {
      const { candidate, fetchResult } = linkedResult;
      let sha256: string | null = null;
      let skipReason: string | null = fetchResult.skipReason;
      const cssBytes = fetchResult.cssBytes;

      if (!skipReason && cssBytes) {
        if (totalBytes + cssBytes.byteLength > this.maxTotalBytesPerPage) {
          skipReason = "page-byte-budget-exceeded";
        } else {
          sha256 = hashSha256Bytes(cssBytes);
          const cssPath = resolve(this.layout.cssCacheDir, `${sha256}.css`);
          assertPathWithinRoot(this.layout.baseDir, cssPath, "css-cache");
          await writeBlobIfMissing(cssPath, cssBytes);
          totalBytes += cssBytes.byteLength;
        }
      }

      cssRecords.push({
        pageSha256,
        pageUrl: normalizedFinalUrl,
        kind: "linked",
        sourceUrl: candidate.hrefUrl,
        sourceUrlSha256: hashSha256String(candidate.hrefUrl),
        status: fetchResult.status,
        contentType: fetchResult.contentType,
        contentLength: cssBytes?.byteLength ?? 0,
        fetchedAtIso: fetchResult.fetchedAtIso,
        sha256,
        skipReason
      });
    }

    for (const cssRecord of cssRecords) {
      assertPathWithinRoot(this.layout.baseDir, this.layout.cssManifestPath, "css-manifest");
      await appendNdjsonRecord(this.layout.cssManifestPath, cssRecord);
    }
  }
}
