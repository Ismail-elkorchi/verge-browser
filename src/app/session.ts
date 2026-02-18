import { parse, type DocumentTree } from "html-parser";

import { fetchPage } from "./fetch-page.js";
import { renderDocumentToTerminal } from "./render.js";
import type { FetchPageResult, PageSnapshot, RenderedPage } from "./types.js";

export type PageLoader = (requestUrl: string) => Promise<FetchPageResult>;
export type PageRenderer = (input: {
  readonly tree: DocumentTree;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
  readonly width: number;
}) => RenderedPage;

export interface BrowserSessionOptions {
  readonly loader?: PageLoader;
  readonly renderer?: PageRenderer;
  readonly widthProvider?: () => number;
}

export class BrowserSession {
  private readonly loader: PageLoader;
  private readonly renderer: PageRenderer;
  private readonly widthProvider: () => number;
  private readonly historyUrls: string[] = [];
  private historyIndex = -1;
  private currentSnapshot: PageSnapshot | null = null;

  public constructor(options: BrowserSessionOptions = {}) {
    this.loader = options.loader ?? fetchPage;
    this.renderer = options.renderer ?? renderDocumentToTerminal;
    this.widthProvider = options.widthProvider ?? (() => 100);
  }

  public get current(): PageSnapshot | null {
    return this.currentSnapshot;
  }

  public canBack(): boolean {
    return this.historyIndex > 0;
  }

  public canForward(): boolean {
    return this.historyIndex >= 0 && this.historyIndex < this.historyUrls.length - 1;
  }

  public async open(requestUrl: string): Promise<PageSnapshot> {
    return this.navigate(requestUrl, "push");
  }

  public async reload(): Promise<PageSnapshot> {
    const currentUrl = this.historyUrls[this.historyIndex];
    if (!currentUrl) {
      throw new Error("No page is loaded");
    }
    return this.navigate(currentUrl, "replace");
  }

  public async back(): Promise<PageSnapshot> {
    if (!this.canBack()) {
      throw new Error("No backward history entry");
    }
    this.historyIndex -= 1;
    const targetUrl = this.historyUrls[this.historyIndex];
    if (!targetUrl) {
      throw new Error("History entry is missing");
    }
    return this.navigate(targetUrl, "replace");
  }

  public async forward(): Promise<PageSnapshot> {
    if (!this.canForward()) {
      throw new Error("No forward history entry");
    }
    this.historyIndex += 1;
    const targetUrl = this.historyUrls[this.historyIndex];
    if (!targetUrl) {
      throw new Error("History entry is missing");
    }
    return this.navigate(targetUrl, "replace");
  }

  public async openLink(linkIndex: number): Promise<PageSnapshot> {
    const currentPage = this.currentSnapshot;
    if (!currentPage) {
      throw new Error("No page is loaded");
    }

    const targetLink = currentPage.rendered.links.find((link) => link.index === linkIndex);
    if (!targetLink) {
      throw new Error(`No link exists at index ${String(linkIndex)}`);
    }

    return this.navigate(targetLink.resolvedHref, "push");
  }

  private commitHistory(url: string, mode: "push" | "replace"): void {
    if (mode === "replace") {
      if (this.historyIndex < 0) {
        this.historyUrls.push(url);
        this.historyIndex = 0;
        return;
      }
      this.historyUrls[this.historyIndex] = url;
      return;
    }

    const truncatedHistory = this.historyUrls.slice(0, this.historyIndex + 1);
    truncatedHistory.push(url);
    this.historyUrls.splice(0, this.historyUrls.length, ...truncatedHistory);
    this.historyIndex = this.historyUrls.length - 1;
  }

  private async navigate(requestUrl: string, mode: "push" | "replace"): Promise<PageSnapshot> {
    const fetchedPage = await this.loader(requestUrl);
    const tree = parse(fetchedPage.html, {
      captureSpans: false,
      trace: false
    });

    const width = Math.max(40, this.widthProvider());
    const rendered = this.renderer({
      tree,
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      width
    });

    const snapshot: PageSnapshot = {
      requestUrl: fetchedPage.requestUrl,
      finalUrl: fetchedPage.finalUrl,
      status: fetchedPage.status,
      statusText: fetchedPage.statusText,
      fetchedAtIso: fetchedPage.fetchedAtIso,
      tree,
      rendered
    };

    this.currentSnapshot = snapshot;
    this.commitHistory(snapshot.finalUrl, mode);

    return snapshot;
  }
}
