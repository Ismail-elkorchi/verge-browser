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
  readonly hasExplicitHeaders: boolean;
  readonly explicitHeaders: readonly DocumentNodeRef[];
  readonly abbreviation: string | null;
  readonly header: boolean;
  readonly headerRole: "row" | "column" | null;
}

export interface HtmlTableSlotInterval {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly cell: DocumentNodeRef;
}

export interface HtmlTableRowSlot {
  readonly index: number;
  readonly node: DocumentNodeRef | null;
  readonly rowGroup: DocumentNodeRef | null;
}

export interface HtmlTableGroupRange {
  readonly node: DocumentNodeRef;
  readonly start: number;
  readonly end: number;
}

export interface HtmlTableCellPlacement {
  readonly node: DocumentNodeRef;
  readonly table: DocumentNodeRef;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly rowGroup: DocumentNodeRef | null;
  readonly columnGroups: readonly DocumentNodeRef[];
  readonly scope: HtmlTableCellScope;
  readonly header: boolean;
  readonly headerRole: "row" | "column" | null;
  readonly empty: boolean;
  readonly hasExplicitHeaders: boolean;
  readonly explicitHeaders: readonly DocumentNodeRef[];
  readonly sourceOrder: number;
}

export interface HtmlTableModelError {
  readonly kind: "overlapping-cells" | "cell-in-multiple-column-groups";
  readonly cell: DocumentNodeRef;
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
  readonly logicalRows: readonly HtmlTableRowSlot[];
  readonly columnCount: number;
  readonly rowGroupRanges: readonly HtmlTableGroupRange[];
  readonly columnGroupRanges: readonly HtmlTableGroupRange[];
  readonly cellPlacements: readonly HtmlTableCellPlacement[];
  readonly slotIntervals: readonly HtmlTableSlotInterval[];
  readonly downwardGrowingCells: readonly DocumentNodeRef[];
  readonly errors: readonly HtmlTableModelError[];
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
