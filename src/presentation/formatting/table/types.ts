import type { DocumentNodeRef } from "../../../document/index.js";
import type { FormattingContainerNode, FormattingNode, FormattingNodeId } from "../types.js";

export interface TableBoxFixupHost {
  anonymousContainer(
    kind: "table-wrapper" | "table" | "table-column-group" | "table-body-group" | "table-row" | "table-cell",
    styleNode: DocumentNodeRef | null,
    children: readonly FormattingNodeId[],
    outer: "block" | "inline",
  ): FormattingContainerNode;
  collapsesEntireTextRun(node: FormattingNode): boolean;
  isOutOfFlow(node: FormattingNode): boolean;
}
