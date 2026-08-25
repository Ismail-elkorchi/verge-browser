import type {
  DocumentNodeRef,
  DocumentSemanticEntry,
  DocumentSourceRange
} from "../../document/index.js";
import type { FormattingNodeId, FormattingTree } from "../formatting/index.js";
import type { CssColor } from "../style/index.js";
import type { VisibleTextMatchId } from "./visible-text.js";

export type FragmentId = string & { readonly __fragmentId: unique symbol };

export interface TerminalRect {
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalGrapheme {
  readonly text: string;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly cells: number;
}

export interface TerminalTextMeasurer {
  width(text: string): number;
  graphemes(text: string): readonly TerminalGrapheme[];
}

export interface TerminalProfile {
  readonly cellWidthPx: number;
  readonly rowHeightPx: number;
  readonly colorDepth: 0 | 4 | 8 | 24;
  readonly unicode: boolean;
  readonly ambiguousWidth: 1 | 2;
}

export interface TerminalViewport {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalStyleRun {
  readonly foreground: CssColor | null;
  readonly background: CssColor | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
}

export type TerminalAction =
  | { readonly kind: "link"; readonly node: DocumentNodeRef; readonly destination: string }
  | { readonly kind: "form-control"; readonly node: DocumentNodeRef; readonly form: DocumentNodeRef | null }
  | { readonly kind: "disclosure"; readonly node: DocumentNodeRef; readonly open: boolean };

interface FragmentBase {
  readonly id: FragmentId;
  readonly kind: "container" | "text" | "control" | "replaced";
  readonly formatting: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly rect: TerminalRect;
  readonly clip: TerminalRect;
  readonly children: readonly FragmentId[];
  readonly visualOrder: number;
  readonly paintOrder: number;
  readonly action: TerminalAction | null;
  readonly semantic: DocumentSemanticEntry | null;
}

export interface ContainerFragment extends FragmentBase {
  readonly kind: "container";
}

export interface TextFragment extends FragmentBase {
  readonly kind: "text";
  readonly text: string;
  readonly style: TerminalStyleRun;
}

export interface ControlFragment extends FragmentBase {
  readonly kind: "control";
  readonly label: string;
  readonly value: string;
}

export interface ReplacedFragment extends FragmentBase {
  readonly kind: "replaced";
  readonly fallbackText: string;
}

export type TerminalFragment = ContainerFragment | TextFragment | ControlFragment | ReplacedFragment;

export interface TerminalRowFragment {
  readonly fragment: FragmentId;
  readonly formatting: FormattingNodeId;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
  readonly contentStartCodeUnit: number | null;
  readonly contentEndCodeUnit: number | null;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly column: number;
  readonly width: number;
}

export interface TerminalRowStyleRun {
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly style: TerminalStyleRun;
}

export interface TerminalRow {
  readonly row: number;
  readonly text: string;
  readonly fragments: readonly TerminalRowFragment[];
  readonly styles: readonly TerminalRowStyleRun[];
}

export interface TerminalHitRegion {
  readonly action: TerminalAction;
  readonly fragment: FragmentId;
  readonly rect: TerminalRect;
}

export interface TerminalFocusTarget {
  readonly node: DocumentNodeRef;
  readonly action: TerminalAction;
  readonly fragments: readonly FragmentId[];
  readonly rects: readonly TerminalRect[];
  readonly label: string;
}

export interface TerminalScrollAnchor {
  readonly id: string;
  readonly source: DocumentNodeRef;
  readonly fragment: FragmentId;
  readonly row: number;
}

export interface TerminalAccessibilityNode {
  readonly source: DocumentNodeRef;
  readonly fragment: FragmentId;
  readonly role: DocumentSemanticEntry["role"];
  readonly name: string;
  readonly description: string;
  readonly rect: TerminalRect;
}

export interface TerminalSearchRange {
  readonly match: VisibleTextMatchId;
  readonly row: number;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
  readonly fragment: FragmentId | null;
  readonly source: DocumentNodeRef | null;
  readonly sourceRange: DocumentSourceRange | null;
}

export interface TerminalSearchMatch {
  readonly id: VisibleTextMatchId;
  readonly ranges: readonly TerminalSearchRange[];
}

export interface TerminalSearchResult {
  readonly query: string;
  readonly matches: readonly TerminalSearchMatch[];
  readonly ranges: readonly TerminalSearchRange[];
  readonly truncated: boolean;
}

export interface FragmentBudgets {
  readonly maxFragments: number;
  readonly maxRows: number;
  readonly maxPaintCells: number;
  readonly maxDepth: number;
  readonly maxSearchMatches: number;
}

export type FragmentOutcome =
  | { readonly status: "complete"; readonly fragments: number; readonly rows: number }
  | {
      readonly status: "truncated";
      readonly fragments: number;
      readonly rows: number;
      readonly budget: keyof FragmentBudgets;
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-viewport" | "invalid-profile" };

export interface BuildFragmentTreeInput {
  readonly formatting: FormattingTree;
  readonly viewport: TerminalViewport;
  readonly measurer: TerminalTextMeasurer;
  readonly profile: TerminalProfile;
  readonly budgets?: Partial<FragmentBudgets>;
  readonly signal?: AbortSignal;
}

export interface FragmentTree {
  readonly formatting: FormattingTree;
  readonly viewport: TerminalViewport;
  readonly profile: TerminalProfile;
  readonly root: FragmentId;
  readonly rows: readonly TerminalRow[];
  readonly hitRegions: readonly TerminalHitRegion[];
  readonly focusTargets: readonly TerminalFocusTarget[];
  readonly scrollAnchors: readonly TerminalScrollAnchor[];
  readonly accessibility: readonly TerminalAccessibilityNode[];
  readonly outcome: FragmentOutcome;
  fragment(id: FragmentId): TerminalFragment;
  parent(id: FragmentId): TerminalFragment | null;
  children(id: FragmentId): readonly TerminalFragment[];
  forSource(source: DocumentNodeRef): readonly TerminalFragment[];
  hitTest(row: number, column: number): TerminalHitRegion | null;
  search(query: string): TerminalSearchResult;
}
