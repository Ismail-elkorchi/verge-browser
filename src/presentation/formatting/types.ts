import type {
  DocumentFormControl,
  DocumentNodeRef,
  DocumentSemanticEntry,
  DocumentSourceRange,
  DocumentState,
  IndexedWebDocumentSnapshot
} from "../../document/index.js";
import type {
  ComputedWhiteSpace,
  PseudoElementIdentity,
  StyleSnapshot
} from "../style/index.js";

export type FormattingNodeId = string & { readonly __formattingNodeId: unique symbol };

export type FormattingNodeKind =
  | "root"
  | "block-container"
  | "inline-container"
  | "text-sequence"
  | "forced-line-break"
  | "anonymous-block"
  | "anonymous-inline"
  | "list-item"
  | "marker"
  | "generated-text"
  | "pseudo-box"
  | "table-wrapper"
  | "table"
  | "table-caption"
  | "table-column-group"
  | "table-column"
  | "table-header-group"
  | "table-body-group"
  | "table-footer-group"
  | "table-row"
  | "table-cell"
  | "flex-container"
  | "flex-item"
  | "grid-container"
  | "grid-item"
  | "replaced-element"
  | "image-fallback"
  | "form-control";

interface FormattingNodeBase {
  readonly id: FormattingNodeId;
  readonly kind: FormattingNodeKind;
  readonly source: DocumentNodeRef | null;
  readonly styleNode: DocumentNodeRef | null;
  readonly pseudo: PseudoElementIdentity | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly children: readonly FormattingNodeId[];
  readonly semantic: DocumentSemanticEntry | null;
  readonly outer: "block" | "inline";
  /** Whether this formatting node owns the source element's principal box values. */
  readonly appliesBoxStyle: boolean;
}

export interface FormattingContainerNode extends FormattingNodeBase {
  readonly kind:
    | "root"
    | "block-container"
    | "inline-container"
    | "anonymous-block"
    | "anonymous-inline"
    | "list-item"
    | "pseudo-box"
    | "table-wrapper"
    | "table"
    | "table-caption"
    | "table-column-group"
    | "table-header-group"
    | "table-body-group"
    | "table-footer-group"
    | "table-row"
    | "table-cell"
    | "flex-container"
    | "flex-item"
    | "grid-container"
    | "grid-item";
}

export interface FormattingTextNode extends FormattingNodeBase {
  readonly kind: "text-sequence" | "generated-text" | "marker";
  readonly text: string;
  readonly whiteSpace: ComputedWhiteSpace;
}

export interface FormattingBreakNode extends FormattingNodeBase {
  readonly kind: "forced-line-break";
}

export interface FormattingReplacedNode extends FormattingNodeBase {
  readonly kind: "replaced-element" | "image-fallback";
  readonly fallbackText: string;
  readonly intrinsicWidth: number | null;
  readonly intrinsicHeight: number | null;
}

export interface FormattingFormControlNode extends FormattingNodeBase {
  readonly kind: "form-control";
  readonly control: DocumentFormControl;
}

export interface FormattingColumnNode extends FormattingNodeBase {
  readonly kind: "table-column";
  readonly span: number;
}

export type FormattingNode =
  | FormattingContainerNode
  | FormattingTextNode
  | FormattingBreakNode
  | FormattingReplacedNode
  | FormattingFormControlNode
  | FormattingColumnNode;

export interface SuppressedFormattingSubtree {
  readonly source: DocumentNodeRef;
  readonly reason: "display-none";
}

export interface FormattingBudgets {
  readonly maxFormattingNodes: number;
  readonly maxDepth: number;
  readonly maxTextCodeUnits: number;
  readonly maxAnonymousWrappers: number;
}

export type FormattingOutcome =
  | { readonly status: "complete"; readonly nodes: number }
  | {
      readonly status: "truncated";
      readonly nodes: number;
      readonly budget: keyof FormattingBudgets;
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "document-style-mismatch" };

export interface BuildFormattingTreeInput {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly styles: StyleSnapshot;
  readonly budgets?: Partial<FormattingBudgets>;
  readonly signal?: AbortSignal;
}

export interface FormattingTree {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly styles: StyleSnapshot;
  readonly root: FormattingNodeId;
  readonly suppressed: readonly SuppressedFormattingSubtree[];
  readonly outcome: FormattingOutcome;
  node(id: FormattingNodeId): FormattingNode;
  parent(id: FormattingNodeId): FormattingNode | null;
  children(id: FormattingNodeId): readonly FormattingNode[];
  forSource(source: DocumentNodeRef): readonly FormattingNode[];
}
