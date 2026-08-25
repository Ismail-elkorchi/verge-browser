import type { DocumentNodeRef, IndexedWebDocumentSnapshot } from "../document/index.js";

export type ReaderBlock =
  | { readonly kind: "heading"; readonly source: DocumentNodeRef; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph" | "quotation" | "term" | "definition"; readonly source: DocumentNodeRef; readonly text: string }
  | { readonly kind: "list-item"; readonly source: DocumentNodeRef; readonly depth: number; readonly marker: string; readonly text: string }
  | { readonly kind: "table"; readonly source: DocumentNodeRef; readonly rows: readonly ReaderTableRow[] }
  | { readonly kind: "media"; readonly source: DocumentNodeRef; readonly text: string };

export interface ReaderTableCell {
  readonly source: DocumentNodeRef;
  readonly header: boolean;
  readonly text: string;
}

export interface ReaderTableRow {
  readonly source: DocumentNodeRef;
  readonly cells: readonly ReaderTableCell[];
}

export interface ReaderDocument {
  readonly document: IndexedWebDocumentSnapshot;
  readonly title: string;
  readonly blocks: readonly ReaderBlock[];
  readonly truncated: boolean;
  readonly indexedNodes: number;
}

export interface ReaderBudgets {
  readonly maxNodes: number;
  readonly maxBlocks: number;
  readonly maxTextCodeUnits: number;
  readonly maxTableCells: number;
}
