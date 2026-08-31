import type { DocumentNodeRef } from "../types.js";

export type HtmlTableCellScope = "row" | "col" | "rowgroup" | "colgroup" | "auto";

export interface HtmlTableCellMetadata {
  readonly node: DocumentNodeRef;
  readonly table: DocumentNodeRef;
  readonly row: DocumentNodeRef;
  readonly rowGroup: DocumentNodeRef | null;
  readonly columnSpan: number;
  readonly rowSpan: number | "remaining-row-group";
  readonly scope: HtmlTableCellScope;
  readonly explicitHeaders: readonly DocumentNodeRef[];
  readonly abbreviation: string | null;
  readonly header: boolean;
}

export interface HtmlTableColumnMetadata {
  readonly node: DocumentNodeRef;
  readonly table: DocumentNodeRef;
  readonly columnGroup: DocumentNodeRef | null;
  readonly span: number;
}

export interface HtmlTableColumnGroupMetadata {
  readonly node: DocumentNodeRef;
  readonly table: DocumentNodeRef;
  readonly span: number;
}

export interface HtmlTableMetadata {
  readonly node: DocumentNodeRef;
  readonly captions: readonly DocumentNodeRef[];
  readonly rowGroups: readonly DocumentNodeRef[];
  readonly rows: readonly DocumentNodeRef[];
  readonly columnGroups: readonly DocumentNodeRef[];
  readonly columns: readonly DocumentNodeRef[];
  readonly cells: readonly DocumentNodeRef[];
}

export interface HtmlTableMetadataIndex {
  readonly tables: ReadonlyMap<DocumentNodeRef, HtmlTableMetadata>;
  readonly cells: ReadonlyMap<DocumentNodeRef, HtmlTableCellMetadata>;
  readonly columns: ReadonlyMap<DocumentNodeRef, HtmlTableColumnMetadata>;
  readonly columnGroups: ReadonlyMap<DocumentNodeRef, HtmlTableColumnGroupMetadata>;
  readonly headerAssociations: ReadonlyMap<DocumentNodeRef, readonly DocumentNodeRef[]>;
  readonly slotWork: number;
  readonly headerAssociationWork: number;
  readonly truncation: "slot-work" | "header-association-work" | null;
}

export interface HtmlTableHeaderCellPlacement {
  readonly node: DocumentNodeRef;
  readonly table: DocumentNodeRef;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly rowGroup: DocumentNodeRef | null;
  readonly columnGroup: DocumentNodeRef | null;
  readonly scope: HtmlTableCellScope;
  readonly header: boolean;
  readonly explicitHeaders: readonly DocumentNodeRef[];
}
