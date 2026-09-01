import type {
  SelectorStateDependency,
  StylesheetResource,
  StyleDiagnostic,
} from "../../presentation/style/index.js";
import type {
  DisplayListSpatialQueryMetrics,
  TerminalAccessibilityBound,
  TerminalCellRect,
  TerminalFocusTarget,
  TerminalHitRegion,
  TerminalSearchResult,
  ViewportCellBuffer,
} from "../../presentation/terminal/index.js";
import type {
  DocumentControlState,
  DocumentNodeRef,
  DocumentState,
} from "../../document/index.js";
import type { DocumentActionIdentity } from "../../presentation/formatting/index.js";
import type { RenderStageMeasurement } from "../../presentation/renderer/index.js";
import type { DocumentSearchGeometryResult } from "../../presentation/renderer/index.js";
import type { BrowserRenderPreferences } from "../document-layout.js";

export interface TransferredDocumentState {
  readonly controls: readonly (readonly [DocumentNodeRef, DocumentControlState])[];
  readonly open: readonly DocumentNodeRef[];
  readonly focus: DocumentNodeRef | null;
  readonly hover: DocumentNodeRef | null;
  readonly active: DocumentNodeRef | null;
  readonly urlTarget: DocumentNodeRef | null;
}

export function transferDocumentState(state: DocumentState): TransferredDocumentState {
  return Object.freeze({
    controls: Object.freeze([...state.controls]),
    open: Object.freeze([...state.open]),
    focus: state.focus,
    hover: state.hover,
    active: state.active,
    urlTarget: state.urlTarget,
  });
}

export function hydrateDocumentState(state: TransferredDocumentState): DocumentState {
  return Object.freeze({
    controls: new Map(state.controls),
    open: new Set(state.open),
    focus: state.focus,
    hover: state.hover,
    active: state.active,
    urlTarget: state.urlTarget,
  });
}

export interface RenderDocumentAttachment {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly sourceText: string;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly state: TransferredDocumentState;
  readonly stylesheets: readonly StylesheetResource[];
  readonly styleDiagnostics: readonly StyleDiagnostic[];
}

export interface ViewportRequestParameters {
  readonly columns: number;
  readonly rows: number;
  readonly scrollRow: number;
  readonly overscanBefore: number;
  readonly overscanAfter: number;
  readonly preferences: BrowserRenderPreferences;
  readonly searchQuery: string | null;
}

export interface ViewportSearchGeometryResult {
  readonly query: string;
  readonly matches: readonly {
    readonly id: DocumentSearchGeometryResult["matches"][number]["id"];
    readonly sources: DocumentSearchGeometryResult["matches"][number]["sources"];
    readonly anchorRow: number;
  }[];
  readonly truncated: boolean;
}

export interface RenderDocumentSummary {
  readonly documentRowCount: number;
  readonly incomplete: readonly string[];
  readonly scrollAnchors: readonly RenderScrollAnchorEntry[];
  readonly scrollAnchorByDocumentNode: ReadonlyMap<DocumentNodeRef, RenderScrollAnchorEntry>;
  readonly focusOrder: readonly RenderFocusOrderEntry[];
  readonly authorStateDependencies: readonly SelectorStateDependency[];
}

export interface RenderScrollAnchorEntry {
  readonly documentNode: DocumentNodeRef;
  readonly row: number;
}

export interface RenderFocusOrderEntry {
  readonly node: DocumentNodeRef;
  readonly actionId: string;
  readonly actionKind: DocumentActionIdentity["kind"];
  readonly topRow: number;
  readonly bottomRow: number;
}

export interface ViewportRenderPayload {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly viewportRevision: number;
  readonly cellBuffer: ViewportCellBuffer;
  readonly spatialQuery: DisplayListSpatialQueryMetrics;
  readonly hitRegions: readonly TerminalHitRegion[];
  readonly focusTargets: readonly TerminalFocusTarget[];
  readonly accessibilityBounds: readonly TerminalAccessibilityBound[];
  readonly search: TerminalSearchResult | null;
  readonly cellRectsByDocumentNode: readonly (readonly [DocumentNodeRef, readonly TerminalCellRect[]])[];
  readonly summary: RenderDocumentSummary | null;
  readonly stageMetrics: readonly RenderStageMeasurement[];
}

export type TransferredViewportRenderPayload = Omit<ViewportRenderPayload, "summary"> & {
  readonly summary: Omit<RenderDocumentSummary, "scrollAnchorByDocumentNode"> | null;
};

export type RenderWorkerRequest = {
  readonly kind: "attach-document";
  readonly requestId: number;
  readonly attachment: RenderDocumentAttachment;
  readonly documentGeneration: number;
  readonly documentCancellation: SharedArrayBuffer;
} | {
  readonly kind: "search-document";
  readonly requestId: number;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly documentGeneration: number;
  readonly documentCancellation: SharedArrayBuffer;
  readonly searchGeneration: number;
  readonly searchCancellation: SharedArrayBuffer;
  readonly query: string;
  readonly limit: number;
  readonly parameters: ViewportRequestParameters;
} | {
  readonly kind: "update-document-state";
  readonly requestId: number;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly state: TransferredDocumentState;
  readonly changed: readonly string[];
} | {
  readonly kind: "request-viewport";
  readonly requestId: number;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly stateRevision: number;
  readonly viewportRevision: number;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly documentCancellation: SharedArrayBuffer;
  readonly viewportCancellation: SharedArrayBuffer;
  readonly parameters: ViewportRequestParameters;
} | {
  readonly kind: "release-document";
  readonly requestId: number;
  readonly documentId: string;
} | {
  readonly kind: "metrics";
  readonly requestId: number;
} | {
  readonly kind: "dispose";
  readonly requestId: number;
};

export type RenderWorkerResponse = {
  readonly kind: "acknowledged";
  readonly requestId: number;
} | {
  readonly kind: "viewport-ready";
  readonly requestId: number;
  readonly payload: TransferredViewportRenderPayload;
} | {
  readonly kind: "search-ready";
  readonly requestId: number;
  readonly result: ViewportSearchGeometryResult;
} | {
  readonly kind: "artifact-metrics";
  readonly requestId: number;
  readonly metrics: {
    readonly attachedDocuments: number;
    readonly retainedAnalyses: number;
    readonly retainedCost: number;
    readonly evictions: number;
    readonly viewportRequests: number;
    readonly completedViewportRequests: number;
    readonly supersededViewportRequests: number;
    readonly heapUsedBytes: number;
    readonly stages: readonly RenderStageMeasurement[];
  };
} | {
  readonly kind: "render-failed";
  readonly requestId: number;
  readonly name: string;
  readonly message: string;
  readonly aborted: boolean;
};
