import type { DocumentTree } from "html-parser";

export interface RenderedLink {
  readonly index: number;
  readonly label: string;
  readonly href: string;
  readonly resolvedHref: string;
}

export interface RenderedPage {
  readonly title: string;
  readonly displayUrl: string;
  readonly statusLine: string;
  readonly lines: readonly string[];
  readonly links: readonly RenderedLink[];
  readonly parseErrorCount: number;
  readonly fetchedAtIso: string;
}

export interface FetchPageResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  readonly html: string;
  readonly fetchedAtIso: string;
}

export interface RenderInput {
  readonly tree: DocumentTree;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
  readonly width: number;
}

export interface PageSnapshot {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly fetchedAtIso: string;
  readonly tree: DocumentTree;
  readonly rendered: RenderedPage;
}
