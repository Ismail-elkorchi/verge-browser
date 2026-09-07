import type { DocumentState, IndexedWebDocumentSnapshot } from "../../document/index.js";
import type { LayoutContext } from "../layout/index.js";
import type { MediaEnvironment, StyleDiagnostic, StylesheetResource } from "../style/index.js";
import type { TerminalRenderContext, ViewportWindow } from "../terminal/index.js";
import { RenderArtifactStore } from "./artifact-store.js";
import type {
  DocumentRenderArtifacts,
  RenderArtifactBudgets,
  RetainedViewportRenderResult,
} from "./types.js";

export interface RenderDocumentViewportInput {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly resources: readonly StylesheetResource[];
  readonly styleDiagnostics?: readonly StyleDiagnostic[];
  readonly mediaEnvironment: MediaEnvironment;
  readonly layoutContext: LayoutContext;
  readonly terminalContext: TerminalRenderContext;
  readonly window: ViewportWindow;
  readonly searchQuery?: string | null;
  readonly budgets?: Partial<RenderArtifactBudgets>;
  readonly signal?: AbortSignal;
}

export interface InProcessDocumentViewport {
  readonly artifacts: DocumentRenderArtifacts;
  readonly viewport: RetainedViewportRenderResult;
}

/**
 * Runs the retained artifact engine in-process for subsystem tests and portable
 * non-interactive tooling. Interactive and one-shot browser UI rendering use
 * the worker-owned store instead.
 */
export function renderDocumentViewport(input: RenderDocumentViewportInput): InProcessDocumentViewport {
  const store = new RenderArtifactStore({
    ...(input.budgets?.maxRetainedArtifactBytes === undefined
      ? {}
      : { maxRetainedArtifactBytes: input.budgets.maxRetainedArtifactBytes }),
  });
  const documentId = "in-process-document";
  try {
    store.attach({
      documentId,
      documentRevision: 1,
      stateRevision: 1,
      document: input.document,
      state: input.state,
      resources: input.resources,
      ...(input.styleDiagnostics === undefined ? {} : { styleDiagnostics: input.styleDiagnostics }),
      ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const request = {
      documentId,
      documentRevision: 1,
      mediaEnvironment: input.mediaEnvironment,
      layoutContext: input.layoutContext,
      terminalContext: input.terminalContext,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const artifacts = store.analyze(request);
    const viewport = store.renderViewport({
      ...request,
      viewportRevision: 1,
      window: input.window,
      ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
    });
    return Object.freeze({ artifacts, viewport });
  } finally {
    store.dispose();
  }
}
