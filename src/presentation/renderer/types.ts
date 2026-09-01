import type { DocumentState, IndexedWebDocumentSnapshot } from "../../document/index.js";
import type { FormattingBudgets, FormattingTree } from "../formatting/index.js";
import type { LayoutBudgets, LayoutContext, LayoutFragmentTree } from "../layout/index.js";
import type { TextSearchIndex } from "../search/index.js";
import type { DocumentNodeRef } from "../../document/index.js";
import type { TextSearchMatchId } from "../search/index.js";
import type {
  MediaEnvironment,
  StyleBudgets,
  StyleDiagnostic,
  StylesheetProgram,
  StylesheetResource,
  StyleSnapshot,
} from "../style/index.js";
import type { InlineItemStreamSet } from "../text/index.js";
import type {
  DisplayListSpatialIndex,
  DocumentDisplayList,
  DocumentGeometryIndex,
  TerminalPaintBudgets,
  TerminalRenderContext,
  ViewportDisplayList,
  ViewportTerminalResult,
  ViewportWindow,
} from "../terminal/index.js";
import type { RenderInstrumentation, RenderStageMeasurement } from "./instrumentation.js";

export interface RenderArtifactBudgets {
  readonly maxRetainedArtifactBytes: number;
  readonly style?: Partial<StyleBudgets>;
  readonly formatting?: Partial<FormattingBudgets>;
  readonly layout?: Partial<LayoutBudgets>;
  readonly terminal?: Partial<TerminalPaintBudgets>;
}

export interface AttachDocumentArtifactsInput {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly resources: readonly StylesheetResource[];
  readonly styleDiagnostics?: readonly StyleDiagnostic[];
  readonly budgets?: Partial<RenderArtifactBudgets>;
  readonly signal?: AbortSignal;
}

export type DocumentStateDependencyChange =
  | "focus"
  | "hover"
  | "active"
  | "target"
  | "checked-selected"
  | "disclosure-open"
  | "control-content";

export interface UpdateDocumentArtifactsStateInput {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly state: DocumentState;
  readonly changed: ReadonlySet<DocumentStateDependencyChange>;
}

export interface ArtifactDependencyKey {
  readonly documentRevision: number;
  readonly stylesheetProgram: string;
  readonly stateRevision: number;
  readonly media: string;
  readonly layoutViewport: string;
  readonly textMetrics: string;
  readonly computedStyleMap: string;
  readonly boxTree: string;
  readonly inlineItemStreams: string;
  readonly logicalTextIndex: string;
  readonly documentLayout: string;
  readonly documentDisplayList: string;
  readonly documentGeometry: string;
}

export interface DocumentRenderArtifacts {
  readonly key: ArtifactDependencyKey;
  readonly stylesheetProgram: StylesheetProgram;
  readonly computedStyles: StyleSnapshot;
  readonly boxTree: FormattingTree;
  readonly inlineItemStreams: InlineItemStreamSet;
  readonly textSearchIndex: TextSearchIndex;
  readonly documentLayout: LayoutFragmentTree;
  readonly documentDisplayList: DocumentDisplayList;
  readonly displayListSpatialIndex: DisplayListSpatialIndex;
  readonly documentGeometry: DocumentGeometryIndex;
  readonly retainedCost: number;
}

export interface DocumentAnalysisRequest {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly mediaEnvironment: MediaEnvironment;
  readonly layoutContext: LayoutContext;
  readonly terminalContext: TerminalRenderContext;
  readonly signal?: AbortSignal;
}

export interface ViewportRenderRequest extends DocumentAnalysisRequest {
  readonly viewportRevision: number;
  readonly window: ViewportWindow;
  readonly searchQuery?: string | null;
  /** Document-lifetime cancellation used while producing immutable artifacts. */
  readonly analysisSignal?: AbortSignal;
}

export interface RetainedViewportRenderResult {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly viewportRevision: number;
  readonly artifactKey: ArtifactDependencyKey;
  readonly displayList: ViewportDisplayList;
  readonly terminal: ViewportTerminalResult;
  readonly documentExtentRows: number;
  readonly scrollAnchors: DocumentGeometryIndex["scrollAnchors"];
  readonly focusOrder: DocumentGeometryIndex["focusOrder"];
  readonly stageMetrics: readonly RenderStageMeasurement[];
}

export interface DocumentSearchMatchGeometry {
  readonly id: TextSearchMatchId;
  readonly sources: readonly (DocumentNodeRef | null)[];
  readonly blockOffsetCssPx: number;
}

export interface DocumentSearchGeometryResult {
  readonly query: string;
  readonly matches: readonly DocumentSearchMatchGeometry[];
  readonly truncated: boolean;
}

export interface RenderArtifactStoreMetrics {
  readonly attachedDocuments: number;
  readonly retainedAnalyses: number;
  readonly retainedCost: number;
  readonly evictions: number;
}

export interface RenderArtifactStoreOptions {
  readonly maxRetainedArtifactBytes?: number;
  readonly instrumentation?: RenderInstrumentation;
}
